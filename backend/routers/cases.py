"""API for browsing and serving case study players."""
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Header
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from config import get_settings
from database import SessionLocal
from services.llm import llm_chat

router = APIRouter(prefix="/api/cases", tags=["cases"])

CASES_DIR = Path(__file__).parent.parent / "cases"
settings = get_settings()


def _slug_to_display_name(slug: str) -> str:
    """Convert directory slug like 'case-arm-boot' to a readable name."""
    name = slug
    if name.startswith("case-"):
        name = name[5:]
    return name.replace("-", " ").title()


def _validate_slug(slug: str) -> None:
    if "/" in slug or "\\" in slug or ".." in slug:
        raise HTTPException(status_code=400, detail="Invalid case slug")


def _load_case_context(slug: str) -> str:
    """Load the markdown case document as context for LLM."""
    case_dir = CASES_DIR / slug
    # Try common markdown filenames
    for name in ("arm64_boot.md", "case.md", "lab.md", "README.md"):
        md_path = case_dir / name
        if md_path.exists():
            text = md_path.read_text(encoding="utf-8")
            # Truncate to avoid exceeding context limits
            if len(text) > 8000:
                text = text[:8000] + "\n\n... (内容已截断)"
            return text
    return ""


# ── List cases ──────────────────────────────────────────────

@router.get("")
def list_cases():
    """Return all available case studies."""
    if not CASES_DIR.exists():
        return []
    cases = []
    for d in sorted(CASES_DIR.iterdir()):
        if d.is_dir() and (d / "player.html").exists():
            cases.append({"slug": d.name, "name": _slug_to_display_name(d.name)})
    return cases


# ── Serve player HTML ───────────────────────────────────────

@router.get("/{slug}/player", response_class=HTMLResponse)
def get_case_player(slug: str):
    """Serve the player.html with injected <base> tag and CASE_SLUG."""
    _validate_slug(slug)
    player_path = CASES_DIR / slug / "player.html"
    if not player_path.exists():
        raise HTTPException(status_code=404, detail="Case not found")

    html = player_path.read_text(encoding="utf-8")

    # Inject <base> so relative image paths resolve to /case-assets/{slug}/
    inject = (
        f'\n  <base href="/case-assets/{slug}/">'
        f'\n  <script>var CASE_SLUG = "{slug}";</script>'
    )
    html = html.replace("<head>", f"<head>{inject}", 1)

    return HTMLResponse(content=html)


# ── Case chat (real LLM) ───────────────────────────────────

CASE_SYSTEM_PROMPT = """你是一个操作系统课程的 AI 助教。学生正在阅读一个系统调试/实践案例。
请基于案例内容和学生的问题，提供深入、准确、通俗易懂的解答。

关键行为：
- 用中文回答
- 鼓励学生深入思考，而非直接给出答案
- 用具体类比解释抽象概念
- 回答保持简洁，重点突出
- 如果问题超出案例范围，也可以回答，但要说明这部分是通用知识"""


class CaseChatRequest(BaseModel):
    message: str
    context: Optional[str] = None  # current step context from player
    history: list[dict] = []       # recent chat history [{role, content}, ...]


def _resolve_student(authorization: Optional[str]):
    """Try to resolve student from token. Returns (student, db) or (None, None)."""
    if not authorization or not authorization.startswith("Bearer "):
        return None, None
    token = authorization[7:]
    try:
        from jose import JWTError, jwt
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "student":
            return None, None
        student_id = payload.get("sub")
        if not student_id:
            return None, None

        from models.student import Student
        db = SessionLocal()
        student = db.query(Student).filter(Student.id == int(student_id)).first()
        if not student:
            db.close()
            return None, None
        return student, db
    except (JWTError, Exception):
        return None, None


@router.post("/{slug}/chat")
def case_chat(
    slug: str,
    req: CaseChatRequest,
    authorization: Optional[str] = Header(None),
):
    """Chat with AI about the current case. Uses real LLM."""
    _validate_slug(slug)
    case_dir = CASES_DIR / slug
    if not case_dir.exists():
        raise HTTPException(status_code=404, detail="Case not found")

    # Build system prompt with case context
    case_context = _load_case_context(slug)
    system_parts = [CASE_SYSTEM_PROMPT]
    if case_context:
        system_parts.append(f"\n## 案例原文\n\n{case_context}")
    if req.context:
        system_parts.append(f"\n## 学生当前正在阅读的步骤\n\n{req.context}")
    system_prompt = "\n".join(system_parts)

    # Build messages
    messages = []
    for h in req.history[-10:]:  # limit history
        if h.get("role") in ("user", "assistant") and h.get("content"):
            messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": req.message})

    # Call LLM
    db_for_llm = SessionLocal()
    try:
        reply, input_tokens, output_tokens = llm_chat(db_for_llm, system_prompt, messages)
    finally:
        db_for_llm.close()

    # If student is authenticated, record the conversation
    student, student_db = _resolve_student(authorization)
    if student and student_db:
        try:
            from models.conversation import Session as ConvSession, Conversation

            # Find or create a case session
            session = (
                student_db.query(ConvSession)
                .filter(
                    ConvSession.student_id == student.id,
                    ConvSession.mode == f"case:{slug}",
                    ConvSession.summarized == False,  # noqa: E711
                )
                .order_by(ConvSession.started_at.desc())
                .first()
            )
            if not session:
                session = ConvSession(student_id=student.id, mode=f"case:{slug}")
                student_db.add(session)
                student_db.commit()
                student_db.refresh(session)

            student_db.add(Conversation(
                student_id=student.id, session_id=session.id,
                role="user", content=req.message,
            ))
            student_db.add(Conversation(
                student_id=student.id, session_id=session.id,
                role="assistant", content=reply,
                input_tokens=input_tokens, output_tokens=output_tokens,
                system_prompt=system_prompt[:500],  # truncate for storage
            ))
            student_db.commit()
        except Exception:
            pass  # don't fail the chat if recording fails
        finally:
            student_db.close()

    return {"reply": reply}
