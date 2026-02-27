from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from database import get_db
from routers.auth import get_current_teacher
from services.teacher_chat import teacher_chat as _teacher_chat

router = APIRouter(prefix="/api/teacher", tags=["teacher"])


class ChatMessage(BaseModel):
    role: str
    content: str


class TeacherChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


class TeacherChatResponse(BaseModel):
    reply: str


@router.post("/chat", response_model=TeacherChatResponse)
def do_teacher_chat(
    req: TeacherChatRequest,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    history = [{"role": m.role, "content": m.content} for m in req.history]
    reply = _teacher_chat(db, req.message, history)
    return {"reply": reply}
