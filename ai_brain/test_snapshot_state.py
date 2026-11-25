"""snapshot_state 纯逻辑验收（不需网络）"""
import os
import tempfile
from pathlib import Path

# 临时状态目录，避免污染开发 .bridge_state
_tmpdir = tempfile.mkdtemp(prefix="tidal_snap_")
os.environ["BRIDGE_STATE_DIR"] = _tmpdir

import snapshot_state as snap  # noqa: E402


def test_cutoff_filter_and_hot3():
    hist = [
        {"role": "user", "content": "u1", "id": 1},
        {"role": "assistant", "content": "a1", "id": 2},
        {"role": "user", "content": "u2", "id": 3},
        {"role": "assistant", "content": "a2", "id": 4},
        {"role": "user", "content": "u3", "id": 5},
        {"role": "assistant", "content": "a3", "id": 6},
        {"role": "user", "content": "u4", "id": 7},
        {"role": "assistant", "content": "a4", "id": 8},
    ]
    b = snap.filter_history_after_cutoff(hist, 4)
    assert [m["id"] for m in b] == [5, 6, 7, 8]
    hot = snap.extract_hot3(hist, n_rounds=3)
    assert len(hot) == 6
    assert hot[0]["content"] == "u2"
    assert hot[-1]["content"] == "a4"
    clean = snap.strip_history_meta(b)
    assert "id" not in clean[0]
    print("[OK] cutoff filter + hot3 + strip")


def test_commit_and_fresh_rounds():
    sid = "test-sess-1"
    snap.clear_session(sid)
    e = snap.note_ai_reply(sid, 10)
    assert e["fresh_rounds"] == 1
    assert e["last_relay_id"] == 10
    # 固化周期 5：B 区满 5 轮即可固化
    assert not snap.should_consolidate(sid)
    for i in range(4):
        snap.note_ai_reply(sid, 11 + i)
    assert snap.should_consolidate(sid)
    begun = snap.begin_consolidate(sid)
    assert begun and begun["consolidating"] is True
    assert snap.begin_consolidate(sid) is None  # 互斥
    snap.commit_snapshot(
        sid,
        cutoff_relay_id=20,
        voyage="",
        daily_events="- 12:00 [生活]: 测试",
        hot3=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hey"}],
        schedule="[日程]\n09/12 09:00 线代考",
    )
    e2 = snap.get_entry(sid)
    assert e2["snapshot_cutoff_id"] == 20
    assert e2["fresh_rounds"] == 0
    assert e2["consolidating"] is False
    assert e2["local_a_blob"]["voyage"] == ""
    assert e2["local_a_blob"]["schedule"].startswith("[日程]")
    text = snap.build_local_a_text(e2["local_a_blob"])
    assert "[近期对话摘要]" not in text  # 弃航海摘要
    assert "[今日事件]" in text and "[锚定对话]" in text
    assert "[日程·用法]" in text and "[日程]" in text
    # 用法在日程正文前
    assert text.index("[日程·用法]") < text.index("[日程]\n")
    print("[OK] commit + fresh rounds + a_text (周期5, 弃航海)")


def test_a_window_10_rounds():
    # A 区窗口 = 最近 A_WINDOW_ROUNDS 轮原文
    assert snap.A_WINDOW_ROUNDS == 10
    assert snap.CONSOLIDATE_ROUNDS == 5
    hist = []
    for i in range(1, 13):  # 12 轮对话
        hist.append({"role": "user", "content": f"u{i}", "id": i * 2 - 1})
        hist.append({"role": "assistant", "content": f"a{i}", "id": i * 2})
    hot = snap.extract_hot3(hist, n_rounds=snap.A_WINDOW_ROUNDS)
    # 10 轮 = 20 条消息，应取末尾 20 条
    assert len(hot) == 20
    assert hot[0]["content"] == "u3"     # 第 3 轮起（丢掉最旧 2 轮）
    assert hot[-1]["content"] == "a12"
    print("[OK] A window = 最近 10 轮原文")


def test_stale_consolidating_unlocks():
    sid = "test-sess-stale"
    snap.clear_session(sid)
    snap.note_ai_reply(sid, 1)
    begun = snap.begin_consolidate(sid)
    assert begun and snap.consolidating_active(begun)
    assert snap.begin_consolidate(sid) is None
    # 旧脏标记（无时间戳）视为已死
    dirty = snap.get_entry(sid)
    dirty["consolidating"] = True
    dirty["consolidating_started_at"] = ""
    snap._put(sid, dirty)
    assert not snap.consolidating_active(snap.get_entry(sid))
    assert snap.begin_consolidate(sid) is not None
    snap.clear_session(sid)
    print("[OK] stale consolidating unlocks")


def test_context_hot_window_slot():
    import context_builder as cb
    cb.set_summary_log("")
    cb.set_activity_log("")
    cb.set_hot_window_log(f"{cb.HUMAN_NAME}: hi\n{cb.AI_NAME}: hey")
    msgs = cb.build_messages(history=[{"role": "user", "content": "x"}])
    assert "[锚定对话]" in msgs[0]["content"]
    assert f"{cb.HUMAN_NAME}: hi" in msgs[0]["content"]
    cb.set_hot_window_log("")
    print("[OK] context hot window slot")


if __name__ == "__main__":
    test_cutoff_filter_and_hot3()
    test_commit_and_fresh_rounds()
    test_stale_consolidating_unlocks()
    test_context_hot_window_slot()
    test_a_window_10_rounds()
    print("snapshot_state tests 全部通过")
    # 清理
    try:
        for p in Path(_tmpdir).glob("*"):
            p.unlink()
        Path(_tmpdir).rmdir()
    except OSError:
        pass
