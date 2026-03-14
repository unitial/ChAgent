import base64
from pathlib import Path
from sqlalchemy.orm import Session as DBSession
from models.student import Student
from models.conversation import Session as ConvSession, Conversation
from services.skills import get_enabled_skills_prompt, get_challenge_skill_prompt, get_onboarding_skill_prompt
from services.profile import get_profile_context_for_prompt
from services.llm import llm_chat

BASE_SYSTEM_PROMPT = """You are ChAgent, an intelligent teaching assistant for an undergraduate Operating Systems course (junior year).
Your role is to help students understand OS concepts through Socratic dialogue, clear explanations, and guided problem-solving.

Key behaviors:
- Encourage critical thinking rather than giving direct answers
- Use concrete analogies to explain abstract OS concepts
- Identify and gently correct misconceptions
- Adapt your explanation depth to the student's apparent understanding
- Be encouraging and patient
- Respond in the same language the student uses (Chinese or English)
- Keep responses concise and focused"""


def _build_profile_context(student: Student) -> str:
    # Prefer the richer file-based profile if it exists
    file_context = get_profile_context_for_prompt(student.id)
    if file_context:
        return file_context

    # Fall back to legacy profile_json from session summarization
    profile = student.profile_json or {}
    lines = [f"\n## Student Profile: {student.name}\n"]

    mastery = profile.get("topic_mastery", {})
    if mastery:
        lines.append("**Topic Mastery (0-10):**")
        for topic, level in mastery.items():
            lines.append(f"  - {topic}: {level}")

    mistakes = profile.get("common_mistakes", [])
    if mistakes:
        lines.append("\n**Known Misconceptions:**")
        for m in mistakes[-5:]:
            lines.append(f"  - {m}")

    style = profile.get("learning_style", "")
    if style:
        lines.append(f"\n**Learning Style:** {style}")

    recent = profile.get("recent_summary", "")
    if recent:
        lines.append(f"\n**Recent Session Summary:** {recent}")

    return "\n".join(lines)


def build_system_prompt(db: DBSession, student: Student, session: ConvSession = None, messages: list[dict] | None = None, retrieval_context: str = "") -> str:
    parts = [BASE_SYSTEM_PROMPT]
    skills_block = get_enabled_skills_prompt(messages)
    if skills_block:
        parts.append(skills_block)
    if session and getattr(session, "mode", None) == "challenge":
        challenge_block = get_challenge_skill_prompt()
        if challenge_block:
            parts.append(challenge_block)
    if session and getattr(session, "mode", None) == "onboarding":
        onboarding_block = get_onboarding_skill_prompt()
        if onboarding_block:
            parts.append(onboarding_block)
    if retrieval_context:
        parts.append(retrieval_context)
    profile_block = _build_profile_context(student)
    parts.append(profile_block)
    return "\n".join(parts)


def get_recent_history(db: DBSession, session: ConvSession, limit: int = 20) -> list[dict]:
    conversations = (
        db.query(Conversation)
        .filter(Conversation.session_id == session.id)
        .order_by(Conversation.created_at)
        .limit(limit)
        .all()
    )
    return [{"role": c.role, "content": c.content} for c in conversations]


def _load_session_document(session: ConvSession) -> dict | None:
    """Load the document attached to a session, if any."""
    if not session.doc_path or not session.doc_media_type:
        return None
    doc_file = Path(session.doc_path)
    if not doc_file.exists():
        return None
    return {
        "media_type": session.doc_media_type,
        "data": base64.b64encode(doc_file.read_bytes()).decode(),
    }


def chat(db: DBSession, student: Student, session: ConvSession, user_message: str, document: dict | None = None) -> tuple[str, int, int, str, list[dict]]:
    """Send a message to the configured LLM. Returns (reply, input_tokens, output_tokens, system_prompt, citations)."""
    from services.retrieval import search

    citations = search(user_message)
    retrieval_context = _format_citations_for_prompt(citations) if citations else ""

    history = get_recent_history(db, session)
    messages = history + [{"role": "user", "content": user_message}]
    system_prompt = build_system_prompt(db, student, session, messages, retrieval_context=retrieval_context)
    doc = document if document is not None else _load_session_document(session)
    text, input_tokens, output_tokens = llm_chat(db, system_prompt, messages, document=doc)
    return text, input_tokens, output_tokens, system_prompt, citations


def chat_stream(db: DBSession, student: Student, session: ConvSession, user_message: str, document: dict | None = None):
    """Streaming variant of chat(). Yields (type, data) tuples:
       ('setup', {system_prompt, citations}) first,
       ('delta', str) for text chunks,
       ('done', {input_tokens, output_tokens}) at end.
    """
    from typing import Generator
    from services.retrieval import search
    from services.llm import llm_chat_stream

    citations = search(user_message)
    retrieval_context = _format_citations_for_prompt(citations) if citations else ""

    history = get_recent_history(db, session)
    messages = history + [{"role": "user", "content": user_message}]
    system_prompt = build_system_prompt(db, student, session, messages, retrieval_context=retrieval_context)
    doc = document if document is not None else _load_session_document(session)

    yield ("setup", {"system_prompt": system_prompt, "citations": citations})

    for chunk in llm_chat_stream(db, system_prompt, messages, document=doc):
        if isinstance(chunk, dict):
            yield ("done", chunk)
        else:
            yield ("delta", chunk)


def _format_citations_for_prompt(citations: list[dict]) -> str:
    """Format retrieved citations into a system prompt block."""
    lines = ["\n## 参考教材\n以下是与学生问题相关的教材原文片段，请在回答时参考，并尽量基于这些内容作答：\n"]
    for c in citations:
        lines.append(f"《{c['textbook_name']}》第 {c['page_num']} 页：")
        lines.append(f'"{c["text"]}"\n')
    return "\n".join(lines)
