# 记忆验收（空库 · 虚构对话）

**禁止**把真实聊天、生产 Key、私人星图拷进本目录。若验收要配远端 Key，用**独立测试 Key**（本机 `.env`，勿提交）。

## AI 验收（T3）

给 AI / 自动化用的最短路径：

```powershell
cd <项目根>
.\.venv\Scripts\python.exe test\scripts\05_e2e_timing.py
```

通过标准：

- 打印 `rank coffee=0`，bbq 为 1 或 None；
- 没有 `embedding failed` / `vector storage failed`；
- TOTAL 约 6–12 秒（冷启动可更慢）。

需要什么 Key：

| 场景 | 要什么 |
|---|---|
| 本目录记忆脚本 | 通常**不需要**外部 LLM Key；本地 ONNX embedding 即可 |
| 设置页「发一条主动关怀」 | 需要记忆管线 Key；与自动积温不同 |
| 主聊一发一收（T2） | 需要聊天 Key |

验收层级与命令：[`../AI-HANDOFF.md`](../AI-HANDOFF.md)。耗时样例：[`../ops/verify.md`](../ops/verify.md)。

## 场景：咖啡 + 烧烤干扰

虚构两簇记忆（不预造真实星图数据文件；由脚本写入）：

| 角色 | 内容大意 |
|------|----------|
| 目标 | User 说喜欢美式咖啡、下午会去某家咖啡店 |
| 干扰 | User 聊周末烧烤、炭火、肉串 |

期望：查询「咖啡 / 美式」时，**咖啡相关命中压过烧烤**（混合检索）。细节对话见 [`fixtures/coffee_bbq.md`](./fixtures/coffee_bbq.md)。

## 星星怎么长出（对照代码）

1. 日常路径：聊天 → bridge `ingest` → 静默/积压后 **Scribe** 抽 `memory_fragments` → Chroma 索引 → **Archivist** 归星。  
2. 本目录脚本：为可重复验收，走 **`POST /api/memory`** 直接写入 memories + 向量（跳过等静默），仍走同一套 Librarian / 删除 API。  
3. 查：`GET /librarian/search?q=` 或关键词脚本；原理见 [`advanced/message-lifecycle.md`](../advanced/message-lifecycle.md) §8。

## 测完怎么删

- 跑 [`scripts/04_delete.py`](./scripts/04_delete.py)（按本次 run 记录的 id 删）。  
- 或设置页/星图手动删；空库验收也可用「换全新 `sanctuary.db` + 空 chroma」——**勿用生产库**。

## 前置

```text
Chroma :7707 · memory_service :3013（默认）
本地 ONNX embedding 可用（默认路径）
目标库接近空（无大量旧「咖啡/烧烤」污染）
如果 embedding 走远端 Key，再配独立测试 Key；不要用生产 Key。
```

环境变量（可选）：

```text
MEMORY_URL=http://127.0.0.1:3013
```

## 脚本顺序

| # | 脚本 | 作用 |
|---|------|------|
| 0 | `scripts/00_health.py` | 探活 |
| 1 | `scripts/01_write.py` | 写入咖啡目标 + 烧烤干扰 |
| 2 | `scripts/02_keyword_search.py` | 关键词/FTS 向探测 |
| 3 | `scripts/03_hybrid_search.py` | 混合检索；断言咖啡分 > 烧烤 |
| 4 | `scripts/04_delete.py` | 删除本 run 写入的 id |
| 5 | `scripts/05_e2e_timing.py` | 串联 1→3→4 并打印耗时 |

状态文件：`scripts/.last_run.json`（本次写入的 id；本地临时文件，不要提交）。

```powershell
cd <项目根>
.\.venv\Scripts\python.exe test\scripts\00_health.py
.\.venv\Scripts\python.exe test\scripts\05_e2e_timing.py
```

单步失败时看 memory_service 控制台（embedding / Chroma 最常见）。

全链路（含主聊 / 积温耗时样例）：[`../ops/verify.md`](../ops/verify.md)。

---

## 预期终端样例（正常）

下列摘自维护者 2026-10-23 近空库一次跑通（Chroma 本地 ONNX；墙钟会随机器波动，**排序关系**才是硬断言）。

### `05_e2e_timing.py` 摘要

```text
=== e2e timing ===
GET /healthz → 200 ...
OK
  00_health: 0.93s
POST /api/memory '美式咖啡偏好（测试）' → 200 {'success': True, 'id': 3, 'message': 'Memory saved successfully'}
POST /api/memory '周末烧烤计划（测试干扰）' → 200 {'success': True, 'id': 4, 'message': 'Memory saved successfully'}
  01_write: 1.40s
q='美式咖啡' → 2 hits
  id=3 ... 美式咖啡偏好（测试）
  id=4 ... 烧烤...
OK (keyword probe ...)
  02_keyword_search: 1.91s
q='美式咖啡' hits=2
  [0] id=3 ... 美式咖啡...
  [1] id=4 ... 烧烤...
rank coffee=0 bbq=1 (ids 3/4)
OK — 咖啡压过烧烤（或烧烤未进入同查询结果）
  03_hybrid_search: 1.43s
DELETE /api/memory/3 → 200 ...
DELETE /api/memory/4 → 200 ...
  04_delete: 0.14s
TOTAL: 5.80s
```

### 怎样算通过 / 失败

| 现象 | 判定 |
|------|------|
| `rank coffee=0` 且 `bbq=1`（或 bbq 为 `None`） | **通过** |
| `rank coffee` &gt; `rank bbq` | **失败**（混合检索未达预期） |
| write 带 `embedding failed` / `vector storage failed` | **未通过向量路径**（先查 Chroma `:7707`、本地 ONNX 或 embedding Key） |
| TOTAL 约 6–12 s | 与样例同量级即合理；冷启动可更慢 |

`score=None` 时仍可能通过：Librarian 会合并 FTS + 向量；脚本断言的是**名次**，不是必须打印余弦分。机制见 [`../advanced/message-lifecycle.md`](../advanced/message-lifecycle.md) §8。
