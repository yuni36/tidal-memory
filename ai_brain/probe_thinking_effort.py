"""Live probe: thinking_level clamp + optional thought summary.

Usage (needs network + Gemini key):
  python probe_thinking_effort.py
  # or with env:
  # GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.8-flash python probe_thinking_effort.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from model_router import (  # noqa: E402
    _gemini_ix_generation_config,
    _normalize_gemini_base,
    _parse_ix_response,
    resolve_thinking_level,
    update_params,
)


def _load_dotenv() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


async def _post_ix(base: str, key: str, model: str, level: str, prompt: str) -> dict:
    update_params(thinking_effort=level)
    origin = _normalize_gemini_base(base)
    url = f"{origin}/interactions"
    body = {
        "model": model,
        "store": False,
        "stream": False,
        "input": prompt,
        "generation_config": _gemini_ix_generation_config(model),
    }
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
        "Api-Revision": "2026-05-20",
    }
    timeout = aiohttp.ClientTimeout(total=90, sock_connect=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, json=body, headers=headers) as resp:
            raw = await resp.text()
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}: {raw[:500]}")
            return json.loads(raw)


async def main() -> int:
    _load_dotenv()
    key = (
        os.environ.get("GEMINI_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
        or os.environ.get("CHAT_API_KEY_1")
        or ""
    ).strip()
    base = (
        os.environ.get("GEMINI_API_BASE")
        or os.environ.get("CHAT_API_BASE_1")
        or "https://generativelanguage.googleapis.com/v1beta"
    ).strip()
    if not key or "deepseek" in base.lower() or "openai" in base.lower():
        print("SKIP live: no Gemini key/base in env (unit asserts still run)")
        # offline asserts
        assert resolve_thinking_level("gemini-3.8-flash", "minimal") == "low"
        assert resolve_thinking_level("gemini-3.6-flash", "minimal") == "minimal"
        print("offline OK")
        return 0

    cases = [
        ("gemini-3.8-flash", "minimal", True),   # expect clamp→low, must NOT 400 on minimal after resolve
        ("gemini-3.8-flash", "low", False),
        ("gemini-3.8-flash", "medium", False),
        ("gemini-3.6-flash", "minimal", False),
        ("gemini-3.6-flash", "medium", False),
    ]
    # Hard check: raw minimal on 3.8 must 400 if we bypass resolve (sanity)
    update_params(thinking_effort="low")
    prompt_easy = "用一句话回答：1+1等于几？"
    prompt_hard = "不查资料：前 20 个质数之和是多少？简要说明思路。"

    print("== unit clamp ==")
    for model, effort, _ in cases:
        print(f"  {model} effort={effort} → {resolve_thinking_level(model, effort)}")

    print("== live calls ==")
    for model, effort, _ in cases:
        try:
            data = await _post_ix(
                base, key, model, effort,
                prompt_hard if effort in ("medium", "high") else prompt_easy,
            )
            iid, text, _tools, usage, thought = _parse_ix_response(data)
            print(
                f"  OK {model} effort={effort} level={resolve_thinking_level(model, effort)} "
                f"thought={usage.get('total_thought_tokens')} "
                f"summary={len(thought)}c out={len(text)}c id={iid[:12]}…"
            )
            if thought:
                print(f"     summary[:120]={thought[:120]!r}")
        except Exception as e:
            print(f"  FAIL {model} effort={effort}: {e}")
            return 1

    # Explicit: sending raw minimal without clamp would fail on 3.8 — document via resolve only
    print("== done ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
