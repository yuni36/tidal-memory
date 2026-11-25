# 上下文缓存与流式（两种机制）

> 这篇讲“模型侧缓存”和“界面为什么逐字/不逐字”。  
> 系统地图见 [`architecture.md`](architecture.md)；一条消息的完整拼装见 [`message-lifecycle.md`](message-lifecycle.md)。

先分清三件事：

| 名字 | 是什么 | 在哪 |
|---|---|---|
| 浏览器 / Service Worker 缓存 | 静态资源缓存 | `web/sw.js`，与本文无关 |
| 模型侧上下文缓存 | 省 token、降首包 | 本文 |
| Snapshot 固化（A/B 区） | 把稳定上下文固定下来 | `message-lifecycle.md` §3.2，为缓存服务，但本身不是缓存 |

---

## 1. Gemini：显式 Context Cache（`cachedContents`）

对应代码：`ai_brain/gemini_cache.py`、`bridge._publish_explicit_cache`、`_cache_needs_rebuild`、`_rebuild_a_and_cache`。

### 1.1 缓存的是什么

`_build_cache_system_text` 拼出的稳定块，加上 hot3（锚定对话）与工具定义；开启联网搜索时，`google_search` 也会 bake 进去。

大致包括：

- system 稳定块（人设 / 输出风格 / 工具说明 / 记忆规则 / 摘要 / 事件 / 日程）
- hot3 锚定对话
- 工具定义
- （可选）Google Search grounding

### 1.2 生命周期

- 创建：`create_cached_content` → 拿到 `cachedContents/...` 名字，写入 `.bridge_state` 的 snapshot meta。
- 复用：下一轮直接带 `cachedContent`；**不能再带 system_instruction / tools**（已经 bake 进缓存）。
- 续期：剩余 TTL 小于 `GEMINI_CACHE_PATCH_REMAINING_SEC`（默认 600s）时，后台 `PATCH` TTL，不挡当轮生成。
- 重建：A 区变化、缓存过期/缺失、搜索开关与 bake 状态不一致时，**新建一个 + 删旧**。缓存正文创建后不可变，所以“改 A 区”等于换缓存。
- TTL：`GEMINI_CACHE_TTL_SEC`，默认 1800s。

### 1.3 失败怎么处理

- 内容太短（`is_too_short_error`）、配额、网络失败：本轮退回**无缓存**调用，聊天继续。
- `generate` 模式才用显式缓存；`interactions` 模式走 `previous_interaction_id`，不使用 `cachedContents`。
- Gemini 失败默认不静默 fallback 到 OpenAI（以 `bridge` 注释与设置为准）。

### 1.4 调试

- 日志：`cache create ok`、`cache too short`、`cache search mismatch`。
- 环境变量：`GEMINI_CACHE_TTL_SEC`、`GEMINI_CACHE_PATCH_REMAINING_SEC`。

---

## 2. OpenAI 兼容：供应商自动前缀缓存（DeepSeek 等）

对应代码：`model_router._call_llm_stream` / `_collect_stream` / `_normalize_openai_usage`。

### 2.1 没有显式缓存 API

DeepSeek 的上下文硬盘缓存默认开启，**不需要也不提供** create/patch/delete；命中靠“前缀完整匹配缓存前缀单元”，是 best-effort，不保证 100%。缓存构建秒级，闲置几小时到几天自动清理。

官方文档没有给出“4096 token 才缓存”这类统一门槛；实际命中取决于前缀是否完整匹配、请求边界、公共前缀检测等规则。

### 2.2 我们能控制的是“前缀稳定”

- system 稳定块尽量不变；
- A 区固化后才进 system；
- 动态项（时间、天气、当前状态、相关记忆、自问自答块）放**当轮 user 前缀**；
- Snapshot 采用“滞后一拍”：当前 user 不提前写进 A，避免回退/重生成时出现“Cache 有、库已删”的幽灵。

### 2.3 命中怎么看

DeepSeek 在 `usage` 里返回：

- `prompt_cache_hit_tokens`：命中的输入 token
- `prompt_cache_miss_tokens`：未命中的输入 token
- `prompt_tokens = hit + miss`

`model_router` 会把它们归一成内部字段，写进 `usage_events`。实测（2026-11-25）：

| 请求 | prompt_tokens | 命中 | 未命中 |
|---|---|---|---|
| 第一次，约 2.4k 稳定前缀 | 2459 | 0 | 2459 |
| 第二次，相同请求 | 2459 | 2304 | 155 |
| 第三次，追加一轮 | 2477 | 2304 | 173 |

结论：稳定前缀能命中；最后一条 user 附近仍会 miss。不要指望“整段全命中”。

### 2.4 其它兼容厂商

只认标准 `usage`：

- 有 `prompt_tokens` / `completion_tokens` → 记输入/输出；
- 有 `prompt_cache_hit_tokens` 或 `prompt_tokens_details.cached_tokens` → 再记缓存；
- 完全没有 → 只记调用次数，不报错。

不为某家厂商写特殊分支；没有标准字段就按“未采集”处理。

---

## 3. 为什么 Snapshot 要“滞后一拍”

缓存最怕前缀抖动。如果每轮都把当前 user 写进 A 区，A 区就一直在变：

- Gemini：每轮都要新建 `cachedContents`，缓存还没热就被换掉；
- DeepSeek：前缀对不上，命中率下降。

所以 `snapshot_state.py` 只把“已确认完成轮次”收进 A；当前 user 留在 B 区，等下一轮再固化。这是缓存策略，不是记忆策略。

---

## 4. 缓存 ≠ 流式

| | 影响 | 当前实现 |
|---|---|---|
| 上下文缓存 | 费用、首包时间 | Gemini 显式；OpenAI 兼容靠供应商自动 |
| 流式输出 | 第一段什么时候出现在界面 | Gemini `generate` 逐字推；DeepSeek/OpenAI 兼容也按**完整段落**推草稿 |

所以：

- 两者现在都会边生成边推草稿，但粒度是**段落**，不是 token；
- 单段回复没有空行，仍会在定稿时整段出现；多段回复会逐段出现；
- 要做到 token 级逐字，需要改 `_StreamPush` 的推送粒度，属于功能改动，不是缓存配置。

---

## 5. 常见误区

| 误区 | 实际 |
|---|---|
| “缓存 = 记忆” | 不是。缓存是模型前缀；记忆是星图/检索 |
| “DeepSeek 也有 cachedContents” | 没有。它是自动硬盘缓存，只有命中统计 |
| “DeepSeek 隐式缓存 4096 才生效” | 官方文档没有这个统一门槛；以实际命中为准 |
| “开了缓存一定省钱” | 前缀不稳、上下文短、缓存过期时收益很低 |
| “缓存命中就能逐字输出” | 两者无关 |

---

## 6. 代码索引

| 关注点 | 文件 |
|---|---|
| Gemini 缓存客户端 | `ai_brain/gemini_cache.py` |
| 缓存创建/重建/失效 | `ai_brain/bridge.py`（`_publish_explicit_cache` / `_cache_needs_rebuild` / `_rebuild_a_and_cache`） |
| A/B 区与滞后一拍 | `ai_brain/snapshot_state.py` |
| OpenAI 流式与非流式 | `ai_brain/model_router.py`（`_call_llm_stream` / `_collect_stream` / `_call_llm_nonstream`） |
| usage 归一化 | `ai_brain/model_router._normalize_openai_usage` |
| 用量落库 | `chat_relay/app.py`（`usage_events` / `/app/stats/*`） |
