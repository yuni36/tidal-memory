"""自建 / 远端 ntfy 通知（可选通道）。

只读 NTFY_URL（完整 topic URL，如 https://ntfy.example.com/your-secret-topic）。
未配置则静默跳过。与 Web Push 解耦：本模块零业务、不碰 SQLite。
"""
from __future__ import annotations

import os
import urllib.error
import urllib.request
from typing import Any

NTFY_URL = (os.environ.get("NTFY_URL") or "").strip()
NTFY_TIMEOUT_SEC = float(os.environ.get("NTFY_TIMEOUT_SEC") or "8")


def configured() -> bool:
    return NTFY_URL.startswith("https://") or NTFY_URL.startswith("http://")


def send_text_sync(title: str, body: str) -> dict[str, Any]:
    """同步 POST。返回 {sent, skipped?, reason?, detail?, status?}。"""
    if not configured():
        return {"sent": 0, "skipped": True, "reason": "not_configured"}
    text = (body or "").strip() or (title or "").strip()
    if not text:
        return {"sent": 0, "skipped": True, "reason": "empty"}
    # ntfy 消息体建议别过大
    if len(text.encode("utf-8")) > 3500:
        raw = text.encode("utf-8")[:3500]
        text = raw.decode("utf-8", errors="ignore") + "…"
    hdr_title = ((title or "Tidal").strip() or "Tidal")[:120]
    req = urllib.request.Request(
        NTFY_URL,
        data=text.encode("utf-8"),
        headers={
            "Title": hdr_title,
            "Content-Type": "text/plain; charset=utf-8",
            # 点击可回到站点（可选；无则 App 仍显示正文）
            "Tags": "ocean",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=NTFY_TIMEOUT_SEC) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            raw = resp.read().decode("utf-8", errors="replace")
        if status and int(status) >= 400:
            return {
                "sent": 0,
                "skipped": False,
                "reason": "http_error",
                "status": int(status),
                "detail": raw[:200],
            }
        return {"sent": 1, "skipped": False, "reason": None}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            detail = str(e)[:200]
        return {
            "sent": 0,
            "skipped": False,
            "reason": "http_error",
            "status": int(e.code),
            "detail": detail,
        }
    except Exception as e:
        return {
            "sent": 0,
            "skipped": False,
            "reason": "network_error",
            "detail": str(e).replace("\n", " ").strip()[:200],
        }
