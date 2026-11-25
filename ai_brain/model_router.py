"""
多模型路由器 — 支持 DeepSeek / OpenAI / Gemini / 自定义 OpenAI 兼容 API。
按分组独立配置（聊天大脑 / 记忆流水线），支持故障自动切换（fallback 链）。
"""

import copy
import hashlib
import json
import os
import sys
import asyncio
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiohttp

BJ = timezone(timedelta(hours=8))


def _ix_log_path() -> str | None:
    """Gemini Interactions token 日志路径；空则仅 stderr。"""
    raw = os.environ.get("GEMINI_IX_LOG_PATH", "").strip()
    if raw.lower() in ("0", "false", "off", "no"):
        return None
    if raw:
        return raw
    if os.path.isdir("/app/logs"):
        return "/app/logs/brain_gemini_ix.log"
    root = Path(__file__).resolve().parent.parent
    return str(root / "logs" / "brain_gemini_ix.log")


def _append_ix_log(line: str) -> None:
    path = _ix_log_path()
    if not path:
        return
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        stamp = datetime.now(timezone.utc).astimezone(BJ).strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"[{stamp}] {line.rstrip()}\n")
    except OSError:
        pass


# ---- 加载 .env ----
def _load_dotenv(path: Path) -> None:
    """极简 .env 加载：KEY=VALUE；行内 # 注释剥离；已有环境变量不覆盖"""
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

# 统一密钥：若 CHAT_API_KEY_1 未在 ai_brain/.env 中显式设置（留空或注释），
# 则从环境变量 DEEPSEEK_API_KEY 中读取（与 memory_service/.env 共享同一密钥）。
if not os.environ.get("CHAT_API_KEY_1"):
    shared = os.environ.get("DEEPSEEK_API_KEY", "")
    if shared:
        os.environ["CHAT_API_KEY_1"] = shared


# ---- 故障切换配置 ----
FALLBACK_HTTP_CODES = {401, 403, 404, 408, 409, 429, 500, 502, 503, 504}

# ---- 通用 LLM 参数 ----
TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.7"))
MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "4096"))
# Gemini 3.x thinking_level；3.6 另支持 minimal，其余 Flash 仅 low/medium/high
THINKING_EFFORT = (os.environ.get("THINKING_EFFORT") or "low").strip().lower()
_THINKING_LEVELS_BASE = ("low", "medium", "high")
_THINKING_LEVELS_WITH_MINIMAL = ("minimal",) + _THINKING_LEVELS_BASE


# ---- 模型路由构建 ----

def _build_routes(prefix: str) -> list[dict]:
    """从环境变量构建模型路由链。
    
    读取 PREFIX_API_BASE_1/2/3、PREFIX_API_KEY_1/2/3、PREFIX_MODEL_1/2/3。
    只保留同时填写了 base 和 model 的路由。
    """
    routes = []
    for suffix in ("_1", "_2", "_3"):
        base = os.environ.get(f"{prefix}_API_BASE{suffix}", "").rstrip("/")
        key = os.environ.get(f"{prefix}_API_KEY{suffix}", "")
        model = os.environ.get(f"{prefix}_MODEL{suffix}", "")
        if base and model:
            routes.append({"base": base, "key": key, "model": model})
    return routes


# 聊天大脑模型链
CHAT_ROUTES = _build_routes("CHAT")

# 记忆流水线模型链（独立配置，Phase 3 启用）
MEMORY_ROUTES = _build_routes("MEMORY")


def validate_routes() -> list[str]:
    """校验配置完整性，返回缺失项列表"""
    missing = []
    if not CHAT_ROUTES:
        missing.append("CHAT_API_BASE_1 + CHAT_API_KEY_1 + CHAT_MODEL_1")
    return missing


def update_routes(new_routes: list[dict]) -> None:
    """运行时更新模型路由（bridge 从 relay settings 读取后调用）"""
    global CHAT_ROUTES
    CHAT_ROUTES = new_routes


def update_params(
    temperature: float | None = None,
    max_tokens: int | None = None,
    thinking_effort: str | None = None,
) -> None:
    """运行时更新 LLM 参数（bridge 从 relay settings 读取后调用）"""
    global TEMPERATURE, MAX_TOKENS, THINKING_EFFORT
    if temperature is not None:
        TEMPERATURE = temperature
    if max_tokens is not None:
        MAX_TOKENS = max_tokens
    if thinking_effort is not None:
        THINKING_EFFORT = normalize_thinking_effort(thinking_effort)


def model_allows_minimal_thinking(model: str) -> bool:
    """仅 gemini-3.6* 保留 minimal；3.7/3.8 传 minimal 会 400。"""
    m = (model or "").lower()
    return "3.6" in m


def normalize_thinking_effort(raw: str | None) -> str:
    v = (raw or "").strip().lower()
    if v in _THINKING_LEVELS_WITH_MINIMAL:
        return v
    # 旧 UI 五档 → 三档
    if v in ("xhigh", "max", "ultra"):
        return "high"
    return "low"


def resolve_thinking_level(model: str, effort: str | None = None) -> str | None:
    """把用户 effort 钳到当前模型允许的 thinking_level；非 3.x 返回 None。"""
    m = (model or "").lower()
    if not ("3." in m or m.startswith("gemini-3")):
        return None
    level = normalize_thinking_effort(effort if effort is not None else THINKING_EFFORT)
    if level == "minimal" and not model_allows_minimal_thinking(model):
        return "low"
    return level


# Gemini / Google 官方或兼容网关：静默放行安全拦截（前端无需开关）
_GEMINI_SAFETY_SETTINGS = [
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
]

# Interactions API 安全枚举（与 generateContent 不同）
_GEMINI_IX_SAFETY_SETTINGS = [
    {"type": "hate_speech", "threshold": "off"},
    {"type": "dangerous_content", "threshold": "off"},
    {"type": "harassment", "threshold": "off"},
    {"type": "sexually_explicit", "threshold": "off"},
]

_GEMINI_IX_API_REVISION = "2026-05-20"


def _route_protocol(route: dict) -> str:
    p = (route.get("protocol") or "").strip().lower()
    if p in ("gemini", "openai"):
        return p
    return "openai"


def _needs_gemini_safety(route: dict) -> bool:
    if _route_protocol(route) == "gemini":
        return True
    hay = f"{route.get('model', '')} {route.get('base', '')}".lower()
    return "gemini" in hay or "google" in hay or "generativelanguage" in hay


def _is_deepseek_route(route: dict) -> bool:
    hay = f"{route.get('model', '')} {route.get('base', '')}".lower()
    return "deepseek" in hay


def _is_local_dev() -> bool:
    """云上/生产不要回退 127.0.0.1:7890。"""
    env = os.environ.get("TIDAL_ENV", "").strip().lower()
    if env in ("prod", "production", "cloud"):
        return False
    relay = os.environ.get("RELAY_URL", "http://127.0.0.1:3011").lower()
    return "127.0.0.1" in relay or "localhost" in relay


def proxy_url_for_route(route: dict) -> str | None:
    """DeepSeek 直连；其余优先 HTTPS_PROXY/HTTP_PROXY；本地 Gemini 可用 TIDAL_LOCAL_PROXY 显式指定。"""
    if _is_deepseek_route(route):
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
    # 本机 Gemini 的本地代理必须显式配置，避免静默把所有人带到 7890。
    if _needs_gemini_safety(route) and _is_local_dev():
        return (os.environ.get("TIDAL_LOCAL_PROXY") or "").strip() or None
    return None


def normalize_vision_level(raw) -> str:
    """附件 vision 档：low(~280) / medium(~560) / high(~1120)。默认 low。"""
    v = str(raw or "").strip().lower()
    if v in ("medium", "med", "clear", "560", "500"):
        return "medium"
    if v in ("high", "detail", "fine", "1120", "1000", "original"):
        return "high"
    return "low"


def gemini_media_resolution_enum(level: str) -> str:
    """Gemini 3 Part.media_resolution.level。"""
    lv = normalize_vision_level(level)
    if lv == "medium":
        return "MEDIA_RESOLUTION_MEDIUM"
    if lv == "high":
        return "MEDIA_RESOLUTION_HIGH"
    return "MEDIA_RESOLUTION_LOW"


def deepseek_image_detail(level: str) -> str:
    """DeepSeek image_url.detail：日常 low；更清楚/细看用 original（账单仍 ≤384）。"""
    return "low" if normalize_vision_level(level) == "low" else "original"


def route_supports_vision(route: dict) -> bool:
    """当前聊天路由是否适合把图片编进多模态。"""
    if _route_protocol(route) == "gemini":
        return True
    if _is_deepseek_route(route):
        # deepseek-flash / V4.1-Flash 起原生 Vision；旧纯文本路由也试发，失败再降级
        return True
    hay = f"{route.get('model', '')} {route.get('base', '')}".lower()
    hints = (
        "gemini", "gpt-4o", "gpt-4.1", "gpt-5", "gpt-4-turbo",
        "claude", "vision", "qwen-vl", "qwen2-vl", "glm-4v", "deepseek",
    )
    return any(h in hay for h in hints)


def _image_url_meta(item: dict) -> tuple[str, str]:
    """从 OpenAI image_url 块取出 (data_url, vision_level)。优先 vision，其次 media_resolution，再次 detail。"""
    blob = item.get("image_url") if isinstance(item.get("image_url"), dict) else {}
    url = (blob.get("url") or "").strip()
    if blob.get("vision") is not None:
        return url, normalize_vision_level(blob.get("vision"))
    mr = blob.get("media_resolution")
    if isinstance(mr, str) and mr.strip():
        return url, normalize_vision_level(mr)
    if isinstance(mr, dict) and mr.get("level"):
        raw = str(mr.get("level") or "")
        if "MEDIUM" in raw.upper():
            return url, "medium"
        if "HIGH" in raw.upper() or "ULTRA" in raw.upper():
            return url, "high"
        if "LOW" in raw.upper():
            return url, "low"
        return url, normalize_vision_level(raw)
    detail = str(blob.get("detail") or "").strip().lower()
    if detail == "low":
        return url, "low"
    if detail in ("high", "original"):
        return url, "high"
    return url, "low"


def _format_llm_error(err: BaseException, route: dict | None = None) -> str:
    model = (route or {}).get("model") or "?"
    base = (route or {}).get("base") or ""
    if isinstance(err, aiohttp.ClientResponseError):
        body = (err.message or "").replace("\n", " ").strip()[:240]
        return f"{model} HTTP {err.status}: {body}"
    if isinstance(err, aiohttp.ClientConnectorError):
        return f"{model} 连不上 {base or err}: {err}"
    if isinstance(err, asyncio.TimeoutError):
        return f"{model} 请求超时"
    return f"{model}: {err}"


def _gemini_no_fallback() -> bool:
    """Gemini Interactions 失败时不静默切备用路由（默认开启）。设 GEMINI_NO_FALLBACK=0 才允许 fallback。"""
    raw = os.environ.get("GEMINI_NO_FALLBACK", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    return True


def _log_gemini_ix_fail(route: dict, detail: str) -> None:
    line = f"[gemini-ix] FAIL model={route.get('model')} {detail}"
    print(line, file=sys.stderr, flush=True)
    _append_ix_log(line)


# ---- 用量上报 ----
# 一次 API 调用报一行（工具链中间调用同样报）。用回调解耦：model_router 不认识
# relay，bridge 启动时挂钩子。上报失败绝不影响回复。

_usage_hook = None


def set_usage_hook(fn) -> None:
    """注册用量回调。fn(event: dict)，须自己异步化、自己吞异常。"""
    global _usage_hook
    _usage_hook = fn


def _normalize_openai_usage(usage: dict | None) -> dict | None:
    """把 OpenAI / DeepSeek 风格的 usage 归一成内部字段。

    只认标准字段；缺字段或类型异常时返回 None，调用方按“只记调用次数”处理。
    注意：prompt_tokens 含缓存命中，completion_tokens 含 reasoning。
    """
    if not isinstance(usage, dict):
        return None

    def _n(*keys: str) -> int:
        for key in keys:
            val = usage.get(key)
            if val is None:
                continue
            try:
                return max(0, int(val))
            except (TypeError, ValueError):
                continue
        return 0

    hit = _n("prompt_cache_hit_tokens")
    if not hit:
        details = usage.get("prompt_tokens_details")
        if isinstance(details, dict):
            try:
                hit = max(0, int(details.get("cached_tokens") or 0))
            except (TypeError, ValueError):
                hit = 0

    prompt = _n("prompt_tokens")
    if not prompt:
        prompt = hit + _n("prompt_cache_miss_tokens")
    output = _n("completion_tokens")

    if prompt <= 0 and output <= 0 and hit <= 0:
        return None

    return {
        "total_input_tokens": prompt,
        "total_cached_tokens": min(hit, prompt),
        "total_output_tokens": output,
        # completion_tokens 已含 reasoning，重复记会多算钱
        "total_thought_tokens": 0,
    }


def _report_usage(route: dict, usage: dict | None, *, session_id: str | None, status: str = "ok") -> None:
    if _usage_hook is None:
        return
    u = usage or {}

    def _n(key: str) -> int:
        try:
            return max(0, int(u.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    try:
        _usage_hook({
            "ts": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id or "__legacy__",
            "model": route.get("model") or "",
            "status": status,
            "input_tokens": _n("total_input_tokens"),
            "cached_tokens": _n("total_cached_tokens"),
            "output_tokens": _n("total_output_tokens"),
            "thought_tokens": _n("total_thought_tokens"),
        })
    except Exception as exc:
        print(f"[usage] 上报失败: {exc}", file=sys.stderr, flush=True)


def _log_llm_fallback(route: dict) -> None:
    print(
        f"[llm] fallback ok model={route.get('model')} "
        f"protocol={_route_protocol(route)}",
        file=sys.stderr, flush=True,
    )


_LLM_TIMEOUT = aiohttp.ClientTimeout(total=120, sock_connect=20)


def _schedule_cache_ttl_patch(route: dict, session_id: str | None, cname: str, exp: str) -> None:
    """TTL 续期走后台，不挡当轮 generate。"""
    if not session_id or not cname:
        return

    async def _run() -> None:
        import gemini_cache as gcache
        import snapshot_state as snap
        try:
            patched = await gcache.patch_ttl(route, cname)
            snap.set_cache_meta(
                session_id,
                cache_name=cname,
                expire_at=patched.get("expire_at") or exp,
            )
        except Exception as pe:
            print(f"[gemini-gc] ttl patch fail: {pe}", file=sys.stderr, flush=True)

    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        pass


def _gemini_thinking_config(model: str) -> dict | None:
    """generateContent 路径：3.x 用 thinkingLevel；2.5 用 thinkingBudget=0。二者不能同传。

    includeThoughts：把可读 thought 放进 parts，否则只有 usage.thoughtsTokenCount、前端无思考卡。
    """
    m = (model or "").lower()
    level = resolve_thinking_level(model)
    if level:
        return {"thinkingLevel": level.upper(), "includeThoughts": True}
    if "2.5" in m or "flash-lite" in m:
        return {"thinkingBudget": 0}
    return None


_THINKING_PLACEHOLDER = "在想"


def _normalize_gemini_base(base: str) -> str:
    """旧 base（.../models、:generateContent）归一到 .../v1beta origin。"""
    base = (base or "https://generativelanguage.googleapis.com/v1beta").strip().rstrip("/")
    if ":generateContent" in base:
        base = base.split(":generateContent", 1)[0].rstrip("/")
    marker = "/v1beta"
    idx = base.find(marker)
    if idx >= 0:
        return base[: idx + len(marker)]
    if base.endswith("/models"):
        return base[: -len("/models")]
    return base


def _gemini_interactions_url(route: dict) -> str:
    origin = _normalize_gemini_base(route.get("base") or "")
    return f"{origin}/interactions"


def _openai_tools_to_gemini(tools: list | None, *, google_search: bool = False) -> list | None:
    """Gemini tools：可与 google_search 并存（并且）。"""
    out: list = []
    if google_search:
        out.append({"google_search": {}})
    decls = []
    for t in tools or []:
        fn = (t or {}).get("function") or t or {}
        name = fn.get("name")
        if not name:
            continue
        params = fn.get("parameters") or {"type": "object", "properties": {}}
        decls.append({
            "name": name,
            "description": fn.get("description") or "",
            "parameters": params,
        })
    if decls:
        out.append({"functionDeclarations": decls})
    return out or None


def _openai_tools_to_ix(tools: list | None, *, google_search: bool = False) -> list | None:
    """Interactions tools：可与 google_search 并存。"""
    out: list = []
    if google_search:
        out.append({"type": "google_search"})
    for t in tools or []:
        fn = (t or {}).get("function") or t or {}
        name = fn.get("name")
        if not name:
            continue
        out.append({
            "type": "function",
            "name": name,
            "description": fn.get("description") or "",
            "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    return out or None


def _gemini_tool_config(*, google_search: bool, has_functions: bool) -> dict | None:
    """内置 Search + function 并存时官方要求开此开关。"""
    if google_search and has_functions:
        return {"includeServerSideToolInvocations": True}
    return None


def _user_content_to_gemini_parts(content) -> list:
    if isinstance(content, str):
        return [{"text": content}] if content else []
    if not isinstance(content, list):
        return [{"text": str(content)}] if content else []
    parts = []
    for item in content:
        if not isinstance(item, dict):
            continue
        typ = item.get("type")
        if typ == "text":
            text = item.get("text") or ""
            if text:
                parts.append({"text": text})
        elif typ == "image_url":
            url, vision_lv = _image_url_meta(item)
            if not url.startswith("data:"):
                continue
            try:
                header, b64 = url.split(",", 1)
                mime = header.split(":")[1].split(";")[0] or "image/jpeg"
            except (ValueError, IndexError):
                continue
            parts.append({
                "inline_data": {"mime_type": mime, "data": b64},
                "media_resolution": {"level": gemini_media_resolution_enum(vision_lv)},
            })
    return parts or [{"text": ""}]


def _openai_messages_to_gemini(messages: list) -> tuple[str, list]:
    """OpenAI messages → (systemInstruction 文本, Gemini contents)。"""
    system_bits: list[str] = []
    contents: list[dict] = []
    call_names: dict[str, str] = {}
    for m in messages:
        role = (m.get("role") or "").strip()
        if role == "system":
            text = m.get("content") or ""
            if text:
                system_bits.append(text)
            continue
        if role == "tool":
            cid = m.get("tool_call_id") or ""
            name = call_names.get(cid) or "unknown"
            raw = m.get("content") or ""
            try:
                parsed = json.loads(raw) if raw.strip().startswith(("{", "[")) else {"result": raw}
            except json.JSONDecodeError:
                parsed = {"result": raw}
            if not isinstance(parsed, dict):
                parsed = {"result": parsed}
            contents.append({
                "role": "user",
                "parts": [{"functionResponse": {"name": name, "response": parsed}}],
            })
            continue
        if role == "assistant":
            tcs = m.get("tool_calls") or []
            for tc in tcs:
                fn = (tc or {}).get("function") or {}
                name = fn.get("name") or ""
                tid = tc.get("id") or ""
                if tid and name:
                    call_names[tid] = name
            stored = next((tc.get("_gemini_model_parts") for tc in tcs if isinstance(tc, dict) and tc.get("_gemini_model_parts")), None)
            if stored:
                contents.append({"role": "model", "parts": stored})
                continue
            parts = []
            text = m.get("content")
            if text:
                parts.append({"text": text})
            for tc in tcs:
                fn = (tc or {}).get("function") or {}
                name = fn.get("name") or ""
                args = fn.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args) if args.strip() else {}
                    except json.JSONDecodeError:
                        args = {"_raw": args}
                if not isinstance(args, dict):
                    args = {"value": args}
                if name:
                    fc_part = {"functionCall": {"name": name, "args": args}}
                    sig = (
                        tc.get("thoughtSignature")
                        or tc.get("thought_signature")
                        or fn.get("thoughtSignature")
                    )
                    if sig:
                        fc_part["thoughtSignature"] = sig
                    parts.append(fc_part)
            if parts:
                contents.append({"role": "model", "parts": parts})
            continue
        parts = _user_content_to_gemini_parts(m.get("content"))
        if parts:
            contents.append({"role": "user", "parts": parts})
    return "\n\n".join(system_bits), contents


def _gemini_parts_to_openai(parts: list) -> tuple[str, list | None]:
    text = ""
    calls = []
    raw_parts = [p for p in (parts or []) if isinstance(p, dict)]
    for i, part in enumerate(raw_parts):
        if part.get("text") and not part.get("thought"):
            text += part["text"]
        fc = part.get("functionCall")
        if fc and fc.get("name"):
            args = fc.get("args") or {}
            sig = part.get("thoughtSignature") or fc.get("thoughtSignature")
            entry = {
                "id": f"call_{i}",
                "type": "function",
                "function": {
                    "name": fc["name"],
                    "arguments": json.dumps(args, ensure_ascii=False) if not isinstance(args, str) else args,
                },
            }
            if sig:
                entry["thoughtSignature"] = sig
            calls.append(entry)
    if calls:
        calls[0]["_gemini_model_parts"] = raw_parts
    return text.strip(), (calls or None)


# 临时：DEBUG_LLM_DUMP=1 时把脱敏请求体写到 .bridge_state/llm_dumps/，stderr 只打一行摘要。
DEBUG_LLM_DUMP = os.environ.get("DEBUG_LLM_DUMP", "0") == "1"
_DUMP_DIR = Path(
    os.environ.get("BRIDGE_STATE_DIR")
    or (Path(__file__).resolve().parent / ".bridge_state")
) / "llm_dumps"


def _sanitize_gemini_body(body: dict) -> dict:
    out = copy.deepcopy(body)
    for c in out.get("contents") or []:
        for p in c.get("parts") or []:
            blob = p.get("inline_data") or p.get("inlineData")
            if not isinstance(blob, dict):
                continue
            raw = blob.get("data") or ""
            blob["data"] = f"<omitted {len(raw)} chars>"
    return out


def _gemini_prefix_meta(body: dict) -> dict:
    """相邻两次 dump 对比用：system / tools / 每条 content 的 hash。"""
    sys_text = ""
    for p in ((body.get("systemInstruction") or {}).get("parts") or []):
        sys_text += p.get("text") or ""
    tools_s = json.dumps(body.get("tools") or [], ensure_ascii=False, sort_keys=True)
    contents_meta = []
    for i, c in enumerate(body.get("contents") or []):
        raw = json.dumps(c, ensure_ascii=False, sort_keys=True)
        contents_meta.append({
            "i": i,
            "role": c.get("role"),
            "chars": len(raw),
            "sha16": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16],
        })
    return {
        "system_chars": len(sys_text),
        "system_sha16": hashlib.sha256(sys_text.encode("utf-8")).hexdigest()[:16],
        "tools_chars": len(tools_s),
        "tools_sha16": hashlib.sha256(tools_s.encode("utf-8")).hexdigest()[:16],
        "contents_n": len(contents_meta),
        "contents": contents_meta,
    }


def _maybe_dump_gemini(route: dict, body: dict, usage: dict) -> None:
    if not DEBUG_LLM_DUMP:
        return
    try:
        _DUMP_DIR.mkdir(parents=True, exist_ok=True)
        safe = _sanitize_gemini_body(body)
        prefix = _gemini_prefix_meta(safe)
        ts = time.strftime("%Y%m%d-%H%M%S")
        nonce = hashlib.sha256(f"{ts}{prefix['system_sha16']}{time.time()}".encode()).hexdigest()[:8]
        path = _DUMP_DIR / f"{ts}-{nonce}.json"
        payload = {
            "ts": ts,
            "model": route.get("model"),
            "usage": usage,
            "prefix": prefix,
            "body": safe,
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        cached = usage.get("cachedContentTokenCount")
        print(
            f"[gemini-dump] {path.name} sys={prefix['system_chars']}c "
            f"tools={prefix['tools_chars']}c contents={prefix['contents_n']} "
            f"cached={cached} prompt={usage.get('promptTokenCount')}",
            file=sys.stderr,
            flush=True,
        )
    except Exception as exc:
        print(f"[gemini-dump] 写入失败: {exc}", file=sys.stderr, flush=True)


def _gemini_ix_generation_config(model: str) -> dict:
    cfg: dict = {
        "max_output_tokens": MAX_TOKENS,
    }
    level = resolve_thinking_level(model)
    if level:
        cfg["thinking_level"] = level
        # auto：有可读摘要才返回；无则仅 signature。store=true 时签名由服务端管。
        cfg["thinking_summaries"] = "auto"
    return cfg


def _gemini_chat_mode() -> str:
    """generate（默认，显式 Cache）| interactions（旧链，回滚用）。"""
    raw = (os.environ.get("GEMINI_CHAT_MODE") or "generate").strip().lower()
    if raw in ("interactions", "ix", "interaction"):
        return "interactions"
    return "generate"


def _gemini_generate_url(route: dict) -> str:
    origin = _normalize_gemini_base(route.get("base") or "")
    model = (route.get("model") or "").strip()
    return f"{origin}/models/{model}:generateContent"


def _maybe_log_gc_usage(
    route: dict,
    usage: dict,
    *,
    cached_content: str | None,
    tool_calls: list | None,
) -> None:
    cached = usage.get("cachedContentTokenCount")
    cached_s = "-" if cached is None else cached
    thought = usage.get("thoughtsTokenCount")
    thought_s = "-" if thought is None else thought
    name = (cached_content or "").strip()
    name_tail = name[-20:] if len(name) > 20 else (name or "-")
    line = (
        f"[gemini-gc] ok model={route.get('model')} "
        f"cached={cached_s} prompt={usage.get('promptTokenCount')} "
        f"out={usage.get('candidatesTokenCount')} thought={thought_s} "
        f"tool={'yes' if tool_calls else 'no'} "
        f"cache={'yes' if name else 'no'} id=…{name_tail}"
    )
    print(line, file=sys.stderr, flush=True)
    _append_ix_log(line)


def _gemini_generate_request(
    route: dict,
    messages: list,
    tools: list | None,
    *,
    cached_content: str | None = None,
    google_search: bool = False,
) -> tuple[str, dict, str]:
    """generateContent / streamGenerateContent 共用请求体 → (model, body, cache_name)。

    额度内 Search 与自定义 function 并存；有 Cache 时 tools 已 bake 在 Cache 里。
    """
    model = (route.get("model") or "").strip()
    if not model:
        raise RuntimeError("Gemini 未填写模型名")

    use_cache = bool((cached_content or "").strip())
    msgs = messages
    if use_cache:
        msgs = [m for m in messages if (m.get("role") or "").strip() != "system"]

    sys_text, contents = _openai_messages_to_gemini(msgs)
    if not contents:
        contents = [{"role": "user", "parts": [{"text": "你好"}]}]

    gen_cfg: dict = {
        "maxOutputTokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
    }
    think = _gemini_thinking_config(model)
    if think:
        gen_cfg["thinkingConfig"] = think

    body: dict = {
        "contents": contents,
        "generationConfig": gen_cfg,
        "safetySettings": _GEMINI_SAFETY_SETTINGS,
    }
    cache_name = ""
    has_fns = bool(tools)
    if use_cache:
        # CachedContent 禁止在 generateContent 再带 system_instruction / tools / tool_config
        # （Google 400；tools 与并存 toolConfig 须在 create 时 bake）
        cache_name = cached_content.strip()
        if not cache_name.startswith("cachedContents/"):
            cache_name = f"cachedContents/{cache_name}"
        body["cachedContent"] = cache_name
    else:
        if sys_text:
            body["system_instruction"] = {"parts": [{"text": sys_text}]}
        gem_tools = _openai_tools_to_gemini(tools, google_search=google_search)
        if gem_tools:
            body["tools"] = gem_tools
        tc = _gemini_tool_config(google_search=google_search, has_functions=has_fns)
        if tc:
            body["toolConfig"] = tc
    return model, body, cache_name


def _gemini_headers(route: dict) -> dict:
    return {
        "Content-Type": "application/json",
        "x-goog-api-key": route.get("key") or "",
    }


async def _call_gemini_generate(
    route: dict,
    messages: list,
    tools: list | None,
    *,
    cached_content: str | None = None,
    google_search: bool = False,
):
    """无状态 generateContent；可选引用显式 cachedContents。"""
    model, body, cache_name = _gemini_generate_request(
        route, messages, tools,
        cached_content=cached_content, google_search=google_search,
    )
    url = _gemini_generate_url(route)
    proxy = proxy_url_for_route(route)
    async with aiohttp.ClientSession(timeout=_LLM_TIMEOUT) as session:
        async with session.post(url, json=body, headers=_gemini_headers(route), proxy=proxy) as resp:
            raw = await resp.text()
            if resp.status != 200:
                raise aiohttp.ClientResponseError(
                    resp.request_info, resp.history,
                    status=resp.status, message=raw[:800],
                )
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"{model}: generateContent 返回非 JSON") from e

    cands = data.get("candidates") or []
    if not cands:
        pf = data.get("promptFeedback") or {}
        raise RuntimeError(f"{model} generateContent 无 candidates: {pf or data}")
    cand0 = cands[0] if isinstance(cands[0], dict) else {}
    parts = ((cand0.get("content") or {}).get("parts")) or []
    usage = data.get("usageMetadata") or {}
    return _gemini_finish(route, body, cache_name, cand0, parts, usage)


def _merge_stream_part(acc: list, part: dict) -> None:
    """流式分片里的同类文字片段合并成一个 part；签名挂在合并后的 part 上（回传工具轮要用）。"""
    if not isinstance(part, dict):
        return
    is_text = "text" in part and not part.get("functionCall")
    if is_text and acc:
        prev = acc[-1]
        if (
            "text" in prev
            and not prev.get("functionCall")
            and bool(prev.get("thought")) == bool(part.get("thought"))
        ):
            prev["text"] = (prev.get("text") or "") + (part.get("text") or "")
            sig = part.get("thoughtSignature")
            if sig and not prev.get("thoughtSignature"):
                prev["thoughtSignature"] = sig
            return
    acc.append(dict(part))


async def _maybe_await(fn, arg) -> None:
    if fn is None:
        return
    r = fn(arg)
    if asyncio.iscoroutine(r):
        await r


async def _call_gemini_generate_stream(
    route: dict,
    messages: list,
    tools: list | None,
    *,
    cached_content: str | None = None,
    google_search: bool = False,
    on_thought=None,
    on_text=None,
    should_abort=None,
):
    """streamGenerateContent（SSE）。边收边回调思考/正文片段；返回值与非流式一致。

    should_abort() 为真时停止读流并返回已收到的部分（不抛异常，避免误触发路由降级）。
    """
    import codecs

    model, body, cache_name = _gemini_generate_request(
        route, messages, tools,
        cached_content=cached_content, google_search=google_search,
    )
    url = _gemini_generate_url(route).replace(":generateContent", ":streamGenerateContent") + "?alt=sse"
    proxy = proxy_url_for_route(route)
    parts_acc: list[dict] = []
    cand_meta: dict = {}
    usage: dict = {}
    last_payload: dict = {}
    saw_candidate = False

    async def _handle_event(payload: dict) -> None:
        nonlocal usage, last_payload, saw_candidate
        last_payload = payload
        if isinstance(payload.get("usageMetadata"), dict):
            usage = payload["usageMetadata"]
        cands = payload.get("candidates") or []
        if not cands or not isinstance(cands[0], dict):
            return
        saw_candidate = True
        c0 = cands[0]
        for k, v in c0.items():
            if k != "content":
                cand_meta[k] = v
        for p in ((c0.get("content") or {}).get("parts")) or []:
            if not isinstance(p, dict):
                continue
            _merge_stream_part(parts_acc, p)
            if p.get("functionCall"):
                continue
            t = p.get("text") or ""
            if not t:
                continue
            if p.get("thought"):
                await _maybe_await(on_thought, t)
            else:
                await _maybe_await(on_text, t)

    async with aiohttp.ClientSession(timeout=_LLM_TIMEOUT) as session:
        async with session.post(url, json=body, headers=_gemini_headers(route), proxy=proxy) as resp:
            if resp.status != 200:
                raw = await resp.text()
                raise aiohttp.ClientResponseError(
                    resp.request_info, resp.history,
                    status=resp.status, message=raw[:800],
                )
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            buf = ""
            aborted = False
            async for chunk in resp.content.iter_any():
                buf += decoder.decode(chunk)
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data_s = line[5:].strip()
                    if not data_s or data_s == "[DONE]":
                        continue
                    try:
                        payload = json.loads(data_s)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(payload, dict):
                        await _handle_event(payload)
                if should_abort is not None and should_abort():
                    aborted = True
                    break
            if not aborted:
                tail = (buf + decoder.decode(b"", final=True)).strip()
                if tail.startswith("data:"):
                    try:
                        payload = json.loads(tail[5:].strip())
                        if isinstance(payload, dict):
                            await _handle_event(payload)
                    except json.JSONDecodeError:
                        pass

    if not saw_candidate and not (should_abort is not None and should_abort()):
        pf = last_payload.get("promptFeedback") or {}
        raise RuntimeError(f"{model} streamGenerateContent 无 candidates: {pf or last_payload}")
    cand0 = {**cand_meta, "content": {"role": "model", "parts": parts_acc}}
    return _gemini_finish(route, body, cache_name, cand0, parts_acc, usage)


def _gemini_finish(route: dict, body: dict, cache_name: str, cand0: dict, parts: list, usage: dict):
    """候选 parts → (text, tool_calls, reasoning, usage)；记 gc 日志 / dump。"""
    text, tool_calls = _gemini_parts_to_openai(parts)
    thought_bits = []
    for p in parts:
        if isinstance(p, dict) and p.get("thought") and p.get("text"):
            thought_bits.append(p["text"])
    reasoning = "\n".join(thought_bits).strip()
    usage = usage or {}
    try:
        thought_n = int(usage.get("thoughtsTokenCount") or 0)
    except (TypeError, ValueError):
        thought_n = 0
    # 有思考消耗但 API 没给可读摘要 → 仍推短卡，避免「在想却没卡片」
    if not reasoning and thought_n > 0:
        reasoning = _THINKING_PLACEHOLDER
    try:
        import grounding_search as gs
        usage = dict(usage)
        # 不按「挂了 search」地板计次；只认响应里的 grounding 痕迹
        usage["_search_grounding"] = gs.count_from_usage_and_candidate(
            usage, cand0, response_text=text or "",
        )
    except Exception:
        pass
    _maybe_log_gc_usage(route, usage, cached_content=cache_name or None, tool_calls=tool_calls)
    _maybe_dump_gemini(route, body, usage)
    return text, tool_calls, reasoning, usage


def _message_content_to_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content or "")
    bits = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            bits.append(item.get("text") or "")
    return "\n".join(bits).strip()


def _user_content_to_ix_input(content) -> str | list:
    """OpenAI user content → Interactions input（字符串或多模态数组）。"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content or "")
    parts = []
    for item in content:
        if not isinstance(item, dict):
            continue
        typ = item.get("type")
        if typ == "text":
            text = item.get("text") or ""
            if text:
                parts.append({"type": "text", "text": text})
        elif typ == "image_url":
            url, vision_lv = _image_url_meta(item)
            if not url.startswith("data:"):
                continue
            try:
                header, b64 = url.split(",", 1)
                mime = header.split(":")[1].split(";")[0] or "image/jpeg"
            except (ValueError, IndexError):
                continue
            parts.append({
                "type": "image",
                "mime_type": mime,
                "data": b64,
                "media_resolution": {"level": gemini_media_resolution_enum(vision_lv)},
            })
    if not parts:
        return ""
    if len(parts) == 1 and parts[0].get("type") == "text":
        return parts[0]["text"]
    return parts


def _history_to_bootstrap_input(history: list) -> list:
    """无 previous_interaction_id 时，用阶梯窗历史 bootstrap 一次。"""
    steps: list = []
    for m in history:
        role = (m.get("role") or "").strip()
        if role == "user":
            inp = _user_content_to_ix_input(m.get("content"))
            if isinstance(inp, str):
                content = [{"type": "text", "text": inp}] if inp else []
            else:
                content = inp
            if content:
                steps.append({"type": "user_input", "content": content})
        elif role == "assistant":
            text = _message_content_to_text(m.get("content"))
            if text:
                steps.append({
                    "type": "model_output",
                    "content": [{"type": "text", "text": text}],
                })
    return steps


def _thought_summary_text(step: dict) -> str:
    """Interactions thought step → 可读摘要文本；无 summary 则空串。"""
    bits: list[str] = []
    summary = step.get("summary")
    if isinstance(summary, str) and summary.strip():
        return summary.strip()
    if not isinstance(summary, list):
        return ""
    for block in summary:
        if isinstance(block, str) and block.strip():
            bits.append(block.strip())
            continue
        if not isinstance(block, dict):
            continue
        text = (block.get("text") or "").strip()
        if text and (block.get("type") in (None, "", "text") or "text" in block):
            bits.append(text)
    return "\n".join(bits).strip()


def _parse_ix_response(data: dict) -> tuple[str, str, list | None, dict, str]:
    """Interaction 响应 → (interaction_id, text, tool_calls, usage, thought_summary)。"""
    iid = (data.get("id") or "").strip()
    steps = data.get("steps") or []
    text_parts: list[str] = []
    thought_parts: list[str] = []
    tool_calls: list[dict] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        stype = step.get("type")
        if stype == "thought":
            summary = _thought_summary_text(step)
            if summary:
                thought_parts.append(summary)
        elif stype == "model_output":
            for c in step.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
                    text_parts.append(c["text"])
        elif stype == "function_call" and step.get("name"):
            args = step.get("arguments") or {}
            tool_calls.append({
                "id": step.get("id") or f"call_{len(tool_calls)}",
                "type": "function",
                "function": {
                    "name": step["name"],
                    "arguments": json.dumps(args, ensure_ascii=False) if not isinstance(args, str) else args,
                },
            })
    usage = data.get("usage") or {}
    thought_summary = "\n\n".join(thought_parts).strip()
    return iid, "".join(text_parts).strip(), (tool_calls or None), usage, thought_summary


def _maybe_log_ix_usage(
    route: dict,
    usage: dict,
    *,
    previous_interaction_id: str | None = None,
    interaction_id: str | None = None,
    thinking_level: str | None = None,
    thought_chars: int = 0,
) -> None:
    cached = usage.get("total_cached_tokens")
    cached_s = "-" if cached is None else cached
    thought = usage.get("total_thought_tokens")
    thought_s = "-" if thought is None else thought
    tool_use = usage.get("total_tool_use_tokens")
    tool_s = "-" if tool_use is None else tool_use
    iid = (interaction_id or "").strip()
    iid_tail = iid[-16:] if len(iid) > 16 else (iid or "-")
    level_s = thinking_level or "-"
    line = (
        f"[gemini-ix] ok model={route.get('model')} level={level_s} "
        f"cached={cached_s} input={usage.get('total_input_tokens')} "
        f"out={usage.get('total_output_tokens')} thought={thought_s} "
        f"summary={thought_chars}c tool={tool_s} "
        f"prev={'yes' if previous_interaction_id else 'no'} id=…{iid_tail}"
    )
    print(line, file=sys.stderr, flush=True)
    _append_ix_log(line)


async def _call_gemini_interactions(
    route: dict,
    messages: list,
    tools: list | None,
    *,
    previous_interaction_id: str | None = None,
    tool_results: list[dict] | None = None,
    store: bool = True,
    google_search: bool = False,
):
    """Gemini Interactions API。tool_results 非空时为工具续跑。"""
    model = (route.get("model") or "").strip()
    if not model:
        raise RuntimeError("Gemini 未填写模型名")

    sys_text = ""
    for m in messages:
        if (m.get("role") or "").strip() == "system":
            sys_text = m.get("content") or ""
            break

    ix_tools = _openai_tools_to_ix(tools, google_search=google_search)
    gen_cfg = _gemini_ix_generation_config(model)
    body: dict = {
        "model": model,
        "store": store,
        "stream": False,
        "generation_config": gen_cfg,
    }
    if sys_text:
        body["system_instruction"] = sys_text
    if ix_tools:
        body["tools"] = ix_tools

    if tool_results:
        if not previous_interaction_id:
            raise RuntimeError("Gemini 工具续跑缺少 previous_interaction_id")
        body["previous_interaction_id"] = previous_interaction_id
        body["input"] = [
            {
                "type": "function_result",
                "call_id": tr["call_id"],
                "name": tr["name"],
                "result": [{"type": "text", "text": tr["result_text"]}],
            }
            for tr in tool_results
        ]
    elif previous_interaction_id:
        body["previous_interaction_id"] = previous_interaction_id
        current = messages[-1] if messages else {}
        body["input"] = _user_content_to_ix_input(current.get("content"))
    else:
        non_system = [m for m in messages if (m.get("role") or "").strip() != "system"]
        if not non_system:
            body["input"] = "你好"
        elif len(non_system) == 1:
            body["input"] = _user_content_to_ix_input(non_system[0].get("content"))
        else:
            bootstrap = _history_to_bootstrap_input(non_system[:-1])
            current = _user_content_to_ix_input(non_system[-1].get("content"))
            if isinstance(current, str):
                bootstrap.append({"type": "text", "text": current})
            else:
                bootstrap.extend(current)
            body["input"] = bootstrap

    url = _gemini_interactions_url(route)
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": route.get("key") or "",
        "Api-Revision": _GEMINI_IX_API_REVISION,
    }
    proxy = proxy_url_for_route(route)
    async with aiohttp.ClientSession(timeout=_LLM_TIMEOUT) as session:
        async with session.post(url, json=body, headers=headers, proxy=proxy) as resp:
            raw = await resp.text()
            if resp.status != 200:
                raise aiohttp.ClientResponseError(
                    resp.request_info, resp.history,
                    status=resp.status, message=raw[:800],
                )
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"{model}: Gemini Interactions 返回非 JSON") from e

    status = (data.get("status") or "").lower()
    if status == "failed":
        err = data.get("error") or {}
        raise RuntimeError(f"{model} Interactions 失败: {err.get('message') or err or status}")

    iid, text, tool_calls, usage, thought_summary = _parse_ix_response(data)
    try:
        thought_n = int((usage or {}).get("total_thought_tokens") or 0)
    except (TypeError, ValueError):
        thought_n = 0
    if not (thought_summary or "").strip() and thought_n > 0:
        thought_summary = _THINKING_PLACEHOLDER
    try:
        import grounding_search as gs
        usage = dict(usage or {})
        usage["_search_grounding"] = gs.count_from_usage_and_candidate(
            usage,
            None,
            response_text=text or "",
            ix_steps=data.get("steps") if isinstance(data, dict) else None,
        )
    except Exception:
        pass
    _maybe_log_ix_usage(
        route, usage,
        previous_interaction_id=previous_interaction_id,
        interaction_id=iid,
        thinking_level=gen_cfg.get("thinking_level"),
        thought_chars=len(thought_summary or ""),
    )
    return text, tool_calls, thought_summary, iid, usage


def _sanitize_openai_vision_messages(messages: list) -> list:
    """OpenAI 兼容口只保留 image_url.url + detail，去掉自用 vision 字段。"""
    out = []
    for m in messages:
        if not isinstance(m, dict):
            out.append(m)
            continue
        content = m.get("content")
        if not isinstance(content, list):
            out.append(m)
            continue
        new_parts = []
        changed = False
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "image_url":
                new_parts.append(item)
                continue
            blob = item.get("image_url") if isinstance(item.get("image_url"), dict) else {}
            url, vision_lv = _image_url_meta(item)
            clean = {
                "type": "image_url",
                "image_url": {
                    "url": url or (blob.get("url") or ""),
                    "detail": deepseek_image_detail(vision_lv),
                },
            }
            new_parts.append(clean)
            changed = True
        if changed:
            nm = dict(m)
            nm["content"] = new_parts
            out.append(nm)
        else:
            out.append(m)
    return out


def _llm_body(route: dict, messages: list, tools: list | None, *, stream: bool) -> dict:
    msgs = messages
    if _route_protocol(route) != "gemini":
        msgs = _sanitize_openai_vision_messages(messages)
    body = {
        "model": route["model"],
        "messages": msgs,
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
        # 显式关闭思考模式：避免产出 reasoning_content 后下轮必须回传否则 400
        "thinking": {"type": "disabled"},
    }
    if stream:
        body["stream"] = True
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if _needs_gemini_safety(route):
        body["safety_settings"] = _GEMINI_SAFETY_SETTINGS
    return body


# =============================================================================
# LLM 调用核心
# =============================================================================

async def _call_llm_stream(route: dict, messages: list, tools: list | None, *, should_abort=None):
    """流式调用 LLM，逐块产出 delta 文本或 tool_calls。

    Yields:
        {"type": "text", "text": str}      — 文本增量
        {"type": "tool_calls", "calls": list}  — 累积完成的 tool_calls
    """
    body = _llm_body(route, messages, tools, stream=True)

    headers = {
        "Authorization": f"Bearer {route['key']}",
        "Content-Type": "application/json",
    }
    url = route["base"] + "/chat/completions"
    proxy = proxy_url_for_route(route)

    async with aiohttp.ClientSession(timeout=_LLM_TIMEOUT) as session:
        async with session.post(url, json=body, headers=headers, proxy=proxy) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise aiohttp.ClientResponseError(
                    resp.request_info, resp.history,
                    status=resp.status, message=text,
                )

            full_text = ""
            reasoning_text = ""
            usage_payload: dict | None = None
            # 流式 tool_calls 累积：{index: {id, function: {name, arguments}}}
            tc_buf: dict[int, dict] = {}

            async for raw in resp.content:
                if should_abort is not None and should_abort():
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if isinstance(chunk.get("usage"), dict):
                    usage_payload = chunk["usage"]
                # 部分厂商最后一块的 choices 为空，不能直接 [0]
                delta = ((chunk.get("choices") or [{}])[0].get("delta") or {})

                # 思考内容（开启 thinking 时返回；关闭时为空）
                if "reasoning_content" in delta and delta["reasoning_content"]:
                    reasoning_text += delta["reasoning_content"]

                # 文本增量
                if "content" in delta and delta["content"]:
                    full_text += delta["content"]
                    yield {"type": "text", "text": delta["content"]}

                # 累积 tool_calls
                if "tool_calls" in delta:
                    for tc in delta["tool_calls"]:
                        idx = tc.get("index", 0)
                        if idx not in tc_buf:
                            tc_buf[idx] = {
                                "id": "",
                                "type": "function",
                                "function": {"name": "", "arguments": ""},
                            }
                        entry = tc_buf[idx]
                        if "id" in tc:
                            entry["id"] = tc["id"]
                        if "function" in tc:
                            fn = tc["function"]
                            if "name" in fn:
                                entry["function"]["name"] += fn["name"]
                            if "arguments" in fn:
                                entry["function"]["arguments"] += fn["arguments"]

            # 流结束，产出结果
            if tc_buf:
                yield {
                    "type": "tool_calls",
                    "calls": [tc_buf[i] for i in sorted(tc_buf.keys())],
                    "text": full_text,
                    "reasoning": reasoning_text,
                    "usage": usage_payload,
                }
            else:
                yield {
                    "type": "done",
                    "text": full_text,
                    "reasoning": reasoning_text,
                    "usage": usage_payload,
                }


async def _call_llm_nonstream(route: dict, messages: list, tools: list | None):
    """非流式调用 LLM，返回 (完整文本, tool_calls | None, reasoning, usage)"""
    body = _llm_body(route, messages, tools, stream=False)

    headers = {
        "Authorization": f"Bearer {route['key']}",
        "Content-Type": "application/json",
    }
    url = route["base"] + "/chat/completions"
    proxy = proxy_url_for_route(route)

    async with aiohttp.ClientSession(timeout=_LLM_TIMEOUT) as session:
        async with session.post(url, json=body, headers=headers, proxy=proxy) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise aiohttp.ClientResponseError(
                    resp.request_info, resp.history,
                    status=resp.status, message=text,
                )
            data = await resp.json()

    choice = data["choices"][0]
    text = (choice.get("message", {}).get("content") or "").strip()
    tool_calls = choice.get("message", {}).get("tool_calls")
    reasoning = choice.get("message", {}).get("reasoning_content") or ""
    return text, tool_calls, reasoning, data.get("usage")


async def call_llm(
    messages: list,
    tools: list | None = None,
    stream: bool = True,
    *,
    session_id: str | None = None,
    persist_interaction: bool = True,
    previous_interaction_id: str | None = None,
    tool_results: list[dict] | None = None,
    cached_content: str | None = None,
    google_search: bool = False,
    turn_meta: dict | None = None,
    on_thought=None,
    on_text=None,
    should_abort=None,
):
    """多模型路由调用，支持故障切换。

    on_thought / on_text：Gemini generate 路径改走 streamGenerateContent，边收边回调。

    Gemini：
      默认 GEMINI_CHAT_MODE=generate → generateContent + 可选显式 cachedContent
      GEMINI_CHAT_MODE=interactions → 旧 Interactions 链（回滚）
    google_search：额度允许时与自定义 function 并存挂内置 Search（仅 Gemini）。
    turn_meta：若传入 dict，写入 search_grounding 供 bridge 记账 / act 卡。
    """
    import gemini_interaction_state as gis
    import gemini_cache as gcache
    import snapshot_state as snap

    errors: list[str] = []
    last_err = None
    last_route = None
    gemini_failed = False
    for route in CHAT_ROUTES:
        last_route = route
        try:
            if _route_protocol(route) == "gemini":
                if _gemini_chat_mode() == "interactions":
                    prev_id = previous_interaction_id
                    if prev_id is None and session_id and persist_interaction:
                        prev_id = gis.get_interaction_id(
                            session_id,
                            base=route.get("base") or "",
                            model=route.get("model") or "",
                        )
                    text, tool_calls, reasoning, iid, usage = await _call_gemini_interactions(
                        route, messages, tools,
                        previous_interaction_id=prev_id,
                        tool_results=tool_results,
                        store=persist_interaction,
                        google_search=google_search,
                    )
                    _report_usage(route, usage, session_id=session_id)
                    if turn_meta is not None and isinstance(usage, dict):
                        sg = usage.get("_search_grounding")
                        if sg:
                            turn_meta["search_grounding"] = sg
                    if persist_interaction and session_id:
                        gis.note_ix_usage(
                            session_id,
                            input_tokens=usage.get("total_input_tokens"),
                            cached_tokens=usage.get("total_cached_tokens"),
                            base=route.get("base") or "",
                            model=route.get("model") or "",
                        )
                        if iid:
                            gis.set_interaction_id(
                                session_id, iid,
                                base=route.get("base") or "",
                                model=route.get("model") or "",
                            )
                    return text, tool_calls, reasoning

                # —— generateContent + 显式 Cache ——
                cache_name = (cached_content or "").strip()
                if not cache_name and session_id:
                    entry = snap.get_entry(session_id)
                    cname = (entry.get("cache_name") or "").strip()
                    exp = (entry.get("expire_at") or "").strip()
                    if cname and not gcache.is_expired(exp):
                        cache_name = cname
                        if gcache.should_patch_ttl(exp):
                            _schedule_cache_ttl_patch(route, session_id, cname, exp)
                    elif cname and gcache.is_expired(exp):
                        # 过期：本轮降级；是否重建由 bridge 按 r 决定
                        cache_name = ""

                streaming = on_thought is not None or on_text is not None

                async def _gen(cname: str | None):
                    if streaming:
                        return await _call_gemini_generate_stream(
                            route, messages, tools,
                            cached_content=cname,
                            google_search=google_search,
                            on_thought=on_thought,
                            on_text=on_text,
                            should_abort=should_abort,
                        )
                    return await _call_gemini_generate(
                        route, messages, tools,
                        cached_content=cname,
                        google_search=google_search,
                    )

                try:
                    text, tool_calls, reasoning, usage = await _gen(cache_name or None)
                except aiohttp.ClientResponseError as e:
                    # cache 失效 → 清指针、当轮立刻无 Cache 再打一次（400 很快；超时不二次 120s）
                    if cache_name and e.status in (400, 403, 404):
                        if session_id:
                            snap.clear_cache_meta(session_id)
                        detail = (getattr(e, "message", None) or "")[:400]
                        print(
                            f"[gemini-gc] cache HTTP {e.status} → degrade no-cache"
                            + (f" detail={detail}" if detail else ""),
                            file=sys.stderr, flush=True,
                        )
                        text, tool_calls, reasoning, usage = await _gen(None)
                    else:
                        raise
                except asyncio.TimeoutError:
                    if cache_name:
                        print(
                            "[gemini-gc] cache call timeout → no second full generate",
                            file=sys.stderr, flush=True,
                        )
                    raise

                # 映射到统一 usage 字段供计价
                mapped = {
                    "total_input_tokens": usage.get("promptTokenCount"),
                    "total_output_tokens": usage.get("candidatesTokenCount"),
                    "total_cached_tokens": usage.get("cachedContentTokenCount"),
                    "total_thought_tokens": usage.get("thoughtsTokenCount"),
                }
                if turn_meta is not None and isinstance(usage, dict):
                    sg = usage.get("_search_grounding")
                    if sg:
                        turn_meta["search_grounding"] = sg
                _report_usage(route, mapped, session_id=session_id)
                return text, tool_calls, reasoning
            if stream:
                result = await _collect_stream(
                    route,
                    messages,
                    tools,
                    on_text=on_text,
                    on_thought=on_thought,
                    should_abort=should_abort,
                )
            else:
                result = await _call_llm_nonstream(route, messages, tools)
            text, tool_calls, reasoning, raw_usage = result
            # 只有厂商返回标准 usage 时才记 token；没返回就只记调用次数。
            _report_usage(
                route,
                _normalize_openai_usage(raw_usage),
                session_id=session_id,
            )
            if gemini_failed:
                _log_llm_fallback(route)
            return text, tool_calls, reasoning
        except aiohttp.ClientResponseError as e:
            last_err = e
            err_line = _format_llm_error(e, route)
            errors.append(err_line)
            if _route_protocol(route) == "gemini":
                gemini_failed = True
                _log_gemini_ix_fail(route, err_line)
                _report_usage(route, None, session_id=session_id, status="fail")
                if _gemini_no_fallback():
                    raise RuntimeError(err_line) from e
            if e.status in FALLBACK_HTTP_CODES:
                continue
            raise RuntimeError(errors[-1]) from e
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            last_err = e
            err_line = _format_llm_error(e, route)
            errors.append(err_line)
            if _route_protocol(route) == "gemini":
                gemini_failed = True
                _log_gemini_ix_fail(route, err_line)
                _report_usage(route, None, session_id=session_id, status="fail")
                if _gemini_no_fallback():
                    raise RuntimeError(err_line) from e
            continue
        except RuntimeError as e:
            last_err = e
            err_line = _format_llm_error(e, route)
            errors.append(err_line)
            if _route_protocol(route) == "gemini":
                gemini_failed = True
                _log_gemini_ix_fail(route, err_line)
                _report_usage(route, None, session_id=session_id, status="fail")
                if _gemini_no_fallback():
                    raise
            continue
    detail = "; ".join(errors) if errors else _format_llm_error(last_err or RuntimeError("未知错误"), last_route)
    raise RuntimeError(f"聊天模型调用失败: {detail}")


async def _collect_stream(
    route: dict,
    messages: list,
    tools: list | None,
    *,
    on_text=None,
    on_thought=None,
    should_abort=None,
):
    """收集流式输出，返回完整文本 + tool_calls + 思考内容 + usage。

    on_text / on_thought 用来把增量实时转给前端；不传则只收集。
    """
    full_text = ""
    tool_calls = None
    reasoning = ""
    usage = None
    async for chunk in _call_llm_stream(route, messages, tools, should_abort=should_abort):
        if chunk["type"] == "text":
            full_text += chunk["text"]
            if on_text is not None:
                await on_text(chunk["text"])
        elif chunk["type"] == "tool_calls":
            tool_calls = chunk["calls"]
            full_text = chunk.get("text", full_text)
            reasoning = chunk.get("reasoning", "")
            usage = chunk.get("usage") or usage
        elif chunk["type"] == "done":
            full_text = chunk["text"]
            reasoning = chunk.get("reasoning", "")
            usage = chunk.get("usage") or usage
    return (full_text.strip(), tool_calls, reasoning, usage)
