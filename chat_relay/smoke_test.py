"""Phase 1 冒烟测试 — 验证聊天中继所有核心端点"""
import urllib.request
import json

BASE = "http://127.0.0.1:3011"

def req(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

print("=" * 50)
print("Phase 1 冒烟测试 — Tidal 聊天中继")
print("=" * 50)

# 1. 健康检查
code, data = req("GET", "/healthz")
assert code == 200, f"healthz FAIL: {code}"
assert data["ok"] is True, f"healthz not ok: {data}"
print("[PASS] 1/5 健康检查 /healthz")

# 2. 发送消息
code, data = req("POST", "/app/send", {"text": "Hello, 这是一条测试消息"})
assert code == 200, f"send FAIL: {code} {data}"
msg_id = data["id"]
assert isinstance(msg_id, int), f"send returned no id: {data}"
print(f"[PASS] 2/5 发送消息 /app/send → id={msg_id}")

# 3. 发送第二条消息
code, data = req("POST", "/app/send", {"text": "第二条测试消息，带附件模拟"})
assert code == 200, f"send2 FAIL: {code}"
print(f"[PASS] 3/5 发送第二条 → id={data['id']}")

# 4. 查询历史
code, data = req("GET", "/app/history")
assert code == 200, f"history FAIL: {code}"
msgs = data["messages"]
assert len(msgs) >= 2, f"history expected >=2 messages, got {len(msgs)}"
assert msgs[0]["from"] == "human", f"first msg should be human: {msgs[0]}"
assert msgs[0]["kind"] == "user", f"kind should be user: {msgs[0]}"
print(f"[PASS] 4/5 查询历史 /app/history → {len(msgs)} 条消息")

# 5. AI 回复（模拟 AI 大脑发送回复）
code, data = req("POST", "/channel/out", {"type": "reply", "text": "收到！我是 AI 回复"})
assert code == 200, f"channel/out FAIL: {code} {data}"
print(f"[PASS] 5/5 AI 回复 /channel/out → id={data['id']}")

# 最终验证：历史应该有 3 条（2 人类 + 1 AI）
code, data = req("GET", "/app/history")
assert len(data["messages"]) >= 3, f"final history expected >=3, got {len(data['messages'])}"
# 验证最后一条是 AI 回复
assert data["messages"][-1]["from"] == "ai", "last msg should be from ai"

print()
print("=" * 50)
print("全部测试通过！Phase 1 聊天中继核心功能正常。")
print("=" * 50)