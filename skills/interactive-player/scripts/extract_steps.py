#!/usr/bin/env python3
"""
从现有的 player.html 中提取 STEPS 数组，生成 player-data.js。
用于将旧架构（自包含 player.html）迁移到新架构（模板 + 数据分离）。

用法: python3 scripts/extract_steps.py <case-slug> [title] [subtitle] [splashImage]

示例:
  python3 scripts/extract_steps.py case-arm-boot \
    "Case 19: 同一个内核，两块板子" \
    "嵌入式内核排障全真模拟推演。<br>跟随资深工程师的视角，一步步揭发底层系统命案真相。" \
    "hardware_setup.png"
"""
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).parent.parent
PROJECT_ROOT = SKILL_DIR.parent
CASES_DIR = PROJECT_ROOT / "backend" / "cases"
if not CASES_DIR.exists():
    print(f"❌ 找不到 cases 目录: {CASES_DIR}")
    sys.exit(1)

if len(sys.argv) < 2:
    print("用法: python3 extract_steps.py <case-slug> [title] [subtitle] [splashImage]")
    sys.exit(1)

slug = sys.argv[1]
case_dir = CASES_DIR / slug
player_path = case_dir / "player.html"

if not player_path.exists():
    print(f"❌ 找不到 {player_path}")
    sys.exit(1)

src = player_path.read_text(encoding="utf-8")

# 提取 STEPS
start_marker = "    const STEPS = ["
end_marker = "    ];\n\n    class TerminalPlayer"
start = src.find(start_marker)
end = src.find(end_marker)

if start == -1 or end == -1:
    print("❌ 找不到 STEPS 数组")
    sys.exit(1)

steps_block = src[start + len("    const STEPS = "):end + 6]  # includes "];"

# 参数
title = sys.argv[2] if len(sys.argv) > 2 else slug
subtitle = sys.argv[3] if len(sys.argv) > 3 else ""
splash = sys.argv[4] if len(sys.argv) > 4 else "null"
splash_val = f'"{splash}"' if splash != "null" else "null"

data_js = f'''/**
 * player-data.js — {title}
 * 从 {slug}/player.html 提取
 */
const PLAYER_CONFIG = {{
  title: "{title}",
  subtitle: "{subtitle}",
  splashImage: {splash_val},

  steps: {steps_block}
}};
'''

out = case_dir / "player-data.js"
out.write_text(data_js, encoding="utf-8")
print(f"✅ Created {out} ({len(data_js)} bytes)")
