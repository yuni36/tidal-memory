"""Gemini Google Search grounding：额度闸门、用量抽取、act 卡片。"""

from __future__ import annotations

import os
import re
from typing import Any

import aiohttp

MEMORY_URL = os.environ.get("MEMORY_URL", "http://127.0.0.1:3013").rstrip("/")

# 默认开；设 0 总关
def search_enabled_by_env() -> bool:
    v = (os.environ.get("GEMINI_GOOGLE_SEARCH") or "1").strip().lower()
    return v not in ("0", "false", "off", "no")


_GROUNDING_URL_RE = re.compile(
    r"vertexaisearch\.cloud\.google\.com/grounding-api-redirect|"
    r"grounding-api-redirect",
    re.I,
)


_SEARCH_HINT_RE = re.compile(
    r"(搜(索|一下)?|查一下(网|下)|网上|新闻|热搜|比分|几比几|"
    r"最新消息|头条|谷歌一下|google\s*(一下|下)?)",
    re.I,
)


def user_text_wants_search(text: str) -> bool:
    """保留启发式（测试/调试）；主路径已不 XOR，不再用它切搜轮。"""
    t = (text or "").strip()
    if not t:
        return False
    return bool(_SEARCH_HINT_RE.search(t))


async def fetch_quota(session: aiohttp.ClientSession | None = None) -> dict[str, Any]:
    """GET /grounding/quota → { allowed, used, limit, remaining, month }。"""
    own = session is None
    if own:
        session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8))
    try:
        async with session.get(f"{MEMORY_URL}/grounding/quota") as resp:
            if resp.status != 200:
                return {"allowed": False, "used": 0, "limit": 3000, "remaining": 0, "error": resp.status}
            data = await resp.json()
            return data if isinstance(data, dict) else {}
    except Exception as e:
        return {"allowed": False, "used": 0, "limit": 3000, "remaining": 0, "error": str(e)}
    finally:
        if own:
            await session.close()


async def consume(count: int, session: aiohttp.ClientSession | None = None) -> dict[str, Any]:
    n = max(0, int(count or 0))
    if n <= 0:
        return {}
    own = session is None
    if own:
        session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8))
    try:
        async with session.post(
            f"{MEMORY_URL}/grounding/quota/consume",
            json={"count": n},
        ) as resp:
            if resp.status != 200:
                return {"error": resp.status}
            data = await resp.json()
            return data if isinstance(data, dict) else {}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if own:
            await session.close()


def count_from_usage_and_candidate(
    usage: dict | None,
    candidate: dict | None,
    *,
    response_text: str = "",
    ix_steps: list | None = None,
    search_turn: bool = False,
) -> dict[str, Any]:
    """估计 billable search 次数（宁多勿少）。

    官方只说明 Gemini 3 按非空 query 计费；generateContent 的 billedToolCalls
    常缺失。启发式：有明确条数用条数；有搜过痕迹但无数 → 保守 +2。
    """
    usage = usage or {}
    queries: list[str] = []
    sources: list[str] = []
    count = 0
    reason = "none"

    for item in usage.get("billedToolCalls") or usage.get("billed_tool_calls") or []:
        if not isinstance(item, dict):
            continue
        tool = str(item.get("tool") or item.get("name") or "").upper()
        if "GOOGLE_SEARCH" in tool or tool.endswith("SEARCH"):
            c = item.get("successfulToolCallCount")
            if c is None:
                c = item.get("successful_tool_call_count")
            try:
                n = int(c or 0)
            except (TypeError, ValueError):
                n = 0
            if n > count:
                count = n
                reason = "billedToolCalls"

    for item in usage.get("grounding_tool_count") or usage.get("groundingToolCount") or []:
        if not isinstance(item, dict):
            continue
        typ = str(item.get("type") or "").lower()
        if "search" not in typ:
            continue
        try:
            n = int(item.get("count") or 0)
        except (TypeError, ValueError):
            n = 0
        if n > count:
            count = n
            reason = "grounding_tool_count"

    gm = None
    if isinstance(candidate, dict):
        gm = candidate.get("groundingMetadata") or candidate.get("grounding_metadata")

    if isinstance(gm, dict):
        raw_q = gm.get("webSearchQueries") or gm.get("web_search_queries") or []
        for q in raw_q:
            s = str(q or "").strip()
            if s and s not in queries:
                queries.append(s)
        for ch in gm.get("groundingChunks") or gm.get("grounding_chunks") or []:
            if not isinstance(ch, dict):
                continue
            web = ch.get("web") or {}
            title = (web.get("title") or "").strip()
            if title and title not in sources:
                sources.append(title)

    if ix_steps:
        for step in ix_steps:
            if not isinstance(step, dict):
                continue
            if step.get("type") == "google_search_call":
                args = step.get("arguments") or {}
                for q in args.get("queries") or []:
                    s = str(q or "").strip()
                    if s and s not in queries:
                        queries.append(s)

    if queries and count < len(queries):
        count = len(queries)
        reason = "webSearchQueries"

    # 有 grounding 痕迹但无数：保守按 2 计（一轮常 ≥1，多 query 时宁可多记）
    has_gm_trace = False
    if isinstance(gm, dict) and (
        gm.get("groundingChunks")
        or gm.get("grounding_chunks")
        or gm.get("groundingSupports")
        or gm.get("grounding_supports")
        or gm.get("searchEntryPoint")
        or gm.get("search_entry_point")
        or queries
    ):
        has_gm_trace = True

    has_citation = False
    if isinstance(candidate, dict):
        parts = ((candidate.get("content") or {}).get("parts")) or []
        for p in parts:
            if not isinstance(p, dict):
                continue
            for ann in p.get("annotations") or []:
                if not isinstance(ann, dict):
                    continue
                typ = str(ann.get("type") or "").lower()
                if "citation" in typ or ann.get("url") or ann.get("uri"):
                    has_citation = True
                    break
            if has_citation:
                break

    has_redirect = bool(response_text and _GROUNDING_URL_RE.search(response_text))

    if count <= 0 and (has_gm_trace or has_citation or has_redirect):
        count = 2
        reason = (
            "redirect" if has_redirect
            else "citation" if has_citation
            else "gm_trace"
        )

    # 有明确 1 次但多源/跳转痕迹 → 抬到 2（不再做无痕迹 search_turn 地板）
    if count == 1 and (len(sources) >= 2 or has_redirect):
        count = 2
        reason = "bump_sources"

    return {
        "count": max(0, int(count)),
        "queries": queries,
        "sources": sources[:8],
        "reason": reason,
    }


def build_act_payload(info: dict[str, Any]) -> tuple[str, dict]:
    """→ (text, meta) for kind=act。"""
    queries = list(info.get("queries") or [])
    sources = list(info.get("sources") or [])
    if len(queries) == 1:
        q = queries[0]
        label = f"查了：{q[:28]}{'…' if len(q) > 28 else ''}"
    elif queries:
        label = f"查了一下网（{len(queries)} 条）"
    else:
        label = "查了一下网"

    steps: list[dict] = []
    for q in queries:
        steps.append({"tool": "google_search", "result": f"query: {q}"})
    if sources:
        steps.append({"tool": "sources", "result": " · ".join(sources[:5])})
    if not steps:
        steps.append({"tool": "google_search", "result": f"searches≈{info.get('count') or 1}"})

    return label, {"glyph": "web", "steps": steps}


def merge_google_search_tool(gemini_tools: list | None, enabled: bool) -> list | None:
    """在 Gemini tools 数组前插入 {google_search:{}}。"""
    if not enabled:
        return gemini_tools
    out: list = [{"google_search": {}}]
    if gemini_tools:
        out.extend(gemini_tools)
    return out
