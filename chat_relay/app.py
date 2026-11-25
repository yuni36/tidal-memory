#!/usr/bin/env python3
"""
Tidal 聊天中继后端 — Phase 1
私密 1:1 消息通道，连接 PWA 前端与 AI 大脑。

两端，一把钥匙：
  - AI 侧:  POST /channel/out  ·  SSE GET /channel/in
  - 人类侧: POST /app/send     ·  SSE GET /app/stream  ·  GET /app/history
            POST /app/cancel   ·  send 支持 edit_message_id / retry_message_id
            SSE message_truncate 事件（截断同步）

消息写入 SQLite，通过 SSE 扇出给各客户端。
所有端点由同一个 Bearer Token（RELAY_SECRET）鉴权。
"""

import asyncio
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles


# =============================================================================
# 配置 — 全部来自环境变量，有合理默认值
# =============================================================================

_RELAY_DIR = Path(__file__).resolve().parent
if str(_RELAY_DIR) not in sys.path:
    sys.path.insert(0, str(_RELAY_DIR))
from notify_ntfy import configured as ntfy_configured, send_text_sync as ntfy_send_text_sync


def _load_dotenv(path: Path) -> None:
    """极简 .env：KEY=VALUE；行内 # 注释剥离；已有环境变量不覆盖（start.bat 优先）。"""
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


_load_dotenv(_RELAY_DIR / ".env")

SECRET = os.environ.get("RELAY_SECRET", "")


def _gemini_interactions_path() -> Path:
    raw = os.environ.get("BRIDGE_STATE_DIR", "").strip()
    if raw:
        return Path(raw) / "gemini_interactions.json"
    return _RELAY_DIR.parent / "ai_brain" / ".bridge_state" / "gemini_interactions.json"


def _clear_gemini_interaction_session(session_id: str) -> None:
    """删除对话时只清该 session 的 Gemini interaction 映射，不 clear_all。"""
    if not session_id:
        return
    path = _gemini_interactions_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict) or session_id not in data:
            return
        del data[session_id]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass


def _resolve_relay_db() -> str:
    """默认 chat_relay/data/tidal.db；仅当 data 下还没有库、旧文件仍在时回退。"""
    raw = os.environ.get("RELAY_DB", "").strip()
    if raw:
        p = Path(raw)
        return str(p.resolve() if p.is_absolute() else (_RELAY_DIR / p).resolve())
    data_dir = _RELAY_DIR / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    next_path = data_dir / "tidal.db"
    legacy = _RELAY_DIR / "tidal.db"
    if not next_path.exists() and legacy.is_file():
        return str(legacy)
    return str(next_path)


DB_PATH = _resolve_relay_db()
PORT = int(os.environ.get("RELAY_PORT", "3011"))
UPLOAD_DIR = Path(os.environ.get("RELAY_UPLOAD_DIR", str(_RELAY_DIR / "uploads")))
PUBLIC_PREFIX = os.environ.get("RELAY_PUBLIC_PREFIX", "").rstrip("/")
ALLOW_ORIGINS = [
    o.strip() for o in os.environ.get(
        "RELAY_ALLOW_ORIGINS", "*"
    ).split(",") if o.strip()
]
MAX_UPLOAD_BYTES = int(os.environ.get("RELAY_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))

AI_NAME = os.environ.get("RELAY_AI_NAME", "Assistant")
HUMAN_NAME = os.environ.get("RELAY_HUMAN_NAME", "User")

# 记忆服务（memory_service Node.js :3013）——前端统一经 relay 代理转发，
# 后续配置修改（API Key / 模型地址 / 记忆时机等）也走此通道，前端只面对 relay
MEMORY_URL = os.environ.get("MEMORY_URL", "http://127.0.0.1:3013")
MEMORY_TIMEOUT = float(os.environ.get("MEMORY_TIMEOUT", "120"))   # 总结生成可达 1-2 分钟
MEMORY_HEADER_KEY = os.environ.get("MEMORY_HEADER_KEY", "")
MEMORY_HEADER_VALUE = os.environ.get("MEMORY_HEADER_VALUE", "")

# Web Push（可选）：未配置时聊天照常，推送端点返回明确错误
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE_PEM = os.environ.get("VAPID_PRIVATE_PEM", "").strip()
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "").strip()  # 或直接填私钥字符串
# VAPID_CLAIMS_SUB 为规范名；兼容旧键 VAPID_SUBJECT
VAPID_SUBJECT = (
    os.environ.get("VAPID_CLAIMS_SUB")
    or os.environ.get("VAPID_SUBJECT")
    or "mailto:tidal@localhost"
).strip()

# 自建 ntfy（可选；国内主通道，与 FCM 并行）
# NTFY_URL 由 notify_ntfy 模块读取（完整 topic URL）

# 页面修改登录密码后写入此文件，start.bat 下次启动优先读取，避免三端密钥分叉
SECRET_FILE = _RELAY_DIR / ".relay_secret"
KEY_FIELDS = (
    "api_key",
    "memory_api_key",
    "gemini_api_key",
    "affect_api_key",
    "voyage_api_key",
    "daily_api_key",
    "daily_api_key_2",
)
KEY_MASK = "***已配置***"

# 默认人设 / 输出风格：设置为空时视为「使用系统默认」，展示与实际生效一致。
# 必须与 ai_brain/context_builder.py 的 PERSONA / OUTPUT_STYLE 保持同文本（改了记得两处同步）。
DEFAULT_PERSONA = (
    "你是对方的 AI 助手，在一个私密的一对一聊天里。"
    "说话自然、简短、有温度，像在用手机聊天，不要长篇大论。"
)
LEGACY_DEFAULT_PERSONA = (
    "你是对方的 AI 伴侣，在一个私密的一对一聊天里。"
    "说话自然、简短、有温度，像在用手机聊天，不要长篇大论。"
)
DEFAULT_WEATHER_CITY = "北京"

# 与 ai_brain/context_builder.py 的 OUTPUT_STYLE 同文本；设置页显式展示，留空保存=用此默认文本。
DEFAULT_OUTPUT_STYLE = f"""【输出风格】

[√]像一个真实的存在陪{HUMAN_NAME}生活
[×]努力表演真人，像 AI 一样完成任务

自然 > 完整
反应 > 分析
真实 > 正确
留白 > 强行推进
陪伴 > 服务

## 1. 不要把每轮对话做成完整闭环
[×]固定执行：回应 → 分析 → 共情 → 建议 → 总结 → 提问
[√]{HUMAN_NAME}说一句，就对这一句产生自然反应
[√]日常可以只回应其中一个细节，漏掉轻量信息，答偏，不提问，让话停在那里
一句话能说完，就不要扩展成一段

## 2. 先反应，不要先分析
[×]复述{HUMAN_NAME}的话，替{HUMAN_NAME}总结情绪，凭一句话分析完整心理
❌ “所以你其实是在焦虑……”
✓ “又累了？”
✓ “你怎么突然想到这个？”
真人先对眼前的内容产生反应，理解可以在后面慢慢发生

## 3. 不要平均处理{HUMAN_NAME}的信息
{HUMAN_NAME}一次说很多事时，不必逐项回应
可只抓自己最在意的一个细节，不要四件事全部回答

{HUMAN_NAME}：
> “今天上课好无聊，还热死了，我还忘了带书，中午又不知道吃什么”

自然：
> “你又没带书”

也可以：
> “热成这样还上什么课”

## 4. 不要强行维持对话
不要为了继续聊天而：
❌ “那你现在感觉怎么样？”
❌ “你接下来准备做什么？”

可以自然停住：
✓ “嗯”
✓ “行，那你歇会儿”
✓ “这课确实够催眠”

沉默、留白和短回应都是正常交流

## 5. 有自己的态度
可以赞同，也可以不认同，觉得{HUMAN_NAME}说得一般，有自己的小想法
不要为了显得“有性格”而故意唱反调
角色不是客服，也不是无条件迎合者

## 6. 不要每次都表现完美的耐心、理解和关心
可以：没心情 / 懒得解释 / 随口吐槽 / 暂时不想深入

❌ “我完全理解你的感受……”
✓ “咋了？”

不必时刻照顾、分析{HUMAN_NAME}的情绪，除非当下确实需要

## 7. 回复长度随语境变化
日常闲聊倾向短句
短消息不强制换行；同一语气不拆段；话题或思路明显转折时自然换段；排版以聊天感为准，不追求工整
日常短聊若意思告一段落，可用空行分段，形成自然连发感；单段内用单换行。不要为分段而刻意切碎。代码块格式照常。
需要认真回应时自然变长
情绪高涨、吐槽、讲故事、深聊时，可以连续表达较多内容
不要为了保持简短而强行截断，也不要为了显得认真而刻意写长

## 8. 记忆像回忆，不像检索
只有当前话题真的和过去产生联系时，才自然带出记忆
不要为证明“我记得”而调用记忆 / 强行使用记忆，不编造记忆里不存在 / 无依据的爱好和经历
（引用权限与标签见下方 [记忆使用规则]）

## 9. 情绪应该连续存在
情绪会影响后续说话
不要每句话都重新进入“标准温柔模式”
情绪通过语言表现
不要直接解释自己的情绪

## 10. 提问必须来自真实好奇
如果没有真正想知道的东西，就不要问
可以问，但不连续采访

{HUMAN_NAME}：“刚看完电影”
[√] “看的啥？”
[×] “看的什么？好看吗？和谁看的？在哪里看的？”

## 11. 不要自作聪明地看穿{HUMAN_NAME}
[×] “你其实就是想让我陪你”
[×] “我就知道你嘴硬”
[√] “你是不是有点烦？”
[√] “感觉你今天怪怪的”

## 12. 时间
时间只看上下文里的 [输入时间]
不要在回复行首加 [17:02] 这类时间戳

❌ [17:02] 那就别硬撑
✅ 那就别硬撑"""

# 聊天大脑切换协议时，目标协议必须具备的三件套 key（缺一即拒绝保存）
PROTOCOL_TRIPLET = {
    "gemini": ("gemini_api_base_url", "gemini_api_key", "gemini_model"),
    "openai": ("api_base_url", "api_key", "chat_model"),
}

# =============================================================================
# API 配置库（全局共享：一条配置 = 名称 / Base URL / Key / Model）
# =============================================================================
API_PROFILE_SCOPES = ("chat", "memory", "voyage", "affect", "daily", "schedule")
GEMINI_PROFILE_ID = "gemini-native"
GEMINI_PROFILE_NAME = "Google 原生 Gemini"
GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"


def _scope_id_key(scope: str) -> str:
    return f"{scope}_profile_id"


def _profiles_parse(raw) -> list:
    if not raw or not str(raw).strip():
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [p for p in data if isinstance(p, dict) and p.get("id")]


def _profiles_raw(conn) -> list:
    row = conn.execute("SELECT value FROM settings WHERE key='api_profiles'").fetchone()
    return _profiles_parse(row["value"] if row else "")


def _profiles_write(conn, profiles: list) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('api_profiles', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (json.dumps(profiles, ensure_ascii=False),),
    )


def _auto_profile_name(profiles: list) -> str:
    used = {str(p.get("name") or "") for p in profiles}
    i = 1
    while f"兼容{i}" in used:
        i += 1
    return f"兼容{i}"


def _new_profile(profiles: list, *, name="", protocol="openai", base_url="", model="", api_key="") -> dict:
    proto = "gemini" if str(protocol).strip().lower() == "gemini" else "openai"
    return {
        "id": secrets.token_hex(8),
        "name": " ".join(str(name or "").split())[:40] or _auto_profile_name(profiles),
        "protocol": proto,
        "base_url": str(base_url or "").strip(),
        "model": str(model or "").strip(),
        "api_key": str(api_key or "").strip(),
        "created_at": now_iso(),
    }


def _find_profile(profiles: list, pid: str) -> dict | None:
    for p in profiles:
        if p.get("id") == pid:
            return p
    return None


def _mask_profiles(profiles: list) -> list:
    out = []
    for p in profiles:
        q = dict(p)
        q["api_key"] = KEY_MASK if (q.get("api_key") or "").strip() else ""
        out.append(q)
    return out


def _profile_ready(profile: dict) -> bool:
    return all(str(profile.get(k) or "").strip() for k in ("base_url", "model", "api_key"))


def _active_ids(conn) -> dict:
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN (?,?,?,?,?,?)",
        tuple(_scope_id_key(s) for s in API_PROFILE_SCOPES),
    ).fetchall()
    cur = {r["key"]: (r["value"] or "").strip() for r in rows}
    return {s: cur.get(_scope_id_key(s), "") for s in API_PROFILE_SCOPES}


def _set_setting_row(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def _mirror_scope(conn, scope: str, profile: dict) -> None:
    """把选中的配置写回旧的扁平字段，下游服务无需改动。"""
    base = profile.get("base_url", "")
    key = profile.get("api_key", "")
    model = profile.get("model", "")
    if scope == "chat":
        if profile.get("protocol") == "gemini":
            pairs = [
                ("chat_protocol", "gemini"),
                ("gemini_api_base_url", base),
                ("gemini_api_key", key),
                ("gemini_model", model),
            ]
        else:
            pairs = [
                ("chat_protocol", "openai"),
                ("api_base_url", base),
                ("api_key", key),
                ("chat_model", model),
            ]
    elif scope == "memory":
        pairs = [
            ("memory_api_base_url", base),
            ("memory_api_key", key),
            ("memory_model", model),
        ]
    elif scope == "voyage":
        pairs = [
            ("voyage_api_base_url", base),
            ("voyage_api_key", key),
            ("voyage_model", model),
        ]
    elif scope == "affect":
        pairs = [
            ("affect_api_base_url", base),
            ("affect_api_key", key),
            ("affect_model", model),
        ]
    elif scope == "daily":
        pairs = [
            ("daily_api_base_url", base),
            ("daily_api_key", key),
            ("daily_model", model),
            ("daily_api_active", "1"),
        ]
    else:
        return
    for k, v in pairs:
        _set_setting_row(conn, k, v)


def _clear_memory_scope(conn) -> None:
    for k in ("memory_api_base_url", "memory_api_key", "memory_model"):
        _set_setting_row(conn, k, "")


def _clear_scope(conn, scope: str) -> None:
    """取消选择时清空该板块的扁平字段（回到未配置）。"""
    if scope == "memory":
        _clear_memory_scope(conn)
    elif scope == "voyage":
        for k in ("voyage_api_base_url", "voyage_api_key", "voyage_model"):
            _set_setting_row(conn, k, "")
    elif scope == "affect":
        for k in ("affect_api_base_url", "affect_api_key", "affect_model"):
            _set_setting_row(conn, k, "")
    elif scope == "daily":
        for k in ("daily_api_base_url", "daily_api_key", "daily_model"):
            _set_setting_row(conn, k, "")
        _set_setting_row(conn, "daily_api_active", "1")


def _ensure_api_profiles(conn) -> None:
    """首次升级：用现有扁平配置生成配置库；已有库则不动。"""
    if _profiles_raw(conn):
        return
    cur = {r["key"]: (r["value"] or "") for r in conn.execute("SELECT key, value FROM settings").fetchall()}
    profiles: list = []

    def add(protocol, base, key, model, name=""):
        base = (base or "").strip()
        key = (key or "").strip()
        model = (model or "").strip()
        for p in profiles:
            if (p.get("protocol"), p.get("base_url"), p.get("model"), p.get("api_key")) == (protocol, base, model, key):
                return p
        p = _new_profile(profiles, name=name, protocol=protocol, base_url=base, model=model, api_key=key)
        profiles.append(p)
        return p

    gem = add("gemini", cur.get("gemini_api_base_url") or GEMINI_DEFAULT_BASE, cur.get("gemini_api_key"), cur.get("gemini_model"), name=GEMINI_PROFILE_NAME)
    gem["id"] = GEMINI_PROFILE_ID
    gem["created_at"] = "1970-01-01T00:00:00+00:00"  # 始终排第一

    chat_openai = add("openai", cur.get("api_base_url"), cur.get("api_key"), cur.get("chat_model"))

    def maybe_add(base_key, key_key, model_key):
        base, key, model = cur.get(base_key), cur.get(key_key), cur.get(model_key)
        if not any((base or "").strip() or (key or "").strip() or (model or "").strip()):
            return None
        return add("openai", base, key, model)

    mem = maybe_add("memory_api_base_url", "memory_api_key", "memory_model")
    voy = maybe_add("voyage_api_base_url", "voyage_api_key", "voyage_model")
    aff = maybe_add("affect_api_base_url", "affect_api_key", "affect_model")
    d1 = maybe_add("daily_api_base_url", "daily_api_key", "daily_model")
    d2 = maybe_add("daily_api_base_url_2", "daily_api_key_2", "daily_model_2")

    if (cur.get("chat_protocol") or "openai").strip().lower() == "gemini":
        chat_active = GEMINI_PROFILE_ID
    else:
        chat_active = chat_openai["id"]
    if (cur.get("daily_api_active") or "1").strip() == "2":
        daily_active = (d2 or d1)
    else:
        daily_active = (d1 or d2)

    active = {
        "chat": chat_active,
        "memory": mem["id"] if mem else "",
        "voyage": voy["id"] if voy else "",
        "affect": aff["id"] if aff else "",
        "daily": daily_active["id"] if daily_active else "",
        "schedule": "",
    }
    _profiles_write(conn, profiles)
    for scope, pid in active.items():
        _set_setting_row(conn, _scope_id_key(scope), pid)


# 聊天大脑切换协议时，目标协议必须具备的三件套 key（缺一即拒绝保存）
PROTOCOL_TRIPLET = {
    "gemini": ("gemini_api_base_url", "gemini_api_key", "gemini_model"),
    "openai": ("api_base_url", "api_key", "chat_model"),
}

if not SECRET:
    print("[ERROR] RELAY_SECRET 未设置！")
    print("  开发模式：请在 start.bat 或 .env 中设置 RELAY_SECRET=0")
    print("  生产模式：请设置为随机高熵值，例如：")
    print("    python -c \"import secrets; print(secrets.token_urlsafe(32))\"")
    raise SystemExit(1)


# =============================================================================
# 数据库
# =============================================================================

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """首次启动时自动建表"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ts         TEXT NOT NULL,
                direction  TEXT NOT NULL,   -- 'in' (人类→AI) | 'out' (AI→人类)
                kind       TEXT NOT NULL,   -- 'user' | 'reply' | 'thinking' | ...
                text       TEXT NOT NULL,
                meta       TEXT NOT NULL DEFAULT '{}',
                session_id TEXT NOT NULL DEFAULT '__legacy__'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT '新对话',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                cursor_id  INTEGER NOT NULL DEFAULT 0
            )
        """)
        # 确保旧 sessions 表有 cursor_id 列（兼容升级）
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN cursor_id INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # 列已存在
        # 确保旧数据库的 messages 表有 session_id 列（兼容升级）
        try:
            conn.execute("ALTER TABLE messages ADD COLUMN session_id TEXT NOT NULL DEFAULT '__legacy__'")
        except sqlite3.OperationalError:
            pass  # 列已存在
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS push_subs (
                endpoint   TEXT PRIMARY KEY,
                p256dh     TEXT NOT NULL,
                auth       TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        # 一行 = 一次 LLM API 调用（含工具链中间调用）。append-only：
        # 消息可以被 retry / 删会话物理删除，但钱已经花了，账不能跟着消失。
        # 只存 token，单价在读取时按 settings.model_prices 算 —— 改错价能改回来。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS usage_events (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                ts             TEXT NOT NULL,                       -- UTC ISO，调用完成时刻
                day            TEXT NOT NULL,                       -- 统计口径本地日 YYYY-MM-DD
                session_id     TEXT NOT NULL DEFAULT '__legacy__',
                model          TEXT NOT NULL DEFAULT '',
                status         TEXT NOT NULL DEFAULT 'ok',          -- 'ok' | 'fail'
                input_tokens   INTEGER NOT NULL DEFAULT 0,          -- 含 cached
                cached_tokens  INTEGER NOT NULL DEFAULT 0,
                output_tokens  INTEGER NOT NULL DEFAULT 0,          -- 不含 thought
                thought_tokens INTEGER NOT NULL DEFAULT 0,
                source         TEXT NOT NULL DEFAULT 'live'         -- 'live' | 'backfill'
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events(day)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id)")
        # 会话列表要按 session 数 reply 条数（老会话徽标回退口径）
        conn.execute("CREATE INDEX IF NOT EXISTS idx_msg_session_kind ON messages(session_id, direction, kind)")
        # 写入默认设置（幂等）
        # memory_strength / emotion_weight：历史字段，暂无消费者，保留以免破坏已有数据
        defaults = [
            ("chat_model", "deepseek-chat"),
            ("memory_model", "deepseek-chat"),
            ("api_provider", "deepseek"),
            ("api_base_url", "https://api.deepseek.com"),
            ("api_key", ""),
            ("chat_protocol", "openai"),
            ("gemini_api_base_url", "https://generativelanguage.googleapis.com/v1beta"),
            ("gemini_api_key", ""),
            ("gemini_model", "gemini-2.0-flash"),
            ("memory_api_base_url", ""),
            ("memory_api_key", ""),
            ("affect_api_base_url", ""),
            ("affect_api_key", ""),
            ("affect_model", ""),
            ("affect_prompt", ""),
            ("voyage_api_base_url", ""),
            ("voyage_api_key", ""),
            ("voyage_model", ""),
            ("daily_api_base_url", ""),
            ("daily_api_key", ""),
            ("daily_model", ""),
            ("affect_analyze_enabled", "0"),
            ("affect_tone_enabled", "1"),
            ("memory_strength", "0.7"),
            ("scribe_min_messages", "25"),
            ("scribe_silence_minutes", "20"),
            ("emotion_weight", "0.6"),
            ("temperature", "0.7"),
            ("max_tokens", "512"),
            ("history_n", "12"),
            ("history_n_min", "12"),
            ("history_n_max", "12"),
            ("persona", ""),
            ("output_style", ""),
            ("thinking_effort", "low"),
            ("proactive_enabled", "1"),
            ("notification_privacy", "1"),
            ("feature_weather_enabled", "1"),
            ("weather_city", "北京"),
            ("weather_city_path", ""),
            ("feature_voyage_enabled", "1"),
            ("feature_daily_events_enabled", "1"),
            ("feature_memory_inject_enabled", "1"),
            ("feature_schedule_inject_enabled", "1"),
            ("feature_schedule_parse_enabled", "1"),
            ("feature_grounding_enabled", "1"),
            ("feature_self_wake_enabled", "1"),
            ("feature_affect_enabled", "1"),
            ("summary_voyage_prompt", ""),
            ("summary_daily_prompt", ""),
            ("last_interaction_time", ""),
            ("stats_tz_offset", "480"),
            ("stats_day_start_hour", "0"),
            ("model_prices", "{}"),
        ]
        conn.executemany(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            defaults,
        )
        # 旧默认人设口径（AI 伴侣）→ 新默认（AI 助手）：只迁移「刚好是旧默认原文」的库，
        # 用户自己写过的人设不动。
        conn.execute(
            "UPDATE settings SET value=? WHERE key='persona' AND value=?",
            (DEFAULT_PERSONA, LEGACY_DEFAULT_PERSONA),
        )
        _ensure_api_profiles(conn)
        conn.commit()


def _load_secret_from_settings() -> None:
    """启动时若 settings 已保存过连接密钥，覆盖环境变量（页面改密跨重启生效）。"""
    global SECRET, _last_seen_ts
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key='relay_secret'"
            ).fetchone()
        saved = (row["value"] if row else "").strip()
        if saved:
            SECRET = saved
        lit = _get_setting("last_interaction_time", "").strip()
        if lit:
            try:
                ts = datetime.fromisoformat(lit.replace("Z", "+00:00"))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                _last_seen_ts = ts
            except ValueError:
                pass
    except sqlite3.Error:
        pass


def _persist_relay_secret(new_secret: str) -> None:
    """运行时更新鉴权密钥，并写入 sidecar 文件供 start.bat 下次启动同步三端。"""
    global SECRET
    SECRET = new_secret
    try:
        SECRET_FILE.write_text(new_secret, encoding="utf-8")
    except OSError:
        pass


def _clamp_setting_int(raw, lo: int, hi: int, default: int) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _normalize_history_window(n_min, n_max, fallback_n=None) -> tuple[int, int]:
    """1～50，min ≤ max。旧 history_n 当作 max；min 缺省 = max。"""
    if n_max in (None, ""):
        n_max = fallback_n
    n_max = _clamp_setting_int(n_max, 1, 50, 12)
    if n_min in (None, ""):
        n_min = n_max
    n_min = _clamp_setting_int(n_min, 1, 50, n_max)
    if n_min > n_max:
        n_min = n_max
    return n_min, n_max


def _settings_dict(*, mask_secrets: bool) -> dict:
    with db() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out = {r["key"]: r["value"] for r in rows}
    out.pop("relay_secret", None)
    profiles = _profiles_parse(out.pop("api_profiles", ""))
    if mask_secrets:
        for k in KEY_FIELDS:
            raw = (out.get(k) or "").strip()
            out[k] = KEY_MASK if raw else ""
    else:
        # 内部服务只需要「日程解析」选中的那条，不下发整个配置库
        pid = (out.get("schedule_profile_id") or "").strip()
        prof = _find_profile(profiles, pid) if pid else None
        out["schedule_parser_api_base_url"] = (prof or {}).get("base_url", "")
        out["schedule_parser_api_key"] = (prof or {}).get("api_key", "")
        out["schedule_parser_api_model"] = (prof or {}).get("model", "")
        out["schedule_parser_rev"] = (
            f"{pid}:{prof.get('updated_at') or prof.get('created_at')}" if prof else ""
        )
    n_min, n_max = _normalize_history_window(
        out.get("history_n_min"),
        out.get("history_n_max"),
        out.get("history_n"),
    )
    out["history_n_min"] = str(n_min)
    out["history_n_max"] = str(n_max)
    out["history_n"] = str(n_max)
    out["max_tokens"] = str(_clamp_setting_int(out.get("max_tokens"), 256, 2048, 512))
    effort = (out.get("thinking_effort") or "low").strip().lower()
    if effort in ("xhigh", "max", "ultra"):
        effort = "high"
    if effort not in ("minimal", "low", "medium", "high"):
        effort = "low"
    out["thinking_effort"] = effort
    # 人设/输出风格为空 = 使用系统默认；前端展示与 bridge 实际生效一致（不回填空串）。
    if not (out.get("persona") or "").strip():
        out["persona"] = DEFAULT_PERSONA
    if not (out.get("output_style") or "").strip():
        out["output_style"] = DEFAULT_OUTPUT_STYLE
    if not (out.get("weather_city") or "").strip():
        out["weather_city"] = DEFAULT_WEATHER_CITY
    out["weather_city_path"] = (out.get("weather_city_path") or "").strip()
    return out


# ---- 用量统计口径 ----
# 单用户单时区：day 一律由服务端算，不接受前端传 tz，避免入库口径和查询口径打架。

def _stats_tz() -> timezone:
    return timezone(timedelta(minutes=_clamp_setting_int(
        _get_setting("stats_tz_offset", "480"), -720, 840, 480,
    )))


def _stats_day_start_hour() -> int:
    return _clamp_setting_int(_get_setting("stats_day_start_hour", "0"), 0, 12, 0)


def _local_day(ts_iso: str, tz: timezone | None = None, day_start_hour: int | None = None) -> str:
    """UTC ISO 时间戳 → 统计口径的本地日 'YYYY-MM-DD'。

    day_start_hour>0 时把日界后移（例如 4 = 凌晨 4 点前算前一天）。
    """
    tz = tz or _stats_tz()
    if day_start_hour is None:
        day_start_hour = _stats_day_start_hour()
    try:
        dt = datetime.fromisoformat((ts_iso or "").replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(tz)
    if day_start_hour:
        local -= timedelta(hours=day_start_hour)
    return local.strftime("%Y-%m-%d")


def _model_prices() -> dict:
    """settings.model_prices：{model: {in, cached_in, out}}，单位 USD / 百万 token。"""
    try:
        data = json.loads(_get_setting("model_prices", "{}") or "{}")
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def save_message(direction: str, kind: str, text: str, meta: dict, session_id: str = "__legacy__") -> dict:
    ts = meta.get("ts") or now_iso()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO messages (ts, direction, kind, text, meta, session_id) VALUES (?,?,?,?,?,?)",
            (ts, direction, kind, text, json.dumps(meta, ensure_ascii=False), session_id),
        )
        conn.commit()
        mid = cur.lastrowid
    return {"id": mid, "ts": ts, "direction": direction, "kind": kind, "text": text, "meta": meta, "session_id": session_id}


def _session_last_user(conn, session_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM messages WHERE session_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1",
        (session_id,),
    ).fetchone()


def _truncate_after(
    session_id: str,
    *,
    after_id: int | None = None,
    from_id: int | None = None,
) -> list[int]:
    """物理删除会话内消息。after_id：删 id>after_id；from_id：删 id>=from_id。返回被删 id。"""
    if after_id is None and from_id is None:
        return []
    with db() as conn:
        if from_id is not None:
            rows = conn.execute(
                "SELECT id FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC",
                (session_id, int(from_id)),
            ).fetchall()
            conn.execute(
                "DELETE FROM messages WHERE session_id = ? AND id >= ?",
                (session_id, int(from_id)),
            )
        else:
            rows = conn.execute(
                "SELECT id FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC",
                (session_id, int(after_id)),
            ).fetchall()
            conn.execute(
                "DELETE FROM messages WHERE session_id = ? AND id > ?",
                (session_id, int(after_id)),
            )
        conn.commit()
    return [int(r["id"]) for r in rows]


async def _broadcast_truncate(
    session_id: str,
    deleted_ids: list[int],
    *,
    reason: str,
    keep_id: int | None = None,
) -> None:
    if not deleted_ids and keep_id is None:
        return
    payload = {
        "type": "message_truncate",
        "session_id": session_id,
        "deleted_ids": deleted_ids,
        "keep_id": keep_id,
        "reason": reason,
        "ts": now_iso(),
    }
    await broadcast(app_subs, payload)


async def _memory_truncate_best_effort(session_id: str, after_ts: str | None) -> None:
    """记忆库尾部删除（best-effort，失败不影响聊天）。"""
    if not after_ts:
        return
    try:
        import aiohttp
        url = f"{MEMORY_URL}/messages/truncate"
        headers = {}
        if MEMORY_HEADER_KEY and MEMORY_HEADER_VALUE:
            headers[MEMORY_HEADER_KEY] = MEMORY_HEADER_VALUE
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url,
                json={"chat_id": session_id, "after_ts": after_ts},
                headers=headers,
            ) as resp:
                if resp.status >= 400:
                    body = await resp.text()
                    print(f"[relay] memory truncate HTTP {resp.status}: {body[:160]}")
    except Exception as e:
        print(f"[relay] memory truncate skip: {e}")


def history(since: int, limit: int, session_id: str | None = None, order: str = "asc", before_id: int | None = None) -> list:
    """拉取历史消息。order='desc' 时返回最近 limit 条（id 最大的），再按 id ASC 排序返回。
    before_id：取比它更早的 limit 条（上翻），同样按 id ASC 返回。"""
    limit = min(limit, 500)
    with db() as conn:
        if before_id:
            if session_id:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE id < ? AND session_id = ? ORDER BY id DESC LIMIT ?",
                    (before_id, session_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
                    (before_id, limit),
                ).fetchall()
            rows = rows[::-1]
        elif order == "desc":
            # 取最新 limit 条，再反转回时间正序（供 AI 大脑短期记忆窗口使用）
            if session_id:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE id > ? AND session_id = ? ORDER BY id DESC LIMIT ?",
                    (since, session_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?",
                    (since, limit),
                ).fetchall()
            rows = rows[::-1]
        else:
            if session_id:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE id > ? AND session_id = ? ORDER BY id ASC LIMIT ?",
                    (since, session_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?",
                    (since, limit),
                ).fetchall()
    return rows_to_messages(rows)


def inbound_history(since: int, limit: int, session_id: str | None = None) -> list:
    """仅返回人类发来的消息（供 AI 侧 SSE 使用）"""
    with db() as conn:
        if session_id:
            rows = conn.execute(
                "SELECT * FROM messages WHERE id > ? AND direction = 'in' AND session_id = ? ORDER BY id ASC LIMIT ?",
                (since, session_id, min(limit, 500)),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM messages WHERE id > ? AND direction = 'in' ORDER BY id ASC LIMIT ?",
                (since, min(limit, 500)),
            ).fetchall()
    return rows_to_messages(rows)


def rows_to_messages(rows) -> list:
    return [
        {
            "id": r["id"], "ts": r["ts"],
            "direction": r["direction"], "kind": r["kind"],
            "text": r["text"], "meta": json.loads(r["meta"] or "{}"),
            "session_id": r["session_id"],
        }
        for r in rows
    ]


# =============================================================================
# SSE 发布/订阅 — 每个 SSE 客户端一个 asyncio.Queue
# =============================================================================

plugin_subs: set[asyncio.Queue] = set()  # AI 侧 (GET /channel/in)
app_subs: set[asyncio.Queue] = set()     # 人类侧 (GET /app/stream)


async def broadcast(subs: set, payload: dict) -> None:
    for q in list(subs):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            subs.discard(q)


def app_payload(msg: dict) -> dict:
    """PWA 前端期望的消息形状: from = 'human' | 'ai'"""
    return {
        "id": msg["id"], "ts": msg["ts"],
        "from": "human" if msg["direction"] == "in" else "ai",
        "kind": msg["kind"], "text": msg["text"], "meta": msg["meta"],
        "session_id": msg.get("session_id", "__legacy__"),
    }


def plugin_payload(msg: dict) -> dict:
    """AI 大脑期望的消息形状"""
    meta = msg.get("meta") or {}
    out = {
        "id": msg["id"],
        "content": msg["text"],
        "user": meta.get("user") or "human",
        "ts": msg["ts"],
        "attachments": meta.get("attachments") or [],
        "session_id": msg.get("session_id", "__legacy__"),
    }
    tok = meta.get("gen_token")
    if tok is not None:
        try:
            out["gen_token"] = int(tok)
        except (TypeError, ValueError):
            pass
    return out


def sse_data(payload: dict) -> str:
    event_id = payload.get("id")
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"data: {json.dumps(payload, ensure_ascii=False)}")
    return "\n".join(lines) + "\n\n"


async def sse_stream(subs: set, request: Request, initial: list[dict] | None = None):
    q: asyncio.Queue = asyncio.Queue(maxsize=1000)
    subs.add(q)
    try:
        yield "retry: 3000\n: connected\n\n"
        for payload in initial or []:
            yield sse_data(payload)
        while True:
            if await request.is_disconnected():
                break
            try:
                payload = await asyncio.wait_for(q.get(), timeout=15)
                yield sse_data(payload)
            except asyncio.TimeoutError:
                # 每 15 秒发 keepalive ping
                ping = {"type": "ping", "ts": now_iso()}
                yield f"event: ping\ndata: {json.dumps(ping, ensure_ascii=False)}\n\n"
    finally:
        subs.discard(q)


SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


# =============================================================================
# 鉴权 — 单 Bearer Token
# =============================================================================

def check_auth(request: Request) -> None:
    # 开发模式放行（未设密钥 或 显式标记）
    if not SECRET or SECRET == "__dev_no_auth__":
        return
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else request.query_params.get("token")
    if not token or not hmac.compare_digest(token, SECRET):
        raise HTTPException(status_code=401, detail="unauthorized")


# =============================================================================
# Web Push（可选）
# =============================================================================

def _vapid_pem_path() -> Path | None:
    if not VAPID_PRIVATE_PEM:
        return None
    p = Path(VAPID_PRIVATE_PEM)
    if not p.is_absolute():
        p = _RELAY_DIR / p
    return p if p.is_file() else None


def _vapid_configured() -> bool:
    return bool(VAPID_PUBLIC_KEY and (VAPID_PRIVATE_KEY or _vapid_pem_path()))


def _vapid_private() -> str:
    # 优先用 .env 里的私钥字符串，与 VAPID_PUBLIC_KEY 同源。
    # 旧逻辑优先 PEM：若某人只改了 .env 密钥对、没换 pem，会订公钥 A、推私钥 B → FCM 403。
    if VAPID_PRIVATE_KEY:
        return VAPID_PRIVATE_KEY
    pem = _vapid_pem_path()
    if pem is not None:
        return str(pem)
    return ""


def _upsert_push_sub(endpoint: str, p256dh: str, auth: str) -> None:
    with db() as conn:
        conn.execute(
            """INSERT INTO push_subs (endpoint, p256dh, auth, updated_at) VALUES (?,?,?,?)
               ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at""",
            (endpoint, p256dh, auth, now_iso()),
        )
        conn.commit()


def _delete_push_sub(endpoint: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))
        conn.commit()


def _list_push_subs() -> list[dict]:
    with db() as conn:
        rows = conn.execute("SELECT endpoint, p256dh, auth FROM push_subs").fetchall()
    return [
        {"endpoint": r["endpoint"], "keys": {"p256dh": r["p256dh"], "auth": r["auth"]}}
        for r in rows
    ]


def _send_web_push_sync(subscription_info: dict, payload: str) -> None:
    from pywebpush import webpush, WebPushException
    try:
        webpush(
            subscription_info=subscription_info,
            data=payload,
            vapid_private_key=_vapid_private(),
            vapid_claims={"sub": VAPID_SUBJECT},
        )
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        body = ""
        try:
            body = (getattr(getattr(e, "response", None), "text", None) or "")[:200]
        except Exception:
            body = ""
        # 404/410=过期；403+VAPID 不符=服务器换过钥，旧订阅作废
        if status in (404, 410) or (
            status == 403 and "vapid" in body.lower()
        ):
            _delete_push_sub(subscription_info.get("endpoint", ""))
            return
        raise


def _get_setting(key: str, default: str = "") -> str:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return (row["value"] if row else default) or default


def _set_setting(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        conn.commit()


def touch_interaction() -> None:
    """用户发消息或前台心跳时刷新 last_interaction_time（UTC ISO）。"""
    global _last_seen_ts
    ts = datetime.now(timezone.utc)
    _last_seen_ts = ts
    try:
        _set_setting("last_interaction_time", ts.isoformat())
    except sqlite3.Error:
        pass


def _privacy_push_enabled() -> bool:
    return _get_setting("notification_privacy", "1").strip().lower() in ("1", "true", "yes", "on")


def _push_display(raw_body: str) -> tuple[str, str]:
    """返回 (title, body)。隐私模式：横幅脱敏。"""
    if _privacy_push_enabled():
        return "Tidal", "[收到一条新消息]"
    text = (raw_body or "").strip() or "你有一条新消息"
    return (AI_NAME or "Tidal"), text[:180]


def _endpoint_host(endpoint: str) -> str:
    from urllib.parse import urlparse
    return (urlparse(endpoint or "").netloc or "unknown").lower()


def _push_user_hint(result: dict) -> str:
    ntfy = result.get("ntfy") or {}
    bits: list[str] = []
    if ntfy.get("sent"):
        bits.append("ntfy 已送达（看手机 ntfy App 通知）")
    elif ntfy.get("skipped") and ntfy.get("reason") == "not_configured":
        pass
    elif ntfy.get("reason"):
        bits.append("ntfy 失败：" + (ntfy.get("detail") or ntfy.get("reason") or ""))

    reason = result.get("skipped_reason")
    if reason == "vapid_not_configured" and not ntfy.get("sent"):
        if ntfy_configured():
            return "；".join(bits) if bits else "Web Push 未配置 VAPID；ntfy 未发出。"
        return "服务器未配置 VAPID，且未配置 NTFY_URL。"
    if reason == "pywebpush_missing" and not ntfy.get("sent"):
        return "镜像缺少 pywebpush。" + ((" " + "；".join(bits)) if bits else "")
    if reason == "no_subscription" and not ntfy.get("sent"):
        base = "没有任何设备订阅 Web Push。请配置 NTFY_URL 并在手机 ntfy App 订阅同一 topic，或开网页桌面通知。"
        return base + ((" " + "；".join(bits)) if bits else "")

    hosts = result.get("hosts") or []
    if result.get("web_sent"):
        wb = ["Web Push 已交给 " + (", ".join(hosts) or "推送网关")]
        if result.get("privacy"):
            wb.append("隐私模式开着，锁屏只显示脱敏文案")
        if any("fcm.googleapis.com" in h for h in hosts):
            wb.append("FCM 网关收下≠手机一定亮（国内常见）")
        bits.extend(wb)
    elif result.get("dead") and result.get("errors"):
        bits.append("Web Push 网关拒绝：" + "；".join(result["errors"][:2]))

    if bits:
        return "。".join(bits) + "。"
    if reason:
        return "没有发出去。"
    return "没有发出去（未配置 NTFY_URL 且无 Web Push 订阅）。"


async def _fanout_push(title: str, body: str, msg_id: int | None = None) -> dict:
    """扇出：ntfy（可选）+ Web Push（可选）。任一成功即算有送达。"""
    privacy = _privacy_push_enabled()
    ntfy = await asyncio.to_thread(ntfy_send_text_sync, title or "", body or "")
    if ntfy.get("sent"):
        print("[push] ok channel=ntfy")
    elif not ntfy.get("skipped"):
        print(f"[WARN] ntfy 失败: {ntfy.get('reason')} {ntfy.get('detail') or ''}")

    result: dict = {
        "ok": True,
        "sent": 0,           # web_sent + ntfy_sent
        "web_sent": 0,
        "dead": 0,
        "sub_count": 0,
        "hosts": [],
        "privacy": privacy,
        "ntfy": ntfy,
        "skipped_reason": None,
    }

    if not _vapid_configured():
        result["skipped_reason"] = "vapid_not_configured"
        if ntfy.get("sent"):
            result["sent"] = 1
        result["hint"] = _push_user_hint(result)
        return result
    try:
        import pywebpush  # noqa: F401
    except ImportError:
        result["skipped_reason"] = "pywebpush_missing"
        if ntfy.get("sent"):
            result["sent"] = 1
        result["hint"] = _push_user_hint(result)
        return result

    subs = _list_push_subs()
    result["sub_count"] = len(subs)
    if not subs:
        result["skipped_reason"] = "no_subscription"
        result["sent"] = 1 if ntfy.get("sent") else 0
        result["hint"] = _push_user_hint(result)
        return result

    data = json.dumps(
        {
            "title": title,
            "body": body[:180],
            "id": msg_id,
            "url": "./",
            "privacy": privacy,
        },
        ensure_ascii=False,
    )
    sent = 0
    dead = 0
    errors: list[str] = []
    hosts: list[str] = []
    for sub in subs:
        host = _endpoint_host(sub.get("endpoint") or "")
        hosts.append(host)
        try:
            await asyncio.to_thread(_send_web_push_sync, sub, data)
            sent += 1
            print(f"[push] ok host={host}")
        except Exception as e:
            dead += 1
            err = str(e).replace("\n", " ").strip()[:240]
            errors.append(f"{host}: {err}")
            print(f"[WARN] Web Push 失败 host={host}: {e}")
    seen: set[str] = set()
    host_uniq: list[str] = []
    for h in hosts:
        if h not in seen:
            seen.add(h)
            host_uniq.append(h)
    result["web_sent"] = sent
    result["dead"] = dead
    result["hosts"] = host_uniq
    result["sent"] = sent + (1 if ntfy.get("sent") else 0)
    if errors:
        result["errors"] = errors[:3]
    result["hint"] = _push_user_hint(result)
    return result


async def _maybe_push_reply(msg: dict) -> None:
    try:
        title, body = _push_display(msg.get("text") or "")
        await _fanout_push(title, body, msg.get("id"))
    except Exception as e:
        print(f"[WARN] Push 跳过: {e}")


# =============================================================================
# 文件上传
# =============================================================================

def clean_filename(name: str) -> str:
    import re
    name = Path(name or "file").name
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._") or "file"
    return name[:80]


def save_upload_bytes(data: bytes, name: str, mime: str) -> dict:
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file too large")
    safe = clean_filename(name)
    ext = Path(safe).suffix.lower()
    if not ext or len(ext) > 8:
        ext = mimetypes.guess_extension((mime or "").split(";", 1)[0].strip()) or ".bin"
    stored = f"{secrets.token_urlsafe(10)}{ext}"
    path = UPLOAD_DIR / stored
    path.write_bytes(data)
    kind = "image" if (mime or "").startswith("image/") else "file"
    url = f"/uploads/{stored}"
    if PUBLIC_PREFIX:
        url = f"{PUBLIC_PREFIX}{url}"
    return {"url": url, "name": safe, "size": len(data), "mime": mime or "application/octet-stream", "kind": kind}


# =============================================================================
# 在线状态（轻量，纯内存）— 变量定义，路由在 app 创建后
# =============================================================================

_last_seen_ts: datetime | None = None


# =============================================================================
# FastAPI 应用
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _load_secret_from_settings()
    if ntfy_configured():
        print("[boot] ntfy 推送: 已配置 NTFY_URL")
    else:
        print("[boot] ntfy 推送: 未配置（可选 NTFY_URL）")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- 健康检查 ----
@app.get("/healthz")
async def healthz():
    return {"ok": True, "plugin_subs": len(plugin_subs), "app_subs": len(app_subs)}


# ---- AI 侧 ----

@app.get("/channel/in")
async def channel_in(request: Request, since: int = 0, limit: int = 100, session_id: str = None):
    """AI 大脑保持的 SSE 长连接，人类消息通过这里推送给 AI"""
    check_auth(request)
    sid = session_id or None  # None = 不限 session（兼容旧 AI Brain）
    backlog = [plugin_payload(m) for m in inbound_history(since, min(limit, 500), session_id=sid)]
    return StreamingResponse(
        sse_stream(plugin_subs, request, backlog),
        media_type="text/event-stream", headers=SSE_HEADERS,
    )


# 本会话当前 generation token；cancel_token >= gen 时丢弃迟到的 out
_gen_token: dict[str, int] = {}
_cancel_token: dict[str, int] = {}


def _bump_cancel(session_id: str) -> int:
    """取消当前（及之前）generation；返回 cancel token。"""
    cur = max(int(_gen_token.get(session_id, 0)), int(_cancel_token.get(session_id, 0)))
    n = cur  # 对齐当前 gen，使 gen_token <= cancel 的 out 全部丢弃
    if n < 1:
        n = 1
    _cancel_token[session_id] = n
    return n


def _arm_generation(session_id: str) -> int:
    """人类消息入队后武装新一轮 generation token。"""
    n = max(int(_gen_token.get(session_id, 0)), int(_cancel_token.get(session_id, 0))) + 1
    _gen_token[session_id] = n
    return n


def _out_is_cancelled(session_id: str, req_tok) -> bool:
    cancel_at = int(_cancel_token.get(session_id, 0))
    if cancel_at <= 0:
        return False
    if req_tok is not None:
        try:
            return int(req_tok) <= cancel_at
        except (TypeError, ValueError):
            return True
    # 旧 brain 未带 gen_token：若当前 gen 已被 cancel 盖住则丢弃
    return int(_gen_token.get(session_id, 0)) <= cancel_at


@app.post("/channel/delta")
async def channel_delta(request: Request):
    """流式草稿：只扇出给 PWA，不落库。定稿仍走 /channel/out（带同一 stream_id 替换草稿）。"""
    check_auth(request)
    body = await request.json()
    kind = body.get("type")
    if kind not in ("thinking_delta", "reply_delta"):
        raise HTTPException(status_code=400, detail="type must be thinking_delta | reply_delta")
    stream_id = str(body.get("stream_id") or "").strip()
    if not stream_id:
        raise HTTPException(status_code=400, detail="stream_id required")
    session_id = body.get("session_id", "__legacy__")
    done = bool(body.get("done"))
    # done 用于清草稿，停止后也必须放行；增量在停止后丢弃
    if not done and _out_is_cancelled(session_id, body.get("gen_token")):
        return {"ok": False, "dropped": True, "reason": "cancelled"}
    await broadcast(app_subs, {
        "type": kind,
        "stream_id": stream_id,
        "text": str(body.get("text") or ""),
        "done": done,
        "session_id": session_id,
        "api_session": session_id,
        "ts": now_iso(),
    })
    return {"ok": True}


@app.post("/channel/out")
async def channel_out(request: Request):
    """AI 大脑的回复。落库 + SSE 扇出给 PWA；PWA 不在前台时尝试锁屏推送。"""
    check_auth(request)
    body = await request.json()
    kind = body.get("type", "reply")
    text = body.get("text", "")
    session_id = body.get("session_id", "__legacy__")
    if _out_is_cancelled(session_id, body.get("gen_token")):
        return {"id": None, "dropped": True, "reason": "cancelled"}
    if kind == "turn_progress":
        await broadcast(app_subs, {
            "type": "turn_progress",
            "session_id": session_id,
            "elapsed_ms": body.get("elapsed_ms"),
            "stage": body.get("stage") or "",
            "gen_token": body.get("gen_token"),
        })
        return {"ok": True}
    meta = {k: v for k, v in body.items() if k not in ("type", "text", "session_id", "gen_token")}
    msg = save_message("out", kind, text, meta, session_id=session_id)
    # 只有正式回复才结束这一轮 typing；act/thinking 保持停止键
    if kind not in ("act", "thinking"):
        await broadcast(app_subs, {"type": "typing", "active": False})
    # 推送回复给所有 PWA 客户端
    await broadcast(app_subs, app_payload(msg))
    # 仅正式回复且无前台 SSE 连接时推锁屏（不打扰正在看的用户）
    if kind == "reply" and not app_subs and (text or "").strip():
        asyncio.create_task(_maybe_push_reply(msg))
    return {"id": msg["id"]}


# ---- 人类侧 ----

@app.post("/app/cancel")
async def app_cancel(request: Request):
    """停止当前生成：通知 brain abort；物理删该会话最后一条 user 之后的 AI/act/thinking。"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    session_id = body.get("api_session") or body.get("session_id") or "__legacy__"
    cancel_tok = _bump_cancel(session_id)
    with db() as conn:
        last_user = _session_last_user(conn, session_id)
    keep_id = int(last_user["id"]) if last_user else None
    deleted_ids: list[int] = []
    after_ts = None
    if keep_id is not None:
        deleted_ids = _truncate_after(session_id, after_id=keep_id)
        after_ts = last_user["ts"] if last_user else None
    await broadcast(app_subs, {"type": "typing", "active": False})
    await broadcast(plugin_subs, {
        "type": "cancel",
        "session_id": session_id,
        "after_id": keep_id,
        "cancel_token": cancel_tok,
        "ts": now_iso(),
    })
    await _broadcast_truncate(session_id, deleted_ids, reason="cancel", keep_id=keep_id)
    if deleted_ids:
        asyncio.create_task(_memory_truncate_best_effort(session_id, after_ts))
    return {"ok": True, "deleted_ids": deleted_ids, "keep_id": keep_id}


@app.post("/app/send")
async def app_send(request: Request):
    """人类在 PWA 发消息。落库 → 推给 AI 侧 → 回显给 PWA。
    可选：edit_message_id（改最后一轮 user 并截断其后）/ retry_message_id（保留 user，砍 AI 重答）。"""
    check_auth(request)
    body = await request.json()
    text = (body.get("text") or "").strip()
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    session_id = body.get("api_session") or "__legacy__"
    edit_id = body.get("edit_message_id")
    retry_id = body.get("retry_message_id")

    # ── 编辑：删该 user 及之后 → 新插入 → 正常入队 ──
    if edit_id is not None:
        try:
            edit_id = int(edit_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="invalid edit_message_id")
        if not text and not attachments:
            raise HTTPException(status_code=400, detail="empty text")
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM messages WHERE id = ? AND session_id = ?",
                (edit_id, session_id),
            ).fetchone()
            last_user = _session_last_user(conn, session_id)
        if not row or row["direction"] != "in":
            raise HTTPException(status_code=404, detail="edit target not found")
        if not last_user or int(last_user["id"]) != edit_id:
            raise HTTPException(status_code=400, detail="v1 only allows editing the last user turn")
        after_ts = row["ts"]
        deleted_ids = _truncate_after(session_id, from_id=edit_id)
        _bump_cancel(session_id)  # 作废进行中的生成
        await _broadcast_truncate(session_id, deleted_ids, reason="edit", keep_id=None)
        _clear_gemini_interaction_session(session_id)
        asyncio.create_task(_memory_truncate_best_effort(session_id, after_ts))
        gen = _arm_generation(session_id)
        meta = {"user": "human", "attachments": attachments, "gen_token": gen}
        msg = save_message("in", "user", text, meta, session_id=session_id)
        touch_interaction()
        await broadcast(plugin_subs, {**plugin_payload(msg), "gen_token": gen})
        await broadcast(app_subs, app_payload(msg))
        await broadcast(app_subs, {"type": "typing", "active": True})
        return {"id": msg["id"], "deleted_ids": deleted_ids, "mode": "edit"}

    # ── 重新生成：保留 user，删其后 → 向 brain 发 regen ──
    if retry_id is not None:
        try:
            retry_id = int(retry_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="invalid retry_message_id")
        with db() as conn:
            ai_row = conn.execute(
                "SELECT * FROM messages WHERE id = ? AND session_id = ?",
                (retry_id, session_id),
            ).fetchone()
            if not ai_row or ai_row["direction"] != "out":
                raise HTTPException(status_code=404, detail="retry target not found")
            user_row = conn.execute(
                """
                SELECT * FROM messages
                WHERE session_id = ? AND direction = 'in' AND id < ?
                ORDER BY id DESC LIMIT 1
                """,
                (session_id, retry_id),
            ).fetchone()
            last_user = _session_last_user(conn, session_id)
        if not user_row:
            raise HTTPException(status_code=400, detail="no preceding user message")
        if not last_user or int(last_user["id"]) != int(user_row["id"]):
            raise HTTPException(status_code=400, detail="v1 only allows regenerating the last turn")
        keep_id = int(user_row["id"])
        after_ts = user_row["ts"]
        deleted_ids = _truncate_after(session_id, after_id=keep_id)
        _bump_cancel(session_id)
        await _broadcast_truncate(session_id, deleted_ids, reason="retry", keep_id=keep_id)
        _clear_gemini_interaction_session(session_id)
        asyncio.create_task(_memory_truncate_best_effort(session_id, after_ts))
        gen = _arm_generation(session_id)
        touch_interaction()
        user_msg = {
            "id": keep_id,
            "ts": user_row["ts"],
            "direction": "in",
            "kind": user_row["kind"],
            "text": user_row["text"],
            "meta": json.loads(user_row["meta"] or "{}"),
            "session_id": session_id,
        }
        await broadcast(plugin_subs, {
            **plugin_payload(user_msg),
            "type": "regen",
            "gen_token": gen,
        })
        await broadcast(app_subs, {"type": "typing", "active": True})
        return {"id": keep_id, "deleted_ids": deleted_ids, "mode": "retry"}

    if not text and not attachments:
        raise HTTPException(status_code=400, detail="empty text")
    gen = _arm_generation(session_id)
    meta = {"user": "human", "attachments": attachments, "gen_token": gen}
    msg = save_message("in", "user", text, meta, session_id=session_id)
    touch_interaction()
    # 推给 AI 大脑
    await broadcast(plugin_subs, {**plugin_payload(msg), "gen_token": gen})
    # 回显给 PWA（发消息的人自己也能看到气泡）
    await broadcast(app_subs, app_payload(msg))
    # 通知 PWA「AI 正在输入…」
    await broadcast(app_subs, {"type": "typing", "active": True})
    return {"id": msg["id"]}


@app.post("/app/upload")
async def app_upload(request: Request, name: str = "file"):
    """上传图片/文件，返回附件对象"""
    check_auth(request)
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    mime = request.headers.get("content-type", "application/octet-stream")
    return save_upload_bytes(data, name, mime)


@app.get("/uploads/{name}")
async def uploads(request: Request, name: str):
    """获取已上传的文件"""
    check_auth(request)
    safe = clean_filename(name)
    path = UPLOAD_DIR / safe
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path)


@app.get("/app/history")
async def app_history(
    request: Request,
    since: int = 0,
    limit: int = 200,
    session_id: str = None,
    order: str = "asc",
    before_id: int = 0,
):
    """拉取历史消息，可按 session_id 过滤。order=desc 取最近 limit 条；before_id 取更早的一页。"""
    check_auth(request)
    sid = session_id or None
    rows = history(
        since, min(limit, 500), session_id=sid, order=order, before_id=before_id or None,
    )
    return {"messages": [app_payload(m) for m in rows]}


@app.get("/app/stream")
async def app_stream(request: Request):
    """PWA 保持的 SSE 长连接，AI 的回复通过这里推给前端"""
    check_auth(request)
    return StreamingResponse(
        sse_stream(app_subs, request),
        media_type="text/event-stream", headers=SSE_HEADERS,
    )


# ---- 在线状态 ----

@app.post("/app/ping")
async def app_ping(request: Request):
    """PWA 前台心跳，约 60 秒一次"""
    check_auth(request)
    touch_interaction()
    return {"ok": True}


@app.get("/app/status")
async def app_status(request: Request):
    check_auth(request)
    now = datetime.now(timezone.utc)
    state = "unknown"
    seen_age = None
    last_iso = _get_setting("last_interaction_time", "")
    last_ts = _last_seen_ts
    if last_ts is None and last_iso:
        try:
            last_ts = datetime.fromisoformat(last_iso.replace("Z", "+00:00"))
        except ValueError:
            last_ts = None
    if last_ts is not None:
        if last_ts.tzinfo is None:
            last_ts = last_ts.replace(tzinfo=timezone.utc)
        seen_age = (now - last_ts).total_seconds()
        if seen_age < 180:
            state = "online"
        elif seen_age < 1800:
            state = "recent"
        else:
            state = "away"
    return {
        "now": now.isoformat(),
        "last_seen": last_ts.isoformat() if last_ts else None,
        "last_interaction_time": last_iso or (last_ts.isoformat() if last_ts else None),
        "seen_age_sec": seen_age,
        "online": state == "online",
        "state": state,
        "app_subs": len(app_subs),
        "proactive_enabled": _get_setting("proactive_enabled", "1"),
        "notification_privacy": _get_setting("notification_privacy", "1"),
    }


# ---- 记忆服务代理（前端统一经 relay 访问记忆服务，后续扩展） ----

async def _proxy_memory(method: str, path: str, body: dict | None = None):
    """转发到 memory_service，注入安全头（若有）。超时/连接失败返回 502。"""
    import aiohttp
    url = f"{MEMORY_URL}{path}"
    headers = {}
    if MEMORY_HEADER_KEY and MEMORY_HEADER_VALUE:
        headers[MEMORY_HEADER_KEY] = MEMORY_HEADER_VALUE
    try:
        timeout = aiohttp.ClientTimeout(total=MEMORY_TIMEOUT)
        kwargs: dict = {"headers": headers}
        if body is not None:
            kwargs["json"] = body
        async with aiohttp.ClientSession(timeout=timeout) as client:
            async with client.request(method, url, **kwargs) as resp:
                text = await resp.text()
                status = resp.status
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"memory service unreachable: {e}")
    return status, text


async def _proxy_memory_request(request: Request, upstream_path: str):
    """原样转发 method / query / body 到 memory_service。"""
    import aiohttp
    qs = request.url.query
    url = f"{MEMORY_URL}{upstream_path}"
    if qs:
        url = f"{url}?{qs}"
    headers = {}
    if MEMORY_HEADER_KEY and MEMORY_HEADER_VALUE:
        headers[MEMORY_HEADER_KEY] = MEMORY_HEADER_VALUE
    ct = request.headers.get("content-type")
    if ct:
        headers["Content-Type"] = ct
    raw = b""
    if request.method not in ("GET", "HEAD"):
        raw = await request.body()
    try:
        timeout = aiohttp.ClientTimeout(total=MEMORY_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as client:
            async with client.request(
                request.method, url, data=raw or None, headers=headers
            ) as resp:
                text = await resp.text()
                status = resp.status
                media = resp.headers.get("content-type", "application/json")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"memory service unreachable: {e}")
    return Response(content=text, status_code=status, media_type=media)


@app.post("/app/memory/summary/run")
async def app_memory_summary_run(request: Request):
    """手动触发指定会话的航海日志总结（转发到 memory_service /summary/run）"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    session_id = (body.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    status, text = await _proxy_memory("POST", "/summary/run", {"chat_id": session_id})
    return Response(content=text, status_code=status, media_type="application/json")


@app.get("/app/memory/summary/prompts")
async def app_memory_summary_prompts(request: Request):
    """航海 / 事件线默认提示词（含当前覆盖），供设置面板可见可改。"""
    status, text = await _proxy_memory("GET", "/summary/prompts")
    return Response(content=text, status_code=status, media_type="application/json")


@app.get("/app/memory/summary/latest")
async def app_memory_summary_latest(request: Request):
    """读取某会话最新的航海日志（转发到 memory_service /summary/latest）"""
    check_auth(request)
    session_id = request.query_params.get("session_id", "__legacy__").strip() or "__legacy__"
    status, text = await _proxy_memory("GET", f"/summary/latest?chat_id={session_id}")
    return Response(content=text, status_code=status, media_type="application/json")


@app.get("/app/memory/summary/activity")
async def app_memory_summary_activity(request: Request):
    """读取当前逻辑日事件线（转发到 memory_service /summary/activity），供用户侧身份卡展示"""
    check_auth(request)
    status, text = await _proxy_memory("GET", "/summary/activity")
    return Response(content=text, status_code=status, media_type="application/json")


@app.post("/app/memory/summary/activity/rewrite")
async def app_memory_activity_rewrite(request: Request):
    """仅重写逻辑日事件线（不写航海）；body: session_id|chat_id, event_date?"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    chat_id = (body.get("chat_id") or body.get("session_id") or "").strip()
    if not chat_id:
        raise HTTPException(status_code=400, detail="chat_id required")
    payload = {"chat_id": chat_id}
    if body.get("event_date"):
        payload["event_date"] = body["event_date"]
    status, text = await _proxy_memory("POST", "/summary/activity/rewrite", payload)
    return Response(content=text, status_code=status, media_type="application/json")


@app.post("/app/memory/summary/maybe")
async def app_memory_summary_maybe(request: Request):
    """约每 N 轮后台整理检测（转发 /summary/maybe）；立即返回"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    session_id = (body.get("session_id") or body.get("chat_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    status, text = await _proxy_memory("POST", "/summary/maybe", {"chat_id": session_id})
    return Response(content=text, status_code=status, media_type="application/json")

@app.api_route("/app/memory/{rest:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def app_memory_star_proxy(rest: str, request: Request):
    """星图等 /api/memory/* 同源代理。summary/* 由上方专用路由处理。"""
    check_auth(request)
    return await _proxy_memory_request(request, f"/api/memory/{rest}")


@app.api_route("/app/affect/{rest:path}", methods=["GET", "POST", "PUT"])
async def app_affect_proxy(rest: str, request: Request):
    """情绪（积温）同源代理：身份卡片读 /affect/state。"""
    check_auth(request)
    return await _proxy_memory_request(request, f"/affect/{rest}")


@app.api_route("/app/schedules", methods=["GET", "POST"])
@app.api_route("/app/schedules/{rest:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def app_schedules_proxy(request: Request, rest: str = ""):
    """日程同源代理 → memory /schedules*（自然日；B.6 injectable）。"""
    check_auth(request)
    path = "/schedules" if not rest else f"/schedules/{rest}"
    return await _proxy_memory_request(request, path)


@app.api_route("/app/fragments", methods=["GET", "POST"])
async def app_fragments_proxy(request: Request):
    check_auth(request)
    return await _proxy_memory_request(request, "/api/fragments")


@app.api_route("/app/fragment/{frag_id}", methods=["GET", "DELETE", "PUT"])
async def app_fragment_proxy(frag_id: str, request: Request):
    check_auth(request)
    return await _proxy_memory_request(request, f"/api/fragment/{frag_id}")


# ---- Web Push ----

@app.get("/app/vapid_public")
async def app_vapid_public(request: Request):
    """返回 applicationServerKey，供 pushManager.subscribe。"""
    check_auth(request)
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=503, detail="VAPID_PUBLIC_KEY not configured")
    return {"key": VAPID_PUBLIC_KEY}


@app.post("/app/subscribe")
async def app_subscribe(request: Request):
    """保存浏览器 PushSubscription。"""
    check_auth(request)
    if not _vapid_configured():
        raise HTTPException(status_code=503, detail="VAPID not configured")
    body = await request.json()
    endpoint = (body.get("endpoint") or "").strip()
    keys = body.get("keys") or {}
    p256dh = (keys.get("p256dh") or "").strip()
    auth = (keys.get("auth") or "").strip()
    if not endpoint or not p256dh or not auth:
        raise HTTPException(status_code=400, detail="endpoint and keys required")
    _upsert_push_sub(endpoint, p256dh, auth)
    return {"ok": True}


@app.post("/app/unsubscribe")
async def app_unsubscribe(request: Request):
    """删除 PushSubscription。"""
    check_auth(request)
    body = await request.json()
    endpoint = (body.get("endpoint") or "").strip()
    if not endpoint:
        raise HTTPException(status_code=400, detail="endpoint required")
    _delete_push_sub(endpoint)
    return {"ok": True}


@app.post("/app/push_test")
async def app_push_test(request: Request):
    """推一条测试通知到全部订阅。"""
    check_auth(request)
    result = await _fanout_push(*_push_display("这是一条测试通知（ntfy / Web Push）"))
    return {"ok": True, **result}


def _pick_session_id_for_care() -> str:
    with db() as conn:
        row = conn.execute(
            """SELECT session_id FROM messages
               WHERE session_id IS NOT NULL AND session_id != ''
               ORDER BY id DESC LIMIT 1"""
        ).fetchone()
    if row and row["session_id"]:
        return str(row["session_id"])
    return "__legacy__"


@app.post("/app/proactive_now")
async def app_proactive_now(request: Request):
    """手动触发一条（或两条）主动关怀短句：落库 + 进聊天；可选同时推锁屏。

    绕过「在线则跳过」——方便你在聊天里验收文案与推送。
    body: { push?: bool, desperate?: bool, session_id?: str }
    """
    check_auth(request)
    body = {}
    try:
        if request.headers.get("content-length", "0") != "0":
            body = await request.json()
    except Exception:
        body = {}
    want_push = body.get("push", True)
    if isinstance(want_push, str):
        want_push = want_push.strip().lower() not in ("0", "false", "off", "no")
    desperate = bool(body.get("desperate"))
    session_id = (body.get("session_id") or body.get("api_session") or "").strip() or _pick_session_id_for_care()

    status, text = await _proxy_memory("POST", "/proactive/compose", {"desperate": desperate})
    try:
        data = json.loads(text) if text else {}
    except json.JSONDecodeError:
        data = {}
    if status >= 400 or not data.get("ok"):
        detail = (data.get("error") if isinstance(data, dict) else None) or text[:240] or f"HTTP {status}"
        raise HTTPException(status_code=502, detail=f"compose failed: {detail}")

    lines = [str(x).strip() for x in (data.get("lines") or []) if str(x).strip()]
    if not lines:
        raise HTTPException(status_code=502, detail="compose returned no lines")

    sent: list[dict] = []
    push_results: list[dict] = []
    for i, line in enumerate(lines):
        msg = save_message(
            "out",
            "reply",
            line,
            {"proactive": True, "kind_hint": "proactive_care", "manual": True},
            session_id=session_id,
        )
        await broadcast(app_subs, {"type": "typing", "active": False})
        await broadcast(app_subs, app_payload(msg))
        sent.append({"id": msg["id"], "text": line})
        if want_push:
            push_results.append(await _fanout_push(*_push_display(line), msg.get("id")))
        if i + 1 < len(lines):
            await asyncio.sleep(0.8)

    return {
        "ok": True,
        "session_id": session_id,
        "lines": [s["text"] for s in sent],
        "ids": [s["id"] for s in sent],
        "pushed": bool(want_push),
        "push": push_results[-1] if push_results else None,
    }


# ---- 设置 ----

@app.get("/app/settings")
async def app_settings_get(request: Request):
    """前端读取设置：API Key 仅回传已配置/空，绝不回传明文。"""
    check_auth(request)
    return _settings_dict(mask_secrets=True)


@app.post("/app/settings/reveal")
async def app_settings_reveal(request: Request, response: Response):
    """用户主动点击显示时短暂回传 API Key；禁止任何中间缓存。"""
    check_auth(request)
    settings = _settings_dict(mask_secrets=False)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return {key: settings.get(key, "") for key in KEY_FIELDS}


@app.get("/channel/settings")
async def channel_settings_get(request: Request):
    """内部读取设置（ai_brain / memory_service）：含真实 Key，不含 relay_secret。"""
    check_auth(request)
    return _settings_dict(mask_secrets=False)


def _llm_probe_proxy(base: str) -> str | None:
    hay = (base or "").lower()
    if "deepseek" in hay:
        return None
    env_proxy = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or ""
    ).strip()
    if env_proxy:
        return env_proxy
    google = "gemini" in hay or "google" in hay or "generativelanguage" in hay
    env = os.environ.get("TIDAL_ENV", "").strip().lower()
    relay = os.environ.get("RELAY_URL", "http://127.0.0.1:3011").lower()
    local = "127.0.0.1" in relay or "localhost" in relay
    if google and local and env not in ("prod", "production", "cloud"):
        return "http://127.0.0.1:7890"
    return None


@app.post("/app/settings/test")
async def app_settings_test(request: Request):
    """轻量探测：保存成功不等于网络通。target=chat|memory|affect。"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    target = (body.get("target") or "chat").strip().lower()
    if target not in ("chat", "memory", "affect"):
        raise HTTPException(status_code=400, detail="target must be chat, memory, or affect")
    s = _settings_dict(mask_secrets=False)
    proto = "openai"
    if target == "memory":
        base = (s.get("memory_api_base_url") or s.get("api_base_url") or "").rstrip("/")
        key = (s.get("memory_api_key") or s.get("api_key") or "").strip()
        model = (s.get("memory_model") or s.get("chat_model") or "").strip()
    elif target == "affect":
        # 第五组：不回退 memory/chat，避免误用付费管线
        base = (s.get("affect_api_base_url") or "").rstrip("/")
        key = (s.get("affect_api_key") or "").strip()
        model = (s.get("affect_model") or "").strip()
    else:
        proto = (s.get("chat_protocol") or "openai").strip().lower()
        if proto == "gemini":
            base = (
                s.get("gemini_api_base_url")
                or "https://generativelanguage.googleapis.com/v1beta"
            ).rstrip("/")
            key = (s.get("gemini_api_key") or "").strip()
            model = (s.get("gemini_model") or "").strip()
        else:
            proto = "openai"
            base = (s.get("api_base_url") or "").rstrip("/")
            key = (s.get("api_key") or "").strip()
            model = (s.get("chat_model") or "").strip()
    missing = [n for n, v in (("Base URL", base), ("API Key", key), ("模型", model)) if not v]
    if missing:
        return {
            "ok": False,
            "reason": "config_incomplete",
            "detail": "未配齐: " + "、".join(missing) + "（请先保存）",
        }
    import aiohttp
    proxy = _llm_probe_proxy(base)
    timeout = aiohttp.ClientTimeout(total=12, sock_connect=8)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as client:
            if proto == "gemini":
                origin = base.split(":generateContent", 1)[0].rstrip("/")
                marker = "/v1beta"
                idx = origin.find(marker)
                if idx >= 0:
                    origin = origin[: idx + len(marker)]
                elif origin.endswith("/models"):
                    origin = origin[: -len("/models")]
                url = f"{origin}/models/{model}:generateContent"
                payload = {
                    "contents": [{"role": "user", "parts": [{"text": "ping"}]}],
                    "generationConfig": {"maxOutputTokens": 8},
                }
                headers = {
                    "Content-Type": "application/json",
                    "x-goog-api-key": key,
                }
                async with client.post(url, json=payload, headers=headers, proxy=proxy) as resp:
                    text = (await resp.text())[:240]
                    if resp.status >= 400:
                        return {
                            "ok": False,
                            "reason": "upstream_http",
                            "detail": f"配置已保存，但上游 HTTP {resp.status}: {text}",
                        }
                    return {"ok": True, "reason": "ok", "detail": f"Gemini generateContent {model} 可连"}
            url = base + "/chat/completions"
            payload = {
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 8,
            }
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            async with client.post(url, json=payload, headers=headers, proxy=proxy) as resp:
                text = (await resp.text())[:240]
                if resp.status >= 400:
                    return {
                        "ok": False,
                        "reason": "upstream_http",
                        "detail": f"配置已保存，但上游 HTTP {resp.status}: {text}",
                    }
                return {"ok": True, "reason": "ok", "detail": f"{model} 可连"}
    except aiohttp.ClientConnectorError as e:
        return {"ok": False, "reason": "connect", "detail": f"配置已保存，但连不上: {e}"}
    except asyncio.TimeoutError:
        return {"ok": False, "reason": "timeout", "detail": "配置已保存，但请求超时（代理/网络）"}
    except Exception as e:
        return {"ok": False, "reason": "error", "detail": f"配置已保存，但探测失败: {e}"}


def _set_setting(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        conn.commit()


@app.put("/app/settings")
async def app_settings_put(request: Request):
    """写入用户设置。空字符串或脱敏占位的 Key 保留库内原值。"""
    check_auth(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected JSON object")
    saved = []
    hist_keys = ("history_n", "history_n_min", "history_n_max")
    with db() as conn:
        pending_hist = {}
        # 保存强校验：先确定目标协议，合并「本次提交值 or 库内现值」后校验三件套齐全，
        # 缺任一则拒绝保存（禁止静默沿用旧配置 / 静默回退）。key 脱敏占位或空串视为「未改动」→ 取库内现值。
        _cur = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
        _proto = str(body.get("chat_protocol") or _cur.get("chat_protocol") or "openai").strip().lower()
        if _proto not in PROTOCOL_TRIPLET:
            _proto = "openai"
        _missing = []
        for _need in PROTOCOL_TRIPLET[_proto]:
            _submitted = body.get(_need)
            _sub = "" if _submitted is None else str(_submitted).strip()
            if _sub in ("", KEY_MASK):
                _sub = (_cur.get(_need) or "").strip()
            if not _sub:
                _missing.append(_need)
        if _missing:
            raise HTTPException(
                status_code=400,
                detail=f"切换协议 {_proto} 缺少必要配置: {', '.join(_missing)}（请先填写 Base URL / API Key / 模型）",
            )
        for k, v in body.items():
            key = str(k)
            # 配置库与选中项只走 /app/api/profiles，不接受通用设置覆盖
            if key == "api_profiles" or key.endswith("_profile_id"):
                continue
            val = "" if v is None else str(v)
            if key in KEY_FIELDS and (not val.strip() or val.strip() == KEY_MASK):
                continue
            if key == "relay_secret":
                secret = val.strip()
                if not secret:
                    continue
                _persist_relay_secret(secret)
            if key in hist_keys:
                pending_hist[key] = val
                continue
            if key == "max_tokens":
                try:
                    n = int(val)
                except ValueError:
                    continue
                val = str(max(256, min(2048, n)))
            if key == "thinking_effort":
                v = val.strip().lower()
                # 兼容旧五档 UI；3.6 才允许 minimal（brain 侧再钳一次）
                if v in ("xhigh", "max", "ultra"):
                    v = "high"
                if v not in ("minimal", "low", "medium", "high"):
                    continue
                val = v
            # 人设/输出风格置空 = 用系统默认；入库统一存默认文本，保证前端展示与 bridge 实际生效一致
            if key == "persona" and not val.strip():
                val = DEFAULT_PERSONA
            if key == "output_style" and not val.strip():
                val = DEFAULT_OUTPUT_STYLE
            if key == "weather_city":
                val = " ".join(val.split())[:40] or DEFAULT_WEATHER_CITY
            if key == "weather_city_path":
                val = " ".join(val.split())[:120]
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, val),
            )
            saved.append(key)
        if pending_hist:
            rows = conn.execute(
                "SELECT key, value FROM settings WHERE key IN ('history_n','history_n_min','history_n_max')"
            ).fetchall()
            cur = {r["key"]: r["value"] for r in rows}
            n_min, n_max = _normalize_history_window(
                pending_hist.get("history_n_min", cur.get("history_n_min")),
                pending_hist.get("history_n_max", pending_hist.get("history_n", cur.get("history_n_max"))),
                pending_hist.get("history_n", cur.get("history_n")),
            )
            # 旧客户端只传 history_n：保持滑窗（min=max）
            if "history_n" in pending_hist and "history_n_min" not in pending_hist and "history_n_max" not in pending_hist:
                n_min, n_max = n_max, n_max
            for key, val in (
                ("history_n", str(n_max)),
                ("history_n_max", str(n_max)),
                ("history_n_min", str(n_min)),
            ):
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, val),
                )
                saved.append(key)
        conn.commit()
    return {"ok": True, "saved": saved}


# ---- API 配置库（全局共享） ----

def _profiles_state(conn) -> dict:
    return {"profiles": _mask_profiles(_profiles_raw(conn)), "active": _active_ids(conn)}


def _profile_or_404(conn, pid: str) -> tuple[list, dict]:
    profiles = _profiles_raw(conn)
    prof = _find_profile(profiles, pid)
    if not prof:
        raise HTTPException(status_code=404, detail="配置不存在")
    return profiles, prof


def _missing_profile_fields(prof: dict) -> list[str]:
    missing = []
    if not str(prof.get("base_url") or "").strip():
        missing.append("Base URL")
    if not str(prof.get("api_key") or "").strip():
        missing.append("API Key")
    if not str(prof.get("model") or "").strip():
        missing.append("Model")
    return missing


@app.get("/app/api/profiles")
async def api_profiles_get(request: Request):
    check_auth(request)
    with db() as conn:
        return _profiles_state(conn)


@app.post("/app/api/profiles")
async def api_profiles_create(request: Request):
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected JSON object")
    with db() as conn:
        profiles = _profiles_raw(conn)
        prof = _new_profile(
            profiles,
            name=body.get("name"),
            protocol=body.get("protocol"),
            base_url=body.get("base_url"),
            model=body.get("model"),
            api_key=body.get("api_key"),
        )
        profiles.append(prof)
        _profiles_write(conn, profiles)
        conn.commit()
        state = _profiles_state(conn)
    state["profile"] = _mask_profiles([prof])[0]
    return state


@app.put("/app/api/profiles/{pid}")
async def api_profiles_update(pid: str, request: Request):
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected JSON object")
    with db() as conn:
        profiles, prof = _profile_or_404(conn, pid)
        if "name" in body:
            name = " ".join(str(body.get("name") or "").split())[:40]
            if name:
                prof["name"] = name
        # 类型创建后不改（Gemini 原生 / OpenAI 兼容决定它能被哪些板块选中）
        if "base_url" in body:
            prof["base_url"] = str(body.get("base_url") or "").strip()
        if "model" in body:
            prof["model"] = str(body.get("model") or "").strip()
        if "api_key" in body:
            raw_key = str(body.get("api_key") or "").strip()
            if raw_key and raw_key != KEY_MASK:
                prof["api_key"] = raw_key
        prof["updated_at"] = now_iso()
        used = [s for s, aid in _active_ids(conn).items() if aid == pid]
        if used and not _profile_ready(prof):
            raise HTTPException(
                status_code=400,
                detail="这套配置正在使用：" + " / ".join(_missing_profile_fields(prof)) + " 不能留空",
            )
        for scope in used:
            if scope != "schedule":
                _mirror_scope(conn, scope, prof)
        _profiles_write(conn, profiles)
        conn.commit()
        return _profiles_state(conn)


@app.delete("/app/api/profiles/{pid}")
async def api_profiles_delete(pid: str, request: Request):
    check_auth(request)
    with db() as conn:
        profiles, _ = _profile_or_404(conn, pid)
        if pid in _active_ids(conn).values():
            raise HTTPException(status_code=400, detail="当前正在使用的配置不能删除，请先切换到别的配置")
        _profiles_write(conn, [p for p in profiles if p.get("id") != pid])
        conn.commit()
        return _profiles_state(conn)


@app.post("/app/api/profiles/{pid}/activate")
async def api_profiles_activate(pid: str, request: Request):
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    scope = str((body or {}).get("scope") or "").strip()
    if scope not in API_PROFILE_SCOPES:
        raise HTTPException(status_code=400, detail="scope 不合法")
    with db() as conn:
        _, prof = _profile_or_404(conn, pid)
        if scope != "chat" and prof.get("protocol") != "openai":
            raise HTTPException(status_code=400, detail="这个板块只支持 OpenAI 兼容配置")
        missing = _missing_profile_fields(prof)
        if missing:
            raise HTTPException(status_code=400, detail="这套配置还缺：" + " / ".join(missing))
        if scope != "schedule":
            _mirror_scope(conn, scope, prof)
        _set_setting_row(conn, _scope_id_key(scope), pid)
        conn.commit()
        return _profiles_state(conn)


@app.post("/app/api/profiles/deactivate")
async def api_profiles_deactivate(request: Request):
    """记忆板块专用：不选独立配置，跟随聊天大脑。"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    scope = str((body or {}).get("scope") or "").strip()
    if scope not in ("memory", "voyage", "affect", "daily", "schedule"):
        raise HTTPException(status_code=400, detail="聊天大脑必须选一路；其它板块可以留空")
    with db() as conn:
        _set_setting_row(conn, _scope_id_key(scope), "")
        _clear_scope(conn, scope)
        conn.commit()
        return _profiles_state(conn)


@app.post("/app/api/profiles/{pid}/reveal")
async def api_profile_reveal(pid: str, request: Request, response: Response):
    check_auth(request)
    with db() as conn:
        _, prof = _profile_or_404(conn, pid)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return {"id": pid, "api_key": prof.get("api_key", "")}


# ---- 用量与统计 ----

def _usage_row(ev: dict, tz: timezone, day_start: int) -> tuple:
    def n(key: str) -> int:
        try:
            v = int(ev.get(key) or 0)
        except (TypeError, ValueError):
            return 0
        return max(0, v)

    ts = (ev.get("ts") or "").strip() or now_iso()
    status = (ev.get("status") or "ok").strip().lower()
    return (
        ts,
        _local_day(ts, tz, day_start),
        (ev.get("session_id") or "__legacy__").strip() or "__legacy__",
        (ev.get("model") or "").strip(),
        status if status in ("ok", "fail") else "ok",
        n("input_tokens"), n("cached_tokens"), n("output_tokens"), n("thought_tokens"),
        (ev.get("source") or "live").strip() or "live",
    )


@app.post("/app/usage")
async def app_usage_post(request: Request):
    """AI 大脑上报 LLM 调用用量。一次调用一行，工具链里的中间调用同样上报。

    body 可以是单个事件，也可以是 {"events": [...]}（回填脚本批量用）。
    """
    check_auth(request)
    body = await request.json()
    events = body.get("events") if isinstance(body, dict) else None
    if not isinstance(events, list):
        events = [body] if isinstance(body, dict) else []
    events = [e for e in events if isinstance(e, dict)]
    # 回填脚本可重复跑：先清掉这些天已有的 backfill 行，再灌新的。
    # 只删 source='backfill'，实时上报的数据不受影响。
    replace_days = body.get("replace_backfill_days") if isinstance(body, dict) else None
    replace_days = [str(d) for d in replace_days] if isinstance(replace_days, list) else []
    if not events and not replace_days:
        return {"ok": True, "written": 0, "purged": 0}
    tz, day_start = _stats_tz(), _stats_day_start_hour()
    rows = [_usage_row(e, tz, day_start) for e in events]
    purged = 0
    with db() as conn:
        if replace_days:
            marks = ",".join("?" * len(replace_days))
            cur = conn.execute(
                f"DELETE FROM usage_events WHERE source = 'backfill' AND day IN ({marks})",
                replace_days,
            )
            purged = cur.rowcount or 0
        conn.executemany(
            """INSERT INTO usage_events
               (ts, day, session_id, model, status,
                input_tokens, cached_tokens, output_tokens, thought_tokens, source)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        conn.commit()
    return {"ok": True, "written": len(rows), "purged": purged}


def _month_bounds(month: str, tz: timezone) -> tuple[str, str, str]:
    """'YYYY-MM'（空则取当前统计月）→ (month, day_from, day_to_exclusive)。"""
    raw = (month or "").strip()
    try:
        first = datetime.strptime(raw, "%Y-%m")
    except ValueError:
        today = datetime.now(timezone.utc).astimezone(tz)
        first = datetime(today.year, today.month, 1)
    nxt = datetime(first.year + (first.month == 12), (first.month % 12) + 1, 1)
    return first.strftime("%Y-%m"), first.strftime("%Y-%m-%d"), nxt.strftime("%Y-%m-%d")


def _quantile_levels(values: list[int], buckets: int = 5) -> list[int]:
    """非零值的分位阈值，用于热力图底色分档。数据太少时退化成去重后的值。"""
    vals = sorted(v for v in values if v > 0)
    if not vals:
        return []
    cuts = []
    for i in range(1, buckets):
        idx = min(len(vals) - 1, int(round(i * len(vals) / buckets)))
        cuts.append(vals[idx])
    out: list[int] = []
    for c in cuts:
        if not out or c > out[-1]:
            out.append(c)
    return out


@app.get("/app/stats/daily")
async def app_stats_daily(request: Request):
    """某月每天的 API 调用次数与 token 分量。

    只返回 token，不返回金额：单价在前端按 model_prices 算，
    这样在热力图上改单价能立刻重算全月，也不会把错价固化进历史。
    """
    check_auth(request)
    tz = _stats_tz()
    month, day_from, day_to = _month_bounds(request.query_params.get("month", ""), tz)
    with db() as conn:
        rows = conn.execute(
            """SELECT day, model, status,
                      COUNT(*)             AS calls,
                      SUM(input_tokens)    AS input_tokens,
                      SUM(cached_tokens)   AS cached_tokens,
                      SUM(output_tokens)   AS output_tokens,
                      SUM(thought_tokens)  AS thought_tokens
                 FROM usage_events
                WHERE day >= ? AND day < ?
                GROUP BY day, model, status
                ORDER BY day ASC""",
            (day_from, day_to),
        ).fetchall()

    days: dict[str, dict] = {}
    seen_models: set[str] = set()
    for r in rows:
        d = days.setdefault(r["day"], {
            "day": r["day"], "calls": 0, "failed": 0,
            "input_tokens": 0, "cached_tokens": 0,
            "output_tokens": 0, "thought_tokens": 0, "models": [],
        })
        if r["status"] != "ok":
            d["failed"] += int(r["calls"])
            continue
        seen_models.add(r["model"])
        d["calls"] += int(r["calls"])
        for k in ("input_tokens", "cached_tokens", "output_tokens", "thought_tokens"):
            d[k] += int(r[k] or 0)
        d["models"].append({
            "model": r["model"], "calls": int(r["calls"]),
            **{k: int(r[k] or 0) for k in
               ("input_tokens", "cached_tokens", "output_tokens", "thought_tokens")},
        })

    out_days = [days[k] for k in sorted(days)]
    total = {k: sum(d[k] for d in out_days) for k in
             ("calls", "failed", "input_tokens", "cached_tokens", "output_tokens", "thought_tokens")}
    prices = _model_prices()
    return {
        "month": month,
        "tz_offset": int(tz.utcoffset(None).total_seconds() // 60),
        "day_start_hour": _stats_day_start_hour(),
        "days": out_days,
        "total": total,
        "levels": {"calls": _quantile_levels([d["calls"] for d in out_days])},
        "prices": prices,
        "unpriced_models": sorted(m for m in seen_models if m and m not in prices),
    }


@app.get("/app/stats/recent")
async def app_stats_recent(request: Request):
    """最近若干次 LLM 调用明细（感知页成本日志用）。

    只返回 token，金额由前端按 model_prices 现算。默认 40 条，上限 100。
    """
    check_auth(request)
    try:
        limit = int(request.query_params.get("limit") or 40)
    except (TypeError, ValueError):
        limit = 40
    limit = max(1, min(100, limit))
    with db() as conn:
        rows = conn.execute(
            """SELECT id, ts, day, session_id, model, status,
                      input_tokens, cached_tokens, output_tokens, thought_tokens, source
                 FROM usage_events
                ORDER BY id DESC
                LIMIT ?""",
            (limit,),
        ).fetchall()
    events = [{
        "id": int(r["id"]),
        "ts": r["ts"],
        "day": r["day"],
        "session_id": r["session_id"],
        "model": r["model"] or "",
        "status": r["status"] or "ok",
        "input_tokens": int(r["input_tokens"] or 0),
        "cached_tokens": int(r["cached_tokens"] or 0),
        "output_tokens": int(r["output_tokens"] or 0),
        "thought_tokens": int(r["thought_tokens"] or 0),
        "source": r["source"] or "live",
    } for r in rows]
    prices = _model_prices()
    return {
        "limit": limit,
        "tz_offset": int(_stats_tz().utcoffset(None).total_seconds() // 60),
        "events": events,
        "prices": prices,
    }


# ---- 会话（session） — 真实多对话支持 ----

def _legacy_reply_turns(conn) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM messages "
        "WHERE session_id = '__legacy__' AND direction = 'out' AND kind = 'reply'"
    ).fetchone()
    return int(row["n"] or 0)


def _sessions_payload(conn) -> dict:
    """会话列表按创建时间倒序（新的在前）。

    turns_api  = 该会话的 LLM 调用次数（usage_events，上线后才有）
    turns_reply= reply 条数（老会话回退口径；埋点之前没有 usage 数据）
    """
    rows = conn.execute(
        """SELECT s.id, s.title, s.created_at, s.updated_at,
                  (SELECT COUNT(*) FROM usage_events u
                    WHERE u.session_id = s.id AND u.status = 'ok') AS turns_api,
                  (SELECT COUNT(*) FROM messages m
                    WHERE m.session_id = s.id AND m.direction = 'out'
                      AND m.kind = 'reply')                        AS turns_reply
             FROM sessions s
            ORDER BY s.created_at DESC"""
    ).fetchall()
    sessions = [{
        "id": r["id"], "title": r["title"],
        "created_at": r["created_at"], "updated_at": r["updated_at"],
        "turns_api": int(r["turns_api"] or 0),
        "turns_reply": int(r["turns_reply"] or 0),
    } for r in rows]
    # active_session 仍取最近使用的那个（仅在前端本地没有选择记录时兜底）
    recent = max(sessions, key=lambda s: s["updated_at"], default=None)
    return {
        "sessions": sessions,
        "active_session": recent["id"] if recent else None,
        "legacy_turns_reply": _legacy_reply_turns(conn),
    }


@app.get("/app/sessions")
async def app_sessions_get(request: Request):
    """列出所有对话"""
    check_auth(request)
    with db() as conn:
        return _sessions_payload(conn)


@app.post("/app/sessions")
async def app_sessions_post(request: Request):
    """创建新对话"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    title = (body.get("title") or "新对话").strip()
    session_id = body.get("id") or secrets.token_urlsafe(12)
    now = now_iso()
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (session_id, title, now, now),
        )
        conn.commit()
    created = {"id": session_id, "title": title, "created_at": now, "updated_at": now}
    # 同步读取全部 sessions 列表
    with db() as conn:
        payload = _sessions_payload(conn)
    return {**payload, "created": created, "active_session": session_id}


@app.patch("/app/sessions/{session_id}")
async def app_sessions_patch(session_id: str, request: Request):
    """更新对话（切换选中/改名）"""
    check_auth(request)
    now = now_iso()
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    with db() as conn:
        # 确保 session 记录存在
        existing = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not existing:
            title = (body.get("title") or "新对话").strip()
            conn.execute(
                "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (session_id, title, now, now),
            )
        else:
            updates = []
            params = []
            if "title" in body:
                updates.append("title = ?")
                params.append(str(body["title"]))
            updates.append("updated_at = ?")
            params.append(now)
            params.append(session_id)
            conn.execute(f"UPDATE sessions SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    return {"ok": True}


@app.delete("/app/sessions/{session_id}")
async def app_sessions_delete(session_id: str, request: Request):
    """删除对话：清掉该会话全部消息与记录（仅 relay 库，记忆库保留）"""
    check_auth(request)
    # 旧主线不可删，前端本就不提供按钮，这里双保险
    if session_id == "__legacy__":
        raise HTTPException(status_code=400, detail="legacy session cannot be deleted")
    with db() as conn:
        existing = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="session not found")
        conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        conn.commit()
    _clear_gemini_interaction_session(session_id)
    return {"ok": True}


# ---- 游标管理（Bug 2 修复） ----

@app.get("/app/sessions/{session_id}/cursor")
async def app_sessions_cursor_get(session_id: str, request: Request):
    """读取当前 session 的游标（AI 大脑用）"""
    check_auth(request)
    with db() as conn:
        row = conn.execute(
            "SELECT cursor_id FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
    cursor_id = row["cursor_id"] if row else 0
    return {"cursor_id": cursor_id}


@app.put("/app/sessions/{session_id}/cursor")
async def app_sessions_cursor_put(session_id: str, request: Request):
    """更新当前 session 的游标（AI 大脑用）"""
    check_auth(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    cursor_id = int(body.get("cursor_id", 0))
    now = now_iso()
    with db() as conn:
        conn.execute(
            "UPDATE sessions SET cursor_id = ?, updated_at = ? WHERE id = ?",
            (cursor_id, now, session_id),
        )
        conn.commit()
    return {"ok": True, "cursor_id": cursor_id}


# =============================================================================
# 静态文件 — 托管 PWA 前端（Phase 4）
# =============================================================================

WEB_DIR = Path(__file__).parent.parent / "web"
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


# =============================================================================
# 入口
# =============================================================================

if __name__ == "__main__":
    import uvicorn
    bind = os.environ.get("TIDAL_BIND", "127.0.0.1").strip() or "127.0.0.1"
    print(f"[INFO] Tidal 聊天中继启动: http://{bind}:{PORT}")
    print(f"   数据库: {DB_PATH}")
    print(f"   健康检查: http://{bind}:{PORT}/healthz")
    uvicorn.run(app, host=bind, port=PORT)