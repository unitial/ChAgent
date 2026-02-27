from collections import Counter
from datetime import date, datetime, timezone
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from database import get_db
from models.student import Student
from models.conversation import Conversation
from routers.auth import get_current_teacher

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

OS_KEYWORDS = [
    "进程", "线程", "调度", "内存", "虚拟内存", "页表", "段", "文件系统",
    "同步", "互斥", "死锁", "信号量", "管程", "IPC", "中断", "系统调用",
    "CPU", "cache", "缓存", "磁盘", "I/O", "驱动", "内核", "用户态",
    "process", "thread", "scheduler", "memory", "paging", "filesystem",
    "synchronization", "mutex", "deadlock", "semaphore", "interrupt", "syscall",
]


class DashboardStats(BaseModel):
    total_students: int
    active_today: int
    total_messages: int


class HotTopic(BaseModel):
    topic: str
    count: int


@router.get("/stats", response_model=DashboardStats)
def get_stats(db: DBSession = Depends(get_db), _=Depends(get_current_teacher)):
    total_students = db.query(Student).count()
    total_messages = db.query(Conversation).count()

    today_start = datetime.combine(date.today(), datetime.min.time()).replace(tzinfo=timezone.utc)
    active_today_ids = (
        db.query(Conversation.student_id)
        .filter(Conversation.created_at >= today_start)
        .distinct()
        .count()
    )

    return DashboardStats(
        total_students=total_students,
        active_today=active_today_ids,
        total_messages=total_messages,
    )


@router.get("/hot-topics", response_model=list[HotTopic])
def get_hot_topics(db: DBSession = Depends(get_db), _=Depends(get_current_teacher)):
    # Get recent user messages (last 500)
    convs = (
        db.query(Conversation.content)
        .filter(Conversation.role == "user")
        .order_by(Conversation.created_at.desc())
        .limit(500)
        .all()
    )

    counter: Counter = Counter()
    for (content,) in convs:
        content_lower = content.lower()
        for kw in OS_KEYWORDS:
            if kw.lower() in content_lower:
                counter[kw] += 1

    top = counter.most_common(20)
    return [HotTopic(topic=kw, count=cnt) for kw, cnt in top if cnt > 0]
