from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession
from typing import Optional

from database import get_db, SessionLocal
from models.student import Student
from services.profile import (
    list_profile_aspects,
    get_profile_aspect,
    write_profile_aspect,
    delete_profile_aspect,
    update_profile_index_from_aspects,
)
from services.profile_updater import update_student_profile, update_all_profiles
from routers.auth import get_current_teacher

router = APIRouter(tags=["profiles"])


class AspectOut(BaseModel):
    slug: str
    name: str
    content: str
    updated_at: str = ""


class AspectUpdate(BaseModel):
    name: Optional[str] = None
    content: str


@router.get("/api/students/{student_id}/profile", response_model=list[AspectOut])
def get_profile(
    student_id: int,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    if not db.query(Student).filter(Student.id == student_id).first():
        raise HTTPException(status_code=404, detail="Student not found")
    return [AspectOut(**a) for a in list_profile_aspects(student_id)]


@router.put("/api/students/{student_id}/profile/{slug}")
def update_aspect(
    student_id: int,
    slug: str,
    payload: AspectUpdate,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    write_profile_aspect(student_id, slug, payload.name or slug, payload.content)
    update_profile_index_from_aspects(student_id, student.name)
    return {"ok": True}


@router.delete("/api/students/{student_id}/profile/{slug}", status_code=204)
def delete_aspect(
    student_id: int,
    slug: str,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    if not delete_profile_aspect(student_id, slug):
        raise HTTPException(status_code=404, detail="Aspect not found")
    update_profile_index_from_aspects(student_id, student.name)


@router.post("/api/students/{student_id}/profile/update")
async def trigger_student_update(
    student_id: int,
    background_tasks: BackgroundTasks,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    async def _run():
        _db = SessionLocal()
        try:
            s = _db.query(Student).filter(Student.id == student_id).first()
            await update_student_profile(_db, s)
        finally:
            _db.close()

    background_tasks.add_task(_run)
    return {"ok": True, "message": f"Profile update for {student.name} started in background"}


@router.post("/api/profiles/update-all")
async def trigger_all_updates(
    background_tasks: BackgroundTasks,
    force: bool = False,
    _=Depends(get_current_teacher),
):
    async def _run():
        _db = SessionLocal()
        try:
            await update_all_profiles(_db, smart=not force)
        finally:
            _db.close()

    background_tasks.add_task(_run)
    return {"ok": True, "message": "Profile update for all students started in background"}


@router.get("/api/profiles/update-status")
def get_update_status(db: DBSession = Depends(get_db), _=Depends(get_current_teacher)):
    from models.student import Student as SM
    from services.profile_updater import student_needs_profile_update
    students = db.query(SM).all()
    needs = [s.id for s in students if student_needs_profile_update(db, s)]
    return {"total": len(students), "needs_update": len(needs)}
