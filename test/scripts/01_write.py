#!/usr/bin/env python3
"""Write coffee (target) + BBQ (distractor) memories into an assumed-empty-ish DB."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import BBQ, COFFEE, request_json, save_run


def _create(item: dict) -> int:
    status, data = request_json(
        "POST",
        "/api/memory",
        body={
            "title": item["title"],
            "content": item["content"],
            "tags": item["tags"],
            "status": "permanent",
        },
    )
    print(f"POST /api/memory {item['title']!r} → {status} {data}")
    if status >= 400 or not data.get("id"):
        raise SystemExit(f"写入失败: {data}")
    if data.get("warning"):
        print(f"  warning: {data['warning']}")
    return int(data["id"])


def main() -> None:
    coffee_id = _create(COFFEE)
    bbq_id = _create(BBQ)
    save_run({"coffee_id": coffee_id, "bbq_id": bbq_id})
    print(f"saved .last_run.json coffee_id={coffee_id} bbq_id={bbq_id}")


if __name__ == "__main__":
    main()
