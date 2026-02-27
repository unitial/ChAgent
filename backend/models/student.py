from sqlalchemy import Column, Integer, String, JSON, DateTime, BigInteger
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class Student(Base):
    __tablename__ = "students"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    feishu_user_id = Column(String, unique=True, index=True, nullable=True)
    profile_json = Column(
        JSON,
        default=lambda: {
            "topic_mastery": {},
            "common_mistakes": [],
            "learning_style": "",
            "recent_summary": "",
        },
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
    daily_token_limit = Column(Integer, nullable=True)  # None = use global default; 0 = unlimited

    sessions = relationship("Session", back_populates="student", cascade="all, delete-orphan")
    conversations = relationship("Conversation", back_populates="student", cascade="all, delete-orphan")
