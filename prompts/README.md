# 提示词槽位表

> 公开树**不收录私人正文**。下表列出全量可填槽：填哪、存哪、谁读。怎么写人设见 [`maintain/write-prompts.md`](../maintain/write-prompts.md)。  
> 占位符：`{user}` / `{ai}`（以及 `{{user.name}}` 等）由 `memory_service/services/nameResolver.js` 按 `memory_config` 替换。默认名应为 **User / Assistant**。

---

## 怎么填（总规则）

1. **聊天人设 / 输出风格 / 航海·事件线覆盖**：设置页或 relay `settings` 表；空字符串表示「用代码内置默认」（人设/风格清空会回落到 `context_builder` 默认）。
2. **记忆抽取 / 屏障 / 工具教导 / 世界观**：多在 `memory_service` 源码常量；改代码或后续把覆盖接到 settings（当前以表内「存储位置」为准）。
3. **私人称呼、真实关系细节、Voyage 私人口吻**：**不要提交进 git**；只留本机 `.env` / 本机 settings / 本机改过的未跟踪文件。
4. 填完用一轮真实闲聊 + `DEBUG_SYSTEM_PROMPT=1` 或设置页预览核对拼装顺序（见 [`advanced/message-lifecycle.md`](../advanced/message-lifecycle.md) §4–5）。

---

## A. 主聊 system（稳定块）

| 槽位 ID | 作用 | 存储 / 编辑入口 | 读取方 | 公开仓正文 |
|---------|------|-----------------|--------|------------|
| `persona` | 身份与关系（长文身份放这） | relay `settings.persona`；设置页 | `bridge.apply_hot_settings` → `set_persona` | **空**（运行时回落内置中性默认） |
| `output_style` | 怎么吐字（闭环/留白/长度等） | `settings.output_style` | `set_output_style` | **空** → 代码内 `OUTPUT_STYLE` |
| `AFFECT_PRIORITY` | 语调开时的「情绪优先」声明 | `ai_brain/context_builder.py` 常量 | `build_messages` | 代码常量（非私人槽） |
| `tools.instructionText` | 各工具合起来的使用教导 | 各 `services/tools/*.js` 的 `instructionText`；经 `/tools/definitions` | `set_tool_guidance` | 中性模板；`{user}` 运行时替换 |
| `TOOL_DISCIPLINE` | 工具次数 / resolve 纪律 | `context_builder.py` | system | 代码常量 |
| `STATE_TENSE` | 当前状态时态读法 | `context_builder.py` | system | 代码常量 |
| `barrierPrompt` | 记忆引用权限与时间感 | `memory_service/server.js` → `MEMORY_BARRIER_PROMPT`；definitions 下发 | `set_memory_barrier` | 代码模板（含 `{user}`） |
| `MEMORY_BARRIER_STYLE_HINT` | 「接话勿汇报记得什么」 | `context_builder.py` | 拼在屏障后 | 代码常量 |
| `summary` / voyage | `[近期对话摘要]` | Snapshot；由 summary 任务写入 | `set_summary_log` | 运行时产物，非手填槽 |
| `activity` | `[今日事件]` | `/summary/activity` + Snapshot | `set_activity_log` | 运行时产物 |
| `schedule` | `[日程]` | schedules injectable + Snapshot | `set_schedule_log` | 运行时产物 |
| `hot_window` | `[锚定对话]` | Snapshot hot3 | `set_hot_window_log` | 运行时产物 |

---

## B. 当轮 user 动态前缀（一般不手填长文）

| 槽位 ID | 作用 | 来源 |
|---------|------|------|
| `[输入时间]` | 北京时间本轮时钟 | `format_now_clock` |
| `[天气]` | 环境常识 | `inject_weather` |
| `[当前情绪]` | 语调短指引 | affect state / 积温 meta |
| `[当前状态]` | 带 `#id` 的短时观察 | `/intuition/context` |
| `[相关记忆]` | 自动检索（默认关） | `INJECT_RELATED_MEMORY` + Librarian |
| `[自醒]` / `[积温·惦记]` | 系统轮由头 | `format_self_wake_block` / `format_jiwen_contact_block` |

---

## C. 记忆流水线旁路（另一套账单）

| 槽位 ID | 作用 | 存储 / 编辑入口 | 公开仓正文 |
|---------|------|-----------------|------------|
| `WORLD_CONTEXT` | Scribe/Archivist 等共用世界前缀 | `memory_config` → `worldContext.js` | 用 User/Assistant 中性描述；**勿写私人真名** |
| `SCRIBE_SYSTEM_PROMPT` | 抽事实 JSON schema 与铁律 | `services/scribe.js` | 上游模板；改前先读 lifecycle §8 |
| `summary_voyage_prompt` | 航海日志生成 | `settings.summary_voyage_prompt`；空则 `summary.js` 默认模板 | **空** |
| `summary_daily_prompt` | 今日事件线生成 | `settings.summary_daily_prompt` | **空** |
| Archivist 任务内 prompt | 归类 / 合并 / 概述等 | `services/archivist.js` 内联 | 不单独开设置项；改代码 |
| Consolidator 等 | 整合层 | `services/consolidator.js` 等 | 同上 |

---

## D. 积温 / 情绪（可选旁路）

| 槽位 ID | 作用 | 位置 | 公开仓正文 |
|---------|------|------|------------|
| affect `SYSTEM_PROMPT` | 五维 delta 分析 | `services/affect/analyzer.js` | 内置**中性模板**；想加自己的规则，在设置页或 `settings.affect_prompt` 覆盖 |
| tone / describe | 语调文案、状态旁白 | `affect/tone.js` · `describe.js` | 语调默认用上游 `@clarashafiq/jiwen/tone-grid` 的通用文案；留空 = 用内置；关染色则不注入 |
| 积温 compose | 主动开口文案 | `composeCare.js` 等 | 中性短句；可关；失败不得挡主聊 |

---

## E. 名称与双星（不是长提示词，但影响所有槽）

| 项 | 位置 | 公开默认 |
|----|------|----------|
| 显示名 User / Assistant | `memory_service/memory_config.json` + relay `HUMAN_NAME`/`AI_NAME` | User / Assistant |
| `{user}` `{ai}` 替换 | `nameResolver.fillPrompt` | 跟 config |

---

## F. 槽位文件约定（本目录）

| 文件 | 用途 |
|------|------|
| `README.md` | 本表 |
| `slots.example.md` | 逐槽「建议写什么 / 不要写什么」；**无私人正文** |
| `private/.gitignore` | 可选：本机放私人草稿（目录内文件已被忽略）；**禁止 push** |

把私人 `persona` 全文贴进本目录并提交 = 脱敏失败。
