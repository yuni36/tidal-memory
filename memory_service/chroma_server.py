#!/usr/bin/env python3
"""
Tidal ChromaDB Server — 向量服务
取代缺失的 chroma_helper.py，通过 HTTP 持久运行，避免每次 spawn 子进程。

用法:
  .\.venv\Scripts\python.exe chroma_server.py

数据目录: chroma_data/ (持久化)
端口: 7707
"""

import asyncio
import json
import os
import sys
import math
from pathlib import Path

import aiohttp
from aiohttp import web

# ── ChromaDB 客户端 ──
try:
    import chromadb
    from chromadb.config import Settings as ChromaSettings
    CHROMADB_AVAILABLE = True
except ImportError:
    CHROMADB_AVAILABLE = False

# ── Embedding ──
_embed_fn = None
_EMBED_DIM = 384

DATA_DIR = Path(__file__).resolve().parent / "chroma_data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

COLLECTION_NAME = "memories"
COSINE_METADATA = {"hnsw:space": "cosine"}


# =====================================================================
# Embedding 函数
# =====================================================================

def _get_embedding_function():
    global _embed_fn
    if _embed_fn is not None:
        return _embed_fn

    if CHROMADB_AVAILABLE:
        try:
            from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
            fn = DefaultEmbeddingFunction()
            test = fn(["test"])
            if test and len(test) > 0 and len(test[0]) > 0:
                embed_dim = len(test[0])
                print(f"[Chroma] 使用本地 ONNX embedding (dim={embed_dim})", flush=True)
                _embed_fn = fn
                return fn
        except Exception as e:
            print(f"[Chroma] 本地 embedding 不可用: {e}", flush=True)

    print("[Chroma] 回退到 API embedding", flush=True)
    _embed_fn = None
    return None


async def _get_api_embedding(text: str) -> list:
    """通过 SiliconFlow API 获取 embedding"""
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    api_base = os.environ.get("EMBED_API_BASE", "https://api.siliconflow.cn/v1")
    model = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")

    if not api_key:
        raise ValueError("DEEPSEEK_API_KEY 未设置，无法生成 embedding")

    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{api_base}/embeddings",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"input": text, "model": model},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            if resp.status != 200:
                err = await resp.text()
                raise RuntimeError(f"Embedding API HTTP {resp.status}: {err[:200]}")
            data = await resp.json()
            return data["data"][0]["embedding"]


async def get_embedding(text: str) -> list:
    fn = _get_embedding_function()
    if fn is not None:
        result = fn([text])
        return result[0].tolist() if hasattr(result[0], 'tolist') else list(result[0])
    return await _get_api_embedding(text)


async def get_embeddings_batch(texts: list) -> list:
    fn = _get_embedding_function()
    if fn is not None:
        result = fn(texts)
        return [r.tolist() if hasattr(r, 'tolist') else list(r) for r in result]
    results = []
    for t in texts:
        results.append(await get_embedding(t))
    return results


# =====================================================================
# ChromaDB 客户端（持久化）
# =====================================================================

_client = None


def get_client():
    global _client
    if _client is not None:
        return _client
    if not CHROMADB_AVAILABLE:
        raise RuntimeError("chromadb 未安装")
    _client = chromadb.PersistentClient(
        path=str(DATA_DIR),
        settings=ChromaSettings(
            anonymized_telemetry=False,
            allow_reset=False,
        ),
    )
    print(f"[Chroma] 持久化客户端已连接 (data_dir={DATA_DIR})", flush=True)
    return _client


async def _get_or_create_collection(name: str = COLLECTION_NAME):
    """获取或创建 collection；新库一律 cosine。已有非 cosine 库由 /reset_collection 迁移。"""
    client = get_client()
    fn = _get_embedding_function()
    try:
        if fn is not None:
            col = client.get_collection(name, embedding_function=fn)
        else:
            col = client.get_collection(name)
        space = (col.metadata or {}).get("hnsw:space")
        if space != "cosine":
            print(
                f"[Chroma] 警告: collection={name} hnsw:space={space!r}（应为 cosine）。"
                f"请跑 reset_collection + 全量重嵌，否则 1-distance 分数会偏。",
                flush=True,
            )
        return col
    except Exception:
        kwargs = {"name": name, "metadata": dict(COSINE_METADATA)}
        if fn is not None:
            kwargs["embedding_function"] = fn
        col = client.create_collection(**kwargs)
        print(f"[Chroma] 已创建 collection={name} space=cosine", flush=True)
        return col


async def _reset_collection_cosine(name: str = COLLECTION_NAME):
    """删除并按 cosine 重建空 collection（需随后全量重嵌）。"""
    client = get_client()
    fn = _get_embedding_function()
    try:
        client.delete_collection(name)
        print(f"[Chroma] 已删除旧 collection={name}", flush=True)
    except Exception as e:
        print(f"[Chroma] delete_collection 跳过: {e}", flush=True)
    kwargs = {"name": name, "metadata": dict(COSINE_METADATA)}
    if fn is not None:
        kwargs["embedding_function"] = fn
    col = client.create_collection(**kwargs)
    print(f"[Chroma] 已重建 collection={name} space=cosine", flush=True)
    return col


# =====================================================================
# HTTP 处理器
# =====================================================================

async def handle_health(request):
    space = None
    count = None
    try:
        col = await _get_or_create_collection(COLLECTION_NAME)
        space = (col.metadata or {}).get("hnsw:space")
        count = col.count()
    except Exception:
        pass
    return web.json_response({
        "ok": True,
        "chromadb": CHROMADB_AVAILABLE,
        "embed_fn": _get_embedding_function() is not None or bool(os.environ.get("DEEPSEEK_API_KEY")),
        "data_dir": str(DATA_DIR),
        "collection": COLLECTION_NAME,
        "hnsw_space": space,
        "count": count,
    })


async def handle_reset_collection(request):
    """运维：重建 cosine collection。body 可选 {confirm: true}。"""
    try:
        body = await request.json() if request.can_read_body else {}
    except Exception:
        body = {}
    if not (body or {}).get("confirm"):
        return web.json_response(
            {"error": "pass {\"confirm\": true} to reset collection to cosine"},
            status=400,
        )
    try:
        col = await _reset_collection_cosine(COLLECTION_NAME)
        return web.json_response({
            "ok": True,
            "collection": COLLECTION_NAME,
            "hnsw_space": (col.metadata or {}).get("hnsw:space"),
            "count": col.count(),
        })
    except Exception as e:
        print(f"[Chroma] reset_collection 异常: {e}", flush=True)
        return web.json_response({"error": str(e)}, status=500)


async def handle_embed(request):
    try:
        body = await request.json()
        text = body.get("text", "")
        if not text:
            return web.json_response({"error": "text required"}, status=400)
        embedding = await get_embedding(text)
        return web.json_response({"embedding": embedding})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_index_batch(request):
    try:
        body = await request.json()
        items = body.get("items", [])
        if not items:
            return web.json_response({"indexed": 0})

        collection = await _get_or_create_collection(COLLECTION_NAME)

        ids = []
        texts = []
        metadatas = []
        for item in items:
            ids.append(str(item["id"]))
            texts.append(item.get("text", ""))
            meta = item.get("metadata", {})
            if meta:
                cleaned = {}
                for k, v in meta.items():
                    if isinstance(v, (str, int, float, bool)):
                        cleaned[k] = v
                    elif v is None:
                        cleaned[k] = ""
                    else:
                        cleaned[k] = str(v)
                metadatas.append(cleaned)
            else:
                metadatas.append({})

        # 跳过已存在的 ID
        existing = set()
        try:
            existing_data = collection.get(ids=ids)
            if existing_data and existing_data["ids"]:
                existing = set(existing_data["ids"])
        except Exception:
            pass

        new_ids, new_texts, new_metadatas = [], [], []
        for i, id_ in enumerate(ids):
            if id_ not in existing:
                new_ids.append(id_)
                new_texts.append(texts[i])
                new_metadatas.append(metadatas[i])

        duplicates = []
        for id_ in ids:
            if id_ in existing:
                duplicates.append({
                    "new_id": id_,
                    "existing_id": id_,
                    "similarity": 1.0,
                    "new_preview": texts[ids.index(id_)][:60],
                    "existing_preview": "already indexed",
                })

        if new_ids:
            try:
                collection.add(
                    ids=new_ids,
                    documents=new_texts,
                    metadatas=new_metadatas,
                )
                print(f"[Chroma] 索引 {len(new_ids)} 个新条目", flush=True)
            except Exception as e:
                print(f"[Chroma] 索引失败: {e}", flush=True)
                return web.json_response({"indexed": 0, "error": str(e)})

        return web.json_response({
            "indexed": len(new_ids),
            "total": len(ids),
            "duplicates": duplicates,
        })
    except Exception as e:
        print(f"[Chroma] index_batch 异常: {e}", flush=True)
        return web.json_response({"indexed": 0, "error": str(e)}, status=500)


async def handle_query(request):
    try:
        body = await request.json()
        embedding = body.get("embedding")
        n_results = body.get("n_results", 10)
        query_text = body.get("query_text", "")
        min_similarity = body.get("min_similarity", 0.0)

        collection = await _get_or_create_collection(COLLECTION_NAME)

        query_params = {"n_results": min(n_results * 2, 100)}

        if embedding is not None:
            query_params["query_embeddings"] = [embedding]
        else:
            query_params["query_texts"] = [query_text]

        results = collection.query(**query_params)

        return web.json_response({
            "ids": results.get("ids", []),
            "distances": results.get("distances", []),
            "metadatas": results.get("metadatas", []),
        })
    except Exception as e:
        print(f"[Chroma] query 异常: {e}", flush=True)
        return web.json_response({"ids": [[]], "distances": [[]], "metadatas": [[]]})


async def handle_query_multi(request):
    try:
        body = await request.json()
        queries = body.get("queries", [])
        if not queries:
            return web.json_response({"results": []})

        collection = await _get_or_create_collection(COLLECTION_NAME)
        all_results = []

        for q in queries:
            embedding = q.get("embedding")
            n_results = q.get("n_results", 5)
            if embedding:
                r = collection.query(query_embeddings=[embedding], n_results=n_results)
            elif q.get("text"):
                r = collection.query(query_texts=[q["text"]], n_results=n_results)
            else:
                continue
            all_results.append(r)

        return web.json_response({"results": all_results})
    except Exception as e:
        return web.json_response({"results": [], "error": str(e)}, status=500)


async def handle_find_similar_groups(request):
    try:
        body = await request.json()
        items = body.get("items", [])
        n_results = body.get("n_results", 5)
        min_similarity = body.get("min_similarity", 0.78)

        if len(items) < 2:
            return web.json_response({"pairs": []})

        texts = [item["text"] for item in items]
        ids = [str(item["id"]) for item in items]

        embeddings = await get_embeddings_batch(texts)

        pairs = []
        for i in range(len(embeddings)):
            for j in range(i + 1, len(embeddings)):
                sim = _cosine_similarity(embeddings[i], embeddings[j])
                if sim >= min_similarity:
                    pairs.append({
                        "fragment_a": ids[i],
                        "fragment_b": ids[j],
                        "similarity": round(sim, 4),
                    })

        pairs.sort(key=lambda p: p["similarity"], reverse=True)

        return web.json_response({"pairs": pairs[:n_results * 2]})
    except Exception as e:
        print(f"[Chroma] find_similar_groups 异常: {e}", flush=True)
        return web.json_response({"pairs": []})


async def handle_find_duplicates(request):
    """Scribe 回环过滤：新 entry 与 ChromaDB 中已有碎片比对，防重复提取"""
    try:
        body = await request.json()
        items = body.get("items", [])
        threshold = body.get("threshold", 0.82)

        if not items:
            return web.json_response({"duplicates": []})

        collection = await _get_or_create_collection(COLLECTION_NAME)
        texts = [item["text"] for item in items]
        ids = [str(item["id"]) for item in items]

        # 生成 embedding
        embeddings = await get_embeddings_batch(texts)

        duplicates = []
        for i, emb in enumerate(embeddings):
            try:
                result = collection.query(query_embeddings=[emb], n_results=3)
                if result and result["ids"] and result["ids"][0]:
                    for j, rid in enumerate(result["ids"][0]):
                        dist = result["distances"][0][j] if result.get("distances") else [1]
                        sim = 1 - dist[0] if isinstance(dist, list) else 1 - dist
                        if sim >= threshold:
                            duplicates.append({
                                "new_id": ids[i],
                                "existing_id": rid,
                                "similarity": round(sim, 4),
                                "new_preview": texts[i][:60],
                                "existing_preview": result["documents"][0][j][:60] if result.get("documents") else "",
                            })
                            break
            except Exception:
                pass

        return web.json_response({"duplicates": duplicates})
    except Exception as e:
        print(f"[Chroma] find_duplicates 异常: {e}", flush=True)
        return web.json_response({"duplicates": []})


async def handle_delete(request):
    try:
        body = await request.json()
        id_ = body.get("id")
        if not id_:
            return web.json_response({"error": "id required"}, status=400)
        collection = await _get_or_create_collection(COLLECTION_NAME)
        collection.delete(ids=[str(id_)])
        return web.json_response({"deleted": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_get_collection_stats(request):
    try:
        collection = await _get_or_create_collection(COLLECTION_NAME)
        count = collection.count()
        return web.json_response({
            "count": count,
            "hnsw_space": (collection.metadata or {}).get("hnsw:space"),
            "collection": COLLECTION_NAME,
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


def _cosine_similarity(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    n1 = math.sqrt(sum(x * x for x in a))
    n2 = math.sqrt(sum(x * x for x in b))
    if n1 == 0 or n2 == 0:
        return 0
    return dot / (n1 * n2)


# =====================================================================
# 启动
# =====================================================================

app = web.Application()
app.router.add_get("/health", handle_health)
app.router.add_post("/embed", handle_embed)
app.router.add_post("/index_batch", handle_index_batch)
app.router.add_post("/query", handle_query)
app.router.add_post("/query_multi", handle_query_multi)
app.router.add_post("/find_similar_groups", handle_find_similar_groups)
app.router.add_post("/find_duplicates", handle_find_duplicates)
app.router.add_post("/delete", handle_delete)
app.router.add_post("/reset_collection", handle_reset_collection)
app.router.add_get("/stats", handle_get_collection_stats)

if __name__ == "__main__":
    port = int(os.environ.get("CHROMA_PORT", "7707"))
    bind = os.environ.get("TIDAL_BIND", "127.0.0.1").strip() or "127.0.0.1"
    print(f"[Chroma] 服务启动: http://{bind}:{port}", flush=True)
    print(f"[Chroma] 数据目录: {DATA_DIR}", flush=True)
    fn_status = "本地 ONNX" if _get_embedding_function() is not None else "API"
    print(f"[Chroma] Embedding: {fn_status}", flush=True)
    print(f"[Chroma] ChromaDB 可用: {CHROMADB_AVAILABLE}", flush=True)
    web.run_app(app, host=bind, port=port)