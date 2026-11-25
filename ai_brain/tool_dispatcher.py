"""
工具调度器 — 注册记忆四工具，处理 LLM 的 tool_calls 请求。
Phase 3：对接记忆服务 HTTP API 执行真实工具调用。

工具协议：OpenAI function calling 格式
  - 工具定义 → LLM 请求中注入 "tools"
  - LLM 返回 tool_calls → execute_tool → POST /tools/:toolName → 结果回填上下文
"""

import asyncio
import json
import os
import sys

import aiohttp

MEMORY_URL = os.environ.get("MEMORY_URL", "http://127.0.0.1:3013").rstrip("/")


# =============================================================================
# 记忆工具 — OpenAI function calling 定义
# =============================================================================
#
# 单一数据源在记忆服务后端（GET /tools/definitions?format=openai）。
# 启动时由 load_tools_from_backend() 原地刷新；拉取失败时回退到下方
# 本地副本（向后兼容，保证断网/后端未启动也能跑）。
# MEMORY_TOOLS 是模块级可变列表，原地 clear+extend 以保证
# bridge.py / smoke_test.py 中 from-import 的引用拿到最新定义。

MEMORY_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": "搜索和召回与当前对话相关的过往记忆。当需要回忆以前聊过的话题、事实或事件时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "自然语言搜索查询，如「用户喜欢的书」「旅行计划」",
                    },
                    "memory_id": {
                        "type": "integer",
                        "description": "记忆或片段的数字ID，用于深度追溯原始对话（可选）",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browse_memories",
            "description": "浏览和查看记忆库中的记忆分类、剧集或传奇。用于了解已存储的记忆概况。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "分区路径或实体名称，如「社交」「爱好」「地点」",
                    },
                    "query": {
                        "type": "string",
                        "description": "在指定分区内搜索的关键词",
                    },
                    "limit": {"type": "integer", "default": 8},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_current_state",
            "description": "更新AI伙伴对当前对话的理解和用户状态的认知。用于记录用户的状态变化、情绪、新了解的信息等。",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "操作类型：set(新建状态) / update(修改已有状态) / resolve(结束状态) / update_overview(更新实体描述)",
                        "enum": ["set", "update", "resolve", "update_overview"],
                    },
                    "state_id": {
                        "type": "integer",
                        "description": "要修改/结束的状态ID（update/resolve时必填）",
                    },
                    "content": {
                        "type": "string",
                        "description": "状态描述，≤500字（set/update时必填）",
                    },
                    "expires_at": {
                        "type": "string",
                        "description": "ISO 8601 过期时间（set/update时必填）",
                    },
                    "resolve_reason": {
                        "type": "string",
                        "description": "结束原因（resolve时必填）",
                    },
                    "entity": {
                        "type": "string",
                        "description": "实体名称（update_overview时必填）",
                    },
                    "overview": {
                        "type": "string",
                        "description": "新的完整描述（update_overview时必填）",
                    },
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "correct_memory",
            "description": "修正记忆中存在的错误信息。当用户指出记忆不准确时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "wrong_statement": {
                        "type": "string",
                        "description": "AI 说错的内容",
                    },
                    "correction": {
                        "type": "string",
                        "description": "用户给出的正确版本",
                    },
                    "memory_id": {
                        "type": "integer",
                        "description": "需要修正的记忆条目 ID（可选，从上下文中的 #数字 获取）",
                    },
                },
                "required": ["wrong_statement", "correction"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查看对方所在地（设置里选的城市）的天气。闲聊有新鲜[天气]时不必调用；细问或缓存缺失/偏旧时调用。days=0~3。",
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {
                        "type": "integer",
                        "description": "未来天数 0~3；0=实况",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_self_wake",
            "description": "给自己设唤醒闹钟。at=ISO+08:00，note=8～40字留言。到点只交还留言，不规定醒来干嘛。",
            "parameters": {
                "type": "object",
                "properties": {
                    "at": {"type": "string", "description": "ISO+08:00"},
                    "note": {"type": "string", "description": "短留言 8～40 字"},
                },
                "required": ["at", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_self_wake",
            "description": "取消尚未响起的自醒闹钟。",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer", "description": "闹钟 id"},
                },
                "required": ["id"],
            },
        },
    },
]

# 后端 instructionText（工具使用教导）与记忆屏障块（启动拉取后填充）
TOOL_GUIDANCE = ""
MEMORY_BARRIER = ""


async def load_tools_from_backend() -> bool:
    """启动时从记忆服务拉取工具定义 + 使用教导 + 记忆屏障块。

    成功后原地刷新 MEMORY_TOOLS / TOOL_GUIDANCE / MEMORY_BARRIER；
    失败保持本地回退副本，保证向后兼容。
    最多重试 3 次（记忆服务可能比 AI Brain 晚就绪）。

    Returns:
        True = 后端拉取成功；False = 使用本地回退
    """
    global TOOL_GUIDANCE, MEMORY_BARRIER
    url = f"{MEMORY_URL}/tools/definitions"
    last_error = "未知错误"
    for attempt in range(1, 4):
        data = None
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url, params={"format": "openai"},
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status != 200:
                        last_error = f"HTTP {resp.status}"
                    else:
                        data = await resp.json()
        except Exception as e:
            last_error = str(e)

        if data and data.get("tools"):
            tools = data["tools"]
            new_tools = [{"type": "function", "function": t} for t in tools]
            MEMORY_TOOLS.clear()
            MEMORY_TOOLS.extend(new_tools)
            TOOL_GUIDANCE = data.get("instructionText", "") or ""
            MEMORY_BARRIER = data.get("barrierPrompt", "") or ""
            return True

        if attempt < 3:
            await asyncio.sleep(attempt * 1.5)

    print(f"[boot] 工具定义拉取失败（3 次重试）: {last_error}", file=sys.stderr, flush=True)
    return False


# =============================================================================
# 工具执行（对接记忆服务 HTTP API）
# =============================================================================

async def execute_tool(call: dict) -> dict:
    """执行单个工具调用，返回 OpenAI tool result 格式。

    调用记忆服务 POST /tools/:toolName 转发工具参数，
    服务端执行后返回 {success, formatted} 结果。

    Args:
        call: LLM 返回的 tool_call 对象，含 id/type/function

    Returns:
        {"tool_call_id": str, "role": "tool", "content": str}
    """
    fn = call.get("function", {})
    name = fn.get("name", "")
    try:
        args = json.loads(fn.get("arguments", "{}"))
    except json.JSONDecodeError:
        args = {}

    tool_call_id = call.get("id", "")

    try:
        async with aiohttp.ClientSession() as session:
            url = f"{MEMORY_URL}/tools/{name}"
            async with session.post(url, json=args, timeout=aiohttp.ClientTimeout(total=15 if name == "get_weather" else 10)) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return _tool_result(tool_call_id, f"工具调用失败 (HTTP {resp.status}): {error_text[:200]}")
                data = await resp.json()
    except Exception as e:
        return _tool_result(tool_call_id, f"记忆服务连接失败: {e}")

    inner = data.get("result", {})
    if isinstance(inner, dict) and inner.get("success") is False:
        return _tool_result(tool_call_id, inner.get("formatted", inner.get("error", "工具执行失败")))
    if isinstance(inner, dict) and inner.get("formatted"):
        return _tool_result(tool_call_id, inner["formatted"])

    # 兜底：直接序列化返回
    return _tool_result(tool_call_id, json.dumps(data, ensure_ascii=False))


def _tool_result(tool_call_id: str, content: str) -> dict:
    return {"tool_call_id": tool_call_id, "role": "tool", "content": content}