from sqlalchemy.orm import Session as DBSession
from models.app_settings import AppSettings

DEFAULTS = {
    "model_provider": "anthropic",
    "model_name": "claude-sonnet-4-6",
    "openrouter_api_key": "",
    "default_daily_token_limit": "0",  # 0 = unlimited
}


def init_default_settings(db: DBSession) -> None:
    for key, value in DEFAULTS.items():
        if not db.query(AppSettings).filter(AppSettings.key == key).first():
            db.add(AppSettings(key=key, value=value))
    db.commit()


def get_setting(db: DBSession, key: str, default: str = "") -> str:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    return row.value if row else default


def set_setting(db: DBSession, key: str, value: str) -> None:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSettings(key=key, value=value))
    db.commit()


def get_model_config(db: DBSession) -> dict:
    return {
        "provider": get_setting(db, "model_provider", "anthropic"),
        "model": get_setting(db, "model_name", "claude-sonnet-4-6"),
        "openrouter_api_key": get_setting(db, "openrouter_api_key", ""),
        "default_daily_token_limit": int(get_setting(db, "default_daily_token_limit", "0")),
    }
