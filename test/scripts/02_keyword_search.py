#!/usr/bin/env python3
"""Keyword-oriented probe via Librarian (FTS leg inside hybrid)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import load_run, request_json


def _search(q: str) -> list:
    status, data = request_json("GET", "/librarian/search", query={"q": q, "limit": "8"})
    if status != 200:
        raise SystemExit(f"search failed {status}: {data}")
    results = data.get("results") or []
    print(f"\nq={q!r} → {len(results)} hits")
    for r in results:
        print(
            f"  id={r.get('id')} score={r.get('score')} "
            f"type={r.get('type')} content={(r.get('content') or '')[:80]}"
        )
    return results


def main() -> None:
    run = load_run()
    print(f"expect coffee_id={run.get('coffee_id')} bbq_id={run.get('bbq_id')}")
    coffee_hits = _search("美式咖啡")
    bbq_hits = _search("烧烤")
    # Soft checks: at least one side should see its keyword world
    if not coffee_hits and not bbq_hits:
        raise SystemExit("两侧皆空：检查 embedding/FTS/是否写入成功")
    print("OK (keyword probe done; strict ranking → 03_hybrid_search.py)")


if __name__ == "__main__":
    main()
