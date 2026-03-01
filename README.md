# ChAgent

面向操作系统课程的 AI 教学助手，支持 Web 界面与飞书私聊双通道接入。基于苏格拉底对话法引导学生独立思考，并对每位学生建立持续演化的知识画像。

## 功能概览

### 学生端
- **多通道接入**：Web 浏览器直接访问，或通过飞书私聊对话
- **会话管理**：30 分钟无操作自动超时，支持手动开启新对话
- **文档上传**：在 Web 端上传 PDF / PPTX 教案，AI 结合文档内容作答（整个会话持续有效）
- **挑战模式**：AI 主动出题考查知识点，独立于普通对话会话

### 教师端（Dashboard）
- **学生管理**：查看所有学生列表、对话记录、知识画像
- **Skills 管理**：配置知识点提示、教学策略、全局指令等，动态注入系统提示词
- **用量控制**：为每位学生设置每日 Token 上限
- **数据统计**：总学生数、今日活跃数、消息量、热门讨论话题
- **LLM 切换**：在设置页面切换 Anthropic / OpenRouter，无需重启服务

### 自动化
- **会话后总结**：会话超时后自动调用 LLM 提取知识掌握度、常见错误、学习风格，合并进学生画像
- **画像注入**：每次对话时将学生画像追加到系统提示词，使 AI 自适应学生水平

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.11 · FastAPI · SQLAlchemy · SQLite |
| LLM | Anthropic Claude（默认）· OpenRouter（可选） |
| 认证 | JWT（python-jose）· bcrypt（passlib） |
| 飞书 | httpx 直接调用开放平台 API · pycryptodome AES 解密 |
| 前端 | React 18 · TypeScript · Ant Design · Vite |

## 目录结构

```
ChAgent/
├── backend/
│   ├── main.py               # FastAPI 入口
│   ├── config.py             # 配置（读取 .env）
│   ├── database.py           # SQLAlchemy 引擎与 init_db()
│   ├── models/               # ORM 模型
│   ├── routers/              # API 路由
│   │   ├── feishu.py         # 飞书 Webhook
│   │   ├── student_chat.py   # 学生 Web 聊天
│   │   ├── students.py       # 学生管理（教师）
│   │   ├── skills.py         # Skills CRUD
│   │   ├── settings.py       # LLM 配置
│   │   ├── conversations.py  # 对话查询
│   │   └── dashboard.py      # 统计数据
│   ├── services/
│   │   ├── agent.py          # 系统提示词构建 + LLM 调用
│   │   ├── llm.py            # Anthropic / OpenRouter 适配
│   │   ├── memory.py         # 会话后总结
│   │   ├── skills.py         # Skills 文件读写与注入
│   │   └── profile.py        # 学生画像文件读写
│   ├── skills/               # 每个 skill 一个子目录，含 SKILL.md
│   ├── profiles/             # 每个学生一个子目录，含各维度 .md
│   └── session_docs/         # 上传的 PDF/PPTX 文件
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── StudentChat.tsx   # 学生聊天页
│       │   ├── Dashboard.tsx     # 教师仪表盘
│       │   ├── Students.tsx      # 学生列表
│       │   ├── Skills.tsx        # Skills 管理
│       │   ├── Conversations.tsx # 对话记录
│       │   └── ModelSettings.tsx # LLM 设置
│       └── api/
│           └── index.ts          # 所有 API 调用
└── init_data.py              # 初始化数据库 + 创建默认教师账号
```

## 快速开始

### 1. 环境变量

复制 `.env.example` 为 `.env` 并填写：

```env
# LLM（至少填其中一个）
ANTHROPIC_API_KEY=sk-ant-...

# 飞书（不使用飞书可留空）
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...
FEISHU_VERIFICATION_TOKEN=...
FEISHU_ENCRYPT_KEY=...          # 若飞书开启消息加密则填写

# 安全
JWT_SECRET_KEY=your-secret-key  # 生产环境请修改

# 可选
DATABASE_URL=sqlite:///./chagent.db
SESSION_TIMEOUT_MINUTES=30      # 会话超时时间（分钟）
```

### 2. 启动后端

```bash
cd backend
pip install -r requirements.txt

# 初始化数据库并创建默认教师账号（admin / changeme123）
python ../tools/init_data.py

uvicorn main:app --reload --port 8000
```

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端开发服务器默认运行在 `http://localhost:5173`，API 请求代理至 `http://localhost:8000`。

### 4. 登录

- **教师端**：访问 `http://localhost:5173`，使用账号 `admin` / `changeme123` 登录
- **学生端**：访问 `http://localhost:5173/student`，输入姓名直接进入（首次自动注册）

## 飞书接入

1. 在[飞书开放平台](https://open.feishu.cn)创建应用，开启**机器人**能力
2. 订阅事件：`im.message.receive_v1`（接收消息）
3. 将 Webhook 地址设为：`https://your-domain/webhook/feishu`
4. 将应用的 App ID / App Secret / Verification Token / Encrypt Key 填入 `.env`

**学生绑定**：学生在飞书私聊机器人，发送「我是 张三」即可完成绑定并开始对话。

## Skills 系统

Skills 以文件形式存储在 `backend/skills/` 下，每个 skill 一个子目录：

```
skills/
└── virtual-memory/
    └── SKILL.md
```

`SKILL.md` 格式：

```markdown
---
name: 虚拟内存
type: knowledge_point      # knowledge_point | teaching_strategy | global | challenge
enabled: true
description: 页表、TLB、缺页中断
---

当学生提问虚拟内存相关内容时，请重点引导其理解地址翻译的完整过程...
```

| 类型 | 注入时机 |
|---|---|
| `global` | 每次对话都注入 |
| `teaching_strategy` | 每次对话都注入 |
| `knowledge_point` | 当对话内容命中关键词时注入 |
| `challenge` | 挑战模式时注入 |

Skills 可在教师 Dashboard 的「Skills」页面可视化管理。

## 学生画像

每次会话超时后，系统自动分析对话并生成结构化画像，存储于 `backend/profiles/<student_id>/`。教师也可在 Dashboard 手动编辑各维度内容。画像在每次对话时自动注入系统提示词，使 AI 适配学生当前水平。

## LLM 配置

在教师 Dashboard「模型设置」页面可切换：

- **Anthropic**：填写 API Key，选择模型（默认 `claude-sonnet-4-6`）
- **OpenRouter**：填写 OpenRouter API Key，可使用任意兼容模型

切换后立即生效，无需重启服务。
