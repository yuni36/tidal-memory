#!/usr/bin/env python3
"""Run write → hybrid → delete and print wall times (assumes empty-ish DB)."""
from __future__ import annotations

import importlib
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _run(mod_name: str) -> float:
    t0 = time.perf_counter()
    mod = importlib.import_module(mod_name)
    mod.main()
    return time.perf_counter() - t0


def main() -> None:
    steps = [
        ("00_health", "00_health"),
        ("01_write", "01_write"),
        ("02_keyword_search", "02_keyword_search"),
        ("03_hybrid_search", "03_hybrid_search"),
        ("04_delete", "04_delete"),
    ]
    total = 0.0
    print("=== e2e timing ===")
    for label, name in steps:
        dt = _run(name)
        total += dt
        print(f"  {label}: {dt:.2f}s")
    print(f"TOTAL: {total:.2f}s")


if __name__ == "__main__":
    main()
