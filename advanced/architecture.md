# Tidal — 架构地图

> 单用户、自托管的私密 1:1 AI 伴侣：聊天通道 + 长期记忆星图。  
> 本文是**地图**（谁连谁、双库、SSE），不扛「发一条消息内部怎么拼装」——那份进阶文见 [`message-lifecycle.md`](message-lifecycle.md)，缓存见 [`caching.md`](caching.md)。  
> 原则见 [`../maintain/principles.md`](../maintain/principles.md)；本机 / 云操作见 [`../ops/`](../ops/)。

---

## 1. 概述

你在浏览器（或 PWA）发消息 → 自建 **chat_relay** 落库并经 SSE 交给 **ai_brain** → 模型回复再推回界面。对话由 **memory_service** 提取、整理、检索；下次聊天可按策略注入。可选旁路（积温、天气、搜索等）失败或关闭时，**主聊仍可用**。

**开源范围四服务 + Chroma**：`chat_relay` · `ai_brain` · `memory_service` · `web`。

---

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | 原生 HTML/CSS/JS（PWA） | `web/`，无强制构建；Service Worker 缓存 |
| 中继 | Python 3.10+ / FastAPI | 消息、SSE、SQLite、上传、设置 |
| AI 大脑 | Python | SSE 客户端：组上下文 → LLM → 回帖；工具与记忆注入 |
| 记忆 | Node.js（Memory Constellations 二开） | Scribe / Archivist / Librarian |
| 向量 | ChromaDB | 语义检索 |
| 关系数据 | SQLite（WAL） | 聊天库与记忆库分离 |

---

## 3. 系统结构

```
┌─────────────────────────────────────────────┐
│              浏览器 / PWA                    │
│         web/（由 relay 同源提供）             │
└──────────────────┬──────────────────────────┘
                   │ HTTP + Bearer
                   ▼
┌─────────────────────────────────────────────┐
│         chat_relay  :3011                   │
│  /app/send · /app/stream · /app/history · … │
│  /channel/in · /channel/out（大脑）          │
│  SQLite: tidal.db · uploads/                │
└───────┬─────────────────────┬───────────────┘
        │ SSE / HTTP          │ HTTP
        ▼                     ▼
┌───────────────┐    ┌────────────────────────┐
│  ai_brain     │    │  memory_service :3013  │
│  （无端口）    │    │  Scribe → Archivist     │
│  模型路由     │───▶│  Librarian 检索         │
│  记忆注入     │    │  sanctuary.db + Chroma  │
└───────────────┘    │  Chroma :7707          │
                     └────────────────────────┘
```

### 进程与端口

| # | 进程 | 端口 | 说明 |
|---|---|---|---|
| 1 | ChromaDB | **7707** | 向量库 |
| 2 | chat_relay | **3011** | 唯一对外 HTTP 入口（含静态页） |
| 3 | memory_service | **3013** | 记忆流水线 |
| 4 | ai_brain | — | 连 relay 的 SSE 客户端 |

### 双库

| 库 | 典型路径 | 内容 |
|---|---|---|
| 聊天 | `chat_relay/data/tidal.db` | messages、settings、用量事件等 |
| 记忆 | `memory_service/data/sanctuary.db` | 碎片、实体、叙事、积温状态等 |
| 向量 | 本机常在 `memory_service/chroma_data/`；Docker 常见根目录 `chroma_data/` | 嵌入索引 |

两库不混写；记忆服务经 relay API 同步部分设置（如模型相关字段）。

### 当前状态（current_state）

短时、带时效的「正在发生」观察（考试周、搬家中等），不是长期碎片。聊天工具可写入；注入系统提示时带 `#id` 便于结束。星图上的「当前状态」与五类长期实体星座分开。

### 消息主路径（人话）

```
PWA 发消息 → POST /app/send → 落库 → SSE 给大脑
  → 取记忆/状态（按当前策略）→ 调聊天模型（可走工具）
  → POST /channel/out → 落库 → SSE 回 PWA
```

拼装细节（稳定块 / 动态块、Gemini vs OpenAI 差异、成星与再注入）见 **message-lifecycle**。

### 用量账本（usage_events）

一次 LLM HTTP 调用记一行（含工具链中间步）。与 `messages` 分离：删会话或重试不会抹掉已产生的调用记录。页面可用单价表把 token 估成金额。

- Gemini：记录输入 / 输出 / 思考 / 缓存。
- DeepSeek：记录输入 / 输出 / 缓存命中；思考已含在输出里，不单列。
- 其它 OpenAI 兼容商：返回标准 `usage` 才记，否则只记调用次数。

聊天与记忆 / 积温是**不同账单来源**。

---

## 4. 模型分组

聊天大脑与记忆流水线**配置分离**：换聊天模型不丢星图数据。

| 分组 | 用途 |
|---|---|
| 聊天大脑 | 生成回复（Gemini 原生 **或** OpenAI 兼容，设置页单选） |
| 记忆提取 / 整理 | Scribe、Archivist（可另选便宜模型） |
| 可选旁路 | 积温、航海日志、事件线等各自独立槽位 |

槽位表见 [`../ops/usage-apis.md`](../ops/usage-apis.md)。**联网搜索仅 Gemini grounding。**

---

## 5. 密钥与设置

- **当前**：设置页保存聊天 / 记忆等 Key（脱敏展示）；进程级默认在各目录 `.env`。密钥不进 git。
- **连接密钥** `RELAY_SECRET`：前端、relay、brain（及 memory 侧调用）一致；改密后重启进程。
- 多套 Key 加密轮换、自动欠费切换等属后续能力，勿假定已实现。

---

## 6. 记忆生命周期（参数级）

继承 Memory Constellations；多数阈值可在设置页调节（默认值以运行中设置为准）：

| 参数 | 典型默认 | 含义 |
|---|---|---|
| 静默触发提取 | ~20 分钟 | 停聊多久后提取 |
| 积压触发 | 数十～上百条 | 未处理消息过多则提取 |
| 深度整理 | 闲置约 1 小时量级 | Archivist 深度循环 |
| 碎片冷却 / 冻结 / 清除 | 约 14 / 30 / 90 天 | 长期衰减 |
| 剧集成熟 / 归档 | 约 6 / 12 月 | 叙事层 |

另有短期层：**航海日志**、**今日事件线**（与长期星座分开；可关；有独立 API 槽）。逻辑日与分卷规则以代码与进阶文档为准。

---

## 7. 前端与扩展

| 区域 | 状态 |
|---|---|
| 聊天 | 核心 |
| 记忆星图 | 核心（经 relay 同源代理） |
| 感知 / 用量等页 | 已有入口 |
| 设置 | 模型、记忆、旁路、推送相关 |
| 更多插槽 | 预留，默认隐藏 |

外观：壁纸（开源内置珍珠 / 海港 + 本地「我的」）、浮尘、字号等存在浏览器本地；与设置页大脑配置分开。见 [`../guide/wallpaper.md`](../guide/wallpaper.md)。

后端预留 `/app/plugins/...`；大脑工具为注册表扩展。可选能力（推送、积温、搜索等）一律**可关、可降级**。

---

## 8. 配置落点

```
chat_relay/.env     — 中继、VAPID 等
ai_brain/.env       — 大脑启动默认、代理等
memory_service/.env — 记忆管线、加密钥、天气查询等
tidal.db settings   — 设置页可改项（热更新）
```

清单：[`../ops/configuration.md`](../ops/configuration.md)。操作：[`../ops/env-and-versions.md`](../ops/env-and-versions.md)。

---

## 9. 安全要点

- 单用户模型：一把 `RELAY_SECRET` 代表「只有你和你的 AI」。
- `.env`、数据库、uploads 实文件、私钥不进版本库。
- 生产使用 HTTPS（PWA / Web Push 需要）。
- 未配置 VAPID 时推送降级，聊天不受影响。

---

## 10. 目录（公开树）

```
Tidal-public/
  README.md · LICENSE · NOTICE
  guide/ · ops/ · advanced/ · prompts/ · test/ · maintain/
  chat_relay/ · ai_brain/ · memory_service/ · web/
  Dockerfile · docker-compose.yml · compose.env.example · deploy/Caddyfile
  start.bat · stop.bat · check_env.bat
```

系统边界或端口变了再改本文。对外介绍以根目录 `README.md` 为准。
