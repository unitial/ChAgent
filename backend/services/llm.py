import anthropic
import httpx
from sqlalchemy.orm import Session as DBSession

from services.settings import get_model_config
from config import get_settings

_app_settings = get_settings()


def llm_chat(db: DBSession, system: str, messages: list[dict]) -> tuple[str, int, int]:
    """Call the configured LLM provider. Returns (text, input_tokens, output_tokens)."""
    config = get_model_config(db)
    provider = config["provider"]
    model = config["model"]

    if provider == "openrouter":
        return _openrouter_chat(config["openrouter_api_key"], model, system, messages)
    return _anthropic_chat(_app_settings.anthropic_api_key, model, system, messages)


def _anthropic_chat(api_key: str, model: str, system: str, messages: list[dict]) -> tuple[str, int, int]:
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=2048,
        system=system,
        messages=messages,
    )
    return response.content[0].text, response.usage.input_tokens, response.usage.output_tokens


def _openrouter_chat(api_key: str, model: str, system: str, messages: list[dict]) -> tuple[str, int, int]:
    openai_messages = [{"role": "system", "content": system}] + messages
    resp = httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 2048,
            "messages": openai_messages,
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)
    return text, input_tokens, output_tokens
