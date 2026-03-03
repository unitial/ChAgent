import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession
from typing import Optional

from database import get_db
from services import skills as skills_service
from services.llm import llm_chat
from routers.auth import get_current_teacher

router = APIRouter(prefix="/api/skills", tags=["skills"])

AUTOFILL_SYSTEM = """You are a skill extractor for a university Operating Systems teaching assistant system.
Given raw input text (lecture notes, textbook passages, research papers, teaching materials, etc.), extract the information into a structured skill record.

Return ONLY a JSON object with exactly these fields:
- name: concise English skill name (e.g. "Virtual Memory and Indirection", "Process Scheduling Algorithms")
- type: one of "knowledge_point" | "teaching_strategy" | "global" | "challenge" — use "knowledge_point" for domain content, "teaching_strategy" for pedagogy, "global" for universal instructions
- description: 1-2 sentence Chinese description of what this skill covers
- content: the skill's teaching content in markdown format — distill key concepts, common pitfalls, and teaching hints (3-6 paragraphs). Write as instructions to the AI tutor, not as a lecture.
- source: author or source reference if detectable from the text, otherwise empty string

Output ONLY valid JSON, no preamble, no markdown code fences."""


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


class AutofillRequest(BaseModel):
    text: str


class AutofillOut(BaseModel):
    name: str = ""
    type: str = "knowledge_point"
    description: str = ""
    content: str = ""
    source: str = ""


@router.post("/autofill", response_model=AutofillOut)
def autofill_skill(
    payload: AutofillRequest,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    messages = [{"role": "user", "content": payload.text}]
    raw_text, _, _ = llm_chat(db, AUTOFILL_SYSTEM, messages)
    raw = raw_text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Model returned invalid JSON")
    return AutofillOut(
        name=data.get("name", ""),
        type=data.get("type", "knowledge_point"),
        description=data.get("description", ""),
        content=data.get("content", ""),
        source=data.get("source", ""),
    )
