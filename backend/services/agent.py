from sqlalchemy.orm import Session as DBSession
from models.student import Student
from models.conversation import Session as ConvSession, Conversation
from services.skills import get_enabled_skills_prompt, get_challenge_skill_prompt
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


def build_system_prompt(db: DBSession, student: Student, session: ConvSession = None) -> str:
    parts = [BASE_SYSTEM_PROMPT]
    skills_block = get_enabled_skills_prompt()
    if skills_block:
        parts.append(skills_block)
    if session and getattr(session, "mode", None) == "challenge":
        challenge_block = get_challenge_skill_prompt()
        if challenge_block:
            parts.append(challenge_block)
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


def chat(db: DBSession, student: Student, session: ConvSession, user_message: str) -> tuple[str, int, int, str]:
    """Send a message to the configured LLM. Returns (reply, input_tokens, output_tokens, system_prompt)."""
    system_prompt = build_system_prompt(db, student, session)
    history = get_recent_history(db, session)
    messages = history + [{"role": "user", "content": user_message}]
    text, input_tokens, output_tokens = llm_chat(db, system_prompt, messages)
    return text, input_tokens, output_tokens, system_prompt
