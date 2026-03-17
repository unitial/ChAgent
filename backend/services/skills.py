import re
import shutil
import uuid
import yaml
from pathlib import Path
from typing import Optional

SKILLS_DIR = Path(__file__).parent.parent / "skills"


def _is_ascii(s: str) -> bool:
    try:
        s.encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def _make_slug(name: str) -> str:
    if _is_ascii(name):
        slug = name.lower()
        slug = re.sub(r"[^a-z0-9]+", "-", slug)
        slug = slug.strip("-")
        return slug if slug else f"skill-{uuid.uuid4().hex[:8]}"
    return f"skill-{uuid.uuid4().hex[:8]}"


def _parse_skill_file(path: Path) -> Optional[dict]:
    """Parse a SKILL.md file into a dict with frontmatter fields + content body + slug."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    if not text.startswith("---"):
        return None

    end = text.find("\n---", 3)
    if end == -1:
        return None

    frontmatter_str = text[3:end].strip()
    body = text[end + 4:].strip()

    try:
        meta = yaml.safe_load(frontmatter_str)
    except Exception:
        return None

    if not isinstance(meta, dict):
        return None

    mtime = path.stat().st_mtime
    from datetime import datetime, timezone
    created_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

    return {
        "slug": path.parent.name,
        "name": meta.get("name", path.parent.name),
        "type": meta.get("type", "knowledge_point"),
        "enabled": bool(meta.get("enabled", True)),
        "description": meta.get("description", ""),
        "source": meta.get("source", ""),
        "content": body,
        "created_at": created_at,
    }


def _write_skill_file(slug: str, name: str, type_: str, enabled: bool, description: str, content: str, source: str = "") -> None:
    skill_dir = SKILLS_DIR / slug
    skill_dir.mkdir(parents=True, exist_ok=True)

    meta = {
        "name": name,
        "type": type_,
        "enabled": enabled,
        "description": description,
    }
    if source:
        meta["source"] = source
    frontmatter = yaml.dump(meta, allow_unicode=True, default_flow_style=False).strip()
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(f"---\n{frontmatter}\n---\n\n{content}\n", encoding="utf-8")


def list_skills() -> list[dict]:
    if not SKILLS_DIR.exists():
        return []
    skills = []
    for skill_md in sorted(SKILLS_DIR.glob("*/SKILL.md")):
        data = _parse_skill_file(skill_md)
        if data:
            skills.append(data)
    return skills


def get_skill(slug: str) -> Optional[dict]:
    path = SKILLS_DIR / slug / "SKILL.md"
    if not path.exists():
        return None
    return _parse_skill_file(path)


def create_skill(name: str, type_: str, content: str, enabled: bool = True, description: str = "", source: str = "") -> dict:
    slug = _make_slug(name)
    if (SKILLS_DIR / slug).exists():
        slug = f"{slug}-{uuid.uuid4().hex[:6]}"
    _write_skill_file(slug, name, type_, enabled, description, content, source)
    return get_skill(slug)


def update_skill(
    slug: str,
    name: Optional[str] = None,
    type_: Optional[str] = None,
    content: Optional[str] = None,
    enabled: Optional[bool] = None,
    description: Optional[str] = None,
    source: Optional[str] = None,
) -> Optional[dict]:
    existing = get_skill(slug)
    if existing is None:
        return None
    new_name = name if name is not None else existing["name"]
    new_type = type_ if type_ is not None else existing["type"]
    new_content = content if content is not None else existing["content"]
    new_enabled = enabled if enabled is not None else existing["enabled"]
    new_description = description if description is not None else existing["description"]
    new_source = source if source is not None else existing["source"]
    _write_skill_file(slug, new_name, new_type, new_enabled, new_description, new_content, new_source)
    return get_skill(slug)


def delete_skill(slug: str) -> bool:
    skill_dir = SKILLS_DIR / slug
    if not skill_dir.exists():
        return False
    shutil.rmtree(skill_dir)
    return True


def _extract_keywords(skill: dict) -> list[str]:
    """Extract matchable substrings from skill name and description."""
    text = skill["name"] + " " + skill["description"]
    # Split on common delimiters including Chinese connectors
    parts = re.split(r'[，,、；;/（()）\s与和或：:·]+', text)
    return [p.strip() for p in parts if len(p.strip()) >= 2]


def _skill_matches(skill: dict, conv_text: str) -> bool:
    """Return True if any keyword from the skill appears in the conversation text."""
    conv_lower = conv_text.lower()
    return any(kw.lower() in conv_lower for kw in _extract_keywords(skill))


def get_onboarding_skill_prompt() -> str:
    """Return the onboarding mode skill content to inject when in onboarding mode."""
    skills = [s for s in list_skills() if s["enabled"] and s["type"] == "onboarding"]
    if not skills:
        return ""
    return "\n## Onboarding Mode Instructions\n\n" + skills[0]["content"]


def get_challenge_skill_prompt() -> str:
    """Return the challenge mode skill content to inject when in challenge mode."""
    skills = [s for s in list_skills() if s["enabled"] and s["type"] == "challenge"]
    if not skills:
        return ""
    # Use the first enabled challenge skill (typically challenge-default)
    return "\n## Challenge Mode Instructions\n\n" + skills[0]["content"]


def get_enabled_skills_prompt(messages: list[dict] | None = None) -> str:
    """Build a skills block to inject into the system prompt.

    - global / teaching_strategy skills: always included.
    - knowledge_point skills: only included when their keywords appear in
      the recent conversation (messages). If messages is empty or None,
      no knowledge_point skills are injected (avoids cold-start noise).
    """
    all_skills = [s for s in list_skills() if s["enabled"] and s["type"] not in ("profile_update", "challenge", "onboarding")]

    always = [s for s in all_skills if s["type"] in ("global", "teaching_strategy")]

    kp_skills = [s for s in all_skills if s["type"] == "knowledge_point"]
    if messages and kp_skills:
        # Build a single lowercase string from recent messages for matching
        conv_text = " ".join(m.get("content", "") for m in messages[-8:])
        relevant_kp = [s for s in kp_skills if _skill_matches(s, conv_text)]
    else:
        relevant_kp = []

    selected = always + relevant_kp
    if not selected:
        return ""

    lines = ["\n## Teacher-Configured Skills\n"]
    for skill in selected:
        type_label = {
            "knowledge_point": "Knowledge Point",
            "teaching_strategy": "Teaching Strategy",
            "global": "Global Instruction",
        }.get(skill["type"], skill["type"])
        lines.append(f"### [{type_label}] {skill['name']}\n{skill['content']}\n")

    return "\n".join(lines)


def init_skills_dir() -> None:
    """Create skills directory and migrate existing DB skills to files."""
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)

    try:
        from database import SessionLocal
        from models.skill import Skill as SkillModel

        db = SessionLocal()
        try:
            db_skills = db.query(SkillModel).all()
            migrated = 0
            for s in db_skills:
                slug = _make_slug(s.name)
                if (SKILLS_DIR / slug).exists():
                    continue
                _write_skill_file(slug, s.name, s.type, s.enabled, "", s.content)
                migrated += 1
                print(f"[skills] Migrated: {s.name} → {slug}/SKILL.md")
            if migrated:
                print(f"[skills] Migration complete: {migrated} skills")
        finally:
            db.close()
    except Exception as e:
        print(f"[skills] DB migration skipped: {e}")
