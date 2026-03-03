from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from config import get_settings

settings = get_settings()

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if "sqlite" in settings.database_url else {},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate_sqlite() -> None:
    """Add new columns to existing SQLite DB without Alembic."""
    if "sqlite" not in settings.database_url:
        return
    import sqlite3

    db_path = settings.database_url.split("sqlite:///")[-1].lstrip("./")
    if settings.database_url.startswith("sqlite:///./"):
        db_path = settings.database_url[len("sqlite:///./"):]
    elif settings.database_url.startswith("sqlite:///"):
        db_path = settings.database_url[len("sqlite:///"):]

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    def add_col(table: str, col: str, dtype: str) -> None:
        cur.execute(f"PRAGMA table_info({table})")
        existing = {row[1] for row in cur.fetchall()}
        if col not in existing:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN {col} {dtype}")
            print(f"[db] ALTER TABLE {table} ADD COLUMN {col}")

    try:
        add_col("conversations", "input_tokens", "INTEGER NOT NULL DEFAULT 0")
        add_col("conversations", "output_tokens", "INTEGER NOT NULL DEFAULT 0")
        add_col("conversations", "system_prompt", "TEXT")
        add_col("students", "daily_token_limit", "INTEGER")
        add_col("students", "profile_updated_at", "DATETIME")
        add_col("students", "hashed_password", "TEXT")
        add_col("sessions", "mode", "VARCHAR(32)")
        add_col("sessions", "doc_path", "TEXT")
        add_col("sessions", "doc_media_type", "VARCHAR(64)")
        conn.commit()
    finally:
        conn.close()


def init_db():
    from models import teacher, student, conversation, skill, app_settings, textbook  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _migrate_sqlite()
