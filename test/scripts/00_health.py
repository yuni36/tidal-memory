#!/usr/bin/env python3
"""Probe memory_service (+ optional chroma via pipeline)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import MEMORY_URL, request_json


def main() -> None:
    print(f"MEMORY_URL={MEMORY_URL}")
    status, data = request_json("GET", "/healthz")
    print(f"GET /healthz → {status} {data}")
    if status != 200:
        raise SystemExit("memory_service 未就绪")
    # librarian empty query should still 200
    st2, data2 = request_json("GET", "/librarian/search", query={"q": "ping", "limit": "1"})
    print(f"GET /librarian/search → {st2} keys={list(data2.keys()) if isinstance(data2, dict) else data2}")
    if st2 != 200:
        raise SystemExit("librarian 不可用")
    print("OK")


if __name__ == "__main__":
    main()
