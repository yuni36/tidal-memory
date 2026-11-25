# 协作习惯（公开仓）

不另开「AI 协作」远程仓；约定写在这里。

## 开场必做

任何提交前确认：无聊天库、无 `uploads` 实文件、无真 Key、无私人称呼默认值。扫描口径见 [`principles.md`](principles.md) §5。

## 干活方式

1. **一次只做一件可验收的事**；做完停，等确认再继续。
2. 需求不清就问（选择题更好）；架构取舍摸不准也问。
3. 用户点名的文档 / 上游仓库：先读再改。不许凭记忆编外部 API 请求体。
4. 行为变了写清「改了哪里」；公开树用 PR 说明或 commit message 记录，不维护私有 `CHANGELOG`。

## 改哪里找谁

| 想改… | 先读 | 再动 |
|-------|------|------|
| 拼装 / Gemini·OpenAI 分叉 | [`advanced/message-lifecycle.md`](../advanced/message-lifecycle.md) | `bridge.py` · `context_builder.py` · `model_router.py` |
| 缓存 / 流式 / usage | [`advanced/caching.md`](../advanced/caching.md) | `gemini_cache.py` · `model_router.py` |
| 成星 / 检索 | lifecycle §8 | `scribe.js` · `archivist.js` · `librarian.js` |
| 提示词槽 | [`prompts/`](../prompts/) · [`write-prompts.md`](write-prompts.md) | settings 或表内标明的源码常量 |
| 启动 / 双库 | [`ops/run-desktop.md`](../ops/run-desktop.md) · [`advanced/architecture.md`](../advanced/architecture.md) | 各服务 `.env.example` |
| 云部署 | [`ops/run-cloud.md`](../ops/run-cloud.md) | `Dockerfile` · `docker-compose.yml` · `deploy/Caddyfile` |
| UI 壳 | 现有 `web/`；勿大改菜单 | bump `web/sw.js` 的 `CACHE` |

## 旁路原则

可选能力（天气、搜索、积温、自动相关记忆）失败或关闭时：**主聊仍可用**。不要把旁路焊死进「不回复就卡住」的路径。

## 贡献表述

原创侧重 `ai_brain`；壳与记忆 = 上游接入 + 二开。不要把 Echo / Memory Constellations / jiwen 写成从零自研。
