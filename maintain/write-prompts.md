# 怎么写 / 迭代提示词

槽位全表：[`prompts/README.md`](../prompts/README.md)。拼装顺序：[`advanced/message-lifecycle.md`](../advanced/message-lifecycle.md)。

## 安全

1. 私人正文只留本机（settings DB 或 gitignore 的草稿）。**不要**提交真名、私人口吻、真实聊天摘录。
2. 公开默认名：**User / Assistant**（`memory_config` + 产品 CONFIG）。
3. 脱敏与「好用」冲突时，先脱敏。

## 推荐顺序（新开库）

1. 填 `memory_config` 双星中性名与短关系 → 重启 memory_service（影响 `WORLD_CONTEXT` / `{user}`）。
2. 填 `persona`（身份）→ 再填 `output_style`（吐字）；不要两个槽重复同一段。
3. 需要航海/事件线时再配 `voyage_*` / `daily_*` Key；提示词可先空用默认模板，再按输出格式微调覆盖槽。
4. 工具教导与屏障：先读现成 `instructionText` / `MEMORY_BARRIER_PROMPT`；无痛点勿改。
5. Scribe 铁律：优先调静默/积压与记忆模型，少动 JSON schema。

## 验收一句话

发「今天下午想喝美式」→ 看回复口吻是否像你的 `persona`+`output_style`；需要时 `DEBUG_SYSTEM_PROMPT=1` 核对 system 段顺序；记忆侧用 `test/` 咖啡+烧烤脚本，勿用真实对话。

## 常见翻车

| 现象 | 常因 |
|------|------|
| 清空人设「没生效」 | 空串会回落代码默认；要测「真空」需改代码默认或临时注释回落逻辑 |
| 记忆口吻和人设打架 | Scribe/`WORLD_CONTEXT` 与主聊 persona 两套；改一侧时对齐称呼 |
| 每轮都在复述「我记得」 | 加强 barrier / output_style；并确认没有误开自动相关记忆灌太多 |
| 整理花很多钱主聊却像没记忆 | 正常：成星异步；先查 Librarian / 星图是否已有碎片，再查是否只靠工具 recall |
