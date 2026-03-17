from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession
from typing import Optional

from database import get_db
from models.conversation import Conversation, Session as ConvSession
from models.student import Student
from routers.auth import get_current_teacher

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class ConversationOut(BaseModel):
    id: int
    student_id: int
    student_name: Optional[str] = None
    session_id: int
    session_mode: Optional[str] = None
    role: str
    content: str
    system_prompt: Optional[str] = None
    created_at: Optional[str] = None


@router.get("", response_model=list[ConversationOut])
def list_conversations(
    student_id: Optional[int] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    mode: Optional[str] = Query(None, description="Filter by session mode: onboarding, challenge, or normal"),
    limit: int = Query(200, le=500),
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    query = (
        db.query(Conversation, Student.name, ConvSession.mode)
        .join(Student, Conversation.student_id == Student.id)
        .join(ConvSession, Conversation.session_id == ConvSession.id)
    )

    if student_id:
        query = query.filter(Conversation.student_id == student_id)
    if date_from:
        query = query.filter(Conversation.created_at >= date_from)
    if date_to:
        query = query.filter(Conversation.created_at <= date_to)
    if mode:
        if mode == "normal":
            query = query.filter(ConvSession.mode.is_(None))
        else:
            query = query.filter(ConvSession.mode == mode)

    rows = query.order_by(Conversation.created_at.asc(), Conversation.id.asc()).limit(limit).all()

    return [
        ConversationOut(
            id=c.id,
            student_id=c.student_id,
            student_name=name,
            session_id=c.session_id,
            session_mode=session_mode,
            role=c.role,
            content=c.content,
            system_prompt=c.system_prompt,
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c, name, session_mode in rows
    ]
