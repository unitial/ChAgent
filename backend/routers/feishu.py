import hashlib
import hmac
import json
import re
import time
import base64
from datetime import datetime, timezone, timedelta

import httpx
from fastapi import APIRouter, Request, HTTPException, Depends, BackgroundTasks
from sqlalchemy.orm import Session as DBSession

from database import get_db
from models.student import Student
from models.conversation import Session as ConvSession, Conversation
from services import agent as agent_service
from services.memory import summarize_session
from services.usage import get_daily_limit_info
from config import get_settings

settings = get_settings()
router = APIRouter()

# --- Feishu API helpers ---

async def send_feishu_message(user_id: str, text: str) -> None:
    """Send a text message to a Feishu user via open API."""
    token = await get_tenant_access_token()
    async with httpx.AsyncClient() as client:
        await client.post(
            "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={
                "receive_id": user_id,
                "msg_type": "text",
                "content": json.dumps({"text": text}),
            },
            timeout=10,
        )


_token_cache: dict = {}

async def get_tenant_access_token() -> str:
    now = time.time()
    if _token_cache.get("token") and _token_cache.get("expires_at", 0) > now + 60:
        return _token_cache["token"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": settings.feishu_app_id, "app_secret": settings.feishu_app_secret},
            timeout=10,
        )
        data = resp.json()
        _token_cache["token"] = data["tenant_access_token"]
        _token_cache["expires_at"] = now + data.get("expire", 7200)
        return _token_cache["token"]


# --- Session management ---

def get_or_create_session(db: DBSession, student: Student) -> ConvSession:
    """Find the latest active session or create a new one."""
    timeout = timedelta(minutes=settings.session_timeout_minutes)
    now = datetime.now(timezone.utc)

    latest = (
        db.query(ConvSession)
        .filter(ConvSession.student_id == student.id)
        .order_by(ConvSession.started_at.desc())
        .first()
    )

    if latest:
        last_msg = (
            db.query(Conversation)
            .filter(Conversation.session_id == latest.id)
            .order_by(Conversation.created_at.desc())
            .first()
        )
        reference_time = latest.started_at
        if last_msg and last_msg.created_at:
            reference_time = last_msg.created_at

        # Ensure timezone aware comparison
        if reference_time.tzinfo is None:
            reference_time = reference_time.replace(tzinfo=timezone.utc)

        if now - reference_time < timeout and not latest.summarized:
            return latest

    # Create new session
    session = ConvSession(student_id=student.id)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


async def trigger_session_summary(db: DBSession, student: Student) -> None:
    """Check for timed-out sessions and summarize them."""
    timeout = timedelta(minutes=settings.session_timeout_minutes)
    now = datetime.now(timezone.utc)

    sessions = (
        db.query(ConvSession)
        .filter(
            ConvSession.student_id == student.id,
            ConvSession.summarized == False,  # noqa: E712
        )
        .all()
    )

    for session in sessions:
        last_msg = (
            db.query(Conversation)
            .filter(Conversation.session_id == session.id)
            .order_by(Conversation.created_at.desc())
            .first()
        )
        if not last_msg:
            session.summarized = True
            db.commit()
            continue

        ref_time = last_msg.created_at
        if ref_time.tzinfo is None:
            ref_time = ref_time.replace(tzinfo=timezone.utc)

        if now - ref_time > timeout:
            await summarize_session(db, session)


# --- Encryption decryption ---

def decrypt_feishu_event(encrypt_key: str, encrypted: str) -> dict:
    """Decrypt AES-CBC encrypted Feishu event."""
    import Crypto.Cipher.AES as AES
    key = hashlib.sha256(encrypt_key.encode()).digest()
    encrypted_bytes = base64.b64decode(encrypted)
    iv = encrypted_bytes[:16]
    cipher = AES.new(key, AES.MODE_CBC, iv)
    raw = cipher.decrypt(encrypted_bytes[16:])
    # Remove PKCS7 padding
    pad = raw[-1]
    raw = raw[:-pad]
    return json.loads(raw.decode())


# --- Main webhook handler ---

@router.post("/webhook/feishu")
async def feishu_webhook(request: Request, background_tasks: BackgroundTasks, db: DBSession = Depends(get_db)):
    body = await request.body()
    data = json.loads(body)

    # Handle URL verification challenge
    if "challenge" in data:
        return {"challenge": data["challenge"]}

    # Decrypt if encrypted
    if "encrypt" in data:
        if not settings.feishu_encrypt_key:
            raise HTTPException(status_code=400, detail="Encrypt key not configured")
        data = decrypt_feishu_event(settings.feishu_encrypt_key, data["encrypt"])

    event_type = data.get("header", {}).get("event_type") or data.get("type", "")

    # Handle message events
    if event_type == "im.message.receive_v1":
        event = data.get("event", {})
        msg = event.get("message", {})
        sender = event.get("sender", {})

        # Only handle private chat text messages
        if msg.get("chat_type") != "p2p":
            return {"ok": True}
        if msg.get("message_type") != "text":
            return {"ok": True}

        feishu_user_id = sender.get("sender_id", {}).get("open_id", "")
        if not feishu_user_id:
            return {"ok": True}

        content_raw = msg.get("content", "{}")
        text = json.loads(content_raw).get("text", "").strip()
        if not text:
            return {"ok": True}

        # Remove @mentions
        text = re.sub(r"@\S+", "", text).strip()

        # Look up student
        student = db.query(Student).filter(Student.feishu_user_id == feishu_user_id).first()

        # Binding flow: user says "我是 张三" or "I am Zhang San"
        if not student:
            bind_match = re.match(r"^(?:我是|I am|我叫|my name is)\s*(.+)$", text, re.IGNORECASE)
            if bind_match:
                name = bind_match.group(1).strip()
                existing_name = db.query(Student).filter(Student.name == name).first()
                if existing_name:
                    reply = f"名字「{name}」已被注册，请使用其他名字。"
                else:
                    student = Student(name=name, feishu_user_id=feishu_user_id)
                    db.add(student)
                    db.commit()
                    db.refresh(student)
                    reply = f"你好，{name}！我是 ChAgent，你的操作系统课程助教。有任何问题都可以问我 😊"
            else:
                reply = "你好！请先告诉我你的姓名，例如：「我是 张三」"
            background_tasks.add_task(send_feishu_message, feishu_user_id, reply)
            return {"ok": True}

        # Get or create session
        session = get_or_create_session(db, student)

        # Check daily token limit
        used, limit = get_daily_limit_info(db, student)
        if limit > 0 and used >= limit:
            limit_reply = f"抱歉，你今天的 API 用量（已用 {used} tokens）已达到上限（{limit} tokens），请明天再来。"
            background_tasks.add_task(send_feishu_message, feishu_user_id, limit_reply)
            return {"ok": True}

        # Call LLM
        reply, input_tokens, output_tokens, system_prompt = agent_service.chat(db, student, session, text)

        # Store messages
        db.add(Conversation(student_id=student.id, session_id=session.id, role="user", content=text))
        db.add(Conversation(
            student_id=student.id, session_id=session.id,
            role="assistant", content=reply,
            input_tokens=input_tokens, output_tokens=output_tokens,
            system_prompt=system_prompt,
        ))
        db.commit()

        # Send reply
        background_tasks.add_task(send_feishu_message, feishu_user_id, reply)

        # Async: check if any old sessions need summarizing
        background_tasks.add_task(trigger_session_summary, db, student)

        return {"ok": True}

    return {"ok": True}
