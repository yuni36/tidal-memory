# API 槽位与协议差异

聊天、记忆整理、摘要、积温等可以各用各的 Key。**整理账单 ≠ 聊天账单。**  
可选槽位留空或关掉 = 该能力没有，不挡主聊。

> 测试背景：维护者日常以 Google 原生 Gemini 为主，DeepSeek 作为补充 / 备用；两种协议能力不完全对等，未覆盖的组合以实际运行为准。

花费与实测账单：[`usage-and-cost.md`](usage-and-cost.md)。

---

## 1. Gemini 优先适配（请先读）

产品与设置页的**默认模型名、联网搜索、原生协议探测**按 **Google Gemini** 路径磨得最多：

| 点 | 现状 |
|---|---|
| 设置默认聊天模型占位 | 常见 Gemini 原生模型名（以官方当前列表为准） |
| 联网搜索 | **仅** Gemini Google Search grounding；OpenAI 兼容口没有同款 |
| 上下文缓存 | Gemini 用显式 `cachedContents`（见 [`../advanced/caching.md`](../advanced/caching.md)） |
| OpenAI 兼容 | 主聊与积温完全可用（DeepSeek 等）；只是搜索 / 部分 Gemini 专用能力没有 |
| 用量 token | Gemini 记录输入 / 输出 / 思考 / 缓存；DeepSeek 记录输入 / 输出 / 缓存；其它兼容商返回标准 `usage` 才记 |

结论：你可以只用 DeepSeek 把“能聊 + 记忆脚本 + 积温”跑绿；若要验收**搜索**或对照 Gemini 官方账单结构，请切到 Gemini 原生协议。

---

## 2. 槽位表

| 槽位 | 配置入口 | 用途 | 必填？ | 备注 |
|---|---|---|---|---|
| 聊天 · OpenAI 兼容 | 设置页「当前使用 = OpenAI 兼容」+ Base / Key / Model | 主对话 | 与下一行二选一 | DeepSeek 等 `/v1` 兼容口；示例模型名可用 `deepseek-flash` |
| 聊天 · Gemini 原生 | 设置页「当前使用 = Google 原生」+ Gemini Base / Key / Model | 主对话 | 与上一行二选一 | 官方 `v1beta`；勿填成 OpenAI 兼容路径 |
| 记忆流水线 | 设置页「记忆提炼」 | Scribe / Archivist 等 | 强烈建议 | 可与聊天不同模型；换聊天模型不丢星图 |
| 航海日志 | 设置页「航海日志」 | 周期摘要写入稳定区 | 可选 | API **独立**，不借用积温 |
| 今日事件线 | 设置页「今日事件线」 | 短时事件线注入 | 可选 | 可两套候选；与固化解耦 |
| 积温 | 设置页「情绪分析」 | 五轴分析 / 语调 / 主动开口 | 可选 | **只服务积温**；不回退聊天 Key。留空仍会按静默主动来找，但不分析情绪 |
| 天气 | 开关 + memory `.env` 查询词等 | 注入天气、工具 | 可选 | 无 Key 也可走公共天气源（以代码为准） |
| 联网搜索 | 设置「联网搜索」+ brain 环境变量 | Google Search grounding | 可选 | **仅 Gemini** |
| 中继密钥 | 根 `.env` / `chat_relay/.relay_secret` / 设置页连接密钥 | 鉴权 | 必填 | 生产高熵；改后重启进程 |
| 记忆加密钥 | `memory_service/.env` → `SANCTUARY_ENCRYPTION_KEY` | 记忆库加密 | 生产必填 | 勿用 example 占位 |

启动默认值还可写在各服务 `.env`（见 [`env-and-versions.md`](env-and-versions.md)）；网页保存的设置进 `tidal.db`。

> DeepSeek 官方当前模型名是 `deepseek-flash` / `deepseek-v4-pro`；旧别名（如 `deepseek-chat`）可能仍会自动路由，但新配置建议直接写官方名字。

积温补充：

- 不配 `affect_*` 也会有数学时钟和主动来找；主动来找用**聊天模型**，计入主聊。
- 要“聊天注入情绪”，再打开「启用情绪分析」并配 Gemini flash lite 免费层。
- 手动「发一条主动关怀」走记忆管线 Key，和自动积温不是同一条路。
- 分析额度超限 / 429 只做兜底，不自动切付费。

---

## 3. 搜索：仅 Gemini

- 联网搜索走 **Google Search grounding**，挂在 **Gemini 聊天路径**上（与自定义 function 可并存，受月度额度等约束）。
- OpenAI 兼容聊天路**不**提供同一套 Google grounding。
- 总开关：设置页「联网搜索」；服务端另有环境开关（如 `GEMINI_GOOGLE_SEARCH`、月硬顶）。任一关掉 = 不搜，聊天仍可进行。

---

## 4. 最小 / 推荐 / 完整

见根目录 README 的 T1–T3，以及 [`../AI-HANDOFF.md`](../AI-HANDOFF.md)。

```text
T1 部署：不需要 API
T2 最小可用：1 个聊天 Key，能一发一收
T3 推荐基线：+ 记忆 Key（可选；本地 ONNX 通常能跑），咖啡压过烧烤
```

积温 / 搜索 / 推送 / 云属于可选能力，不是“装好”的门槛。  
提示词：[`../prompts/`](../prompts/)。单轮拼装：[`../advanced/message-lifecycle.md`](../advanced/message-lifecycle.md)。
