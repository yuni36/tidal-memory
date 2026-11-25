# 各槽怎么填（示例说明 · 无私人正文）

对照 [`README.md`](./README.md) 槽位 ID。下列「建议」是写法指引，不是要提交的成品文案。

---

## persona

- **写**：你们是谁、关系边界、禁忌、长期目标；用第二人称对 AI 说话（「你是…」）。
- **不写**：输出句式细则（放到 `output_style`）；工具用法（放到工具 instruction / 纪律）。
- **长度**：宁可短而硬，勿把整本小说塞进 system。
- **填法**：设置页「人设」→ 存 `settings.persona`。公开验收可留空，确认回落默认后再填本机值。

## output_style

- **写**：长短、是否闭环、是否采访式提问、如何用记忆（接话 vs 汇报）。
- **不写**：具体 API、模型名、部署细节。
- **填法**：设置页；空 = 使用 `context_builder.OUTPUT_STYLE`。

## summary_voyage_prompt / summary_daily_prompt

- **写**：输出围栏格式（须与 `summaryParse.js` 一致：`` ```voyage_log`` `` / `` ```daily_events`` ``）、事实密度、禁止寒暄。
- **不写**：聊天人设长文（航海员不是伴侣角色扮演）。
- **填法**：relay settings；空 = `summary.js` 内 `DEFAULT_*_PROMPT_TEMPLATE`。
- **账单**：走 `voyage_*` / `daily_*` 模型配置，不是聊天 Key。

## WORLD_CONTEXT / memory_config

- **写**：双星称呼、关系类型、短特质；保持与星图展示名一致。
- **不写**：真实姓名、可识别隐私、未脱敏的私人口吻。
- **填法**：编辑 `memory_service/memory_config.json`（及生成 `WORLD_CONTEXT` 的字段）。

## barrierPrompt（MEMORY_BARRIER）

- **写**：引用权限标签怎么读、时间远近措辞、纠正时听用户不辩解。
- **改入口**：`memory_service/server.js` 中 `MEMORY_BARRIER_PROMPT`（改后重启 memory_service）。

## Scribe / Archivist

- **优先**：调参数（静默分钟、积压条数）与模型分组，少改铁律。
- **若改** `SCRIBE_SYSTEM_PROMPT`：保持「只输出 JSON」「禁止代码块包裹」、类型枚举与 `emotional_weight` 锚点一致，否则解析会碎。
- Archivist 内联 prompt 与 consolidation 强耦合；改前先跑 `test/` 混合检索与空库冒烟。

## 工具 instructionText

- 每个工具一段「何时调用 / 禁止编造」；`{user}` 会替换。
- 文件：`memory_service/services/tools/memoryTools.js`、`weatherTool.js`、`selfWakeTool.js` 等。
- 改完确认 `GET /tools/definitions` 里 `instructionText` 已变，且 bridge 热加载后 system 含新教导。

## affect

- 分析 prompt 只描述**因果与 JSON 字段**，不塞伴侣长人设（避免跟主聊抢人格）。
- 关 `feature_affect_enabled` / `affect_analyze_enabled` 即可整段旁路。
