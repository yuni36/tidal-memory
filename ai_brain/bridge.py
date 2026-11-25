#!/usr/bin/env python3
"""
Tidal AI 大脑 — Phase 2
基于 Tidal Echo bridge_any_llm.py 的增强版 AI 循环。

核心循环：
  ① SSE 长连 GET /channel/in → 收人类消息（实时）
  ② 记忆注入（检索相关记忆 → 占位，Phase 3 对接）
  ③ 上下文拼接（history + persona + memory）
  ④ 多模型路由调用（流式 + 工具调用 + 故障切换）
  ⑤ POST /channel/out → 回复回 PWA

模型支持：DeepSeek / OpenAI / Gemini / 任意 OpenAI 兼容 API。
工具调度器：注册记忆四工具 + get_weather。

启动：
    pip install -r requirements.txt
    cp .env.example .env   # 填好 RELAY_URL / RELAY_SECRET / CHAT_* 三件
    python bridge.py
"""

import asyncio
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

import aiohttp

from model_router import CHAT_ROUTES, validate_routes, call_llm, route_supports_vision
from context_builder import (
    set_persona, build_messages, set_tool_guidance, set_memory_barrier, set_summary_log,
    set_activity_log, set_hot_window_log, set_schedule_log,
    stamp_history_text, wrap_current_user, format_self_wake_block,
    format_jiwen_contact_block,
    clamp_history_n, clamp_history_window,
    slice_history_window, beijing_now,
    set_affect_tone_enabled, set_affect_style, clear_affect_style,
)
from memory_injector import inject_memories, inject_current_state, inject_schedule, inject_weather
from memory_injector import set_feature_gates as set_inject_feature_gates
from affect_client import observe as affect_observe, fetch_state as affect_fetch_state
from tool_dispatcher import MEMORY_TOOLS, execute_tool
import tool_dispatcher as td
import snapshot_state as snap

# 热加载：情绪分析 / 语调染色（与 settings 同步）
_AFFECT_ANALYZE_ON = False
_AFFECT_TONE_ON = False
_FEATURE_AFFECT = True
_FEATURE_GROUNDING = True
_FEATURE_SELF_WAKE = True

_TECH_HINTS = (
    "代码", "部署", "docker", "api", "bug", "报错", "commit", "函数", "接口",
    "数据库", "sql", "json", "debug", "日志", "服务器", "vps", "npm", "python",
    "编译", "端口", "配置", "env", "token", "schema", "refactor", "pr ", "git",
    "模型", "prompt", "token", "积温", "delta", "sw.js",
)


def _looks_like_tech(text: str) -> bool:
    t = (text or "").lower()
    if not t.strip():
        return False
    hits = sum(1 for h in _TECH_HINTS if h.lower() in t)
    return hits >= 2 or any(h in t for h in ("```", "docker compose", "localhost", "traceback"))


# =============================================================================
# 配置
# =============================================================================

def _load_dotenv(path: Path) -> None:
    """极简 .env：KEY=VALUE；行内 # 注释剥离；已有环境变量不覆盖。"""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip()
            if " #" in v and not (v.startswith('"') or v.startswith("'")):
                v = v.split(" #", 1)[0].rstrip()
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass

_load_dotenv(Path(__file__).resolve().parent / ".env")

RELAY_URL = os.environ.get("RELAY_URL", "http://127.0.0.1:3011").rstrip("/")
SECRET = os.environ.get("RELAY_SECRET", "")
MEMORY_URL = os.environ.get("MEMORY_URL", "http://127.0.0.1:3013").rstrip("/")
# 短期记忆：1轮=1用户+1AI。默认 min=max=12（滑窗）；设置页 history_n_min/max 每轮热加载。
# 长历史偶发「口头答应不调工具」时，开新对话即可切断错误上下文。
HISTORY_N = int(os.environ.get("HISTORY_N", "12"))
HISTORY_FETCH_CAP = 200


def _clamp_history_n(raw, default: int = 12) -> int:
    return clamp_history_n(raw, default)


def _clamp_max_tokens(raw, default: int = 512) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(256, min(2048, n))


HISTORY_N = _clamp_history_n(HISTORY_N, 12)
HISTORY_N_MIN = HISTORY_N
HISTORY_N_MAX = HISTORY_N
STREAM_ENABLED = os.environ.get("LLM_STREAM", "1") == "1"
# 调试开关：=1 时每条消息打印拼装后的完整 system prompt（默认关闭）
DEBUG_SYSTEM_PROMPT = os.environ.get("DEBUG_SYSTEM_PROMPT", "0") == "1"
# P1 默认关闭常驻 [相关记忆]；需要时设 INJECT_RELATED_MEMORY=1
INJECT_RELATED_MEMORY = os.environ.get("INJECT_RELATED_MEMORY", "0").strip().lower() in (
    "1", "true", "yes", "on",
)

# 人设统一由 relay 设置中心提供（apply_hot_settings boot/热加载），不再从 .env PERSONA/PERSONA_FILE 回退，
# 保证前端展示与 bridge 实际生效一致。relay 不可用时回落到 context_builder 内置默认。

# 默认活跃 session（用 __legacy__ 兜底）
DEFAULT_SESSION_ID = "__legacy__"

# 进行中的会话任务 + 取消标记（session_id → asyncio.Task / cancel meta）
_active_tasks: dict[str, asyncio.Task] = {}
_cancel_tokens: dict[str, int] = {}
_session_gen_token: dict[str, int | None] = {}
_turn_stage: dict[str, str] = {}
_turn_heartbeats: dict[str, asyncio.Task] = {}
_EMPTY_REPLY = "(这轮没有生成出文字，请再发一次。)"
_HEARTBEAT_SEC = 8

# 工具调用最大轮次（防止无限循环）
MAX_TOOL_ROUNDS = 8
# 同一工具在一条消息内最多重试次数（超过即止损，直接要求模型收尾回复）
MAX_TOOL_ATTEMPTS = 2

# 工具名 → (进行中文案, 完成文案)，用于前端 act 动作卡片
ACT_LABELS = {
    "recall_memory": ("正在回忆相关记忆", "已回忆相关记忆"),
    "browse_memories": ("正在浏览长期记忆", "已浏览长期记忆"),
    "update_current_state": ("正在更新对你的了解", "已更新对你的了解"),
    "correct_memory": ("正在纠正对你的记忆", "已纠正对你的记忆"),
    "get_weather": ("正在看外面天气", "已看过天气"),
    "set_self_wake": ("正在给自己设闹钟", "已设好自醒闹钟"),
    "cancel_self_wake": ("正在取消自醒闹钟", "已取消自醒闹钟"),
}
# 工具结果判定失败的文本前缀（execute_tool 失败时以此开头）
ACT_FAIL_PREFIXES = ("工具调用失败", "记忆服务连接失败", "工具执行失败")


def _weather_act_label(content: str) -> str | None:
    """从 get_weather 工具原文抽出短实况，供 act 完成卡标题展示。"""
    text = (content or "").strip()
    if not text:
        return None
    if text.startswith(ACT_FAIL_PREFIXES) or text.startswith("查天气失败"):
        return None
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    summary = None
    for i, ln in enumerate(lines):
        if ln.startswith("【天气"):
            if i + 1 < len(lines):
                summary = lines[i + 1]
            break
        if "°C" in ln or "℃" in ln:
            summary = ln
            break
    if not summary and lines:
        summary = lines[-1] if lines[0].startswith("【") and len(lines) > 1 else lines[0]
    if not summary:
        return None
    for sep in ("（更新于", "（实时拉取失败", "\n失败原因"):
        if sep in summary:
            summary = summary.split(sep, 1)[0].strip()
    if len(summary) > 72:
        summary = summary[:70] + "…"
    return f"看了天气：{summary}"


def _act_done_label(tc_names: list[str], act_steps: list[dict], act_failed: bool) -> str:
    if act_failed:
        return "工具遇到问题"
    if len(tc_names) == 1 and tc_names[0] == "get_weather":
        raw = ""
        for step in act_steps:
            if step.get("tool") == "get_weather":
                raw = step.get("result") or ""
                break
        label = _weather_act_label(raw)
        if label:
            return label
    if len(tc_names) == 1:
        return ACT_LABELS.get(tc_names[0], (tc_names[0], tc_names[0]))[1]
    return f"已完成 {len(tc_names)} 项操作"


def log(tag: str, msg: str) -> None:
    stamp = beijing_now().strftime("%H:%M:%S")
    print(f"[{stamp}] [{tag}] {msg}", file=sys.stderr, flush=True)


def _require_config() -> None:
    missing = []
    if not RELAY_URL:
        missing.append("RELAY_URL")
    if not SECRET:
        log("warn", "RELAY_SECRET 未设置，请求将不带鉴权头（relay 开发模式兼容）")
    missing.extend(validate_routes())
    if missing:
        log("fatal", "缺少配置: " + ", ".join(missing) + " — 填 .env 后再跑")
        sys.exit(1)


# =============================================================================
# 游标管理（Bug 2 修复 — 存在 relay 数据库里，删库自动消失）
# =============================================================================

async def read_cursor(session: aiohttp.ClientSession, session_id: str) -> int:
    """从 relay 读取指定 session 的游标"""
    try:
        data = await relay_get_json(session, f"/app/sessions/{session_id}/cursor")
        return int(data.get("cursor_id", 0))
    except Exception:
        return 0


async def write_cursor(session: aiohttp.ClientSession, session_id: str, cursor_id: int) -> None:
    """将游标写回 relay 的 sessions 表"""
    try:
        await relay_put(session, f"/app/sessions/{session_id}/cursor", {"cursor_id": cursor_id})
    except Exception:
        pass


# =============================================================================
# Relay HTTP 客户端
# =============================================================================

_auth_headers = {} if not SECRET else {"Authorization": f"Bearer {SECRET}"}


async def relay_get_json(session: aiohttp.ClientSession, path: str) -> dict:
    url = f"{RELAY_URL}{path}"
    async with session.get(url, headers=_auth_headers) as resp:
        return await resp.json()


async def relay_post(session: aiohttp.ClientSession, path: str, body: dict) -> dict:
    url = f"{RELAY_URL}{path}"
    async with session.post(url, json=body, headers=_auth_headers) as resp:
        text = await resp.text()
        return json.loads(text) if text else {}


async def relay_put(session: aiohttp.ClientSession, path: str, body: dict) -> dict:
    url = f"{RELAY_URL}{path}"
    async with session.put(url, json=body, headers=_auth_headers) as resp:
        text = await resp.text()
        return json.loads(text) if text else {}


# =============================================================================
# 用量上报 — 一次 LLM 调用一条（含工具链中间调用），攒批发给 relay
# =============================================================================

USAGE_FLUSH_SECONDS = 2.0
USAGE_BATCH_MAX = 50
USAGE_QUEUE_MAX = 500

_usage_queue: asyncio.Queue | None = None
_turn_llm_calls: dict[str, int] = {}      # session_id → 本轮已成功调用次数


def _on_llm_usage(event: dict) -> None:
    """model_router 的同步回调：只入队，不做 IO。"""
    sid = event.get("session_id") or DEFAULT_SESSION_ID
    if event.get("status") == "ok":
        _turn_llm_calls[sid] = _turn_llm_calls.get(sid, 0) + 1
    if _usage_queue is None:
        return
    try:
        _usage_queue.put_nowait(event)
    except asyncio.QueueFull:
        log("usage", "队列已满，丢弃一条用量记录")


async def usage_reporter(session: aiohttp.ClientSession) -> None:
    """攒批 POST /app/usage。统计链路失败绝不影响聊天，异常一律吞掉。"""
    if _usage_queue is None:
        return
    while True:
        events = [await _usage_queue.get()]
        deadline = time.monotonic() + USAGE_FLUSH_SECONDS
        while len(events) < USAGE_BATCH_MAX:
            wait = deadline - time.monotonic()
            if wait <= 0:
                break
            try:
                events.append(await asyncio.wait_for(_usage_queue.get(), wait))
            except asyncio.TimeoutError:
                break
        try:
            await relay_post(session, "/app/usage", {"events": events})
        except Exception as e:
            log("usage", f"上报失败，丢弃 {len(events)} 条: {e}")


# =============================================================================
# 暖启动：读取游标 + 拉最新消息 ID 初始化 cursor
# =============================================================================

async def warm_start(session: aiohttp.ClientSession) -> int:
    """翻页拉取 relay 中的最新消息 ID，初始化游标。
    
    [Bug 4] 不再填充进程中 convo。上下文改为 handle_human_message()
    中每次从 relay 按 session_id 实时拉取。
    """
    rows, since = [], 0
    while True:
        page = await relay_get_json(session, f"/app/history?since={since}&limit=500")
        msgs = page.get("messages", [])
        if not msgs:
            break
        rows.extend(msgs)
        since = msgs[-1]["id"]
        if len(msgs) < 500:
            break

    max_id = rows[-1]["id"] if rows else 0
    log("boot", f"暖启动: {len(rows)} 条消息在 relay, cursor={max_id}")
    return max_id


# =============================================================================
# AI 回复
# =============================================================================

def _is_cancelled(session_id: str) -> bool:
    gen = _session_gen_token.get(session_id)
    if gen is None:
        return int(_cancel_tokens.get(session_id, 0)) > 0
    return int(_cancel_tokens.get(session_id, 0)) >= int(gen)


def _request_cancel(session_id: str, cancel_token: int | None = None) -> None:
    tok = int(cancel_token or 0)
    if tok <= 0:
        tok = max(int(_session_gen_token.get(session_id) or 0), int(_cancel_tokens.get(session_id, 0)), 1)
    _cancel_tokens[session_id] = max(int(_cancel_tokens.get(session_id, 0)), tok)
    task = _active_tasks.get(session_id)
    if task and not task.done():
        task.cancel()
        log("in", f"cancel [{session_id}] token={tok}")
    # 停止只作废这一轮；不碰 snapshot / Cache / ix。下一句按此刻消息表重拼。


async def send_reply(
    session: aiohttp.ClientSession,
    text: str,
    kind: str = "reply",
    session_id: str = "__legacy__",
    meta: dict | None = None,
    *,
    ingest: bool = True,
) -> dict:
    """发送回复到 relay → 落库 + SSE 扇出到 PWA。
    仅 kind=reply 推送给记忆服务（Scribe/summary 依赖 AI 消息计轮次）；
    act/thinking 等卡片不进记忆库。"""
    if _is_cancelled(session_id):
        log("out", f"{kind} dropped (cancelled) [{session_id}]")
        return {"id": None, "dropped": True}
    body = {"type": kind, "text": text, "session_id": session_id}
    gen = _session_gen_token.get(session_id)
    if gen is not None:
        body["gen_token"] = int(gen)
    if meta:
        body.update(meta)   # glyph/steps 等由 relay 摊进消息 meta，前端直接读取
    result = await relay_post(session, "/channel/out", body)
    if result.get("dropped"):
        log("out", f"{kind} relay-dropped [{session_id}]")
        return result
    log("out", f"{kind} (id={result.get('id')})")
    if kind == "reply" and ingest:
        await ingest_to_memory(session, "ai", text, chat_id=session_id)
    return result


async def send_turn_progress(
    session: aiohttp.ClientSession,
    session_id: str,
    *,
    elapsed_ms: int,
    stage: str = "",
) -> None:
    """轮次心跳：不落库，只告诉前端还在跑。"""
    if _is_cancelled(session_id):
        return
    body: dict = {
        "type": "turn_progress",
        "session_id": session_id,
        "elapsed_ms": int(elapsed_ms),
        "stage": (stage or "").strip(),
    }
    gen = _session_gen_token.get(session_id)
    if gen is not None:
        body["gen_token"] = int(gen)
    try:
        await relay_post(session, "/channel/out", body)
    except Exception:
        pass


_PARA_BREAK = re.compile(r"\n[ \t]*\n")


class _StreamPush:
    """一轮 LLM 调用的流式草稿推送（POST /channel/delta，不落库）。

    思考：累积全文、约 150ms 推一次。正文：只推「已完整的段落」（遇空行才算完），
    半段留在这里，结尾由 /channel/out 定稿带出；代码块未闭合时不推，免得草稿和定稿分段对不上。
    """

    THINK_EVERY_SEC = 0.15

    def __init__(self, session: aiohttp.ClientSession, session_id: str):
        self.session = session
        self.sid = session_id
        self.stream_id = os.urandom(6).hex()
        self.thought = ""
        self.reply = ""
        self._thought_sent = ""
        self._reply_sent = ""
        self.thought_live = False
        self.reply_live = False
        self._last_think_at = 0.0

    async def _post(self, kind: str, text: str, *, done: bool = False) -> None:
        body: dict = {
            "type": kind,
            "stream_id": self.stream_id,
            "session_id": self.sid,
            "text": text,
        }
        if done:
            body["done"] = True
        gen = _session_gen_token.get(self.sid)
        if gen is not None:
            body["gen_token"] = int(gen)
        try:
            await relay_post(self.session, "/channel/delta", body)
        except Exception as e:
            log("warn", f"stream delta fail: {e}")

    async def on_thought(self, chunk: str) -> None:
        # 思考只累积给本轮定稿；不推 thinking_delta（前端要默认折叠卡，跟旧版一样）
        if _is_cancelled(self.sid):
            return
        self.thought += chunk

    async def on_text(self, chunk: str) -> None:
        if _is_cancelled(self.sid):
            return
        self.reply += chunk
        breaks = list(_PARA_BREAK.finditer(self.reply))
        if not breaks:
            return
        done_part = self.reply[: breaks[-1].start()].strip()
        if not done_part or done_part == self._reply_sent:
            return
        if done_part.count("```") % 2 or done_part.count("~~~") % 2:
            return
        self._reply_sent = done_part
        self.reply_live = True
        await self._post("reply_delta", done_part)

    async def clear(self) -> None:
        """丢弃草稿（工具轮 / 停止 / 出错 / 沉默）。"""
        if self.thought_live:
            await self._post("thinking_delta", "", done=True)
        if self.reply_live:
            await self._post("reply_delta", "", done=True)
        self.thought_live = False
        self.reply_live = False


async def _turn_heartbeat(session: aiohttp.ClientSession, session_id: str, t0: float) -> None:
    try:
        while True:
            await asyncio.sleep(_HEARTBEAT_SEC)
            if _is_cancelled(session_id):
                return
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            await send_turn_progress(
                session,
                session_id,
                elapsed_ms=elapsed_ms,
                stage=_turn_stage.get(session_id) or "",
            )
    except asyncio.CancelledError:
        return


async def ingest_to_memory(session: aiohttp.ClientSession, sender: str, content: str, ts: str = "", chat_id: str = "__legacy__") -> None:
    """将消息推送到记忆服务，供 Scribe 提取记忆（chat_id = 会话标识，隔离各会话）"""
    try:
        body = {"sender": sender, "content": content, "timestamp": ts, "chat_id": chat_id}
        url = f"{MEMORY_URL}/messages/ingest"
        async with session.post(url, json=body, timeout=aiohttp.ClientTimeout(total=5)) as resp:
            if resp.status != 200:
                log("mem", f"摄入失败 HTTP {resp.status}")
    except Exception as e:
        log("mem", f"摄入异常: {e}")


async def fetch_session_history(
    session: aiohttp.ClientSession,
    session_id: str,
    limit: int = 24,
    exclude_id: int | None = None,
) -> list[dict]:
    """从 relay 按 session_id 拉取最近 N 条消息，转成 OpenAI 格式。
    exclude_id：丢掉本轮已入库的那条，避免再 append 一份造成双份 user。"""
    try:
        # order=desc：取最近 limit 条（修复 Bug：此前 ASC + since=0 取到对话最早的 24 条）
        page = await relay_get_json(session, f"/app/history?since=0&limit={limit}&session_id={session_id}&order=desc")
        msgs = page.get("messages", [])
        history = []
        skip = int(exclude_id) if exclude_id is not None else None
        # relay 端 history(order=desc) 已把最新 limit 条反转回时间正序（最早在前），
        # 这里直接正序遍历即可，切勿再反转，否则上下文整体倒序导致回复复读。
        for m in msgs:
            if skip is not None:
                try:
                    if int(m.get("id") or 0) == skip:
                        continue
                except (TypeError, ValueError):
                    pass
            text = (m.get("text") or "").strip()
            if not text or m.get("kind") in ("thinking", "act"):
                continue
            if m.get("from") == "human":
                history.append({
                    "role": "user",
                    "content": stamp_history_text(text, m.get("ts")),
                    "id": m.get("id"),
                })
            elif m.get("from") == "ai" and m.get("kind") == "reply":
                history.append({
                    "role": "assistant",
                    "content": text,
                    "id": m.get("id"),
                })
        return history
    except Exception as e:
        log("warn", f"拉取 session 历史失败: {e}")
        return []


async def fetch_latest_summary(session: aiohttp.ClientSession, chat_id: str = "__legacy__") -> str | None:
    """拉取记忆服务指定会话最新的对话航海日志（summary.js 短期记忆层），无则返回 None"""
    try:
        url = f"{MEMORY_URL}/summary/latest?chat_id={chat_id}"
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
        return data.get("summary") or None
    except Exception:
        return None


async def fetch_activity_log(session: aiohttp.ClientSession) -> str | None:
    """拉取当前逻辑日（04:00→次日04:00）的行动速记，无则返回 None"""
    try:
        url = f"{MEMORY_URL}/summary/activity"
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
        return data.get("text") or None
    except Exception:
        return None


async def run_chat_summary(session: aiohttp.ClientSession, chat_id: str) -> dict | None:
    """触发航海日志生成；失败返回 None。"""
    try:
        url = f"{MEMORY_URL}/summary/run"
        async with session.post(
            url,
            json={"chat_id": chat_id},
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                log("warn", f"summary/run HTTP {resp.status}: {body[:200]}")
                return None
            data = await resp.json()
        return data.get("result") if isinstance(data, dict) else None
    except Exception as e:
        log("warn", f"summary/run 异常: {e}")
        return None


def _format_hot3_for_system(hot3: list[dict]) -> str:
    lines: list[str] = []
    for m in hot3 or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        from context_builder import HUMAN_NAME, AI_NAME
        who = HUMAN_NAME if role == "user" else AI_NAME
        lines.append(f"{who}: {content}")
    return "\n".join(lines)


def _gemini_uses_generate() -> bool:
    try:
        from model_router import _gemini_chat_mode
        return _gemini_chat_mode() == "generate"
    except Exception:
        return True


def _build_cache_system_text(voyage: str, daily: str, schedule: str | None = None) -> str:
    """拼装写入显式 Cache 的 system（Stable + Voyage + 事件线 + 日程；Hot3 走 contents）。"""
    import context_builder as cb
    parts = [cb.PERSONA, cb.OUTPUT_STYLE]
    if cb.TOOL_GUIDANCE:
        parts.append(f"[工具使用说明]\n{cb.TOOL_GUIDANCE}")
    parts.append(f"[工具纪律]\n{cb.TOOL_DISCIPLINE}")
    parts.append(f"[状态时态]\n{cb.STATE_TENSE}")
    if cb.MEMORY_BARRIER:
        barrier = f"[记忆使用规则]\n{cb.MEMORY_BARRIER}"
        if cb.MEMORY_BARRIER_STYLE_HINT not in cb.MEMORY_BARRIER:
            barrier = f"{barrier}\n{cb.MEMORY_BARRIER_STYLE_HINT}"
        parts.append(barrier)
    if voyage and voyage.strip():
        parts.append(f"[近期对话摘要]\n{voyage.strip()}")
    if daily and daily.strip():
        parts.append(f"[今日事件]\n{daily.strip()}")
        parts.append(cb.ACTIVITY_USAGE)
    sched = (schedule if schedule is not None else getattr(cb, "SCHEDULE_LOG", "") or "").strip()
    if sched:
        parts.append(cb.SCHEDULE_USAGE)
        parts.append(sched if sched.startswith("[日程]") else f"[日程]\n{sched}")
    return "\n\n".join(parts)


async def _publish_explicit_cache(
    session_id: str,
    *,
    voyage: str,
    daily: str,
    hot3: list[dict],
    schedule: str = "",
    old_cache_name: str = "",
) -> None:
    """固化后创建显式 Cache；失败则清空指针（下轮整包降级）。

    额度内 bake google_search + 自定义 function（并且）；顶满则只 bake function。
    """
    import gemini_cache as gcache
    import model_router as mr

    route = mr.CHAT_ROUTES[0] if mr.CHAT_ROUTES else {}
    if (route.get("protocol") or "").strip().lower() != "gemini":
        return
    if not _gemini_uses_generate():
        return

    bake_search = False
    try:
        import grounding_search as gs
        if gs.search_enabled_by_env() and _FEATURE_GROUNDING:
            quota = await gs.fetch_quota()
            bake_search = bool(quota.get("allowed"))
    except Exception as e:
        log("warn", f"[{session_id}] cache bake quota check fail: {e}")

    system_text = _build_cache_system_text(voyage, daily, schedule=schedule)
    try:
        created = await gcache.create_cached_content(
            route,
            system_text=system_text,
            hot3=hot3,
            tools=MEMORY_TOOLS,
            display_name=f"tidal-{session_id}"[:128],
            google_search=bake_search,
        )
        snap.set_cache_meta(
            session_id,
            cache_name=created.get("name") or "",
            expire_at=created.get("expire_at") or "",
            cache_google_search=bake_search,
        )
        log(
            "snap",
            f"[{session_id}] cache create ok "
            f"tokens={created.get('total_token_count')} search={bake_search} "
            f"name={created.get('name')}",
        )
    except Exception as e:
        snap.clear_cache_meta(session_id)
        if gcache.is_too_short_error(e):
            log("snap", f"[{session_id}] cache too short → degrade: {e}")
        else:
            log("warn", f"[{session_id}] cache create fail: {e}")

    if old_cache_name and old_cache_name != snap.get_entry(session_id).get("cache_name"):
        try:
            await gcache.delete_cached_content(route, old_cache_name)
        except Exception:
            pass


def _last_history_id(history: list[dict]) -> int:
    """已完成对话里最后一条的 relay id；无则 0。"""
    for m in reversed(history or []):
        try:
            mid = int((m or {}).get("id") or 0)
        except (TypeError, ValueError):
            mid = 0
        if mid > 0:
            return mid
    return 0


def _cache_needs_rebuild(session_id: str) -> bool:
    """无 Cache 或已过期 → 需要重建（废弃「剩余轮数少就不重建」）。"""
    import gemini_cache as gcache

    entry = snap.get_entry(session_id)
    cname = (entry.get("cache_name") or "").strip()
    if not cname:
        return True
    return gcache.is_expired((entry.get("expire_at") or "").strip())


async def _rebuild_a_and_cache(
    session: aiohttp.ClientSession,
    session_id: str,
    completed_history: list[dict],
    *,
    reason: str = "",
) -> dict:
    """统一重建：A 区 = 最近 A_WINDOW_ROUNDS 轮原文，cutoff = 末条 id，B 区清空。

    不再现场生成 voyage；事件线只拉「已有」。Cache 创建失败即降级（无 Cache 本轮整包）。
    """
    activity = (await fetch_activity_log(session)) or ""
    schedule = (await inject_schedule()) or ""
    hot3 = snap.extract_hot3(completed_history, n_rounds=snap.A_WINDOW_ROUNDS)
    cutoff = _last_history_id(completed_history)
    prev = snap.get_entry(session_id)
    old_cache = (prev.get("cache_name") or "").strip()
    entry = snap.commit_snapshot(
        session_id,
        cutoff_relay_id=cutoff,
        voyage="",
        daily_events=activity,
        hot3=hot3,
        schedule=schedule,
    )
    _apply_snapshot_to_context(entry)
    await _publish_explicit_cache(
        session_id,
        voyage="",
        daily=activity,
        hot3=hot3,
        schedule=schedule,
        old_cache_name=old_cache,
    )
    log(
        "snap",
        f"[{session_id}] {reason or 'rebuild'} "
        f"A原文={len(hot3) // 2}轮/{len(hot3)}条 cutoff={cutoff}",
    )
    return entry


def _apply_snapshot_to_context(entry: dict) -> None:
    """把 session Snapshot 的 A 区写进 context_builder 全局槽。"""
    blob = (entry or {}).get("local_a_blob") or {}
    voyage = (blob.get("voyage") or "").strip()
    daily = (blob.get("daily_events") or "").strip()
    schedule = (blob.get("schedule") or "").strip()
    # 已弃航海摘要：传空即清空，避免跨会话残留旧摘要
    set_summary_log(voyage)
    set_activity_log(daily)
    set_schedule_log(schedule)
    set_hot_window_log(_format_hot3_for_system(blob.get("hot3") or []))


# 固化已移至「新消息到来时」的请求前置步骤（滞后一拍，防幽灵）；
# 原后台 _consolidate_session_bg / maybe_schedule_consolidate 已删除，统一走 _rebuild_a_and_cache。


async def maybe_reset_gemini_cycle(
    session: aiohttp.ClientSession,
    session_id: str,
    *,
    base: str,
    model: str,
) -> bool:
    """回复发完后：若 input/miss 触发阈值，则生成航海日志、推进 Snapshot、clear interaction。

    不再推送前端 toast；与 10 轮固化共用 commit_snapshot。
    """
    import gemini_interaction_state as gis

    reason = gis.should_reset_cycle(session_id, base=base, model=model)
    if not reason:
        return False
    log("ix-reset", f"[{session_id}] {reason}")
    entry = snap.get_entry(session_id)
    cutoff = int(entry.get("last_relay_id") or 0)
    result = await run_chat_summary(session, session_id)
    if result and result.get("success"):
        log(
            "ix-reset",
            f"航海日志 ok rounds={result.get('roundStart')}-{result.get('roundEnd')}",
        )
        voyage = (result.get("summary") or "").strip()
        daily = (result.get("dailyEvents") or "").strip()
        if not daily:
            daily = (await fetch_activity_log(session)) or ""
        schedule = (await inject_schedule()) or ""
        # ix 截断时若拿不到热窗历史，保留旧 hot3
        old_hot = ((entry.get("local_a_blob") or {}).get("hot3")) or []
        snap.commit_snapshot(
            session_id,
            cutoff_relay_id=cutoff,
            voyage=voyage or ((entry.get("local_a_blob") or {}).get("voyage") or ""),
            daily_events=daily,
            hot3=old_hot,
            schedule=schedule,
        )
        _apply_snapshot_to_context(snap.get_entry(session_id))
    else:
        msg = (result or {}).get("message") if isinstance(result, dict) else None
        log("ix-reset", f"航海日志未生成（仍 reset）: {msg or 'no result'}")
        summary = await fetch_latest_summary(session, chat_id=session_id)
        if summary:
            set_summary_log(summary)
        activity = await fetch_activity_log(session)
        set_activity_log(activity or "")
        schedule = (await inject_schedule()) or ""
        set_schedule_log(schedule)
        snap.patch_a_schedule(session_id, schedule)
    gis.clear_session(session_id)
    log("ix-reset", f"[{session_id}] interaction cleared (silent); next turn bootstrap")
    return True


# =============================================================================
# 处理一条人类消息（核心逻辑）
# =============================================================================

async def apply_hot_settings(session: aiohttp.ClientSession, *, boot: bool = False) -> None:
    """每条消息从内部接口热加载 Key / Base URL / 模型（明文不走 /app/settings）。"""
    settings = await relay_get_json(session, "/channel/settings")
    if not settings:
        return
    import model_router as mr

    proto = (settings.get("chat_protocol") or "openai").strip().lower()
    if proto == "gemini":
        api_base = (
            settings.get("gemini_api_base_url")
            or "https://generativelanguage.googleapis.com/v1beta"
        ).rstrip("/")
        api_key = (settings.get("gemini_api_key") or "").strip()
        chat_model = (settings.get("gemini_model") or "").strip()
    else:
        proto = "openai"
        api_base = (settings.get("api_base_url") or "").rstrip("/")
        api_key = (settings.get("api_key") or "").strip()
        chat_model = (settings.get("chat_model") or "").strip()
    if api_base and api_key and chat_model:
        cur = mr.CHAT_ROUTES[0] if mr.CHAT_ROUTES else {}
        changed = (
            cur.get("base") != api_base
            or cur.get("key") != api_key
            or cur.get("model") != chat_model
            or cur.get("protocol") != proto
        )
        if changed:
            new_routes = [{"base": api_base, "key": api_key, "model": chat_model, "protocol": proto}]
            fallback = [
                r for r in mr.CHAT_ROUTES
                if not (r.get("base") == api_base and r.get("model") == chat_model and r.get("protocol") == proto)
            ]
            if proto == "gemini":
                # Gemini 模式不挂 OpenAI 备用链，避免静默 fallback；映射长期保留在 gemini_interactions.json
                mr.update_routes(new_routes)
            else:
                mr.update_routes(new_routes + fallback)
            tag = "boot" if boot else "hot"
            log(tag, f"模型已加载: {proto} {chat_model} @ {api_base}")

    global HISTORY_N, HISTORY_N_MIN, HISTORY_N_MAX
    raw_max = settings.get("history_n_max")
    if raw_max in (None, ""):
        raw_max = settings.get("history_n")
    raw_min = settings.get("history_n_min")
    if raw_max not in (None, "") or raw_min not in (None, ""):
        new_min, new_max = clamp_history_window(
            raw_min, raw_max if raw_max not in (None, "") else HISTORY_N_MAX, HISTORY_N_MAX,
        )
        if (new_min, new_max) != (HISTORY_N_MIN, HISTORY_N_MAX):
            HISTORY_N_MIN, HISTORY_N_MAX = new_min, new_max
            HISTORY_N = new_max
            log("boot" if boot else "hot", f"history_n={HISTORY_N_MIN}..{HISTORY_N_MAX}")
        elif boot:
            log("boot", f"从设置加载 history_n={HISTORY_N_MIN}..{HISTORY_N_MAX}")

    temp = settings.get("temperature")
    max_tok = settings.get("max_tokens")
    effort = settings.get("thinking_effort")
    if temp not in (None, "") or max_tok not in (None, "") or effort not in (None, ""):
        try:
            clamped_tok = _clamp_max_tokens(max_tok) if max_tok not in (None, "") else None
            mr.update_params(
                temperature=float(temp) if temp not in (None, "") else None,
                max_tokens=clamped_tok,
                thinking_effort=str(effort) if effort not in (None, "") else None,
            )
            if boot:
                log(
                    "boot",
                    f"从设置加载参数: temperature={temp}, max_tokens={clamped_tok}, "
                    f"thinking_effort={mr.THINKING_EFFORT}",
                )
        except (TypeError, ValueError):
            pass

    persona = (settings.get("persona") or "").strip()
    # 人设一律应用：为空则恢复内置默认（清空真正生效，不保留旧值 / 不回退 .env）
    set_persona(persona)
    if boot:
        log("boot", f"从设置加载人设（len={len(persona)}）")

    output_style = (settings.get("output_style") or "").strip()
    from context_builder import set_output_style
    set_output_style(output_style)
    if boot:
        log("boot", f"从设置加载输出风格（len={len(output_style)}）")

    global _AFFECT_ANALYZE_ON, _AFFECT_TONE_ON
    global _FEATURE_GROUNDING, _FEATURE_SELF_WAKE, _FEATURE_AFFECT
    def _flag(key: str, default: str = "0") -> bool:
        v = str(settings.get(key, default) or default).strip().lower()
        return v in ("1", "true", "on", "yes")

    _FEATURE_AFFECT = _flag("feature_affect_enabled", "1")
    _AFFECT_ANALYZE_ON = _FEATURE_AFFECT and _flag("affect_analyze_enabled", "0")
    _AFFECT_TONE_ON = _FEATURE_AFFECT and _flag("affect_tone_enabled", "1")
    set_affect_tone_enabled(_AFFECT_TONE_ON)

    weather_on = _flag("feature_weather_enabled", "1")
    schedule_inject_on = _flag("feature_schedule_inject_enabled", "1")
    memory_inject_on = _flag("feature_memory_inject_enabled", "1")
    set_inject_feature_gates(
        weather=weather_on,
        schedule_inject=schedule_inject_on,
        memory_inject=memory_inject_on,
    )

    _FEATURE_GROUNDING = _flag("feature_grounding_enabled", "1")
    _FEATURE_SELF_WAKE = _flag("feature_self_wake_enabled", "1")

    if boot:
        log(
            "boot",
            f"积温开关: master={'on' if _FEATURE_AFFECT else 'off'} "
            f"analyze={'on' if _AFFECT_ANALYZE_ON else 'off'} "
            f"tone={'on' if _AFFECT_TONE_ON else 'off'} | "
            f"weather={'on' if weather_on else 'off'} "
            f"schedInject={'on' if schedule_inject_on else 'off'} "
            f"memInject={'on' if memory_inject_on else 'off'} "
            f"grounding={'on' if _FEATURE_GROUNDING else 'off'} "
            f"selfWake={'on' if _FEATURE_SELF_WAKE else 'off'}",
        )


async def _attachment_data_url(http: aiohttp.ClientSession, att: dict) -> str | None:
    """把本轮图片读成 data URL，供多模态；历史窗口不再回放旧图。"""
    raw_url = (att.get("url") or "").strip()
    mime = (att.get("mime") or "image/jpeg").split(";", 1)[0].strip() or "image/jpeg"
    if not raw_url:
        return None
    if raw_url.startswith("data:"):
        return raw_url
    if raw_url.startswith("http://") or raw_url.startswith("https://"):
        fetch_url = raw_url
    elif raw_url.startswith("/"):
        fetch_url = RELAY_URL + raw_url
    else:
        fetch_url = f"{RELAY_URL}/uploads/{raw_url.lstrip('/')}"
    try:
        async with http.get(fetch_url, headers=_auth_headers, timeout=aiohttp.ClientTimeout(total=20)) as resp:
            if resp.status != 200:
                log("warn", f"读附件失败 HTTP {resp.status}")
                return None
            data = await resp.read()
    except Exception as e:
        log("warn", f"读附件异常: {e}")
        return None
    if not data:
        return None
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _is_image_att(att: dict) -> bool:
    kind = (att.get("kind") or "").lower()
    mime = (att.get("mime") or "").lower()
    name = (att.get("name") or "").lower()
    if kind == "image" or mime.startswith("image/"):
        return True
    return name.endswith((".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"))


async def _build_user_turn(http: aiohttp.ClientSession, user_text: str, atts: list) -> list | str:
    """当前轮：能看图则编多模态；不能则明确说明，不要假装看见。"""
    images = [a for a in atts if _is_image_att(a)]
    files = [a for a in atts if not _is_image_att(a)]
    import model_router as mr
    route = mr.CHAT_ROUTES[0] if mr.CHAT_ROUTES else {}
    can_see = bool(images) and route_supports_vision(route)

    if can_see:
        parts: list = []
        text = user_text
        if files:
            names = ", ".join((a.get("name") or "file") for a in files)
            text = (text + "\n" if text else "") + f"（另有非图片附件: {names}，本阶段不解析文件内容）"
        parts.append({"type": "text", "text": text or "请看图。"})
        for att in images:
            data_url = await _attachment_data_url(http, att)
            if data_url:
                vision = mr.normalize_vision_level(att.get("vision") or att.get("image_quality"))
                parts.append({
                    "type": "image_url",
                    "image_url": {
                        "url": data_url,
                        "vision": vision,
                        "detail": mr.deepseek_image_detail(vision),
                    },
                })
        if len(parts) == 1:
            return parts[0]["text"]
        return parts

    note_bits = []
    if user_text:
        note_bits.append(user_text)
    if images:
        note_bits.append(
            "【系统】用户这轮发了图片。当前聊天模型不能看图，"
            "请明确告诉用户你看不见图片，不要编造图里的内容。"
            "请改用 DeepSeek Flash（原生识图）或 Google 原生 Gemini。"
        )
    if files:
        names = ", ".join((a.get("name") or "file") for a in files)
        note_bits.append(f"【系统】用户发了非图片附件（{names}），本阶段不解析文件内容。")
    return "\n".join(note_bits).strip()


async def handle_human_message(session: aiohttp.ClientSession, msg: dict) -> None:
    try:
        await apply_hot_settings(session, boot=False)
    except Exception:
        pass
    user_text = (msg.get("content") or "").strip()
    atts = msg.get("attachments") or []
    wake_meta = msg.get("self_wake") if isinstance(msg.get("self_wake"), dict) else None
    is_self_wake = bool(wake_meta) or (msg.get("type") or "") == "self_wake"
    jiwen_meta = msg.get("jiwen_contact") if isinstance(msg.get("jiwen_contact"), dict) else None
    is_jiwen_contact = bool(jiwen_meta) or (msg.get("type") or "") == "jiwen_contact"
    is_system_turn = is_self_wake or is_jiwen_contact
    if not user_text and not atts and not is_system_turn:
        return
    if is_self_wake and not user_text:
        user_text = "（自醒）"
    if is_jiwen_contact and not user_text:
        user_text = "（惦记）"

    mid = msg.get("id")
    sid = msg.get("session_id", "__legacy__")
    is_regen = (msg.get("type") or "") == "regen"
    try:
        gen_tok = int(msg["gen_token"]) if msg.get("gen_token") is not None else None
    except (TypeError, ValueError):
        gen_tok = None
    _session_gen_token[sid] = gen_tok
    if gen_tok is not None and int(_cancel_tokens.get(sid, 0)) < gen_tok:
        _cancel_tokens.pop(sid, None)
    tag = ""
    if is_regen:
        tag += " regen"
    if is_self_wake:
        tag += " wake"
    if is_jiwen_contact:
        tag += " jiwen"
    log("in", f"#{mid} [{sid}]{tag}: {(user_text or '[附件]')[:60]}")
    _t0 = time.monotonic()

    import model_router as mr
    route = mr.CHAT_ROUTES[0] if mr.CHAT_ROUTES else {}
    is_gemini = (route.get("protocol") or "").strip().lower() == "gemini"

    if _is_cancelled(sid):
        log("in", f"#{mid} skip (already cancelled)")
        return

    _turn_stage[sid] = "拼装"
    prev_hb = _turn_heartbeats.get(sid)
    if prev_hb and not prev_hb.done():
        prev_hb.cancel()
    _turn_heartbeats[sid] = asyncio.create_task(_turn_heartbeat(session, sid, _t0))

    # ① 记忆注入等与主链同步；情绪 observe 旁路异步（不挡回复）。
    # 语调只用库内已有情绪状态（滞后一拍）；本轮 observe 只改数字，供后续轮/tick。
    async def _noop_ctx():
        return None

    try:
        mid_int = int(mid) if mid is not None else None
    except (TypeError, ValueError):
        mid_int = None

    memory_coro = (
        inject_memories(user_text)
        if (INJECT_RELATED_MEMORY and user_text and not is_system_turn)
        else _noop_ctx()
    )
    state_coro = inject_current_state(user_text, sticky_entities=not is_gemini)
    weather_coro = inject_weather()

    memory_ctx, state_ctx, weather_ctx = await asyncio.gather(
        memory_coro, state_coro, weather_coro
    )
    log("perf", f"#{mid} mem-inject +{time.monotonic() - _t0:.2f}s")

    do_observe = bool(_AFFECT_ANALYZE_ON and user_text and not is_regen and not is_system_turn)
    if do_observe:
        async def _affect_observe_bg():
            try:
                result = await affect_observe(session, text=user_text, message_id=mid_int)
            except Exception as e:
                log("affect", f"#{mid} observe bg fail: {e}")
                return
            if not isinstance(result, dict) or not result.get("ok"):
                return
            d = result.get("delta") or {}
            tag = "skip" if result.get("skipped") else (
                "fallback" if result.get("fallback") else "delta"
            )
            log(
                "affect",
                f"#{mid} bg-{tag} "
                f"p={d.get('pride', 0)} v={d.get('valence', 0)} "
                f"a={d.get('arousal', 0)} c={d.get('connection', 0)}"
                + (" meta" if result.get("meta") else "")
                + (f" ({result.get('reason')})" if result.get("skipped") else ""),
            )

        asyncio.create_task(_affect_observe_bg())

    # 语调染色：总闸+tone 开 → 拉库内最新 style；关则不注入。
    # 不等本轮 observe（滞后一拍；desire/meta 本轮不强制）。
    clear_affect_style()
    if is_jiwen_contact and _AFFECT_TONE_ON:
        style = str((jiwen_meta or {}).get("styleGuidance") or "").strip()
        if style:
            set_affect_style(style)
            log("affect", f"#{mid} jiwen tone {style[:60]}")
    elif _AFFECT_TONE_ON and not is_self_wake:
        tech = _looks_like_tech(user_text or "")
        if tech:
            log("affect", f"#{mid} tone skip (tech)")
        else:
            style = ""
            st_axes = {}
            st = await affect_fetch_state(session)
            if isinstance(st, dict) and st.get("ok"):
                style = (st.get("styleGuidance") or "").strip()
                if isinstance(st.get("state"), dict):
                    st_axes = st["state"]
            pride = float(st_axes.get("pride") or 0) if st_axes else 0.0
            # 闸门由 memory_service 的 tone.shouldEmphasizeTone 统一决定；
            # 旧版 state 没有 emphasize 字段时回退到本地表达式，保证兼容。
            if isinstance(st, dict) and "emphasize" in st:
                emphasize = bool(st.get("emphasize"))
            else:
                emphasize = pride <= 0.12 or pride >= 0.50
            if style and emphasize:
                set_affect_style(style)
                log("affect", f"#{mid} tone(lag) {style[:60]}")
            elif style:
                log("affect", f"#{mid} tone skip (mid pride={pride:.2f})")
    if _is_cancelled(sid):
        return

    # ② 摄入：只收用户正文；纯附件 / 自醒 / 积温惦记不进 Scribe
    # regen 时 user 已在记忆库，跳过重复摄入
    if user_text and not is_regen and not is_system_turn:
        await ingest_to_memory(session, "user", user_text, msg.get("ts", ""), chat_id=sid)
    log("perf", f"#{mid} mem-ingest +{time.monotonic() - _t0:.2f}s")

    # ③ Snapshot：A 进 system；B = id > cutoff（首周期最多 FRESH_MAX 轮）
    try:
        skip_id = int(mid) if mid is not None else None
    except (TypeError, ValueError):
        skip_id = None
    history = await fetch_session_history(session, sid, limit=HISTORY_FETCH_CAP, exclude_id=skip_id)
    log("perf", f"#{mid} fetch-history +{time.monotonic() - _t0:.2f}s")
    turn = await _build_user_turn(session, user_text, atts)
    if not turn:
        await send_reply(session, "(没能读到这条消息，请再发一次。)", session_id=sid, ingest=False)
        return

    snap_entry = snap.get_entry(sid)

    # 固化「滞后一拍」：新消息到来时才把「已确认的完成轮次」收进 A 区。
    # 当前 user 还未确认，永远留在动态 B 区 → 回退/重生成最近一轮不会出现
    # 「Cache 有、库里已删」的幽灵。A 区永远绑定当前 session_id，绝不跨对话拉全局。
    # 新会话/过期/缺失也走同一条重建管道。
    need_consolidate = snap.should_consolidate(sid)
    need_cache = is_gemini and _gemini_uses_generate() and _cache_needs_rebuild(sid)
    if need_consolidate or need_cache:
        if snap.begin_consolidate(sid) is not None:
            try:
                await _rebuild_a_and_cache(
                    session, sid, history,
                    reason="consolidate" if need_consolidate else "ensure-cache",
                )
                snap_entry = snap.get_entry(sid)
            except Exception as e:
                log("warn", f"#{mid} 固化/重建失败（本轮降级）: {e}")
                snap.abort_consolidate(sid)

    _apply_snapshot_to_context(snap_entry)

    # 事件线兜底：blob 无当日事件线时拉一次（航海摘要已弃，不再注入）
    if not (snap_entry.get("local_a_blob") or {}).get("daily_events"):
        activity_log = await fetch_activity_log(session)
        if activity_log:
            set_activity_log(activity_log)

    # 日程：A 区「当天不变」——有 blob 则用固化稿；仅冷启动缺失时拉一次并写回
    blob_sched = ((snap_entry.get("local_a_blob") or {}).get("schedule") or "").strip()
    if "schedule" not in (snap_entry.get("local_a_blob") or {}):
        schedule_ctx = (await inject_schedule()) or ""
        set_schedule_log(schedule_ctx)
        snap.patch_a_schedule(sid, schedule_ctx)
    else:
        set_schedule_log(blob_sched)

    cutoff = int(snap_entry.get("snapshot_cutoff_id") or 0)
    if cutoff > 0:
        history = snap.filter_history_after_cutoff(history, cutoff)
        log("snap", f"#{mid} B-zone id>{cutoff} msgs={len(history)}")
    else:
        history = snap.take_last_n_rounds(history, snap.FRESH_MAX_ROUNDS)

    wake_block = ""
    if is_self_wake:
        wake_block = format_self_wake_block(
            (wake_meta or {}).get("note") or (wake_meta or {}).get("message")
        )
    jiwen_block = ""
    if is_jiwen_contact:
        c_raw = (jiwen_meta or {}).get("connection")
        try:
            c_val = float(c_raw) if c_raw is not None else None
        except (TypeError, ValueError):
            c_val = None
        jiwen_block = format_jiwen_contact_block(
            silence_label=(jiwen_meta or {}).get("silence_label"),
            connection=c_val,
            style=(jiwen_meta or {}).get("styleGuidance"),
            description=(jiwen_meta or {}).get("description"),
            desperate=bool((jiwen_meta or {}).get("desperate")),
        )

    history.append({
        "role": "user",
        "content": wrap_current_user(
            turn,
            memory_context=memory_ctx if isinstance(memory_ctx, str) else "",
            current_state=state_ctx if isinstance(state_ctx, str) else "",
            weather_context=weather_ctx if isinstance(weather_ctx, str) else "",
            self_wake_context=wake_block,
            jiwen_contact_context=jiwen_block,
        ),
    })
    log("perf", f"#{mid} snap-assemble +{time.monotonic() - _t0:.2f}s")

    if is_gemini:
        import gemini_interaction_state as gis
        has_ix = bool(gis.get_interaction_id(
            sid,
            base=route.get("base") or "",
            model=route.get("model") or "",
        ))
        if not has_ix:
            log("ix", f"#{mid} bootstrap via Snapshot A+B (no ix id)")

    messages = build_messages(
        history=snap.strip_history_meta(history),
        gemini=is_gemini,
    )
    # 调试开关：=1 时打印拼装后的完整 system prompt，便于查看各段提示词
    if DEBUG_SYSTEM_PROMPT:
        print(f"[{beijing_now().strftime('%H:%M:%S')}] [sys] 完整 system prompt:\n{messages[0]['content']}\n{'=' * 60}", file=sys.stderr, flush=True)

    # ④ 工具调用循环（最多 8 轮）
    _turn_llm_calls[sid] = 0          # 本轮调用计数归零，最终回复时写进 meta
    name_counts: dict[str, int] = {}
    gemini_tool_results: list[dict] | None = None
    gemini_generate = is_gemini and _gemini_uses_generate()
    want_google_search = False
    if is_gemini and not is_system_turn:
        try:
            import grounding_search as gs
            if gs.search_enabled_by_env() and _FEATURE_GROUNDING:
                quota = await gs.fetch_quota()
                # 并且：额度够则每轮挂 search（与自定义工具并存）；模型自己决定是否搜
                want_google_search = bool(quota.get("allowed"))
                if want_google_search:
                    log(
                        "search",
                        f"#{mid} search armed used={quota.get('used')}/{quota.get('limit')}",
                    )
                else:
                    log(
                        "search",
                        f"grounding gated used={quota.get('used')}/{quota.get('limit')}",
                    )
        except Exception as e:
            log("warn", f"grounding quota check fail: {e}")
            want_google_search = False
        # Cache 内 bake 的 search 标记须与本轮一致；不一致则清指针本轮整包
        if gemini_generate:
            entry = snap.get_entry(sid)
            if (entry.get("cache_name") or "").strip():
                baked = bool(entry.get("cache_google_search"))
                if baked != want_google_search:
                    old = (entry.get("cache_name") or "").strip()
                    snap.clear_cache_meta(sid)
                    log(
                        "search",
                        f"[{sid}] cache search mismatch "
                        f"baked={baked} want={want_google_search} → clear",
                    )
                    if want_google_search or baked:
                        # 后台按当前额度重建（本轮已无 Cache）
                        blob = entry.get("local_a_blob") or {}
                        if blob.get("voyage") or blob.get("hot3"):
                            asyncio.create_task(
                                _publish_explicit_cache(
                                    sid,
                                    voyage=(blob.get("voyage") or ""),
                                    daily=(blob.get("daily_events") or ""),
                                    hot3=list(blob.get("hot3") or []),
                                    schedule=(blob.get("schedule") or ""),
                                    old_cache_name=old,
                                )
                            )
    pusher: _StreamPush | None = None
    try:
        for round_idx in range(MAX_TOOL_ROUNDS + 1):
            if _is_cancelled(sid):
                log("in", f"#{mid} aborted before llm-round{round_idx + 1}")
                return
            _turn_stage[sid] = "生成"
            turn_meta: dict = {}
            llm_kw: dict = {
                "tools": MEMORY_TOOLS,
                "turn_meta": turn_meta,
            }
            pusher = None
            if is_gemini:
                llm_kw["stream"] = False
                llm_kw["session_id"] = sid
                llm_kw["google_search"] = want_google_search
                if (not gemini_generate) and gemini_tool_results:
                    llm_kw["tool_results"] = gemini_tool_results
                if gemini_generate and STREAM_ENABLED:
                    pusher = _StreamPush(session, sid)
                    llm_kw["on_thought"] = pusher.on_thought
                    llm_kw["on_text"] = pusher.on_text
                    llm_kw["should_abort"] = lambda: _is_cancelled(sid)
            else:
                llm_kw["stream"] = STREAM_ENABLED
                if STREAM_ENABLED:
                    pusher = _StreamPush(session, sid)
                    llm_kw["on_text"] = pusher.on_text
                    llm_kw["should_abort"] = lambda: _is_cancelled(sid)
            text, tool_calls, reasoning = await call_llm(messages, **llm_kw)
            if _is_cancelled(sid):
                log("in", f"#{mid} aborted after llm-round{round_idx + 1}")
                return
            gemini_tool_results = None
            log("perf", f"#{mid} llm-round{round_idx + 1} +{time.monotonic() - _t0:.2f}s")

            sg = turn_meta.get("search_grounding") if isinstance(turn_meta, dict) else None
            if isinstance(sg, dict) and int(sg.get("count") or 0) > 0:
                try:
                    import grounding_search as gs
                    await gs.consume(int(sg["count"]))
                    act_text, act_meta = gs.build_act_payload(sg)
                    await send_reply(
                        session, act_text, kind="act", session_id=sid, meta=act_meta,
                    )
                    log(
                        "search",
                        f"#{mid} grounding +{sg.get('count')} "
                        f"reason={sg.get('reason')} q={sg.get('queries')}",
                    )
                except Exception as se:
                    log("warn", f"grounding act/consume fail: {se}")

            if tool_calls:
                # 有工具调用 → 执行后继续下一轮
                if pusher:
                    await pusher.clear()
                    pusher = None
                _turn_stage[sid] = "查记忆"
                tc_names = [tc["function"]["name"] for tc in tool_calls]
                log("tool", f"第 {round_idx + 1} 轮: {tc_names}")
                # 发「进行中」act 卡片，让前端实时看到 AI 在调用工具
                active_label = ACT_LABELS.get(tc_names[0], (f"正在调用 {tc_names[0]}", ""))[0] if len(tc_names) == 1 else "正在更新对你的了解"
                act_glyph = "weather" if tc_names == ["get_weather"] else "memory"
                await send_reply(session, active_label, kind="act", session_id=sid, meta={"glyph": act_glyph})
                act_steps = []
                act_failed = False
                gemini_tool_results = []
                # OpenAI 路径 + Gemini generate：工具结果写回 messages
                use_msg_tools = (not is_gemini) or gemini_generate
                if use_msg_tools:
                    assistant_msg = {
                        "role": "assistant",
                        "content": text or None,
                        "tool_calls": tool_calls,
                    }
                    if reasoning:
                        assistant_msg["reasoning_content"] = reasoning
                    messages.append(assistant_msg)
                for tc in tool_calls:
                    if _is_cancelled(sid):
                        return
                    name = tc["function"]["name"]
                    name_counts[name] = name_counts.get(name, 0) + 1
                    if name_counts[name] > MAX_TOOL_ATTEMPTS:
                        log("tool", f"  -> {name}: 连续调用超 {MAX_TOOL_ATTEMPTS} 次，止损不再执行")
                        result = {
                            "tool_call_id": tc.get("id", ""),
                            "role": "tool",
                            "content": "该工具已连续调用 2 次仍未成功，已停止重试。请不要继续调用工具，直接回复用户说明当前情况。",
                        }
                    else:
                        result = await execute_tool(tc)
                    log("tool", f"  -> {name}: {result['content'][:60]}")
                    log("perf", f"#{mid} tool-exec({name}) +{time.monotonic() - _t0:.2f}s")
                    # 天气卡要展示实况，明细留长一点；其它工具仍截短
                    clip = 400 if name == "get_weather" else 200
                    act_steps.append({"tool": name, "result": result["content"][:clip]})
                    if result["content"].startswith(ACT_FAIL_PREFIXES):
                        act_failed = True
                    if is_gemini and not gemini_generate:
                        gemini_tool_results.append({
                            "call_id": tc.get("id") or "",
                            "name": name,
                            "result_text": result["content"],
                        })
                    else:
                        messages.append({
                            "role": "tool",
                            "tool_call_id": result["tool_call_id"],
                            "content": result["content"],
                        })
                # 发「完成」act 卡片（天气标题用实况摘要；可展开看明细）
                done_text = _act_done_label(tc_names, act_steps, act_failed)
                await send_reply(
                    session, done_text, kind="act", session_id=sid,
                    meta={"glyph": act_glyph, "steps": act_steps},
                )
                continue

            # 无工具调用 → 最终回复
            skip_snap = False
            if not (text or "").strip():
                if is_self_wake or is_jiwen_contact:
                    log(
                        "wake" if is_self_wake else "jiwen",
                        f"#{mid} silent (model chose not to speak)",
                    )
                    return
                text = _EMPTY_REPLY
                skip_snap = True
                log("warn", f"#{mid} empty model text → fallback reply")
            stream_meta = {"stream_id": pusher.stream_id} if pusher else None
            if reasoning and str(reasoning).strip():
                think_result = await send_reply(
                    session, str(reasoning).strip(), kind="thinking", session_id=sid,
                    meta=stream_meta,
                )
                if pusher and not (think_result or {}).get("dropped"):
                    pusher.thought_live = False
            out_meta: dict = {"llm_calls": _turn_llm_calls.get(sid, 0)}
            if stream_meta:
                out_meta.update(stream_meta)
            if is_self_wake:
                out_meta["kind_hint"] = "self_wake"
                out_meta["proactive"] = True
                aid = (wake_meta or {}).get("id")
                if aid is not None:
                    out_meta["alarm_id"] = aid
            if is_jiwen_contact:
                out_meta["kind_hint"] = "jiwen_contact"
                out_meta["proactive"] = True
                tid = (jiwen_meta or {}).get("id")
                if tid is not None:
                    out_meta["trigger_id"] = tid
            reply_result = await send_reply(
                session, text, session_id=sid,
                meta=out_meta,
                ingest=not skip_snap,
            )
            if pusher and not (reply_result or {}).get("dropped"):
                pusher.reply_live = False
            log("perf", f"#{mid} out +{time.monotonic() - _t0:.2f}s")
            # Snapshot：只计轮；固化改到「下一条消息到来时」（滞后一拍，防幽灵）
            if (
                not skip_snap
                and not _is_cancelled(sid)
                and text
                and reply_result
                and not reply_result.get("dropped")
            ):
                try:
                    snap.note_ai_reply(sid, reply_result.get("id"))
                except Exception as se:
                    log("warn", f"snapshot 计轮失败（不影响本轮）: {se}")
            # 15k ix 截断仅 Interactions 回滚路径需要；generateContent 靠 10 轮 Snapshot
            if is_gemini and (not gemini_generate) and not _is_cancelled(sid):
                try:
                    await maybe_reset_gemini_cycle(
                        session, sid,
                        base=route.get("base") or "",
                        model=route.get("model") or "",
                    )
                except Exception as re:
                    log("warn", f"ix-reset 失败（不影响本轮回复）: {re}")
            return

        # 超过最大轮次仍在调工具 → 告知用户
        await send_reply(session, "(工具调用次数过多，已停止。请再说一次你的问题。)", session_id=sid)

    except asyncio.CancelledError:
        log("in", f"#{mid} task cancelled [{sid}]")
        raise
    except Exception as e:
        if _is_cancelled(sid):
            log("in", f"#{mid} error ignored (cancelled): {e}")
            return
        log("err", f"生成失败: {e}")
        err_text = f"(抱歉，出了点问题: {e})"
        await send_reply(session, err_text, session_id=sid)
    finally:
        # 没定稿就结束（停止 / 出错 / 沉默 / 定稿被丢弃）→ 让前端草稿淡出
        if pusher and (pusher.thought_live or pusher.reply_live):
            try:
                await pusher.clear()
            except BaseException:
                pass


# =============================================================================
# SSE 入站流：GET /channel/in（断线自动重连）
# =============================================================================

async def _run_turn(session: aiohttp.ClientSession, msg: dict) -> None:
    sid = msg.get("session_id", "__legacy__")
    # 同会话新一轮到来时取消旧任务（用旧 gen，勿用新消息的 token）
    prev = _active_tasks.get(sid)
    if prev and not prev.done():
        _request_cancel(sid, _session_gen_token.get(sid))
        try:
            await prev
        except (asyncio.CancelledError, Exception):
            pass
    task = asyncio.current_task()
    _active_tasks[sid] = task
    try:
        await handle_human_message(session, msg)
    except asyncio.CancelledError:
        pass
    finally:
        hb = _turn_heartbeats.pop(sid, None)
        if hb and not hb.done():
            hb.cancel()
        _turn_stage.pop(sid, None)
        if _active_tasks.get(sid) is task:
            _active_tasks.pop(sid, None)


async def stream_inbound(session: aiohttp.ClientSession, cursor: int) -> None:
    """SSE 长连接：订阅所有 session 的人类消息（relay 兼容路径，session_id=None），全局游标存 DEFAULT_SESSION_ID。
    新对话（新建 session）的消息 id 更大，天然会被拉取，无需重启 AI 大脑。"""
    backoff = 1  # 重连退避秒数
    while True:
        try:
            url = f"{RELAY_URL}/channel/in?since={cursor}"
            headers = {**_auth_headers, "Accept": "text/event-stream"}
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=0, sock_read=90)) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    log("err", f"SSE HTTP {resp.status}: {body[:200]}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 15)
                    continue

                log("in", f"SSE 已连接 (since={cursor}, 全局会话)")
                backoff = 1
                data_lines: list[str] = []

                # 逐行读取 SSE 流
                async for raw in resp.content:
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                    elif line == "":  # 空行 = SSE 帧结束
                        if not data_lines:
                            continue
                        payload_str = "\n".join(data_lines)
                        data_lines = []
                        try:
                            m = json.loads(payload_str)
                        except json.JSONDecodeError:
                            continue
                        if m.get("type") == "ping":
                            continue
                        # 停止生成（无消息 id）
                        if m.get("type") == "cancel":
                            sid = m.get("session_id") or DEFAULT_SESSION_ID
                            _request_cancel(sid, m.get("cancel_token"))
                            continue
                        # regen：不依赖 cursor（user id 可能已处理过）
                        if m.get("type") == "regen" and "id" in m:
                            asyncio.create_task(_run_turn(session, m))
                            continue
                        if "id" not in m:
                            continue
                        mid = int(m.get("id") or 0)
                        if mid <= cursor:
                            continue
                        # 并行任务：同会话可被后续 cancel / 新消息打断
                        asyncio.create_task(_run_turn(session, m))
                        cursor = mid
                        await write_cursor(session, DEFAULT_SESSION_ID, cursor)

            log("in", "SSE 流结束 → 重连")

        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            log("in", f"断开 ({e}) → {backoff}s 后重连")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 15)


# =============================================================================
# 主入口
# =============================================================================

async def main() -> None:
    _require_config()
    log("boot", (
        f"relay={RELAY_URL}  "
        f"models={[r['model'] for r in CHAT_ROUTES]}  "
        f"history_n={HISTORY_N_MIN}..{HISTORY_N_MAX}  "
        f"stream={STREAM_ENABLED}"
    ))

    async with aiohttp.ClientSession() as session:
        # 全局订阅所有 session 的消息（不再锁定单一 session，新对话自动响应）
        log("boot", "全局订阅所有 session")

        # 用量上报：队列在事件循环内建，再把钩子挂给 model_router
        global _usage_queue
        _usage_queue = asyncio.Queue(maxsize=USAGE_QUEUE_MAX)
        import model_router as _mr
        _mr.set_usage_hook(_on_llm_usage)
        usage_task = asyncio.create_task(usage_reporter(session))

        # 从 relay 读取全局游标（存 DEFAULT_SESSION_ID）
        cursor = await read_cursor(session, DEFAULT_SESSION_ID)

        # 暖启动：拉最新消息 ID，游标为 0 时初始化
        try:
            max_id = await warm_start(session)
            if cursor == 0:
                cursor = max_id
                await write_cursor(session, DEFAULT_SESSION_ID, cursor)
        except Exception as e:
            log("boot", f"暖启动跳过 ({e})")

        # 从 relay 拉取设置：启动时读内部接口（含真实 Key），之后每条消息热更新模型/温度/人设
        try:
            await apply_hot_settings(session, boot=True)
        except Exception as e:
            log("boot", f"从 relay 读取设置失败，使用 .env 默认值 ({e})")

        # 从记忆服务拉取工具定义 + 使用教导 + 记忆屏障块
        # （失败时 tool_dispatcher 保持本地回退副本，向后兼容）
        try:
            if await td.load_tools_from_backend():
                set_tool_guidance(td.TOOL_GUIDANCE)
                set_memory_barrier(td.MEMORY_BARRIER)
                log("boot", f"工具定义已从记忆服务加载: {len(MEMORY_TOOLS)} 个工具")
            else:
                log("boot", f"工具定义拉取失败（{MEMORY_URL}/tools/definitions），使用本地回退")
        except Exception as e:
            log("boot", f"工具定义拉取异常: {e}")

        # 主动关怀调度（纯数学时钟；与 SSE 主循环并行）+ 自醒旁路 + 积温完整一轮
        from proactive_scheduler import run_proactive_loop

        def _silence_label_from_minutes(mins) -> str:
            try:
                m = float(mins)
            except (TypeError, ValueError):
                return "未知"
            if m < 60:
                return f"约 {int(round(m))} 分钟"
            return f"约 {m / 60:.1f} 小时"

        async def _on_self_wake(session, alarm: dict, session_id: str) -> bool:
            note = (alarm.get("note") or alarm.get("message") or "").strip()
            sid = session_id or "__legacy__"
            # 免费 act 卡：让你看见他醒了 + 当时留言（不调模型）
            shown = note if len(note) <= 40 else (note[:39] + "…")
            act_label = f"醒了一下：「{shown}」" if shown else "醒了一下"
            try:
                await send_reply(
                    session,
                    act_label,
                    kind="act",
                    session_id=sid,
                    meta={
                        "glyph": "wake",
                        "kind_hint": "self_wake",
                        "alarm_id": alarm.get("id"),
                        "note": note,
                        "steps": (
                            [{"tool": "self_wake", "result": f"留给自己的留言：「{note}」"}]
                            if note else []
                        ),
                    },
                    ingest=False,
                )
            except Exception as e:
                log("warn", f"self_wake act card failed: {e}")
            msg = {
                "id": f"wake-{alarm.get('id')}",
                "content": "（自醒）",
                "session_id": sid,
                "type": "self_wake",
                "self_wake": {"id": alarm.get("id"), "note": note},
            }
            try:
                await _run_turn(session, msg)
                return True
            except Exception as e:
                log("err", f"self_wake turn failed: {e}")
                return False

        async def _on_jiwen_contact(session, pending: dict, session_id: str) -> bool:
            """积温 contact → act 底线卡 + 完整 bridge 一轮（复用 A 区）。"""
            sid = session_id or "__legacy__"
            tid = pending.get("id")
            silence = _silence_label_from_minutes(pending.get("silence_minutes"))
            # 若调度没带静默分钟，补拉一次 state
            if silence == "未知":
                try:
                    st = await affect_fetch_state(session)
                    lm = (st or {}).get("lastMessage") or {}
                    if lm.get("minutesSince") is not None:
                        silence = _silence_label_from_minutes(lm.get("minutesSince"))
                        pending = {**pending, "silence_minutes": lm.get("minutesSince")}
                except Exception:
                    pass
            try:
                await send_reply(
                    session,
                    "惦记了一下",
                    kind="act",
                    session_id=sid,
                    meta={
                        "glyph": "memory",
                        "kind_hint": "jiwen_contact",
                        "trigger_id": tid,
                        "steps": [
                            {
                                "tool": "jiwen_contact",
                                "result": f"静默 {silence}；connection≈{pending.get('connection')}",
                            }
                        ],
                    },
                    ingest=False,
                )
            except Exception as e:
                log("warn", f"jiwen act card failed: {e}")
            msg = {
                "id": f"jiwen-{tid}",
                "content": "（惦记）",
                "session_id": sid,
                "type": "jiwen_contact",
                "jiwen_contact": {
                    "id": tid,
                    "connection": pending.get("connection"),
                    "desperate": bool(pending.get("desperate") or pending.get("forced")),
                    "styleGuidance": pending.get("styleGuidance") or "",
                    "description": pending.get("description") or "",
                    "silence_label": silence,
                    "silence_minutes": pending.get("silence_minutes"),
                },
            }
            try:
                await _run_turn(session, msg)
                return True
            except Exception as e:
                log("err", f"jiwen turn failed: {e}")
                return False

        def _is_session_busy(session_id: str) -> bool:
            t = _active_tasks.get(session_id)
            return bool(t and not t.done())

        care_task = asyncio.create_task(
            run_proactive_loop(
                session,
                relay_url=RELAY_URL,
                memory_url=MEMORY_URL,
                auth_headers=_auth_headers,
                on_self_wake=_on_self_wake,
                on_jiwen_contact=_on_jiwen_contact,
                is_session_busy=_is_session_busy,
            )
        )
        try:
            await stream_inbound(session, cursor)
        finally:
            for task in (care_task, usage_task):
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("boot", "收到中断信号，退出")