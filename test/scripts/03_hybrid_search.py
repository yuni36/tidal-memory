#!/usr/bin/env python3
"""Hybrid search: coffee query should rank coffee memory above BBQ distractor."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import load_run, request_json


def main() -> None:
    run = load_run()
    coffee_id = int(run["coffee_id"])
    bbq_id = int(run["bbq_id"])
    q = "美式咖啡"
    status, data = request_json("GET", "/librarian/search", query={"q": q, "limit": "10"})
    if status != 200:
        raise SystemExit(f"hybrid failed {status}: {data}")

    results = data.get("results") or []
    print(f"q={q!r} hits={len(results)}")
    for i, r in enumerate(results):
        print(
            f"  [{i}] id={r.get('id')} score={r.get('score')} "
            f"{(r.get('content') or '')[:72]}"
        )

    def rank_of(mid: int):
        for i, r in enumerate(results):
            try:
                if int(r.get("id")) == mid:
                    return i
            except (TypeError, ValueError):
                continue
            blob = f"{r.get('content') or ''}"
            if mid == coffee_id and ("咖啡" in blob or "美式" in blob):
                return i
            if mid == bbq_id and ("烧烤" in blob or "肉串" in blob):
                return i
        return None

    rc, rb = rank_of(coffee_id), rank_of(bbq_id)
    print(f"rank coffee={rc} bbq={rb} (ids {coffee_id}/{bbq_id})")

    if rc is None:
        raise SystemExit("未命中咖啡记忆：检查向量索引 / Chroma space=cosine / embedding Key")
    if rb is not None and rc > rb:
        raise SystemExit("失败：烧烤排在咖啡前面（混合检索未达预期）")
    print("OK — 咖啡压过烧烤（或烧烤未进入同查询结果）")


if __name__ == "__main__":
    main()
