#!/usr/bin/env python3
"""Delete memories created by 01_write.py."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import RUN_FILE, load_run, request_json, save_run


def main() -> None:
    run = load_run()
    deleted = []
    for key in ("coffee_id", "bbq_id"):
        mid = run.get(key)
        if mid is None:
            continue
        status, data = request_json("DELETE", f"/api/memory/{int(mid)}")
        print(f"DELETE /api/memory/{mid} → {status} {data}")
        if status < 400:
            deleted.append(int(mid))
    save_run({**run, "deleted_ids": deleted})
    print(f"done deleted={deleted} (state kept in {RUN_FILE.name})")


if __name__ == "__main__":
    main()
