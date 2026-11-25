"""
情绪（积温）客户端 —— observe / 拉情绪状态。

失败只打日志，绝不打断回复。
"""

from __future__ import annotations

import logging
import os
from typing import Any

import aiohttp

MEMORY_URL = os.environ.get("MEMORY_URL", "http://127.0.0.1:3013").rstrip("/")
log = logging.getLogger("affect_client")


async def observe(
    session: aiohttp.ClientSession | None,
    *,
    text: str,
    message_id: int | None = None,
    context: str = "",
    reset: bool = True,
    timeout: float = 8.0,
) -> dict[str, Any] | None:
    """分析用户本轮消息的情绪冲击。返回 JSON 或 None（失败）。"""
    body = (text or "").strip()
    if not body:
        return None

    payload: dict[str, Any] = {
        "text": body,
        "reset": reset,
    }
    if message_id is not None:
        try:
            payload["message_id"] = int(message_id)
        except (TypeError, ValueError):
            pass
    if context:
        payload["context"] = context[:1500]

    url = f"{MEMORY_URL}/affect/observe"
    own_session = session is None
    http = session or aiohttp.ClientSession()
    try:
        async with http.post(
            url,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            if resp.status >= 400:
                detail = (await resp.text())[:200]
                log.warning("observe HTTP %s: %s", resp.status, detail)
                return None
            data = await resp.json(content_type=None)
            return data if isinstance(data, dict) else None
    except Exception as e:
        log.warning("observe failed: %s", e)
        return None
    finally:
        if own_session:
            await http.close()


async def fetch_state(
    session: aiohttp.ClientSession | None,
    *,
    timeout: float = 4.0,
) -> dict[str, Any] | None:
    """拉五轴 + styleGuidance（语调染色用）。"""
    url = f"{MEMORY_URL}/affect/state"
    own_session = session is None
    http = session or aiohttp.ClientSession()
    try:
        async with http.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            if resp.status >= 400:
                return None
            data = await resp.json(content_type=None)
            return data if isinstance(data, dict) else None
    except Exception as e:
        log.warning("fetch_state failed: %s", e)
        return None
    finally:
        if own_session:
            await http.close()
