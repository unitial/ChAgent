from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession
from typing import Optional

from database import get_db
from services.settings import get_model_config, set_setting
from routers.auth import get_current_teacher

router = APIRouter(prefix="/api/settings", tags=["settings"])

VALID_PROVIDERS = {"anthropic", "openrouter"}


class ModelSettingsUpdate(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    default_daily_token_limit: Optional[int] = None


class ModelSettingsOut(BaseModel):
    provider: str
    model: str
    openrouter_api_key_set: bool
    default_daily_token_limit: int


@router.get("/model", response_model=ModelSettingsOut)
def get_model_settings(db: DBSession = Depends(get_db), _=Depends(get_current_teacher)):
    config = get_model_config(db)
    return ModelSettingsOut(
        provider=config["provider"],
        model=config["model"],
        openrouter_api_key_set=bool(config["openrouter_api_key"]),
        default_daily_token_limit=config["default_daily_token_limit"],
    )


@router.put("/model")
def update_model_settings(
    payload: ModelSettingsUpdate,
    db: DBSession = Depends(get_db),
    _=Depends(get_current_teacher),
):
    if payload.provider is not None:
        if payload.provider not in VALID_PROVIDERS:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail=f"provider must be one of {VALID_PROVIDERS}")
        set_setting(db, "model_provider", payload.provider)
    if payload.model is not None:
        set_setting(db, "model_name", payload.model)
    if payload.openrouter_api_key is not None:
        set_setting(db, "openrouter_api_key", payload.openrouter_api_key)
    if payload.default_daily_token_limit is not None:
        set_setting(db, "default_daily_token_limit", str(payload.default_daily_token_limit))
    return {"ok": True}
