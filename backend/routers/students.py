from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session as DBSession
from typing import Optional

from database import get_db
from models.student import Student
from models.conversation import Conversation, Session as ConvSession
from services.usage import get_daily_tokens, get_daily_limit_info
from services.profile import list_profile_aspects
from services.profile_updater import student_needs_profile_update
from routers.auth import get_current_teacher

router = APIRouter(prefix="/api/students", tags=["students"])


class StudentOut(BaseModel):
    id: int
    name: str
    feishu_user_id: Optional[str] = None
    profile_json: Optional[dict] = None
    profile_aspects: list[str] = []   # names of file-based profile aspects
    daily_token_limit: Optional[int] = None
    today_tokens: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    profile_updated_at: Optional[str] = None
    needs_profile_update: bool = False

    class Config:
        from_attributes = True


class ConversationOut(BaseModel):
    id: int
    role: str
    content: str
    session_id: int
    session_mode: Optional[str] = None
    system_prompt: Optional[str] = None
    created_at: Optional[str] = None

    class Config:
        from_attributes = True


class LimitUpdate(BaseModel):
    daily_token_limit: Optional[int] = None  # None = use global default; 0 = unlimited


class UsageOut(BaseModel):
    student_id: int
    today_tokens: int
    effective_limit: int  # 0 = unlimited


@router.get("", response_model=list[StudentOut])
def list_students(db: DBSession = Depends(get_db), _=Depends(get_current_teacher)):
    today_start = datetime.combine(date.today(), datetime.min.time()).replace(tzinfo=timezone.utc)

    token_subq = (
        db.query(
            Conversation.student_id,
            func.coalesce(
                func.sum(Conversation.input_tokens + Conversation.output_tokens), 0
            ).label("today_tokens"),
        )
        .filter(Conversation.created_at >= today_start)
        .group_by(Conversation.student_id)
        .subquery()
    )

    rows = (
        db.query(Student, func.coalesce(token_subq.c.today_tokens, 0).label("today_tokens"))
        .outerjoin(token_subq, Student.id == token_subq.c.student_id)
        .order_by(Student.created_at.desc())
        .all()
    )

    return [
        StudentOut(
            id=s.id,
            name=s.name,
            feishu_user_id=s.feishu_user_id,
            profile_json=s.profile_json,
            profile_aspects=[a["name"] for a in list_profile_aspects(s.id)],
            daily_token_limit=s.daily_token_limit,
            today_tokens=int(today_tokens),
            created_at=s.created_at.isoformat() if s.created_at else None,
            updated_at=s.updated_at.isoformat() if s.updated_at else None,
            profile_updated_at=s.profile_updated_at.isoformat() if s.profile_updated_at else None,
            needs_profile_update=student_needs_profile_update(db, s),
        )
        for s, today_tokens in rows
    ]


@router.get("/{student_id}", response_model=StudentOut)
def get_student(student_id: int, db: DBSession = Depends(get_db), _=Depends(get_current_teacher)):
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    today_tokens = get_daily_tokens(db, student_id)
    return StudentOut(
        id=student.id,
        name=student.name,
        feishu_user_id=student.feishu_user_id,
        profile_json=student.profile_json,
        daily_token_limit=student.daily_token_limit,
        today_tokens=today_tokens,
        created_at=student.created_at.isoformat() if student.created_at else None,
        updated_at=student.updated_at.isoformat() if student.updated_at else None,
    )


@router.get("/{student_id}/conversations", response_model=list[ConversationOut])
def get_student_conversations(
    student_id: int,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    convs = (
        db.query(Conversation, ConvSession.mode.label("session_mode"))
        .join(ConvSession, Conversation.session_id == ConvSession.id)
        .filter(Conversation.student_id == student_id)
        .order_by(Conversation.created_at)
        .all()
    )
    return [
        ConversationOut(
            id=c.id,
            role=c.role,
            content=c.content,
            session_id=c.session_id,
            session_mode=session_mode,
            system_prompt=c.system_prompt,
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c, session_mode in convs
    ]


@router.put("/{student_id}/limit")
def set_student_limit(
    student_id: int,
    payload: LimitUpdate,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    student.daily_token_limit = payload.daily_token_limit
    db.commit()
    return {"ok": True}


@router.get("/{student_id}/usage", response_model=UsageOut)
def get_student_usage(
    student_id: int,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    used, limit = get_daily_limit_info(db, student)
    return UsageOut(student_id=student_id, today_tokens=used, effective_limit=limit)
