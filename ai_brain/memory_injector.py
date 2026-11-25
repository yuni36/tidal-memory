"""
记忆 / 日程 / 天气注入。功能关时返回空，不抛错——不挡回复、不挡固化。
旗标由 bridge.apply_hot_settings 写入，缺省 fail-open。
"""

import os

import aiohttp

MEMORY_URL = os.environ.get("MEMORY_URL", "http://127.0.0.1:3013").rstrip("/")

# 由 bridge.apply_hot_settings 热更新；缺省开，与上线前行为一致
FEATURE_WEATHER = True
FEATURE_SCHEDULE_INJECT = True
FEATURE_MEMORY_INJECT = True


def set_feature_gates(
    *,
    weather: bool | None = None,
    schedule_inject: bool | None = None,
    memory_inject: bool | None = None,
) -> None:
    global FEATURE_WEATHER, FEATURE_SCHEDULE_INJECT, FEATURE_MEMORY_INJECT
    if weather is not None:
        FEATURE_WEATHER = bool(weather)
    if schedule_inject is not None:
        FEATURE_SCHEDULE_INJECT = bool(schedule_inject)
    if memory_inject is not None:
        FEATURE_MEMORY_INJECT = bool(memory_inject)


async def inject_current_state(
    user_message: str = "",
    *,
    sticky_entities: bool = True,
) -> str | None:
    """当前状态上下文；失败返回 None。"""
    try:
        async with aiohttp.ClientSession() as session:
            url = f"{MEMORY_URL}/intuition/context"
            params = {"q": (user_message or "")[:200]}
            if not sticky_entities:
                params["sticky"] = "0"
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
    except Exception:
        return None
    text = (data.get("text") or "").strip()
    return text or None


async def inject_memories(user_message: str) -> str | None:
    """相关记忆检索；失败 / 无关 / 功能关 返回 None。"""
    if not FEATURE_MEMORY_INJECT:
        return None
    if not user_message.strip():
        return None

    try:
        async with aiohttp.ClientSession() as session:
            url = f"{MEMORY_URL}/librarian/search"
            params = {"q": user_message[:200], "limit": "5"}
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
    except Exception:
        return None

    context = data.get("context")
    if context:
        return f"相关记忆\n{context}"

    results = data.get("results", [])
    if not results:
        return None

    lines: list[str] = []
    for r in results[:5]:
        ctype = r.get("type", "memory")
        content = r.get("content", "")
        entity = r.get("entity", "")
        score = r.get("score", 0)
        if score < 0.3:
            continue
        prefix = ""
        if ctype == "episode":
            prefix = "[片段]"
        elif ctype == "fragment":
            prefix = "[碎片]"
        if entity:
            prefix += f" ·{entity}"
        lines.append(f"{prefix} {content}" if prefix else content)

    if not lines:
        return None

    return "相关记忆\n" + "\n".join(lines)


async def inject_schedule() -> str | None:
    """拉可注入日程短文本。关功能时返回 None（空注入），不挡固化。"""
    if not FEATURE_SCHEDULE_INJECT:
        return None
    try:
        async with aiohttp.ClientSession() as session:
            url = f"{MEMORY_URL}/schedules"
            params = {"injectable": "1"}
            async with session.get(
                url, params=params, timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
    except Exception:
        return None
    text = (data.get("text") or "").strip()
    return text or None


async def inject_weather() -> str | None:
    """拉天气缓存短文本。关功能时返回 None，聊天照常。"""
    if not FEATURE_WEATHER:
        return None
    try:
        async with aiohttp.ClientSession() as session:
            url = f"{MEMORY_URL}/weather/cache"
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
    except Exception:
        return None
    text = (data.get("text") or "").strip()
    return text or None
