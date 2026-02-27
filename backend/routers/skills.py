from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from services import skills as skills_service
from routers.auth import get_current_teacher

router = APIRouter(prefix="/api/skills", tags=["skills"])


class SkillCreate(BaseModel):
    name: str
    type: str  # knowledge_point | teaching_strategy | global
    content: str
    enabled: bool = True
    description: str = ""
    source: str = ""


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    content: Optional[str] = None
    enabled: Optional[bool] = None
    description: Optional[str] = None
    source: Optional[str] = None


class SkillOut(BaseModel):
    id: str
    name: str
    type: str
    content: str
    enabled: bool
    description: str = ""
    source: str = ""
    created_at: Optional[str] = None


VALID_TYPES = {"knowledge_point", "teaching_strategy", "global", "profile_update", "challenge"}


def _to_out(data: dict) -> SkillOut:
    return SkillOut(
        id=data["slug"],
        name=data["name"],
        type=data["type"],
        content=data["content"],
        enabled=data["enabled"],
        description=data.get("description", ""),
        source=data.get("source", ""),
        created_at=data.get("created_at"),
    )


@router.get("", response_model=list[SkillOut])
def list_skills(_=Depends(get_current_teacher)):
    return [_to_out(s) for s in skills_service.list_skills()]


@router.post("", response_model=SkillOut, status_code=201)
def create_skill(payload: SkillCreate, _=Depends(get_current_teacher)):
    if payload.type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {VALID_TYPES}")
    result = skills_service.create_skill(
        name=payload.name,
        type_=payload.type,
        content=payload.content,
        enabled=payload.enabled,
        description=payload.description,
        source=payload.source,
    )
    return _to_out(result)


@router.put("/{skill_id}", response_model=SkillOut)
def update_skill(skill_id: str, payload: SkillUpdate, _=Depends(get_current_teacher)):
    if payload.type and payload.type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {VALID_TYPES}")
    result = skills_service.update_skill(
        slug=skill_id,
        name=payload.name,
        type_=payload.type,
        content=payload.content,
        enabled=payload.enabled,
        description=payload.description,
        source=payload.source,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return _to_out(result)


@router.delete("/{skill_id}", status_code=204)
def delete_skill(skill_id: str, _=Depends(get_current_teacher)):
    if not skills_service.delete_skill(skill_id):
        raise HTTPException(status_code=404, detail="Skill not found")
