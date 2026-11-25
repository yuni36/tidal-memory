"""Gemini Interactions：session → last interaction.id + 截断计数落盘。"""

from __future__ import annotations

import json
import os
from pathlib import Path

_STATE_DIR = Path(
    os.environ.get("BRIDGE_STATE_DIR")
    or (Path(__file__).resolve().parent / ".bridge_state")
)
_STATE_FILE = _STATE_DIR / "gemini_interactions.json"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _reset_enabled() -> bool:
    raw = os.environ.get("GEMINI_IX_RESET_ENABLED", "0").strip().lower()
    return raw not in ("0", "false", "off", "no") and raw != ""


# 同一会话大周期截断（仅 Gemini Interactions）
RESET_INPUT = _env_int("GEMINI_IX_RESET_INPUT", 15000)
RESET_MISS_INPUT = _env_int("GEMINI_IX_RESET_MISS_INPUT", 12000)
RESET_MISS_STREAK = _env_int("GEMINI_IX_RESET_MISS_STREAK", 3)
BOOTSTRAP_ROUNDS = _env_int("GEMINI_IX_BOOTSTRAP_ROUNDS", 3)


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
        _STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def _route_key(base: str, model: str, protocol: str) -> str:
    return f"{protocol}|{(base or '').rstrip('/')}|{model or ''}"


def get_interaction_id(session_id: str, *, base: str, model: str, protocol: str = "gemini") -> str | None:
    entry = _load().get(session_id)
    if not isinstance(entry, dict):
        return None
    if entry.get("route") != _route_key(base, model, protocol):
        return None
    iid = (entry.get("interaction_id") or "").strip()
    return iid or None


def set_interaction_id(
    session_id: str,
    interaction_id: str,
    *,
    base: str,
    model: str,
    protocol: str = "gemini",
) -> None:
    iid = (interaction_id or "").strip()
    if not session_id or not iid:
        return
    data = _load()
    prev = data.get(session_id) if isinstance(data.get(session_id), dict) else {}
    rk = _route_key(base, model, protocol)
    entry = {
        "interaction_id": iid,
        "route": rk,
        "miss_streak": int(prev.get("miss_streak") or 0) if prev.get("route") == rk else 0,
        "last_input_tokens": int(prev.get("last_input_tokens") or 0) if prev.get("route") == rk else 0,
        "last_cached_tokens": int(prev.get("last_cached_tokens") or 0) if prev.get("route") == rk else 0,
    }
    data[session_id] = entry
    _save(data)


def note_ix_usage(
    session_id: str,
    *,
    input_tokens: int | None,
    cached_tokens: int | None,
    base: str,
    model: str,
    protocol: str = "gemini",
) -> None:
    """每轮 ix 成功后更新 miss 计数；不改写 interaction_id。"""
    if not session_id:
        return
    data = _load()
    prev = data.get(session_id) if isinstance(data.get(session_id), dict) else {}
    rk = _route_key(base, model, protocol)
    if prev.get("route") != rk:
        prev = {"route": rk, "interaction_id": ""}
    try:
        inp = int(input_tokens or 0)
    except (TypeError, ValueError):
        inp = 0
    try:
        cached = int(cached_tokens or 0)
    except (TypeError, ValueError):
        cached = 0
    streak = int(prev.get("miss_streak") or 0)
    if cached <= 0:
        streak += 1
    else:
        streak = 0
    data[session_id] = {
        "interaction_id": (prev.get("interaction_id") or "").strip(),
        "route": rk,
        "miss_streak": streak,
        "last_input_tokens": inp,
        "last_cached_tokens": cached,
    }
    _save(data)


def should_reset_cycle(
    session_id: str,
    *,
    base: str,
    model: str,
    protocol: str = "gemini",
) -> str | None:
    """若应截断本会话大周期，返回原因字符串；否则 None。"""
    if not _reset_enabled() or not session_id:
        return None
    entry = _load().get(session_id)
    if not isinstance(entry, dict):
        return None
    if entry.get("route") != _route_key(base, model, protocol):
        return None
    inp = int(entry.get("last_input_tokens") or 0)
    streak = int(entry.get("miss_streak") or 0)
    if inp >= RESET_INPUT:
        return f"input>={RESET_INPUT} (got {inp})"
    if inp >= RESET_MISS_INPUT and streak >= RESET_MISS_STREAK:
        return f"miss×{streak}@{inp}>={RESET_MISS_INPUT}"
    return None


def clear_session(session_id: str) -> None:
    data = _load()
    if session_id in data:
        del data[session_id]
        _save(data)


def clear_all() -> None:
    _save({})
