"""
主动关怀调度 —— 仅积温（jiwen）。

积温路径：
  - 每 ~3 分钟轮询一次 triggers
  - 用户在前台则跳过
  - 23:00–08:00 北京时间不主动发
  - 成功才 POST /affect/triggers/ack → connection-0.35
  - 用户真回复才 reset（observe / 心跳兜底）
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Awaitable

import aiohttp

BJ = timezone(timedelta(hours=8))

QUIET_START, QUIET_END = 23, 8

# ── 积温轮询 ──
JIWEN_POLL_SEC = 180
# 自醒：更密一点，仍挂在同一 loop（每次 jiwen 轮询前也跑）
SELF_WAKE_POLL_SEC = 30
_last_self_wake_poll = 0.0
_last_jiwen_poll = 0.0


def _log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).astimezone(BJ).strftime("%H:%M:%S")
    print(f"[{stamp} BJ] [proactive] {msg}", flush=True)


def _beijing_hour(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    return now.astimezone(BJ).hour


def _in_quiet_hours(hour: int | None = None) -> bool:
    h = _beijing_hour() if hour is None else hour
    return h >= QUIET_START or h < QUIET_END


def _flag_on(raw: Any, default: str = "1") -> bool:
    v = str(raw if raw is not None else default).strip().lower()
    return v not in ("0", "false", "off", "no")


async def _get_json(session: aiohttp.ClientSession, url: str, headers: dict) -> dict:
    async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
        if resp.status >= 400:
            text = await resp.text()
            raise RuntimeError(f"GET {url} → {resp.status}: {text[:200]}")
        return await resp.json()


async def _post_json(
    session: aiohttp.ClientSession, url: str, headers: dict, body: dict
) -> dict:
    async with session.post(
        url, json=body, headers=headers, timeout=aiohttp.ClientTimeout(total=30)
    ) as resp:
        if resp.status >= 400:
            text = await resp.text()
            raise RuntimeError(f"POST {url} → {resp.status}: {text[:200]}")
        return await resp.json()


async def _fetch_status(session: aiohttp.ClientSession, relay_url: str, headers: dict) -> dict:
    return await _get_json(session, f"{relay_url}/app/status", headers)


async def _fetch_settings(session: aiohttp.ClientSession, relay_url: str, headers: dict) -> dict:
    return await _get_json(session, f"{relay_url}/app/settings", headers)


async def _fetch_triggers(session: aiohttp.ClientSession, memory_url: str) -> dict:
    return await _get_json(session, f"{memory_url}/affect/triggers", {})


async def _ack_trigger(
    session: aiohttp.ClientSession, memory_url: str, trigger_id: str, success: bool
) -> dict:
    return await _post_json(
        session,
        f"{memory_url}/affect/triggers/ack",
        {},
        {"id": trigger_id, "success": success},
    )


async def _pick_session_id(session: aiohttp.ClientSession, relay_url: str, headers: dict) -> str:
    try:
        data = await _get_json(session, f"{relay_url}/app/sessions", headers)
        sessions = data.get("sessions") or []
        if sessions:
            return sessions[0].get("id") or "__legacy__"
        active = data.get("active_session")
        if active:
            return active
    except Exception:
        pass
    return "__legacy__"


async def try_dispatch_jiwen(
    session: aiohttp.ClientSession,
    *,
    relay_url: str,
    memory_url: str,
    headers: dict,
    on_jiwen_contact: Callable[..., Awaitable[bool]] | None = None,
    is_session_busy=None,
) -> bool:
    """积温：有 pending contact → 回调开完整一轮（不再走短句模板）。"""
    global _last_jiwen_poll
    import time as _time

    now = _time.monotonic()
    if now - _last_jiwen_poll < JIWEN_POLL_SEC:
        return False
    _last_jiwen_poll = now

    if _in_quiet_hours():
        _log("夜里安静，跳过 jiwen 主动")
        return False

    if on_jiwen_contact is None:
        _log("jiwen：未接 on_jiwen_contact，跳过")
        return False

    status = await _fetch_status(session, relay_url, headers)
    if int(status.get("app_subs") or 0) > 0 or status.get("online"):
        return False

    data = await _fetch_triggers(session, memory_url)
    pending = data.get("pending")
    if not pending:
        return False

    tid = pending.get("id")
    desperate = bool(pending.get("desperate") or pending.get("forced"))
    _log(
        f"积温 pending={tid} c={pending.get('connection')} "
        f"desperate={desperate} cooldown={data.get('cooldownMs')} → 完整一轮"
    )

    sid = await _pick_session_id(session, relay_url, headers)
    if callable(is_session_busy) and is_session_busy(sid):
        _log(f"积温推迟：会话忙碌 sid={sid}")
        return False

    # 补静默分钟（triggers 未必带）
    try:
        st = await _get_json(session, f"{memory_url}/affect/state", {})
        lm = (st or {}).get("lastMessage") or {}
        if lm.get("minutesSince") is not None:
            pending = {**pending, "silence_minutes": lm.get("minutesSince")}
    except Exception as e:
        _log(f"积温拉 state 失败（可继续）: {e}")

    sent_ok = False
    try:
        sent_ok = bool(await on_jiwen_contact(session, pending, sid))
        _log(f"积温一轮 {'ok' if sent_ok else 'fail'} tid={tid}")
    except Exception as e:
        sent_ok = False
        _log(f"积温一轮异常，将保留 pending 重试: {e}")

    try:
        await _ack_trigger(session, memory_url, tid, sent_ok)
    except Exception as e:
        _log(f"ack 失败: {e}")

    return sent_ok


async def try_dispatch_self_wakes(
    session: aiohttp.ClientSession,
    *,
    relay_url: str,
    memory_url: str,
    auth_headers: dict[str, str],
    on_self_wake,
    is_session_busy=None,
) -> int:
    """到期自醒：claim → 回调开一轮 bridge → ack。不走 care 模板。

    on_self_wake(session, alarm_dict, session_id) -> bool
    is_session_busy(session_id) -> bool：忙则本轮不 claim，留待下次。
    """
    global _last_self_wake_poll
    import time as _time

    now = _time.monotonic()
    if now - _last_self_wake_poll < SELF_WAKE_POLL_SEC:
        return 0
    _last_self_wake_poll = now

    if on_self_wake is None:
        return 0

    # 功能关：不 claim、不开回合（与 proactive 解耦）
    try:
        import bridge as _br
        if not getattr(_br, "_FEATURE_SELF_WAKE", True):
            return 0
    except Exception:
        pass

    try:
        data = await _get_json(session, f"{memory_url}/alarms/due", {})
    except Exception as e:
        _log(f"自醒 due 拉取失败: {e}")
        return 0

    items = list(data.get("items") or [])
    if not items:
        return 0

    sid = await _pick_session_id(session, relay_url, auth_headers)
    if callable(is_session_busy) and is_session_busy(sid):
        _log(f"自醒推迟：会话忙碌 sid={sid}")
        return 0

    alarm = items[0]
    aid = alarm.get("id")
    try:
        claimed = await _post_json(
            session, f"{memory_url}/alarms/{aid}/claim", {}, {}
        )
    except Exception as e:
        _log(f"自醒 claim #{aid} 失败: {e}")
        return 0
    if not claimed.get("ok"):
        return 0
    alarm = claimed.get("alarm") or alarm
    _log(f"自醒到点 #{aid} note={(alarm.get('note') or '')[:40]}")
    ok = False
    try:
        ok = bool(await on_self_wake(session, alarm, sid))
    except Exception as e:
        _log(f"自醒回合异常 #{aid}: {e}")
        ok = False
    try:
        await _post_json(
            session,
            f"{memory_url}/alarms/{aid}/ack",
            {},
            {"success": ok},
        )
    except Exception as e:
        _log(f"自醒 ack #{aid} 失败: {e}")
    return 1


async def run_proactive_loop(
    session: aiohttp.ClientSession,
    *,
    relay_url: str,
    memory_url: str,
    auth_headers: dict[str, str],
    on_self_wake=None,
    on_jiwen_contact=None,
    is_session_busy=None,
) -> None:
    relay_url = relay_url.rstrip("/")
    memory_url = memory_url.rstrip("/")
    _log("调度器启动（仅积温 jiwen；含自醒旁路）")

    care_off_logged = False

    while True:
        try:
            # 自醒旁路：不受 proactive_enabled / 静默时段限制
            try:
                await try_dispatch_self_wakes(
                    session,
                    relay_url=relay_url,
                    memory_url=memory_url,
                    auth_headers=auth_headers,
                    on_self_wake=on_self_wake,
                    is_session_busy=is_session_busy,
                )
            except Exception as we:
                _log(f"自醒旁路异常: {we}")

            settings = await _fetch_settings(session, relay_url, auth_headers)
            care_on = _flag_on(settings.get("proactive_enabled", "1"))
            # 主动关怀只走积温
            if care_on:
                care_off_logged = False
                await try_dispatch_jiwen(
                    session,
                    relay_url=relay_url,
                    memory_url=memory_url,
                    headers=auth_headers,
                    on_jiwen_contact=on_jiwen_contact,
                    is_session_busy=is_session_busy,
                )
            else:
                if not care_off_logged:
                    _log("关怀开关关闭（自醒仍运行）")
                    care_off_logged = True

            await asyncio.sleep(SELF_WAKE_POLL_SEC)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log(f"本轮异常: {e}")
            await asyncio.sleep(60)
