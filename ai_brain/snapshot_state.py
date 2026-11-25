"""Session Snapshot 游标状态：cutoff / A 区文稿 / Cache 占位（P2 再用）。

真源仍是 relay `messages`；A/B 只是视图：
  A = 已压进 Snapshot 的状态（voyage + daily_events + schedule + hot3）
  B = id > snapshot_cutoff_id 的纯对话
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_STATE_DIR = Path(
    os.environ.get("BRIDGE_STATE_DIR")
    or (Path(__file__).resolve().parent / ".bridge_state")
)
_STATE_FILE = _STATE_DIR / "session_snapshots.json"

# 首周期尚未固化时，B 区最多保留的轮数（与整理间隔对齐）
FRESH_MAX_ROUNDS = int(os.environ.get("SNAPSHOT_FRESH_MAX_ROUNDS", "10") or "10")
# 固化周期：B 区满 5 轮即固化，A 区滚动为最近 A_WINDOW_ROUNDS 轮原文
CONSOLIDATE_ROUNDS = int(os.environ.get("SNAPSHOT_CONSOLIDATE_ROUNDS", "5") or "5")
# A 区（Cache contents）保留的原始对话轮数
A_WINDOW_ROUNDS = int(os.environ.get("SNAPSHOT_A_WINDOW_ROUNDS", "10") or "10")
# 崩溃后 consolidating=true 会写死；超过此时长视为已死，允许下一轮再固化
CONSOLIDATE_STALE_SEC = int(os.environ.get("SNAPSHOT_CONSOLIDATE_STALE_SEC", "600") or "600")


def _load() -> dict:
    try:
        raw = _STATE_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save(data: dict) -> None:
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass


def _empty_entry() -> dict[str, Any]:
    return {
        "snapshot_cutoff_id": 0,
        "fresh_rounds": 0,
        "last_relay_id": 0,
        "consolidating": False,
        "consolidating_started_at": "",
        "cache_name": "",
        "expire_at": "",
        "cache_google_search": False,
        "local_a_blob": {
            "voyage": "",
            "daily_events": "",
            "hot3": [],
            "built_at": "",
        },
    }


def get_entry(session_id: str) -> dict[str, Any]:
    if not session_id:
        return _empty_entry()
    data = _load()
    prev = data.get(session_id)
    if not isinstance(prev, dict):
        return _empty_entry()
    out = _empty_entry()
    out.update({k: prev[k] for k in out.keys() if k in prev})
    blob = prev.get("local_a_blob")
    if isinstance(blob, dict):
        merged = dict(out["local_a_blob"])
        merged.update({k: blob[k] for k in merged.keys() if k in blob})
        out["local_a_blob"] = merged
    return out


def _put(session_id: str, entry: dict[str, Any]) -> None:
    if not session_id:
        return
    data = _load()
    data[session_id] = entry
    _save(data)


def _parse_iso(raw: str) -> datetime | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def consolidating_active(entry: dict[str, Any] | None) -> bool:
    """True = 后台固化仍在跑。无时间戳的脏标记、或超时，都视为已死。"""
    if not isinstance(entry, dict) or not entry.get("consolidating"):
        return False
    started = _parse_iso(str(entry.get("consolidating_started_at") or ""))
    if started is None:
        return False
    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    return 0 <= elapsed < max(30, CONSOLIDATE_STALE_SEC)


def note_ai_reply(session_id: str, relay_msg_id: int | None) -> dict[str, Any]:
    """AI reply 落库后计一轮；返回最新 entry。"""
    entry = get_entry(session_id)
    try:
        rid = int(relay_msg_id or 0)
    except (TypeError, ValueError):
        rid = 0
    if rid > 0:
        entry["last_relay_id"] = max(int(entry.get("last_relay_id") or 0), rid)
    if not consolidating_active(entry):
        entry["fresh_rounds"] = int(entry.get("fresh_rounds") or 0) + 1
        entry["consolidating"] = False
        entry["consolidating_started_at"] = ""
    _put(session_id, entry)
    return entry


def should_consolidate(session_id: str) -> bool:
    entry = get_entry(session_id)
    if consolidating_active(entry):
        return False
    return int(entry.get("fresh_rounds") or 0) >= max(1, CONSOLIDATE_ROUNDS)


def begin_consolidate(session_id: str) -> dict[str, Any] | None:
    """标记 consolidating；若已在进行则返回 None。"""
    entry = get_entry(session_id)
    if consolidating_active(entry):
        return None
    entry["consolidating"] = True
    entry["consolidating_started_at"] = _iso_now()
    _put(session_id, entry)
    return entry


def abort_consolidate(session_id: str) -> None:
    entry = get_entry(session_id)
    entry["consolidating"] = False
    entry["consolidating_started_at"] = ""
    _put(session_id, entry)


def commit_snapshot(
    session_id: str,
    *,
    cutoff_relay_id: int,
    voyage: str,
    daily_events: str,
    hot3: list[dict],
    schedule: str = "",
    cache_name: str = "",
    expire_at: str = "",
) -> dict[str, Any]:
    """固化成功：推进 cutoff，写入 A 区文稿，清零 fresh_rounds。"""
    try:
        cutoff = int(cutoff_relay_id or 0)
    except (TypeError, ValueError):
        cutoff = 0
    entry = get_entry(session_id)
    entry["snapshot_cutoff_id"] = max(0, cutoff)
    entry["fresh_rounds"] = 0
    entry["consolidating"] = False
    entry["consolidating_started_at"] = ""
    if cutoff > 0:
        entry["last_relay_id"] = max(int(entry.get("last_relay_id") or 0), cutoff)
    if cache_name:
        entry["cache_name"] = cache_name
    if expire_at:
        entry["expire_at"] = expire_at
    entry["local_a_blob"] = {
        "voyage": (voyage or "").strip(),
        "daily_events": (daily_events or "").strip(),
        "schedule": (schedule or "").strip(),
        "hot3": list(hot3 or []),
        "built_at": _iso_now(),
    }
    _put(session_id, entry)
    return entry


def patch_a_schedule(session_id: str, schedule: str) -> dict[str, Any]:
    """冷启动补写日程进 A blob（不推进 cutoff / 不触发固化）。"""
    entry = get_entry(session_id)
    blob = dict(entry.get("local_a_blob") or {})
    blob["schedule"] = (schedule or "").strip()
    entry["local_a_blob"] = blob
    _put(session_id, entry)
    return entry


def set_cache_meta(
    session_id: str,
    *,
    cache_name: str = "",
    expire_at: str = "",
    cache_google_search: bool | None = None,
) -> dict[str, Any]:
    """更新显式 Cache 指针（不改 cutoff / A 文稿）。"""
    entry = get_entry(session_id)
    entry["cache_name"] = (cache_name or "").strip()
    entry["expire_at"] = (expire_at or "").strip()
    if cache_google_search is not None:
        entry["cache_google_search"] = bool(cache_google_search)
    elif not entry["cache_name"]:
        entry["cache_google_search"] = False
    _put(session_id, entry)
    return entry


def clear_cache_meta(session_id: str) -> None:
    set_cache_meta(session_id, cache_name="", expire_at="", cache_google_search=False)


def clear_session(session_id: str) -> None:
    data = _load()
    if session_id in data:
        del data[session_id]
        _save(data)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def filter_history_after_cutoff(
    history: list[dict],
    cutoff_id: int,
    *,
    id_key: str = "id",
) -> list[dict]:
    """B 区：保留 id > cutoff 的条目；无 id 的条目一律保留（兼容旧路径）。"""
    try:
        cutoff = int(cutoff_id or 0)
    except (TypeError, ValueError):
        cutoff = 0
    if cutoff <= 0:
        return list(history)
    out: list[dict] = []
    for m in history:
        mid = m.get(id_key)
        if mid is None:
            out.append(m)
            continue
        try:
            if int(mid) > cutoff:
                out.append(m)
        except (TypeError, ValueError):
            out.append(m)
    return out


def take_last_n_rounds(history: list[dict], n_rounds: int) -> list[dict]:
    """按轮次取末尾（1 轮 ≈ user+assistant；未配对 user 算一轮）。"""
    if not history or n_rounds <= 0:
        return []
    # 末条若是将要发送的当前 user，通常尚未 append；此处对纯历史切片
    max_msgs = n_rounds * 2
    return history[-max_msgs:]


def extract_hot3(history: list[dict], *, n_rounds: int = 3) -> list[dict]:
    """取末尾 n 轮纯 role/content，供写入 A 区。"""
    chunk = take_last_n_rounds(history, n_rounds)
    clean: list[dict] = []
    for m in chunk:
        role = m.get("role")
        content = m.get("content")
        if role not in ("user", "assistant"):
            continue
        if isinstance(content, list):
            # 多模态：只留文本
            texts = [
                (p.get("text") or "")
                for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            ]
            content = "\n".join(t for t in texts if t).strip()
        text = str(content or "").strip()
        if not text:
            continue
        clean.append({"role": role, "content": text})
    return clean


def strip_history_meta(history: list[dict]) -> list[dict]:
    """送进 LLM 前去掉 id 等元数据。"""
    out: list[dict] = []
    for m in history:
        role = m.get("role")
        content = m.get("content")
        if role not in ("user", "assistant", "system", "tool"):
            continue
        out.append({"role": role, "content": content})
    return out


def build_local_a_text(blob: dict | None) -> str:
    """把 local_a_blob 拼成可读 A 区附加段（P1 进 system；P2 进 cachedContents）。"""
    if not isinstance(blob, dict):
        return ""
    parts: list[str] = []
    voyage = (blob.get("voyage") or "").strip()
    daily = (blob.get("daily_events") or "").strip()
    schedule = (blob.get("schedule") or "").strip()
    hot3 = blob.get("hot3") or []
    if voyage:
        parts.append(f"[近期对话摘要]\n{voyage}")
    if daily:
        parts.append(f"[今日事件]\n{daily}")
        try:
            from context_builder import ACTIVITY_USAGE
            parts.append(ACTIVITY_USAGE)
        except Exception:
            pass
    if schedule:
        try:
            from context_builder import SCHEDULE_USAGE
            parts.append(SCHEDULE_USAGE)
        except Exception:
            pass
        parts.append(schedule if schedule.startswith("[日程]") else f"[日程]\n{schedule}")
    if isinstance(hot3, list) and hot3:
        lines = []
        for m in hot3:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = str(m.get("content") or "").strip()
            if not content:
                continue
            from context_builder import HUMAN_NAME, AI_NAME
            who = HUMAN_NAME if role == "user" else AI_NAME
            lines.append(f"{who}: {content}")
        if lines:
            parts.append("[锚定对话]\n" + "\n".join(lines))
    return "\n\n".join(parts)
