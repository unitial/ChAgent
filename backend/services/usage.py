from datetime import date, datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session as DBSession

from models.conversation import Conversation
from models.student import Student
from services.settings import get_setting


def get_daily_tokens(db: DBSession, student_id: int) -> int:
    """Sum of all tokens consumed by a student today (UTC)."""
    today_start = datetime.combine(date.today(), datetime.min.time()).replace(tzinfo=timezone.utc)
    result = db.query(
        func.coalesce(func.sum(Conversation.input_tokens + Conversation.output_tokens), 0)
    ).filter(
        Conversation.student_id == student_id,
        Conversation.created_at >= today_start,
    ).scalar()
    return int(result or 0)


def get_daily_limit_info(db: DBSession, student: Student) -> tuple[int, int]:
    """Returns (used_today, effective_limit). limit=0 means unlimited."""
    limit = student.daily_token_limit
    if limit is None:
        limit = int(get_setting(db, "default_daily_token_limit", "0"))
    used = get_daily_tokens(db, student.id)
    return used, limit


def check_daily_limit(db: DBSession, student: Student) -> None:
    """Raise HTTP 429 if the student has exceeded their daily token limit."""
    used, limit = get_daily_limit_info(db, student)
    if limit > 0 and used >= limit:
        raise HTTPException(
            status_code=429,
            detail=f"每日用量上限 {limit} tokens 已达到（今日已用 {used}），请明天再来。",
        )
