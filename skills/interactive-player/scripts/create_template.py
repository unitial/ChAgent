#!/usr/bin/env python3
"""
从 case-arm-boot/player.html 中提取共享模板 player-template.html。
将硬编码的标题/封面/STEPS 替换为 PLAYER_CONFIG 的动态引用。

用法: python3 scripts/create_template.py
（从项目根目录的 skills/interactive-player/ 下运行）
"""
import sys
from pathlib import Path

# 自动定位 cases 目录
# 脚本位置: skills/interactive-player/scripts/create_template.py
# 项目根目录: skills/interactive-player/scripts -> 上三级
SKILL_DIR = Path(__file__).parent.parent
PROJECT_ROOT = SKILL_DIR.parent
CASES_DIR = PROJECT_ROOT / "backend" / "cases"
if not CASES_DIR.exists():
    print(f"❌ 找不到 cases 目录: {CASES_DIR}")
    sys.exit(1)

src_path = CASES_DIR / "case-arm-boot" / "player.html"
if not src_path.exists():
    print(f"❌ 找不到模板源文件: {src_path}")
    sys.exit(1)

src = src_path.read_text(encoding="utf-8")

# 1. 替换 <title>
src = src.replace(
    "<title>Case 19: 同一个内核，两块板子 — 交互式终端回放</title>",
    "<title>交互式终端回放</title>"
)

# 2. 替换 Splash 屏幕为动态模板
old_splash = '''  <!-- Splash Screen -->
  <div class="splash-overlay" id="splash">
    <div class="splash-card">
      <img src="hardware_setup.png" class="hardware-photo" alt="真实硬件连接图">
      <h1>Case 19: 同一个内核，两块板子</h1>
      <p>嵌入式内核排障全真模拟推演。<br>跟随资深工程师的视角，一步步揭发底层系统命案真相。</p>
      <button class="splash-start-btn" onclick="startPlayback()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
        开始观看
      </button>
    </div>
  </div>'''

new_splash = '''  <!-- Splash Screen (populated by PLAYER_CONFIG) -->
  <div class="splash-overlay" id="splash">
    <div class="splash-card">
      <div id="splashImageContainer"></div>
      <h1 id="splashTitle"></h1>
      <p id="splashSubtitle"></p>
      <button class="splash-start-btn" onclick="startPlayback()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
        开始观看
      </button>
    </div>
  </div>'''

src = src.replace(old_splash, new_splash)

# 3. 替换 Header 标题
src = src.replace(
    '<span class="header-title">Case 19: 同一个内核，两块板子</span>',
    '<span class="header-title" id="headerTitle"></span>'
)

# 4. 替换 STEPS 数组为 PLAYER_CONFIG 引用
steps_start = src.find("    const STEPS = [")
steps_end_marker = "    ];\n\n    class TerminalPlayer"
steps_end = src.find(steps_end_marker)
if steps_start == -1 or steps_end == -1:
    print("❌ 找不到 STEPS 数组边界")
    sys.exit(1)

src = (
    src[:steps_start]
    + "    const STEPS = (typeof PLAYER_CONFIG !== 'undefined') ? PLAYER_CONFIG.steps : [];\n"
    + src[steps_end + 6:]
)

# 5. 在 </script> 前插入初始化脚本
init_script = """

    // ── Initialize from PLAYER_CONFIG ──
    (function() {
      if (typeof PLAYER_CONFIG === 'undefined') {
        console.error('PLAYER_CONFIG not found. Make sure player-data.js is loaded.');
        return;
      }
      const cfg = PLAYER_CONFIG;
      document.title = cfg.title + ' — 交互式终端回放';
      document.getElementById('splashTitle').textContent = cfg.title;
      document.getElementById('splashSubtitle').innerHTML = cfg.subtitle;
      document.getElementById('headerTitle').textContent = cfg.title;
      if (cfg.splashImage) {
        const img = document.createElement('img');
        img.src = cfg.splashImage;
        img.className = 'hardware-photo';
        img.alt = cfg.title;
        document.getElementById('splashImageContainer').appendChild(img);
      }
    })();
"""
src = src.replace("\n  </script>", init_script + "\n  </script>")

out = CASES_DIR / "player-template.html"
out.write_text(src, encoding="utf-8")
print(f"✅ Created {out} ({len(src)} bytes)")
