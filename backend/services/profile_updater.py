import asyncio
import json
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session as DBSession

from models.student import Student
from models.conversation import Conversation
from services.profile import (
    write_profile_aspect,
    update_profile_index_from_aspects,
    list_profile_aspects,
)
from services.skills import get_skill
from services.llm import llm_chat

PROFILE_UPDATE_SKILL_SLUG = "profile-update"

FALLBACK_SYSTEM_PROMPT = """你是一位专业的教育数据分析师，负责根据学生与AI助教的聊天记录，更新该学生在操作系统课程中的知识画像。

请从以下维度分析学生表现（只分析有实际聊天内容支撑的方面，不要臆造）：
- 进程管理 (process-management)
- 内存管理 (memory-management)
- 文件系统 (filesystem)
- I/O系统 (io-system)
- 理解能力 (comprehension)
- 动手能力 (hands-on)

仅输出以下 JSON，不要添加任何说明文字或 markdown 代码块：
{"aspects": [{"slug": "process-management", "name": "进程管理", "content": "..."}]}

每个方面的 content 限制在 200 字以内，客观描述，给出具体学习建议。"""


def _get_update_prompt() -> str:
    skill = get_skill(PROFILE_UPDATE_SKILL_SLUG)
    if skill and skill["enabled"]:
        return skill["content"]
    return FALLBACK_SYSTEM_PROMPT


def _get_recent_convs(db: DBSession, student_id: int, days: int = 7) -> list[dict]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    convs = (
        db.query(Conversation)
        .filter(Conversation.student_id == student_id, Conversation.created_at >= since)
        .order_by(Conversation.created_at)
        .all()
    )
    return [{"role": c.role, "content": c.content} for c in convs]


async def update_student_profile(db: DBSession, student: Student) -> bool:
    """Update a student's file-based profile via LLM analysis of recent conversations."""
    convs = _get_recent_convs(db, student.id)
    if not convs:
        print(f"[profile] No recent conversations for {student.name}, skipping.")
        return False

    conv_text = "\n".join(f"{c['role'].upper()}: {c['content']}" for c in convs)

    current_aspects = list_profile_aspects(student.id)
    current_profile_text = ""
    if current_aspects:
        current_profile_text = "\n\n## 当前已有画像\n"
        for a in current_aspects:
            current_profile_text += f"\n### {a['name']}\n{a['content']}\n"

    system_prompt = _get_update_prompt()
    user_message = (
        f"## 学生：{student.name}\n\n"
        f"## 最近聊天记录（最近7天）\n\n{conv_text}"
        f"{current_profile_text}\n\n"
        "请根据以上聊天记录更新该学生的知识画像，输出 JSON 格式。"
    )

    try:
        response_text, _, _ = await asyncio.to_thread(
            llm_chat, db, system_prompt, [{"role": "user", "content": user_message}]
        )
    except Exception as e:
        print(f"[profile] LLM call failed for {student.name}: {e}")
        return False

    # Extract JSON from response (handles both bare JSON and markdown code blocks)
    try:
        json_match = re.search(r'\{[\s\S]*\}', response_text)
        if json_match:
            data = json.loads(json_match.group())
        else:
            data = json.loads(response_text)
    except json.JSONDecodeError as e:
        print(f"[profile] JSON parse failed for {student.name}: {e}\nResponse: {response_text[:300]}")
        return False

    aspects = data.get("aspects", [])
    if not aspects:
        print(f"[profile] No aspects returned for {student.name}")
        return False

    updated = 0
    for aspect in aspects:
        slug = str(aspect.get("slug", "")).strip()
        name = aspect.get("name", slug)
        content = aspect.get("content", "")
        if slug and content:
            write_profile_aspect(student.id, slug, name, content)
            updated += 1

    update_profile_index_from_aspects(student.id, student.name)
    print(f"[profile] Updated {updated} aspects for {student.name}")
    return True


async def update_all_profiles(db: DBSession) -> dict:
    from models.student import Student as StudentModel

    students = db.query(StudentModel).all()
    results = {"success": 0, "skipped": 0, "failed": 0}
    for student in students:
        try:
            ok = await update_student_profile(db, student)
            results["success" if ok else "skipped"] += 1
        except Exception as e:
            print(f"[profile] Failed for {student.name}: {e}")
            results["failed"] += 1

    print(f"[profile] Batch update complete: {results}")
    return results
