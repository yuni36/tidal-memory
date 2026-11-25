# 消息生命周期（拼装级）

> 进阶必读。地图见 [`architecture.md`](architecture.md)；提示词槽位见 [`../prompts/`](../prompts/)；缓存与流式见 [`caching.md`](caching.md)；原则见 [`../maintain/principles.md`](../maintain/principles.md)。  
> 本文对齐当前代码：`chat_relay/app.py` · `ai_brain/bridge.py` · `ai_brain/context_builder.py` · `ai_brain/snapshot_state.py` · `ai_brain/model_router.py` · `memory_service/services/scribe.js` · `archivist.js` · `librarian.js`。

聊天模型账单 ≠ 记忆整理账单。Scribe / Archivist / summary 走 memory 分组 API；主聊走 chat 路由。

---

## 1. 总览

```
PWA 打字
  │
  ▼
POST /app/send  (chat_relay)  →  tidal.db 落库  →  SSE /channel/in → ai_brain
  │
  ▼
bridge.handle_human_message
  ① 并行：相关记忆? / 当前状态 / 天气（可选）
  ② 摄入 memory：POST memory_service /messages/ingest（旁路；失败不挡聊）
  ③ Snapshot A/B + 拼装 system + 当轮 user
  ④ call_llm（Gemini 或 OpenAI 兼容）± 工具轮
  ⑤ POST /channel/out → relay 落库 → SSE /app/stream → PWA
  │
  ▼（异步，不挡下一句）
Scribe 抽碎片 → Chroma 索引 → Archivist 归星
  │
  ▼（之后某轮）
Librarian 混合检索 →（可选）注入 [相关记忆] / 工具 recall_memory
```

---

## 2. 前端 → relay

| 步骤 | 位置 | 做什么 |
|------|------|--------|
| 发消息 | `web/` → `POST /app/send` | Bearer 鉴权；写入 `chat_relay` 的 `messages` |
| 推大脑 | relay 内部 | 已落库消息经 `GET /channel/in` SSE 推给 `bridge.py` |
| 回前端 | `POST /channel/out` → `GET /app/stream` | AI 回复再落 `tidal.db`，SSE 推气泡 |

附件：`POST /app/upload` 后路径挂在消息 `attachments`；识图能力取决于当前聊天路由（见 bridge `_build_user_turn`）。

---

## 3. bridge 一轮：`handle_human_message`

入口：`ai_brain/bridge.py` → `handle_human_message`。

### 3.1 热加载与旁路拉取

1. `apply_hot_settings`：从 relay 读 `persona` / `output_style` / 功能旗标 / 模型路由等。
2. 并行（失败返回空，不挡回复）：
   - **相关记忆**：仅当 `INJECT_RELATED_MEMORY=1`（默认关）且非系统轮 → `memory_injector.inject_memories` → `GET {MEMORY_URL}/librarian/search`
   - **当前状态**：`inject_current_state` → `GET /intuition/context`（Gemini 时 `sticky_entities=false`）
   - **天气**：`inject_weather`（功能关则空）
3. 积温 observe：若开分析，后台 `affect_observe`；**本轮语调只用库内已有 style**（滞后一拍）。
4. **摄入**：普通用户正文 → `ingest_to_memory` → `POST /messages/ingest`。regen / 自醒 / 积温惦记不进 Scribe 队列。

### 3.2 Snapshot：A 区稳定 · B 区动态

状态文件：`ai_brain/snapshot_state.py`（`.bridge_state/session_snapshots.json`）。

| 区 | 含义 | 典型内容 |
|----|------|----------|
| **A** | 已固化、尽量稳定，进 **system**（Gemini generate 还可进 CachedContent） | `voyage`（可空）、`daily_events`、`schedule`、`hot3`（锚定对话原文） |
| **B** | `id > snapshot_cutoff_id` 的近期对话 + **本轮尚未确认的 user** | 纯历史 + `wrap_current_user(...)` |

固化触发（「滞后一拍」）：新消息到来时若 `should_consolidate` 或 Gemini Cache 过期/缺失 → `_rebuild_a_and_cache`。  
当前 user **永不**在固化前写入 A，避免回退/重生成出现「Cache 有、库已删」幽灵。

默认轮次（可用环境变量覆盖）：

- `SNAPSHOT_CONSOLIDATE_ROUNDS` 默认 5  
- `SNAPSHOT_A_WINDOW_ROUNDS` 默认 10  
- `SNAPSHOT_FRESH_MAX_ROUNDS` 默认 10（尚未固化时 B 区上限）

`_apply_snapshot_to_context` 把 A 写入 `context_builder` 全局槽：`set_summary_log` / `set_activity_log` / `set_schedule_log` / `set_hot_window_log`。

### 3.3 拼装顺序（OpenAI messages 形态）

`build_messages` + 已 append 的当轮 user：

```
messages[0]  role=system   ← 稳定块（见 §4）
messages[1…] role=user/assistant  ← B 区历史（历史 user 可带 [输入时间 MM-DD HH:mm]）
messages[-1] role=user     ← wrap_current_user：动态块 + ----- + 正文
```

历史条数：relay 拉取后按 Snapshot cutoff 切；未固化则 `take_last_n_rounds`。设置页 `history_n_min/max` 另有滑窗逻辑（`slice_history_window`）。

---

## 4. system 稳定块（拼装层级）

实现：`context_builder.build_messages`；Gemini 显式 Cache 用 `_build_cache_system_text`（无 Hot3 正文时 Hot3 走 cache contents，见 `_publish_explicit_cache`）。

顺序（空段跳过）：

| # | 块 | 来源 |
|---|----|------|
| 1 | 人设 `PERSONA` | relay `settings.persona` → `set_persona`；空则内置默认 |
| 2 | 输出风格 `OUTPUT_STYLE` | `settings.output_style` → `set_output_style` |
| 3 | 【情绪优先】`AFFECT_PRIORITY` | 仅 `affect_tone_enabled` 开 |
| 4 | `[工具使用说明]` | memory `GET /tools/definitions` → `instructionText` |
| 5 | `[工具纪律]` | 代码常量 `TOOL_DISCIPLINE` |
| 6 | `[状态时态]` | 代码常量 `STATE_TENSE` |
| 7 | `[记忆使用规则]` | definitions 的 `barrierPrompt` + 短风格 hint |
| 8 | `[近期对话摘要]` | Snapshot `voyage`（当前重建路径常传空；ix-reset 路径可写入） |
| 9 | `[今日事件]` + 用法 | Snapshot / `/summary/activity` |
| 10 | `[日程]` + 用法 | Snapshot 当天固化稿，或冷启动 `inject_schedule` |
| 11 | `[锚定对话]` | Snapshot `hot3` 格式化文本 |

**不进 system 的动态项**：`[输入时间]`、`[天气]`、`[当前情绪]`、`[当前状态]`、`[相关记忆]`、自醒/积温块——一律进当轮 user 前缀（`build_dynamic_prefix`）。

---

## 5. 当轮 user 动态块

`wrap_current_user` / `wrap_gemini_current_user`（二者同逻辑）：

```
[输入时间]
输入于{北京 年月日星期 HH:MM}。

[天气]          ← 可选
[当前情绪]      ← 语调开且本轮有 style
[当前状态]      ← intuition
[相关记忆]      ← 仅 INJECT_RELATED_MEMORY=1
[自醒] / [积温·惦记]  ← 系统轮

-----
{用户正文或多模态 parts}
```

---

## 6. Gemini vs OpenAI（同拼装，不同投递）

上游 messages 都先建成 OpenAI 形态；分叉在 `model_router.call_llm`。

### 6.1 OpenAI 兼容（DeepSeek / GPT / 任意兼容）

- 请求：`messages` 原样（system + history + user）。
- 工具：OpenAI `tools` / `tool_calls`；多轮结果以 `role=tool` 追加。
- 无显式 CachedContent；每次整包 system。供应商（如 DeepSeek）可能自动做前缀缓存，见 [`caching.md`](caching.md)。
- 流式：bridge 同样给 OpenAI 兼容路由挂 `_StreamPush`，按完整段落推草稿；定稿仍走 `/channel/out`。

### 6.2 Gemini · `generate` 模式（`GEMINI_CHAT_MODE=generate`，默认常见）

- `_openai_messages_to_gemini`：system → `system_instruction`；其余 → `contents`。
- 若有有效 Cache：`cachedContent`；**禁止**再带 system_instruction / tools（已 bake 进 cache）。
- Cache 正文 ≈ `_build_cache_system_text` + hot3；工具与（额度内）`google_search` 可 bake。
- 工具循环：generate 路径下工具结果仍走 messages 形态再转 contents。

### 6.3 Gemini · `interactions` 模式

- 首轮可带完整 A+B bootstrap；后续用 `previous_interaction_id` 增量 `input`。
- 当轮动态块仍在 **input**（与 OpenAI user 一致），以保前缀可缓存。
- 轮次/miss 触发 `maybe_reset_gemini_cycle`：可跑 `/summary/run` 写 voyage，再 clear interaction。

协议由 relay `chat_protocol` / 路由表决定；Gemini 失败默认不静默 fallback 到 OpenAI（见 bridge 注释）。

---

## 7. 回复回前端

1. 流式或整包文本 → `send_reply` → `POST /channel/out`。
2. 助手正文同样 `ingest_to_memory`（非 cancel）。
3. 工具：`recall_memory` / `browse_memories` / `update_current_state` / `correct_memory` / `get_weather` / 自醒等 → memory `POST /tools/:name`；前端可收 `act` 卡片。
4. 用量：`model_router` hook → `POST /app/usage`（独立账本，删会话不删钱）。

---

## 8. 异步成星：Scribe → Archivist → Librarian

### 8.1 摄入

`POST /messages/ingest` → `sanctuary.db` 的 `messages`（`is_tagged=0` 待处理）。与 `tidal.db` 双库隔离。

### 8.2 Scribe（`services/scribe.js`）

定时 / `POST /scribe/trigger` / `POST /scribe/force`：

| 条件 | 默认 |
|------|------|
| 静默 | `SILENCE_MINUTES` 20（relay `scribe_silence_minutes` 可覆盖） |
| 积压强制 | `FORCE_TRIGGER_MESSAGES` 100 |
| 连续聊兜底 | `MAX_HOURS_STALE` 0.5h + 至少若干未处理条 |
| 单批 | `MAX_BATCH` 60 |

LLM 用 `SCRIBE_SYSTEM_PROMPT`（含 `WORLD_CONTEXT`、已知实体、去重上下文）抽出 `entries` → 写入 `memory_fragments` → `indexNewFragments` 进 Chroma → `archivistEvents.emit('fragments:written')`。

### 8.3 Archivist（`services/archivist.js`）

监听碎片写入；轻量循环（实体归类、关键词等）+ 闲置深度循环（整合 episode、概述、洞察等）。产出星座 / `entity_profiles` / 剧集层，供星图与检索。

### 8.4 Librarian（`services/librarian.js`）

`searchHybrid(q)`：**FTS5（CJK）+ 向量（Chroma，`1 - distance` 当相似度，库须 `hnsw:space=cosine`）+ 实体字面聚合**，再衰减 / RRF 类融合。

下游：

- 可选自动注入：`inject_memories`（默认关）
- 工具：`recall_memory` → 同套混合检索，当轮用、不进 Snapshot 固化

成星后**下一轮及以后**才可能被检索到；本轮刚聊的内容主要靠 B 区历史，不靠星图。

---

## 9. 两套 API 账单（对照）

| 用途 | 谁调 | 配置分组（relay settings） |
|------|------|---------------------------|
| 主聊 / 工具决策 | `ai_brain` → chat 路由 | `api_*` / `gemini_*` / `chat_protocol` |
| Scribe 抽事实 | memory_service | `memory_*` |
| Archivist 归类整合 | memory_service | 同上 + 任务内配置 id |
| 航海 / 今日事件 | `summary.js` | `voyage_*` / `daily_*` + 提示词覆盖 |
| 积温分析 | affect | `affect_*` |

换聊天模型不应丢记忆；记忆模型欠费只应让整理停，不应拖死主聊（原则见 [`../maintain/principles.md`](../maintain/principles.md)）。

用量口径：Gemini 记录输入/输出/思考/缓存；DeepSeek 记录输入/输出/缓存；其它 OpenAI 兼容商返回标准 `usage` 才记，否则只记调用次数。详见 [`../ops/usage-apis.md`](../ops/usage-apis.md)。

---

## 10. 调试捷径

| 手段 | 作用 |
|------|------|
| `DEBUG_SYSTEM_PROMPT=1` | bridge 打印完整 system |
| `INJECT_RELATED_MEMORY=1` | 恢复每轮自动灌相关记忆 |
| `POST /scribe/force` | 跳过静默条件抽一批 |
| `GET /librarian/search?q=` | 直接看混合检索 |
| `test/` 咖啡+烧烤脚本 | 空库验收写入/搜/删 |

改提示词填槽：见 [`prompts/README.md`](../prompts/README.md) 与 [`maintain/write-prompts.md`](../maintain/write-prompts.md)。
