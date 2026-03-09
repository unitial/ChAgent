from pathlib import Path
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from database import init_db, SessionLocal
from services.skills import init_skills_dir
from services.settings import init_default_settings
from config import get_settings
import routers.feishu as feishu_router
import routers.auth as auth_router
import routers.students as students_router
import routers.skills as skills_router
import routers.conversations as conversations_router
import routers.dashboard as dashboard_router
import routers.student_chat as student_chat_router
import routers.settings as settings_router
import routers.profiles as profiles_router
import routers.teacher_chat as teacher_chat_router
import routers.textbooks as textbooks_router
import routers.cases as cases_router

app = FastAPI(title="ChAgent", description="OS Course Teaching Bot Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

scheduler = AsyncIOScheduler()


async def _nightly_profile_update() -> None:
    from services.profile_updater import update_all_profiles
    db = SessionLocal()
    try:
        await update_all_profiles(db)
    finally:
        db.close()


@app.on_event("startup")
async def on_startup():
    import os
    settings = get_settings()
    if settings.hf_endpoint:
        os.environ["HF_ENDPOINT"] = settings.hf_endpoint

    init_db()
    init_skills_dir()
    db = SessionLocal()
    try:
        init_default_settings(db)
    finally:
        db.close()

    from services.retrieval import init_retrieval
    init_retrieval()

    # Nightly profile update at 23:30 Asia/Shanghai
    scheduler.add_job(
        _nightly_profile_update,
        "cron",
        hour=23,
        minute=30,
        timezone=ZoneInfo("Asia/Shanghai"),
    )
    scheduler.start()


@app.on_event("shutdown")
async def on_shutdown():
    scheduler.shutdown()


app.include_router(feishu_router.router)
app.include_router(auth_router.router)
app.include_router(students_router.router)
app.include_router(skills_router.router)
app.include_router(conversations_router.router)
app.include_router(dashboard_router.router)
app.include_router(student_chat_router.router)
app.include_router(settings_router.router)
app.include_router(profiles_router.router)
app.include_router(teacher_chat_router.router)
app.include_router(textbooks_router.router)
app.include_router(cases_router.router)


@app.get("/health")
def health():
    return {"status": "ok"}


# Serve case study assets (images, etc.)
_CASES_DIR = Path(__file__).parent / "cases"
if _CASES_DIR.exists():
    app.mount("/case-assets", StaticFiles(directory=_CASES_DIR), name="case-assets")

# Serve frontend SPA (must be last)
_FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=_FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        return FileResponse(_FRONTEND_DIST / "index.html")
