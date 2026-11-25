# 验收证据与耗时样例

给部署者 / 协助部署的 AI：按本文勾完，再声称本机可用。  
验收层级与命令以 [`../AI-HANDOFF.md`](../AI-HANDOFF.md) 为准；本页提供可复现的证据与耗时参考。

**本页数字**：DeepSeek 部分为 2026-11-25 在 Windows 本机、`127.0.0.1`、无代理环境下的实测；记忆脚本部分为 2026-10-23 的历史样例。你的机器、模型、冷启动、网络会变，把数量级对上即可，不必咬死毫秒。

---

## 0. 协议现实：Gemini 优先适配，OpenAI 兼容也能聊

| 能力 | Gemini 原生路径 | OpenAI 兼容（如 DeepSeek） |
|---|---|---|
| 主聊天 | 一等公民（设置页「Google 原生」） | 一等公民（设置页「OpenAI 兼容」） |
| 联网搜索 | **仅此路径**：Google Search grounding | 无同一套 grounding |
| 上下文缓存 | 显式 `cachedContents`（TTL / 续期 / 重建） | 供应商自动前缀缓存（如 DeepSeek） |
| 用量 token | 记录输入 / 输出 / 思考 / 缓存 | DeepSeek 记录输入 / 输出 / 缓存；其它兼容商返回标准 usage 才记 |
| 流式输出 | `generate` 模式逐字推前端 | 也按**完整段落**推草稿；单段回复仍可能整段出现 |

缓存机制细节见 [`../advanced/caching.md`](../advanced/caching.md)。

---

## 1. 真实链路（对照代码）

```text
人发一句
  → POST /app/send（relay 落库，通常 <0.1s）
  → SSE 推 brain
  → 拼装上下文 + call_llm（主耗时）
  → POST /channel/out → 前端 SSE 看到回复
  →（旁路）ingest → 稍后 Scribe/Archivist 成星（不挡下一句）

记忆脚本路径（可重复，跳过等静默）
  → POST /api/memory 写入 + Chroma index_batch
  → GET /librarian/search 混合检索
  → DELETE /api/memory/:id
```

拼装级说明：[`../advanced/message-lifecycle.md`](../advanced/message-lifecycle.md)。

---

## 2. 实测耗时（DeepSeek 参考）

环境：Windows 本机，Chroma `:7707` + relay `:3011` + memory `:3013` + ai_brain 已起；`deepseek-flash` / `deepseek-chat`；DeepSeek 直连不走代理。

### 2.1 供应商首字延迟（直接流式）

5 次短提示，直连 `https://api.deepseek.com/v1`，模型 `deepseek-flash`：

| 指标 | 结果 |
|---|---|
| 首字延迟 | min **0.409s** / median **0.573s** / max **1.097s** |
| 总耗时 | 约 0.52–1.24s |

注意：这是**供应商首字**，不是界面首段。

### 2.2 界面首段到达（DeepSeek 流式草稿）

5 次「两段式」提示，监听 `/app/stream` 的 `reply_delta`，记录从 `POST /app/send` 到第一段非空草稿的时间：

| 指标 | 结果 |
|---|---|
| 首段到达 | min **0.685s** / median **1.078s** / max **1.228s** |

说明：推送粒度是**完整段落**（和 Gemini 相同）。单段回复没有空行，仍会在定稿时整段出现；多段回复会逐段出现。

### 2.3 应用端到端（完整回复）

`POST /app/send` → SSE 收到最终 AI `reply`（已落库），5 次：

| 指标 | 结果 |
|---|---|
| 用户等待 | min **0.725s** / median **1.115s** / max **1.271s** |

第一轮可能更慢；冷启动、长上下文、工具 / 搜索会到十几秒级。

### 2.4 缓存命中（DeepSeek）

相同约 2.4k token 前缀，连续请求：

| 请求 | `prompt_tokens` | `prompt_cache_hit_tokens` | 未命中 |
|---|---|---|---|
| 第 1 次 | 2459 | **0** | 2459 |
| 第 2 次（相同） | 2459 | **2304** | 155 |
| 第 3 次（追加一轮） | 2477 | **2304** | 173 |

说明：

- 命中主要是稳定的 system 前缀；最后一条 user 附近仍会 miss。
- 缓存是供应商自动行为，不需要配置；我们只把命中的 token 记进用量账本。
- 预期：第二轮起 `cached_tokens` 明显大于 0；如果一直为 0，先确认前缀是否稳定（人设 / 工具定义是否每轮变化）。

### 2.5 记忆脚本耗时（历史样例）

`test/scripts/05_e2e_timing.py`，2026-10-23 近空库、Chroma 本地 ONNX：

| 步骤 | 墙钟 | 正常长什么样 |
|---|---|---|
| `00_health` | ~0.9–2.2s | `/healthz` 200；librarian 可搜 |
| `01_write` | ~1.4–6.5s | 两条都 `success`，无 `embedding failed` |
| `02_keyword_search` | ~1.9–3.5s | 印出 hits；不强制排序 |
| `03_hybrid_search` | ~1.1–2.3s | 咖啡 rank < 烧烤 rank（或烧烤未进结果） |
| `04_delete` | ~0.1–0.2s | 两条 delete success |
| **TOTAL** | **~6–12s** | 冷 ONNX / 机器忙时偏上限 |

更完整的终端样例见 [`../test/README.md`](../test/README.md)。

---

## 3. T1–T3 操作顺序

```powershell
# T1：四进程起来后
curl.exe -s http://127.0.0.1:3011/healthz
curl.exe -s http://127.0.0.1:3013/healthz
curl.exe -s http://127.0.0.1:7707/health

# T1 通过标准：三个 200；relay healthz 的 plugin_subs >= 1

# T2：鉴权 + 一发一收（完整命令见 AI-HANDOFF §3 S5）
# T3：记忆脚本
cd <repo>
.\.venv\Scripts\python.exe test\scripts\05_e2e_timing.py

# 看 DeepSeek 是否记到 token / 缓存
# GET /app/stats/recent  Authorization: Bearer <你的连接密钥>
```

T1 完成 ≠ 能聊；T2 才需要聊天 Key。T3 记忆脚本建议空库 / 测试库，不要用生产库。

---

## 4. 积温、推送、花费

- 积温：不配 affect API 也会按静默主动来找；要分析情绪再配 Gemini flash lite 免费层。详见 [`../guide/notifications.md`](../guide/notifications.md)。
- 推送：没有域名只做页面内提醒，不承诺锁屏；锁屏要 HTTPS + 域名 + VAPID。同上。
- 花费：主聊 / 积温 / 记忆的账单归属与实测：[`usage-and-cost.md`](usage-and-cost.md)。
- 槽位与协议差异：[`usage-apis.md`](usage-apis.md)。
