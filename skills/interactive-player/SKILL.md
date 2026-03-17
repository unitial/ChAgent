---
name: interactive-player
type: code_generation
enabled: true
description: |
  从 Markdown 案例文档生成交互式 HTML Player 的数据文件 (player-data.js)。
  输入：一个 backend/cases/case-{slug}/ 目录下的 .md 文件
  输出：同目录下的 player-data.js
  共享模板：backend/cases/player-template.html（所有 case 通用，无需修改）
---

# 交互式案例 Player 生成 SKILL

你的任务是将一个 Markdown 格式的操作系统案例文档，转换为一个 `player-data.js` 数据文件。

## 架构

播放器采用**模板 + 数据分离**的架构：

```
backend/cases/
├── player-template.html          ← 所有 case 共享的模板（CSS、JS、布局），不要修改
├── case-arm-boot/
│   ├── arm64_boot.md             ← 案例 Markdown 原文
│   ├── player-data.js            ← ★ 你要生成的文件
│   └── hardware_setup.png        ← 图片资源
├── case-vdso/
│   ├── vdso.md
│   ├── player-data.js            ← ★ 你要生成的文件
│   └── trading_desk.png
```

后端在 serve player 时，自动将 `player-template.html` + `player-data.js` 组合为完整页面。

## player-data.js 的格式

```javascript
/**
 * player-data.js — {案例标题}
 * 由 interactive-player SKILL 按照 {markdown 文件名} 生成
 */
const PLAYER_CONFIG = {
  title: "案例标题",
  subtitle: "一句话描述。<br>第二句话描述。",
  splashImage: "image.png",      // 封面图文件名，null 表示无图
  steps: [
    // STEPS 数组
  ]
};
```

## 生成步骤

### 第一步：阅读 Markdown 内容

完整阅读目标 `.md` 文件，理解：
1. 案例标题（第一行 `# Case: ...`）
2. 故事线的起承转合
3. 所有代码块（命令 vs 输出 vs 源代码）
4. 章节结构（`####` 或 `---` 分隔）
5. 目录中可用的图片

### 第二步：规划 STEPS 分割（8-12 个）

将 Markdown 内容映射为 8-12 个 STEPS。

**分割原则：**
- 每个 `####` 分隔的章节大致对应 1-2 个 STEP
- 有代码块 → 提取为 `terminal` 内容
- 纯叙事 → `terminal: null`
- 章节过长（含多个代码块）→ 拆分为多个 STEP
- `🧪 动手实践` 部分**不转为 STEP**（作为 AI 聊天的知识储备）

### 第三步：构造每个 STEP

#### STEP 数据结构

```javascript
{
  title: "🔍 简短标题（带 emoji，不带步骤编号）",
  terminal: {
    prompt: "$ ",            // 提示符。GDB: "(gdb) "。纯输出: ""
    command: "ls -la",       // 用户命令。多行用 \\n
    output: "line1\\nline2"  // 命令输出。★ 换行必须用 \\n
  },
  // 纯讲解步骤: terminal: null，同时用 infoPanel 填充左侧
  infoPanel: `<h3>📌 标题</h3><p>左侧信息面板内容（HTML）</p>`,  // 可选
  commentary: `<p>HTML 解说</p>`  // JS 模板字符串
}
```

#### terminal 规则
- `output` 中的换行**必须用 `\\n`**（字面反斜杠 n），不能用真换行
- `command` 也用 `\\n` 分隔多条命令
- 纯讲解步骤设 `terminal: null`
- ⚠️ **尽量避免 `terminal: null`**。如果没有命令行输出，可以用 `prompt: "", command: ""` + `output` 展示关键数据、对比表格、流程图或摘要信息（参考 `case-unified-memory` 的实现）
- 当确实设为 `terminal: null` 时，**必须同时提供 `infoPanel`**（HTML 字符串），在左侧面板展示关键信息摘要、知识点列表、对比表等有价值的内容，避免左侧空白只显示"阅读右侧思考过程"

#### infoPanel 规则（可选字段，仅在 terminal: null 时生效）
- 内容为 HTML 字符串，渲染在左侧面板中
- 适合放：关键术语清单、知识点要点、对比表、架构示意图（ASCII art）、步骤流程等
- 不要简单复制右侧 commentary 的内容，而是提供**补充或结构化信息**

#### title 规则
- ⚠️ **不要在 title 中包含「步骤 N」或任何编号**。模板会自动在标题上方显示「步骤 N / 总数」徽章，title 里再写编号会导致编号重复且不一致
- title 以 emoji 开头，后跟简短描述，例如：`"🔍 定位真凶：设备树不匹配"`
- ⚠️ **最后一个 STEP 的 title 不要统一叫「战后总结」**。根据案例类型选择合适的名称：
  - 排障/取证类案例 → `"💡 核心回顾"`
  - 技术说明/对比类案例 → `"💡 总结与启示"`
  - 也可以用其他合适的措辞，关键是**与案例的叙事基调匹配**

#### commentary HTML 可用 class

| 用法 | 代码 |
|------|------|
| 角色对话 | `<p class="dialogue"><span class="speaker">人名：</span>"台词"</p>` |
| 思考过渡 | `<p class="thinking">思考内容</p>` |
| 关键洞察 | `<p class="insight">💡 内容</p>` |
| 严重问题 | `<p class="warning">🔥 内容</p>` |
| 结论总结 | `<p class="conclusion">🎯 内容</p>` |
| 可点击术语 | `<span class="chat-link">关键词</span>` |
| 行内代码 | `<code>代码</code>` |
| 可折叠 | `<details><summary>标题</summary><div class="details-content">内容</div></details>` |
| 图片 | `<img src="文件名.png" class="hardware-photo" alt="描述">` |

### 第四步：写入 player-data.js

将 `PLAYER_CONFIG` 对象写入 `backend/cases/case-{slug}/player-data.js`。

### 第五步：自检

- [ ] STEPS 数量在 8-12 之间
- [ ] 每个 title 有 emoji 前缀
- [ ] title 中**没有**「步骤 N」编号（模板自动生成步骤徽章）
- [ ] 最后一步 title **不是**「战后总结」，而是与案例基调匹配的名称
- [ ] `terminal: null` 的步骤**都有** `infoPanel` 内容（尽量少用 `terminal: null`）
- [ ] `terminal.output` 换行是 `\\n`
- [ ] 关键术语用 `<span class="chat-link">` 包裹
- [ ] 模板字符串中无未转义的反引号
- [ ] `splashImage` 指向目录中实际存在的文件（或 `null`）

## 右侧 AI 聊天栏集成

player 右侧的 AI 聊天面板**自动结合案例 Markdown 原文**来回答学生问题：

1. **`CASE_SLUG` 自动注入**：后端 serve 时注入，player-data.js 不需要定义
2. **Markdown 自动加载**：后端自动读取同目录的 `.md` 文件作为 LLM 知识来源
3. **步骤上下文**：当前步骤的标题和解说会作为上下文发送给 LLM
4. **不重复**：系统提示要求 AI 不重复当前步骤已展示的内容，而是补充原理和延伸

**因此，commentary 中应尽量多用 `<span class="chat-link">关键术语</span>`**，学生点击后 AI 会结合 Markdown 原文深入解答。Markdown 中超出 STEPS 的内容（实验、思考题）会作为 AI 知识储备。

## 示例映射（case-arm-boot）

| Markdown 章节 | STEP title | terminal | commentary 特点 |
|---|---|---|---|
| 故事开场 + picocom | 📎 故事背景 | `picocom -b 115200` | dialogue + 叙述 |
| 新板上电 → 沉默 | ⚡ 新板上电 | U-Boot 日志 | warning |
| 插回旧板 | 🔄 交叉验证 | 旧板启动日志 | 对比 + conclusion |
| JTAG 接入 | 🔌 请出 JTAG | `openocd ...` | dialogue |
| GDB 查寄存器 | 🐛 GDB 查验 | `info reg` | thinking |
| dmesg 日志 | 📜 读内核日志 | `lx-dmesg` | warning |
| 反编译 DTB | 🔍 定位真凶 | `dtc` + `grep` | conclusion |
| 修复 DTS | ✍️ 补丁修复 | `diff` + `dtc` | 分步解说 |
| 成功启动 | 🚀 系统活了 | 新板日志 | conclusion |

## 工具脚本

SKILL 目录下的 `scripts/` 包含辅助脚本：

### `scripts/create_template.py` — 创建共享模板（一次性）

从 `case-arm-boot/player.html` 提取共享模板 `player-template.html`。仅在首次部署或模板需要更新时运行。

```bash
cd ~/cc/ChAgent/backend/skills/interactive-player
python3 scripts/create_template.py
# ✅ Created backend/cases/player-template.html
```

### `scripts/extract_steps.py` — 从旧 player.html 迁移

将现有自包含 `player.html` 中的 STEPS 提取为 `player-data.js`，用于迁移旧架构。

```bash
python3 scripts/extract_steps.py case-arm-boot \
  "Case 19: 同一个内核，两块板子" \
  "嵌入式内核排障全真模拟推演。<br>跟随资深工程师的视角，一步步揭发底层系统命案真相。" \
  "hardware_setup.png"
# ✅ Created case-arm-boot/player-data.js
```

## 注意事项

1. **不要修改 `player-template.html`**，只生成 `player-data.js`
2. **commentary 中使用 HTML**，不要用 Markdown 语法
3. **保持叙事节奏**：开头设悬念，中间逐步揭示，结尾给出结论
4. **`> 💡` / `> 📌` 引用块**：适合放入 `<p class="insight">` 或 `<details>`
