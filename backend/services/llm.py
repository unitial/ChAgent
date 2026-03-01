import anthropic
import httpx
from sqlalchemy.orm import Session as DBSession

from services.settings import get_model_config
from config import get_settings

_app_settings = get_settings()


def llm_chat(db: DBSession, system: str, messages: list[dict], document: dict | None = None) -> tuple[str, int, int]:
    """Call the configured LLM provider. Returns (text, input_tokens, output_tokens)."""
    config = get_model_config(db)
    provider = config["provider"]
    model = config["model"]

    if provider == "openrouter":
        return _openrouter_chat(config["openrouter_api_key"], model, system, messages, document)
    return _anthropic_chat(_app_settings.anthropic_api_key, model, system, messages, document)


def _anthropic_chat(api_key: str, model: str, system: str, messages: list[dict], document: dict | None = None) -> tuple[str, int, int]:
    client = anthropic.Anthropic(api_key=api_key)

    if document:
        # Inject document block into the last user message
        api_messages = []
        for i, msg in enumerate(messages):
            if i == len(messages) - 1 and msg["role"] == "user":
                api_messages.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": document["media_type"],
                                "data": document["data"],
                            },
                        },
                        {"type": "text", "text": msg["content"]},
                    ],
                })
            else:
                api_messages.append(msg)
    else:
        api_messages = messages

    response = client.messages.create(
        model=model,
        max_tokens=4096 if document else 2048,
        system=system,
        messages=api_messages,
    )
    return response.content[0].text, response.usage.input_tokens, response.usage.output_tokens


def _openrouter_chat(api_key: str, model: str, system: str, messages: list[dict], document: dict | None = None) -> tuple[str, int, int]:
    # OpenRouter uses OpenAI-compatible format; prepend extracted text for text/plain documents
    if document and document.get("media_type") == "text/plain":
        import base64
        doc_text = base64.b64decode(document["data"]).decode("utf-8")
        messages = list(messages)
        last = messages[-1]
        messages[-1] = {**last, "content": f"[文档内容]\n{doc_text}\n\n[问题]\n{last['content']}"}

    openai_messages = [{"role": "system", "content": system}] + messages
    resp = httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 4096 if document else 2048,
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
