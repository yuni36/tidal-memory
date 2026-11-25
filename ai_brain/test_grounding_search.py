"""grounding_search.count_from_usage_and_candidate 单测。"""

from grounding_search import count_from_usage_and_candidate, build_act_payload


def test_billed_tool_calls():
    usage = {
        "billedToolCalls": [
            {"tool": "GOOGLE_SEARCH", "successfulToolCallCount": 3},
        ]
    }
    info = count_from_usage_and_candidate(usage, None)
    assert info["count"] == 3


def test_web_search_queries_nonempty():
    cand = {
        "groundingMetadata": {
            "webSearchQueries": ["", "euro 2024", "spain england"],
            "groundingChunks": [
                {"web": {"title": "uefa.com", "uri": "https://x"}},
            ],
        }
    }
    info = count_from_usage_and_candidate({}, cand)
    assert info["count"] == 2
    assert info["queries"] == ["euro 2024", "spain england"]
    assert "uefa.com" in info["sources"]


def test_conservative_redirect():
    info = count_from_usage_and_candidate(
        {},
        None,
        response_text="see https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
    )
    assert info["count"] == 2


def test_act_payload():
    text, meta = build_act_payload({"count": 1, "queries": ["今天大连天气"], "sources": ["wttr"]})
    assert "查了" in text
    assert meta["glyph"] == "web"
    assert meta["steps"]


def test_user_wants_search():
    from grounding_search import user_text_wants_search
    assert user_text_wants_search("帮我搜一下今天新闻")
    assert user_text_wants_search("比分多少")
    assert not user_text_wants_search("吃了吗")
    assert not user_text_wants_search("今天天气怎么样")


def test_gm_chunks_without_queries():
    cand = {
        "groundingMetadata": {
            "groundingChunks": [{"web": {"title": "x.com", "uri": "https://x"}}],
        }
    }
    info = count_from_usage_and_candidate({}, cand)
    assert info["count"] == 2
    assert info["reason"] == "gm_trace"


def test_citation_annotation():
    cand = {
        "content": {
            "parts": [{
                "text": "Spain won",
                "annotations": [{"type": "url_citation", "url": "https://uefa.com"}],
            }]
        }
    }
    info = count_from_usage_and_candidate({}, cand)
    assert info["count"] == 2
    assert info["reason"] == "citation"


def test_search_turn_no_floor():
    # 并且模式：仅挂 search 不算命中；无 grounding 痕迹 → 0
    info = count_from_usage_and_candidate({}, None, search_turn=True)
    assert info["count"] == 0
    assert info["reason"] == "none"


if __name__ == "__main__":
    test_billed_tool_calls()
    test_web_search_queries_nonempty()
    test_conservative_redirect()
    test_act_payload()
    test_user_wants_search()
    test_gm_chunks_without_queries()
    test_citation_annotation()
    test_search_turn_no_floor()
    print("grounding_search tests ok")