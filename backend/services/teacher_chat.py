from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session as DBSession
from sqlalchemy import func

from models.student import Student
from models.conversation import Conversation
from services.llm import llm_chat

TEACHER_SYSTEM_PROMPT = """你是 ChAgent 教师分析助手，帮助教师了解学生学习情况、分析学习趋势、发现需要重点关注的学生。

你可以访问所有学生的提问记录、活跃度统计和知识画像数据。回答要求：
- 直接基于下方数据作答，无数据时如实说明
- 回答简洁有条理，优先用列表或表格
- 涉及具体学生时，结合其知识画像给出有针对性的分析
"""


def build_student_context(db: DBSession) -> str:
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)

    students = db.query(Student).order_by(Student.name).all()
    lines = [
        f"## 学生数据（共 {len(students)} 人，数据时间：{now.strftime('%Y-%m-%d %H:%M UTC')}）\n"
    ]

    for s in students:
        total_msgs = (
            db.query(func.count(Conversation.id))
            .filter(Conversation.student_id == s.id, Conversation.role == "user")
            .scalar() or 0
        )
        recent_msgs = (
            db.query(func.count(Conversation.id))
            .filter(
                Conversation.student_id == s.id,
                Conversation.role == "user",
                Conversation.created_at >= week_ago,
            )
            .scalar() or 0
        )
        last_conv = (
            db.query(Conversation.created_at)
            .filter(Conversation.student_id == s.id)
            .order_by(Conversation.created_at.desc())
            .first()
        )
        last_active = last_conv[0].strftime("%Y-%m-%d") if last_conv else "从未"
        source = "飞书" if s.feishu_user_id else "网页"

        lines.append(f"### {s.name}（{source}）")
        lines.append(
            f"提问：累计 {total_msgs} 条 / 近7天 {recent_msgs} 条 / 最后活跃 {last_active}"
        )

        # File-based profile aspects
        profile_lines = []
        try:
            from services.profile import list_profile_aspects
            for asp in list_profile_aspects(s.id):
                snippet = asp["content"][:100] + ("…" if len(asp["content"]) > 100 else "")
                profile_lines.append(f"  [{asp['name']}] {snippet}")
        except Exception:
            pass

        # Fallback to legacy profile_json
        if not profile_lines:
            pj = s.profile_json or {}
            summary = pj.get("recent_summary", "")
            if summary:
                profile_lines.append(f"  [近期摘要] {summary[:150]}")

        if profile_lines:
            lines.append("知识画像：")
            lines.extend(profile_lines)

        lines.append("")

    return "\n".join(lines)


def teacher_chat(db: DBSession, message: str, history: list[dict]) -> str:
    student_context = build_student_context(db)
    system = TEACHER_SYSTEM_PROMPT + "\n" + student_context
    messages = history[-20:] + [{"role": "user", "content": message}]
    text, _, _ = llm_chat(db, system, messages)
    return text
