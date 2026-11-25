"""Gemini 显式 Context Cache（cachedContents）客户端。

CREATE / PATCH(ttl) / DELETE。正文创建后不可变；更新 A 区 = 新建 + 删旧。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import aiohttp

DEFAULT_TTL_SEC = int(os.environ.get("GEMINI_CACHE_TTL_SEC", "1800") or "1800")
PATCH_IF_REMAINING_SEC = int(os.environ.get("GEMINI_CACHE_PATCH_REMAINING_SEC", "600") or "600")


def _ttl_str(seconds: int | None = None) -> str:
    sec = int(seconds if seconds is not None else DEFAULT_TTL_SEC)
    return f"{max(60, sec)}s"


def _model_resource(model: str) -> str:
    m = (model or "").strip()
    if m.startswith("models/"):
        return m
    return f"models/{m}"


def _normalize_gemini_base(base: str) -> str:
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


def _headers(route: dict) -> dict:
    return {
        "Content-Type": "application/json",
        "x-goog-api-key": route.get("key") or "",
    }


def _origin(route: dict) -> str:
    return _normalize_gemini_base(route.get("base") or "")


def _tools_for_cache(tools: list | None, *, google_search: bool = False) -> list | None:
    out: list[dict[str, Any]] = []
    if google_search:
        out.append({"google_search": {}})
    decls = []
    for t in tools or []:
        fn = (t or {}).get("function") or t or {}
        name = fn.get("name")
        if not name:
            continue
        decls.append({
            "name": name,
            "description": fn.get("description") or "",
            "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    if decls:
        out.append({"functionDeclarations": decls})
    return out or None


def _proxy_for_route(route: dict) -> str | None:
    # 延迟导入，避免与 model_router 循环依赖
    from model_router import proxy_url_for_route
    return proxy_url_for_route(route)


def parse_expire_at(payload: dict | None) -> str:
    if not isinstance(payload, dict):
        return ""
    return (payload.get("expireTime") or payload.get("expire_time") or "").strip()


def remaining_seconds(expire_at: str, *, now: datetime | None = None) -> float | None:
    if not expire_at:
        return None
    raw = expire_at.strip()
    try:
        if raw.endswith("Z"):
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    now = now or datetime.now(timezone.utc)
    return (dt - now).total_seconds()


def should_patch_ttl(expire_at: str) -> bool:
    rem = remaining_seconds(expire_at)
    if rem is None:
        return False
    return 0 < rem < PATCH_IF_REMAINING_SEC


def is_expired(expire_at: str) -> bool:
    rem = remaining_seconds(expire_at)
    if rem is None:
        return False
    return rem <= 0


def is_too_short_error(err: BaseException) -> bool:
    msg = str(err).lower()
    return ("minimum" in msg and "token" in msg) or ("cached content is of" in msg)


async def create_cached_content(
    route: dict,
    *,
    system_text: str,
    hot3: list[dict] | None = None,
    tools: list | None = None,
    ttl_seconds: int | None = None,
    display_name: str = "",
    google_search: bool = False,
) -> dict[str, Any]:
    model = (route.get("model") or "").strip()
    if not model:
        raise RuntimeError("Gemini cache: 未填写模型名")

    contents: list[dict] = []
    for m in hot3 or []:
        if not isinstance(m, dict):
            continue
        role = "user" if m.get("role") == "user" else "model"
        text = str(m.get("content") or "").strip()
        if not text:
            continue
        contents.append({"role": role, "parts": [{"text": text}]})
    if not contents:
        contents = [{"role": "user", "parts": [{"text": "[snapshot anchor]"}]}]

    body: dict[str, Any] = {
        "model": _model_resource(model),
        "contents": contents,
        "ttl": _ttl_str(ttl_seconds),
    }
    if system_text and system_text.strip():
        body["systemInstruction"] = {"parts": [{"text": system_text.strip()}]}
    gem_tools = _tools_for_cache(tools, google_search=google_search)
    if gem_tools:
        body["tools"] = gem_tools
        # Search + function 并存时，toolConfig 必须 bake 进 Cache（generate 端不能再带）
        if google_search and any("functionDeclarations" in (t or {}) for t in gem_tools):
            body["toolConfig"] = {"includeServerSideToolInvocations": True}
    if display_name:
        body["displayName"] = display_name[:128]

    url = f"{_origin(route)}/cachedContents"
    proxy = _proxy_for_route(route)
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, json=body, headers=_headers(route), proxy=proxy) as resp:
            raw = await resp.text()
            if resp.status != 200:
                raise aiohttp.ClientResponseError(
                    resp.request_info,
                    resp.history,
                    status=resp.status,
                    message=raw[:800],
                )
            data = json.loads(raw)

    name = (data.get("name") or "").strip()
    if not name:
        raise RuntimeError("Gemini cache create: 响应无 name")
    usage = data.get("usageMetadata") or data.get("usage_metadata") or {}
    return {
        "name": name,
        "expire_at": parse_expire_at(data),
        "total_token_count": usage.get("totalTokenCount") or usage.get("total_token_count"),
        "raw": data,
    }


async def patch_ttl(
    route: dict,
    cache_name: str,
    *,
    ttl_seconds: int | None = None,
) -> dict[str, Any]:
    name = (cache_name or "").strip()
    if not name:
        raise RuntimeError("Gemini cache patch: 空 name")
    if not name.startswith("cachedContents/"):
        name = f"cachedContents/{name}"

    url = f"{_origin(route)}/{name}?updateMask=ttl"
    body = {"ttl": _ttl_str(ttl_seconds)}
    proxy = _proxy_for_route(route)
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.patch(url, json=body, headers=_headers(route), proxy=proxy) as resp:
            raw = await resp.text()
            if resp.status != 200:
                raise aiohttp.ClientResponseError(
                    resp.request_info,
                    resp.history,
                    status=resp.status,
                    message=raw[:800],
                )
            data = json.loads(raw)
    return {
        "name": (data.get("name") or name).strip(),
        "expire_at": parse_expire_at(data),
        "raw": data,
    }


async def delete_cached_content(route: dict, cache_name: str) -> bool:
    name = (cache_name or "").strip()
    if not name:
        return False
    if not name.startswith("cachedContents/"):
        name = f"cachedContents/{name}"
    url = f"{_origin(route)}/{name}"
    proxy = _proxy_for_route(route)
    timeout = aiohttp.ClientTimeout(total=30)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.delete(url, headers=_headers(route), proxy=proxy) as resp:
                if resp.status in (200, 204, 404):
                    return True
                raw = await resp.text()
                raise aiohttp.ClientResponseError(
                    resp.request_info,
                    resp.history,
                    status=resp.status,
                    message=raw[:400],
                )
    except Exception:
        return False
