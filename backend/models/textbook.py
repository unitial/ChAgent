from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.sql import func
from database import Base


class Textbook(Base):
    __tablename__ = "textbooks"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    file_path = Column(Text, nullable=False)
    status = Column(String, default="pending")  # pending/indexing/ready/error
    chunk_count = Column(Integer, default=0)
    error_msg = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
