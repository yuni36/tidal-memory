"""Shared helpers for memory acceptance scripts."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MEMORY_URL = os.environ.get("MEMORY_URL", "http://127.0.0.1:3013").rstrip("/")
RUN_FILE = Path(__file__).resolve().parent / ".last_run.json"

# Fictional memories — no real chat excerpts
COFFEE = {
    "title": "美式咖啡偏好（测试）",
    "content": "User 下午常喝美式咖啡，少冰，喜欢街角那家咖啡店的美式。",
    "tags": ["test", "coffee"],
}
BBQ = {
    "title": "周末烧烤计划（测试干扰）",
    "content": "User 周末和同事烧烤，准备炭火、肉串和烤串酱。",
    "tags": ["test", "bbq"],
}


def request_json(method: str, path: str, body: dict | None = None, query: dict | None = None):
    url = f"{MEMORY_URL}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"error": raw}
        return e.code, payload
    except urllib.error.URLError as e:
        raise SystemExit(f"无法连接 {url}: {e}") from e


def save_run(payload: dict) -> None:
    RUN_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_run() -> dict:
    if not RUN_FILE.exists():
        raise SystemExit(f"缺少 {RUN_FILE.name}，请先跑 01_write.py")
    return json.loads(RUN_FILE.read_text(encoding="utf-8"))
