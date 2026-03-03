from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
import bcrypt
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from database import get_db
from models.teacher import Teacher
from config import get_settings

settings = get_settings()
router = APIRouter(prefix="/api/auth", tags=["auth"])

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


class Token(BaseModel):
    access_token: str
    token_type: str


class TeacherOut(BaseModel):
    id: int
    username: str

    class Config:
        from_attributes = True


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def get_current_teacher(token: str = Depends(oauth2_scheme), db: DBSession = Depends(get_db)) -> Teacher:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    teacher = db.query(Teacher).filter(Teacher.username == username).first()
    if teacher is None:
        raise credentials_exception
    return teacher


@router.post("/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: DBSession = Depends(get_db)):
    teacher = db.query(Teacher).filter(Teacher.username == form_data.username).first()
    if not teacher or not verify_password(form_data.password, teacher.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect username or password")
    token = create_access_token({"sub": teacher.username})
    return {"access_token": token, "token_type": "bearer"}


@router.get("/me", response_model=TeacherOut)
def get_me(current_teacher: Teacher = Depends(get_current_teacher)):
    return current_teacher


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(
    payload: ChangePasswordRequest,
    current_teacher: Teacher = Depends(get_current_teacher),
    db: DBSession = Depends(get_db),
):
    if not verify_password(payload.current_password, current_teacher.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="当前密码不正确")
    if len(payload.new_password) < 6:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="新密码至少需要 6 位")
    current_teacher.hashed_password = hash_password(payload.new_password)
    db.commit()
    return {"ok": True}
