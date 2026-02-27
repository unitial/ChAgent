import yaml
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

PROFILES_DIR = Path(__file__).parent.parent / "profiles"


def _student_dir(student_id: int) -> Path:
    return PROFILES_DIR / str(student_id)


def _parse_md(path: Path) -> Optional[dict]:
    """Parse a markdown file with YAML frontmatter → {meta, body}."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    meta = yaml.safe_load(text[3:end].strip()) or {}
    body = text[end + 4:].strip()
    return {"meta": meta, "body": body}


# --- Profile index (PROFILE.md) ---

def get_profile_index(student_id: int) -> Optional[dict]:
    result = _parse_md(_student_dir(student_id) / "PROFILE.md")
    return result["meta"] if result else None


def _write_profile_index(student_id: int, student_name: str, aspects: list[dict]) -> None:
    d = _student_dir(student_id)
    d.mkdir(parents=True, exist_ok=True)
    meta = {
        "student_id": student_id,
        "student_name": student_name,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "aspects": aspects,
    }
    fm = yaml.dump(meta, allow_unicode=True, default_flow_style=False).strip()
    (d / "PROFILE.md").write_text(f"---\n{fm}\n---\n", encoding="utf-8")


def update_profile_index_from_aspects(student_id: int, student_name: str) -> None:
    """Rebuild PROFILE.md from existing aspect files."""
    aspects = [{"slug": a["slug"], "name": a["name"]} for a in list_profile_aspects(student_id)]
    _write_profile_index(student_id, student_name, aspects)


# --- Aspect files ---

def list_profile_aspects(student_id: int) -> list[dict]:
    d = _student_dir(student_id)
    if not d.exists():
        return []
    aspects = []
    for md_file in sorted(d.glob("*.md")):
        if md_file.name == "PROFILE.md":
            continue
        result = _parse_md(md_file)
        if result:
            aspects.append({
                "slug": md_file.stem,
                "name": result["meta"].get("name", md_file.stem),
                "updated_at": result["meta"].get("updated_at", ""),
                "content": result["body"],
            })
    return aspects


def get_profile_aspect(student_id: int, slug: str) -> Optional[dict]:
    result = _parse_md(_student_dir(student_id) / f"{slug}.md")
    if result is None:
        return None
    return {
        "slug": slug,
        "name": result["meta"].get("name", slug),
        "updated_at": result["meta"].get("updated_at", ""),
        "content": result["body"],
    }


def write_profile_aspect(student_id: int, slug: str, name: str, content: str) -> None:
    d = _student_dir(student_id)
    d.mkdir(parents=True, exist_ok=True)
    meta = {"name": name, "updated_at": datetime.now(timezone.utc).isoformat()}
    fm = yaml.dump(meta, allow_unicode=True, default_flow_style=False).strip()
    (d / f"{slug}.md").write_text(f"---\n{fm}\n---\n\n{content}\n", encoding="utf-8")


def delete_profile_aspect(student_id: int, slug: str) -> bool:
    path = _student_dir(student_id) / f"{slug}.md"
    if not path.exists():
        return False
    path.unlink()
    return True


# --- System prompt context ---

def get_profile_context_for_prompt(student_id: int) -> str:
    """Build a concise profile block to inject into the chat system prompt."""
    aspects = list_profile_aspects(student_id)
    if not aspects:
        return ""
    lines = ["\n## Student Knowledge Profile\n"]
    for aspect in aspects:
        lines.append(f"### {aspect['name']}\n{aspect['content']}\n")
    return "\n".join(lines)
