#!/usr/bin/env python3
"""Initialize ChAgent: create DB tables and default teacher account."""
import sys
import os

# Add backend directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from database import init_db, SessionLocal
from models.teacher import Teacher
from routers.auth import hash_password


def create_default_teacher(username: str, password: str) -> None:
    db = SessionLocal()
    try:
        existing = db.query(Teacher).filter(Teacher.username == username).first()
        if existing:
            print(f"Teacher '{username}' already exists.")
            return
        teacher = Teacher(username=username, hashed_password=hash_password(password))
        db.add(teacher)
        db.commit()
        print(f"Created teacher account: {username}")
    finally:
        db.close()


if __name__ == "__main__":
    print("Initializing ChAgent database...")
    init_db()
    print("Database tables created.")

    username = os.environ.get("ADMIN_USERNAME", "admin")
    password = os.environ.get("ADMIN_PASSWORD", "changeme123")

    create_default_teacher(username, password)
    print(f"\nAdmin login: {username} / {password}")
    print("Remember to change the password in production!")
