"""Teacher API for textbook management."""
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from database import get_db, SessionLocal
from models.textbook import Textbook
from routers.auth import get_current_teacher
from services.retrieval import index_textbook, delete_textbook_chunks

router = APIRouter(prefix="/api/textbooks", tags=["textbooks"])

TEXTBOOK_FILES_DIR = Path(__file__).parent.parent / "textbook_files"
TEXTBOOK_FILES_DIR.mkdir(exist_ok=True)

MAX_PDF_SIZE = 100 * 1024 * 1024  # 100 MB


class TextbookOut(BaseModel):
    id: int
    name: str
    status: str
    chunk_count: int
    error_msg: str | None
    created_at: str

    class Config:
        from_attributes = True


def _textbook_to_out(tb: Textbook) -> dict:
    return {
        "id": tb.id,
        "name": tb.name,
        "status": tb.status,
        "chunk_count": tb.chunk_count or 0,
        "error_msg": tb.error_msg,
        "created_at": tb.created_at.isoformat() if tb.created_at else "",
    }


def _run_indexing(textbook_id: int, file_path: str, name: str) -> None:
    """Background task: index in a fresh DB session."""
    db = SessionLocal()
    try:
        index_textbook(textbook_id, file_path, name, db)
    finally:
        db.close()


@router.post("", response_model=TextbookOut)
async def upload_textbook(
    background_tasks: BackgroundTasks,
    name: str = Form(...),
    file: UploadFile = File(...),
    db: DBSession = Depends(get_db),
    _: object = Depends(get_current_teacher),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="只支持 PDF 文件")

    file_bytes = await file.read()
    if len(file_bytes) > MAX_PDF_SIZE:
        raise HTTPException(status_code=413, detail="文件过大，最大支持 100 MB")

    unique_name = f"{uuid.uuid4().hex}.pdf"
    saved_path = TEXTBOOK_FILES_DIR / unique_name
    saved_path.write_bytes(file_bytes)

    tb = Textbook(name=name.strip() or file.filename, file_path=str(saved_path), status="pending")
    db.add(tb)
    db.commit()
    db.refresh(tb)

    background_tasks.add_task(_run_indexing, tb.id, str(saved_path), tb.name)

    return _textbook_to_out(tb)


@router.get("", response_model=list[TextbookOut])
def list_textbooks(
    db: DBSession = Depends(get_db),
    _: object = Depends(get_current_teacher),
):
    textbooks = db.query(Textbook).order_by(Textbook.created_at.desc()).all()
    return [_textbook_to_out(tb) for tb in textbooks]


@router.delete("/{textbook_id}")
def delete_textbook(
    textbook_id: int,
    db: DBSession = Depends(get_db),
    _: object = Depends(get_current_teacher),
):
    tb = db.query(Textbook).filter(Textbook.id == textbook_id).first()
    if not tb:
        raise HTTPException(status_code=404, detail="教材不存在")

    # Remove file
    file_path = Path(tb.file_path)
    if file_path.exists():
        file_path.unlink(missing_ok=True)

    # Remove ChromaDB chunks
    delete_textbook_chunks(textbook_id)

    db.delete(tb)
    db.commit()
    return {"ok": True}


@router.get("/{textbook_id}", response_model=TextbookOut)
def get_textbook(
    textbook_id: int,
    db: DBSession = Depends(get_db),
    _: object = Depends(get_current_teacher),
):
    tb = db.query(Textbook).filter(Textbook.id == textbook_id).first()
    if not tb:
        raise HTTPException(status_code=404, detail="教材不存在")
    return _textbook_to_out(tb)
