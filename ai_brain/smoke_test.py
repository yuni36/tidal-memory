"""
Tidal AI 大脑 — Phase 2 冒烟测试
测试模块导入和核心逻辑，不需要真实 LLM API。
"""

import os
import sys
sys.path.insert(0, ".")

def test_imports():
    """2.1-2.6: 所有模块可导入"""
    from context_builder import build_messages, PERSONA
    from memory_injector import inject_memories, inject_current_state
    from tool_dispatcher import MEMORY_TOOLS, execute_tool
    from model_router import CHAT_ROUTES, validate_routes, call_llm
    print("[OK] 2.1-2.6 全部 5 个模块导入成功")


def test_context_builder():
    """2.3: 上下文拼接 — system 静态；状态/记忆进当轮 user；历史带入库时钟"""
    from datetime import datetime, timezone
    from context_builder import (
        build_messages, wrap_current_user, stamp_history_text, format_msg_clock,
    )

    history = [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "你好！有什么可以帮你的？"},
        {"role": "user", "content": "今天天气怎么样"},
    ]

    msgs = build_messages(history_n=2, history=history)
    assert len(msgs) >= 2, f"预期至少 2 条消息，实际 {len(msgs)}"
    assert msgs[0]["role"] == "system"
    sys_text = msgs[0]["content"]
    assert "【输出风格】" in sys_text
    assert "自然 > 完整" in sys_text
    assert "记忆像回忆" in sys_text
    assert "[17:02]" in sys_text
    assert "[工具纪律]\n" in sys_text
    assert "[状态时态]\n" in sys_text
    assert "[当前日期]\n" not in sys_text
    assert "[当前状态]\n" not in sys_text
    assert "[相关记忆]\n" not in sys_text
    non_system = [m for m in msgs if m["role"] != "system"]
    assert len(non_system) >= 2

    wrapped = wrap_current_user(
        "记得我吗？",
        memory_context="用户喜欢喝咖啡",
        current_state="- #12 下周搬家（约5d后过期）",
        now=datetime(2026, 8, 24, 10, 52, tzinfo=timezone.utc),
        weather_context="北京 · 晴 18°C（更新于 16:00）",
    )
    assert "[输入时间]" in wrapped
    assert "输入于" in wrapped
    assert "18:52" in wrapped and "北京时间" in wrapped
    assert "[天气]" in wrapped and "北京" in wrapped
    assert "[当前状态]" in wrapped and "#12" in wrapped
    assert "[相关记忆]" in wrapped and "喜欢喝咖啡" in wrapped
    assert wrapped.endswith("记得我吗？")
    assert wrapped.count("记得我吗？") == 1

    stamped = stamp_history_text("第五条消息", "2026-08-24T10:52:20+00:00")
    assert stamped.startswith("[输入时间 08-24 18:52]")
    assert stamped.endswith("第五条消息")
    assert format_msg_clock("2026-08-24T10:52:20Z") == "[输入时间 08-24 18:52]"

    parts = wrap_current_user(
        [{"type": "text", "text": "请看图。"}, {"type": "image_url", "image_url": {"url": "data:x"}}],
        current_state="- #1 行程",
        now=datetime(2026, 8, 24, 4, 0, tzinfo=timezone.utc),
    )
    assert isinstance(parts, list)
    assert "[输入时间]" in parts[0]["text"] and "请看图。" in parts[0]["text"]
    assert parts[0]["text"].count("请看图。") == 1

    import context_builder as cb
    old_barrier = cb.MEMORY_BARRIER
    cb.set_memory_barrier("规则测试占位")
    try:
        ordered = build_messages(history_n=1, history=[{"role": "user", "content": "hi"}])[0]["content"]
        i_style = ordered.find("【输出风格】")
        i_disc = ordered.find("[工具纪律]\n")
        i_tense = ordered.find("[状态时态]\n")
        i_bar = ordered.find("[记忆使用规则]\n")
        assert i_style != -1 and i_disc != -1 and i_tense != -1 and i_bar != -1
        assert i_style < i_disc < i_tense < i_bar, (
            "system 段顺序应为 输出风格→纪律→时态→规则"
        )
        assert "[当前日期]\n" not in ordered
        assert "不要向她汇报或复述你记得什么" in ordered
    finally:
        cb.MEMORY_BARRIER = old_barrier

    print("[OK] 2.3 上下文拼接测试通过 (system 静态 + 输出风格 + 当轮 wrap + 历史时钟)")


def test_gemini_context_fork():
    """Gemini：检索/状态进当轮 user；system 不含动态块（保 Interactions 前缀缓存）。"""
    from datetime import datetime, timezone
    from context_builder import build_messages, wrap_gemini_current_user

    wrapped = wrap_gemini_current_user(
        "你好",
        memory_context="用户喜欢咖啡",
        current_state="- #1 进行中",
        now=datetime(2026, 8, 24, 10, 52, tzinfo=timezone.utc),
    )
    assert "[输入时间]" in wrapped
    assert "[相关记忆]" in wrapped and "喜欢咖啡" in wrapped
    assert "[当前状态]" in wrapped and "#1" in wrapped

    msgs = build_messages(
        history=[{"role": "user", "content": wrapped}],
        gemini=True,
        memory_context="用户喜欢咖啡",
        current_state="- #1 进行中",
    )
    sys_text = msgs[0]["content"]
    assert "喜欢咖啡" not in sys_text
    assert "#1 进行中" not in sys_text
    assert "[当前状态]\n" not in sys_text
    assert "[相关记忆]\n" not in sys_text
    assert "[当前日期]\n" not in sys_text
    assert msgs[-1]["content"] == wrapped
    print("[OK] Gemini：检索/状态在 user，system 仅稳定块（无当前日期）")


def test_gemini_ix_reset_thresholds():
    import tempfile
    from pathlib import Path
    import gemini_interaction_state as gis

    tmp = Path(tempfile.mkdtemp()) / "ix.json"
    old = gis._STATE_FILE
    old_en = os.environ.get("GEMINI_IX_RESET_ENABLED")
    os.environ["GEMINI_IX_RESET_ENABLED"] = "1"
    gis._STATE_FILE = tmp
    try:
        gis.clear_all()
        sid = "test-reset"
        base, model = "https://example/v1beta", "gemini-3.6-flash"
        gis.note_ix_usage(sid, input_tokens=14000, cached_tokens=0, base=base, model=model)
        gis.note_ix_usage(sid, input_tokens=14100, cached_tokens=0, base=base, model=model)
        assert gis.should_reset_cycle(sid, base=base, model=model) is None
        gis.note_ix_usage(sid, input_tokens=14200, cached_tokens=0, base=base, model=model)
        reason = gis.should_reset_cycle(sid, base=base, model=model)
        assert reason and "miss" in reason
        gis.clear_session(sid)
        gis.note_ix_usage(sid, input_tokens=15000, cached_tokens=7000, base=base, model=model)
        reason2 = gis.should_reset_cycle(sid, base=base, model=model)
        assert reason2 and "input>=" in reason2
        assert gis.BOOTSTRAP_ROUNDS == 3
    finally:
        gis._STATE_FILE = old
        if old_en is None:
            os.environ.pop("GEMINI_IX_RESET_ENABLED", None)
        else:
            os.environ["GEMINI_IX_RESET_ENABLED"] = old_en
    print("[OK] Gemini ix 截断阈值：15k / 12k×3 miss")


def test_gemini_ix_helpers():
    from model_router import (
        _normalize_gemini_base,
        _history_to_bootstrap_input,
        _gemini_chat_mode,
        _gemini_generate_url,
    )

    assert _normalize_gemini_base(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    ) == "https://generativelanguage.googleapis.com/v1beta"
    assert _normalize_gemini_base(
        "https://generativelanguage.googleapis.com/v1beta/models"
    ) == "https://generativelanguage.googleapis.com/v1beta"

    boot = _history_to_bootstrap_input([
        {"role": "user", "content": "[输入时间 08-24 18:00] hi"},
        {"role": "assistant", "content": "hey"},
    ])
    assert boot[0]["type"] == "user_input"
    assert boot[1]["type"] == "model_output"

    assert _gemini_chat_mode() in ("generate", "interactions")
    url = _gemini_generate_url({
        "base": "https://generativelanguage.googleapis.com/v1beta",
        "model": "gemini-3.6-flash",
    })
    assert url.endswith("/models/gemini-3.6-flash:generateContent")
    print("[OK] Gemini URL 归一 + bootstrap + generateContent 模式")


def test_gemini_cache_helpers():
    import gemini_cache as gc
    assert gc._ttl_str(1800) == "1800s"
    assert gc._model_resource("gemini-x") == "models/gemini-x"
    assert not gc.is_expired("")  # 无过期时间不当作已过期
    assert gc.is_too_short_error(RuntimeError("The cached content is of 151 tokens. The minimum token count"))
    print("[OK] gemini_cache 纯函数")


async def test_memory_injector():
    """2.4: 记忆注入器 — memory_service 未运行时优雅降级返回 None（Phase 3 已对接 Librarian API）"""
    from memory_injector import inject_memories
    result = await inject_memories("测试消息")
    assert result is None
    print("[OK] 2.4 记忆注入器测试通过（memory_service 未运行，预期返回 None）")


def test_tool_dispatcher():
    """2.5: 工具调度器 — 七工具定义完整，实际对接 memory_service API"""
    import asyncio
    import json
    from tool_dispatcher import MEMORY_TOOLS, execute_tool

    assert len(MEMORY_TOOLS) == 7
    names = [t["function"]["name"] for t in MEMORY_TOOLS]
    for n in [
        "recall_memory",
        "browse_memories",
        "update_current_state",
        "correct_memory",
        "get_weather",
        "set_self_wake",
        "cancel_self_wake",
    ]:
        assert n in names, f"缺少工具: {n}"

    async def _test():
        fake_call = {
            "id": "call_test123",
            "type": "function",
            "function": {
                "name": "recall_memory",
                "arguments": json.dumps({"query": "用户喜欢的书"}),
            },
        }
        result = await execute_tool(fake_call)
        assert result["role"] == "tool"
        assert result["tool_call_id"] == "call_test123"
        assert len(result["content"]) > 0, "tool should return non-empty content"

    asyncio.run(_test())
    print("[OK] 2.5 工具调度器测试通过 (7 工具定义 + memory_service 离线时优雅降级)")


def test_model_router_config():
    """2.2: 模型路由器 — 配置校验正确"""
    from model_router import CHAT_ROUTES, validate_routes
    missing = validate_routes()
    # 如果已有配置则提示已配置，如果未配置则验证能正常识别缺失
    if missing:
        assert "CHAT_API_BASE_1" in missing[0]
        print("[OK] 2.2 模型路由器配置校验通过 (识别到配置缺失)")
    else:
        assert len(CHAT_ROUTES) > 0
        print(f"[OK] 2.2 模型路由器配置校验通过 (已加载 {len(CHAT_ROUTES)} 条有效路由)")


def test_history_n_clamp():
    from bridge import _clamp_history_n, _clamp_max_tokens
    from context_builder import clamp_history_window
    assert _clamp_history_n(12) == 12
    assert _clamp_history_n("1") == 1
    assert _clamp_history_n("50") == 50
    assert _clamp_history_n(0) == 1
    assert _clamp_history_n(99) == 50
    assert _clamp_history_n("x", 12) == 12
    assert clamp_history_window(20, 12) == (12, 12)
    assert clamp_history_window(None, 12) == (12, 12)
    assert clamp_history_window(6, 12) == (6, 12)
    assert _clamp_max_tokens(1200) == 1200
    assert _clamp_max_tokens(5000) == 2048
    assert _clamp_max_tokens(100) == 256
    print("[OK] history_n 夹紧 1–50；max_tokens 256–2048")


def _ua_history(complete_rounds: int, current: str | None = "now"):
    hist = []
    for i in range(complete_rounds):
        hist.append({"role": "user", "content": f"u{i}"})
        hist.append({"role": "assistant", "content": f"a{i}"})
    if current is not None:
        hist.append({"role": "user", "content": current})
    return hist


def test_history_window_slice():
    from context_builder import slice_history_window, build_messages

    hist = _ua_history(3, "now")
    slid = slice_history_window(hist, 2, 2)
    assert slid == hist[-4:], "min=max 应等于旧滑窗 history[-n*2:]"

    msgs = build_messages(history=hist)
    assert msgs[1:] == hist, "build_messages 不得再二次截断"

    first_fill_a = slice_history_window(_ua_history(10), 6, 12)
    first_fill_b = slice_history_window(_ua_history(11), 6, 12)
    assert first_fill_a[0]["content"] == "u0"
    assert first_fill_b[0]["content"] == "u0"

    after_a = slice_history_window(_ua_history(12), 6, 12)
    after_b = slice_history_window(_ua_history(13), 6, 12)
    assert after_a[0]["content"] == after_b[0]["content"]
    assert after_a[0]["content"] != "u0"
    print("[OK] 阶梯窗口：min=max 滑窗；min<max 同周期首条不变")


def test_bridge_import():
    """2.6: bridge.py 模块可加载"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("bridge", "ai_brain/bridge.py")
    assert spec is not None, "bridge.py 模块规范获取失败"
    print("[OK] 2.6 bridge.py 模块文件可加载")


def test_thinking_effort_resolve():
    """effort → thinking_level：3.6 允 minimal；3.8 钳到 low。"""
    print("\n[TEST] thinking effort resolve")
    from model_router import (
        model_allows_minimal_thinking,
        normalize_thinking_effort,
        resolve_thinking_level,
        _parse_ix_response,
        _gemini_ix_generation_config,
        update_params,
        normalize_vision_level,
        gemini_media_resolution_enum,
        deepseek_image_detail,
        route_supports_vision,
        _user_content_to_gemini_parts,
        _user_content_to_ix_input,
    )
    assert normalize_vision_level(None) == "low"
    assert normalize_vision_level("500") == "medium"
    assert normalize_vision_level("1000") == "high"
    assert gemini_media_resolution_enum("low") == "MEDIA_RESOLUTION_LOW"
    assert gemini_media_resolution_enum("medium") == "MEDIA_RESOLUTION_MEDIUM"
    assert deepseek_image_detail("low") == "low"
    assert deepseek_image_detail("high") == "original"
    assert route_supports_vision({"model": "deepseek-flash", "base": "https://api.deepseek.com"})
    gparts = _user_content_to_gemini_parts([
        {"type": "text", "text": "看"},
        {"type": "image_url", "image_url": {
            "url": "data:image/jpeg;base64,xxxx",
            "vision": "medium",
            "detail": "original",
        }},
    ])
    assert gparts[1]["media_resolution"]["level"] == "MEDIA_RESOLUTION_MEDIUM"
    ix = _user_content_to_ix_input([
        {"type": "image_url", "image_url": {
            "url": "data:image/png;base64,yyyy",
            "vision": "low",
            "detail": "low",
        }},
    ])
    assert ix[0]["media_resolution"]["level"] == "MEDIA_RESOLUTION_LOW"
    assert model_allows_minimal_thinking("gemini-3.6-flash")
    assert not model_allows_minimal_thinking("gemini-3.8-flash")
    assert normalize_thinking_effort("xhigh") == "high"
    assert resolve_thinking_level("gemini-3.6-flash", "minimal") == "minimal"
    assert resolve_thinking_level("gemini-3.8-flash", "minimal") == "low"
    assert resolve_thinking_level("gemini-3.8-flash", "medium") == "medium"
    update_params(thinking_effort="medium")
    cfg = _gemini_ix_generation_config("gemini-3.8-flash")
    assert cfg.get("thinking_level") == "medium"
    assert cfg.get("thinking_summaries") == "auto"
    update_params(thinking_effort="minimal")
    cfg36 = _gemini_ix_generation_config("gemini-3.6-flash")
    assert cfg36.get("thinking_level") == "minimal"
    cfg38 = _gemini_ix_generation_config("gemini-3.8-flash")
    assert cfg38.get("thinking_level") == "low"
    iid, text, tools, usage, thought = _parse_ix_response({
        "id": "ix1",
        "steps": [
            {
                "type": "thought",
                "signature": "sig",
                "summary": [{"type": "text", "text": "先拆题再算"}],
            },
            {"type": "model_output", "content": [{"type": "text", "text": "答案是 42"}]},
        ],
        "usage": {"total_thought_tokens": 120},
    })
    assert iid == "ix1"
    assert text == "答案是 42"
    assert thought == "先拆题再算"
    assert usage.get("total_thought_tokens") == 120
    _, _, _, _, empty = _parse_ix_response({
        "id": "ix2",
        "steps": [{"type": "thought", "signature": "sig", "summary": []}],
        "usage": {},
    })
    assert empty == ""
    update_params(thinking_effort="low")
    print("  OK")


if __name__ == "__main__":
    import asyncio

    print("=" * 50)
    print("Tidal Phase 2 — AI 大脑冒烟测试")
    print("=" * 50)

    test_imports()
    test_context_builder()
    test_gemini_context_fork()
    test_gemini_ix_reset_thresholds()
    test_gemini_ix_helpers()
    test_gemini_cache_helpers()
    from bridge import _EMPTY_REPLY
    assert "再发" in _EMPTY_REPLY
    print("[OK] empty-reply fallback 文案")
    test_thinking_effort_resolve()
    asyncio.run(test_memory_injector())
    test_tool_dispatcher()
    test_model_router_config()
    test_history_n_clamp()
    test_history_window_slice()
    test_bridge_import()

    print("=" * 50)
    print("全部冒烟测试通过！")
    print("=" * 50)