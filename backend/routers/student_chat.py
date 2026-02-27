from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from database import get_db, SessionLocal
from models.student import Student
from models.conversation import Session as ConvSession, Conversation
from services import agent as agent_service
from services import skills as skills_service
from services.memory import summarize_session
from services.usage import check_daily_limit
from routers.auth import create_access_token
from config import get_settings

settings = get_settings()
router = APIRouter(prefix="/api/student", tags=["student"])

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/student/login")


# --- Request/Response models ---

class LoginRequest(BaseModel):
    name: str


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[int] = None  # if set, use this specific session (e.g. challenge)


class ChatResponse(BaseModel):
    reply: str
    session_id: int
    session_mode: Optional[str] = None
    system_prompt: str


class HistoryMessage(BaseModel):
    id: int
    session_id: int
    role: str
    content: str
    created_at: str
    system_prompt: Optional[str] = None


class ChallengeSessionOut(BaseModel):
    session_id: int
    mode: str
    started_at: str


# --- Auth dependency ---

def get_current_student(token: str = Depends(oauth2_scheme), db: DBSession = Depends(get_db)) -> Student:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "student":
            raise credentials_exception
        student_id: str = payload.get("sub")
        if student_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    student = db.query(Student).filter(Student.id == int(student_id)).first()
    if student is None:
        raise credentials_exception
    return student


# --- Session management ---

def get_or_create_session(db: DBSession, student: Student) -> ConvSession:
    timeout = timedelta(minutes=settings.session_timeout_minutes)
    now = datetime.now(timezone.utc)

    latest = (
        db.query(ConvSession)
        .filter(ConvSession.student_id == student.id, ConvSession.mode == None)  # noqa: E711
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

        if reference_time.tzinfo is None:
            reference_time = reference_time.replace(tzinfo=timezone.utc)

        if now - reference_time < timeout and not latest.summarized:
            return latest

    session = ConvSession(student_id=student.id, mode=None)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


async def trigger_session_summary(student_id: int) -> None:
    db = SessionLocal()
    try:
        timeout = timedelta(minutes=settings.session_timeout_minutes)
        now = datetime.now(timezone.utc)

        sessions = (
            db.query(ConvSession)
            .filter(
                ConvSession.student_id == student_id,
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
    finally:
        db.close()


# --- Routes ---

@router.post("/login")
def student_login(req: LoginRequest, db: DBSession = Depends(get_db)):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")

    student = db.query(Student).filter(Student.name == name).first()
    if not student:
        student = Student(name=name, feishu_user_id=None)
        db.add(student)
        db.commit()
        db.refresh(student)

    token = create_access_token({"sub": str(student.id), "type": "student"})
    return {"access_token": token, "token_type": "bearer", "name": student.name}


@router.post("/chat", response_model=ChatResponse)
async def student_chat(
    req: ChatRequest,
    background_tasks: BackgroundTasks,
    db: DBSession = Depends(get_db),
    student: Student = Depends(get_current_student),
):
    text = req.message.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    if req.session_id is not None:
        session = db.query(ConvSession).filter(
            ConvSession.id == req.session_id,
            ConvSession.student_id == student.id,
        ).first()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        session = get_or_create_session(db, student)

    check_daily_limit(db, student)
    reply, input_tokens, output_tokens, system_prompt = agent_service.chat(db, student, session, text)

    db.add(Conversation(student_id=student.id, session_id=session.id, role="user", content=text))
    db.add(Conversation(
        student_id=student.id, session_id=session.id,
        role="assistant", content=reply,
        input_tokens=input_tokens, output_tokens=output_tokens,
        system_prompt=system_prompt,
    ))
    db.commit()

    background_tasks.add_task(trigger_session_summary, student.id)

    return {"reply": reply, "session_id": session.id, "session_mode": session.mode, "system_prompt": system_prompt}


@router.get("/history", response_model=list[HistoryMessage])
def student_history(
    session_id: Optional[int] = None,
    db: DBSession = Depends(get_db),
    student: Student = Depends(get_current_student),
):
    q = db.query(Conversation).filter(Conversation.student_id == student.id)
    if session_id is not None:
        q = q.filter(Conversation.session_id == session_id)
    msgs = (
        q.order_by(Conversation.created_at.desc(), Conversation.id.desc())
        .limit(60)
        .all()
    )
    msgs.reverse()
    return [
        {
            "id": m.id,
            "session_id": m.session_id,
            "role": m.role,
            "content": m.content,
            "created_at": m.created_at.isoformat() if m.created_at else "",
            "system_prompt": m.system_prompt,
        }
        for m in msgs
    ]


@router.post("/challenge/start", response_model=ChallengeSessionOut)
def challenge_start(
    db: DBSession = Depends(get_db),
    student: Student = Depends(get_current_student),
):
    """Start or resume a challenge session. Returns existing active challenge if one exists."""
    existing = (
        db.query(ConvSession)
        .filter(
            ConvSession.student_id == student.id,
            ConvSession.mode == "challenge",
            ConvSession.summarized == False,  # noqa: E712
        )
        .order_by(ConvSession.started_at.desc())
        .first()
    )
    if existing:
        return {
            "session_id": existing.id,
            "mode": existing.mode,
            "started_at": existing.started_at.isoformat(),
        }

    session = ConvSession(student_id=student.id, mode="challenge")
    db.add(session)
    db.commit()
    db.refresh(session)

    # Generate an opening greeting from the AI for new sessions
    kp_skills = [s["name"] for s in skills_service.list_skills() if s["enabled"] and s["type"] == "knowledge_point"]
    topics_str = "、".join(kp_skills) if kp_skills else "（暂无预设知识点）"
    kickoff = (
        f"（系统提示：挑战模式新会话已启动。当前可供选择的知识领域有：{topics_str}。"
        "请用中文向学生打招呼，简要说明挑战模式的玩法，然后列出上述知识领域供学生选择，"
        "同时说明学生也可以自由输入任何想挑战的主题。）"
    )
    reply, input_tokens, output_tokens, system_prompt = agent_service.chat(db, student, session, kickoff)
    db.add(Conversation(
        student_id=student.id, session_id=session.id,
        role="assistant", content=reply,
        input_tokens=input_tokens, output_tokens=output_tokens,
        system_prompt=system_prompt,
    ))
    db.commit()

    return {
        "session_id": session.id,
        "mode": session.mode,
        "started_at": session.started_at.isoformat(),
    }


@router.get("/challenge/active", response_model=Optional[ChallengeSessionOut])
def challenge_active(
    db: DBSession = Depends(get_db),
    student: Student = Depends(get_current_student),
):
    """Check if there is an ongoing (not summarized) challenge session."""
    existing = (
        db.query(ConvSession)
        .filter(
            ConvSession.student_id == student.id,
            ConvSession.mode == "challenge",
            ConvSession.summarized == False,  # noqa: E712
        )
        .order_by(ConvSession.started_at.desc())
        .first()
    )
    if not existing:
        return None
    return {
        "session_id": existing.id,
        "mode": existing.mode,
        "started_at": existing.started_at.isoformat(),
    }
