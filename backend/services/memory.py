import json
import anthropic
from sqlalchemy.orm import Session as DBSession
from models.student import Student
from models.conversation import Session as ConvSession, Conversation
from config import get_settings

settings = get_settings()
client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

SUMMARY_SYSTEM_PROMPT = """You are an assistant that analyzes tutoring conversations for an Operating Systems course.
Given a conversation between a teaching assistant bot and a student, extract a structured JSON summary with:
- topic_mastery: dict mapping OS topic names to mastery level (0-10)
- common_mistakes: list of strings describing misconceptions or errors shown
- learning_style: brief string describing the student's apparent learning style
- recent_summary: 2-3 sentence summary of what was discussed and the student's understanding

Respond ONLY with valid JSON, no markdown fences."""


def _build_summary_messages(conversations: list[Conversation]) -> list[dict]:
    messages = []
    for conv in conversations:
        messages.append({"role": conv.role, "content": conv.content})
    return messages


async def summarize_session(db: DBSession, session: ConvSession) -> None:
    """Summarize a completed session and merge into student profile."""
    if session.summarized:
        return

    conversations = (
        db.query(Conversation)
        .filter(Conversation.session_id == session.id)
        .order_by(Conversation.created_at)
        .all()
    )

    if not conversations:
        session.summarized = True
        db.commit()
        return

    conv_text = "\n".join(
        f"{c.role.upper()}: {c.content}" for c in conversations
    )

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=SUMMARY_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"Please analyze this tutoring conversation:\n\n{conv_text}"}],
    )

    raw = response.content[0].text.strip()
    try:
        new_data = json.loads(raw)
    except json.JSONDecodeError:
        # If JSON parsing fails, mark as summarized without updating
        session.summarized = True
        db.commit()
        return

    student: Student = session.student
    profile = student.profile_json or {}

    # Merge topic_mastery
    existing_mastery = profile.get("topic_mastery", {})
    for topic, level in new_data.get("topic_mastery", {}).items():
        if topic in existing_mastery:
            existing_mastery[topic] = round((existing_mastery[topic] + level) / 2, 1)
        else:
            existing_mastery[topic] = level
    profile["topic_mastery"] = existing_mastery

    # Merge common_mistakes (keep unique, last 20)
    existing_mistakes = profile.get("common_mistakes", [])
    new_mistakes = new_data.get("common_mistakes", [])
    all_mistakes = list(dict.fromkeys(existing_mistakes + new_mistakes))
    profile["common_mistakes"] = all_mistakes[-20:]

    # Update learning_style if provided
    if new_data.get("learning_style"):
        profile["learning_style"] = new_data["learning_style"]

    # Update recent_summary
    if new_data.get("recent_summary"):
        profile["recent_summary"] = new_data["recent_summary"]

    student.profile_json = profile
    session.summarized = True
    db.commit()
