#!/usr/bin/env python3
"""Audit #4: Multi-turn, Idempotency, Replay, Processing Wait — read-only probes.

Covers:
  1. 普通多轮 — browser_prompt multi-turn, conversation_id propagation
  2. 同 conversation_id 重试 — idempotency key reuse, same-key replay
  3. 幂等 — claim/complete/fail lifecycle, fingerprint conflicts
  4. completed replay — replayed responses match original
  5. processing wait — Event.wait() behaviour, waiter timeout

NO modifications. NO browser launch. Evidence-first.
"""

import importlib.util
import pathlib
import threading
import time
import json
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

def _load_api_module():
    spec = importlib.util.spec_from_file_location('phantom_api', ROOT / 'server' / 'api_server.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

api = _load_api_module()

PASS = 0
FAIL = 0

def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  — {detail}")


# ═══════════════════════════════════════════════════════════════════════════════
# 1. 普通多轮: browser_prompt multi-turn, conversation_id propagation
# ═══════════════════════════════════════════════════════════════════════════════
def probe_multiturn():
    print("\n=== 1. 普通多轮 (Multi-turn Conversations) ===")

    # 1a: Single user message: prompt is just the content
    prompt = api.browser_prompt([{"role": "user", "content": "你好"}])
    check("single-turn prompt = content", prompt == "你好")

    # 1b: Multi-turn: system + user
    prompt = api.browser_prompt([
        {"role": "system", "content": "You are helpful"},
        {"role": "user", "content": "你好"},
    ])
    check("multi-turn with system: has context header", "以下是对话上下文" in prompt)
    check("multi-turn with system: has system label", "系统：" in prompt)
    check("multi-turn with system: has user question", "【当前用户问题】" in prompt)
    check("multi-turn with system: user content present", "你好" in prompt)

    # 1c: Multi-turn: user → assistant → user (2 user turns)
    prompt = api.browser_prompt([
        {"role": "user", "content": "第一轮"},
        {"role": "assistant", "content": "回复一"},
        {"role": "user", "content": "第二轮"},
    ])
    check("multi-user-turn: first user in context", "第一轮" in prompt)
    check("multi-user-turn: assistant in context", "回复一" in prompt)
    check("multi-user-turn: last user is current question", "【当前用户问题】" in prompt and "第二轮" in prompt)

    # 1d: Multi-turn: user → assistant → user → assistant (3+ turns)
    prompt = api.browser_prompt([
        {"role": "user", "content": "Q1"},
        {"role": "assistant", "content": "A1"},
        {"role": "user", "content": "Q2"},
        {"role": "assistant", "content": "A2"},
        {"role": "user", "content": "Q3"},
    ])
    check("3-turn: all history present", "Q1" in prompt and "A1" in prompt and "Q2" in prompt and "A2" in prompt)
    check("3-turn: last Q is current", "【当前用户问题】" in prompt and "Q3" in prompt)

    # 1e: Tool continuation (no user in sequence)
    prompt = api.browser_prompt([
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "search", "arguments": "{}"}}
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": "results here"},
    ])
    check("tool-continuation: has context header", "以下是工具续轮上下文" in prompt)
    check("tool-continuation: tool call present", "助手工具调用" in prompt)
    check("tool-continuation: tool result present", "工具结果（c1）" in prompt)
    check("tool-continuation: actual result in prompt", "results here" in prompt)

    # 1f: conversation_id propagated through new_browser_job
    job = api.new_browser_job("test", domain="x.com", model="m", conversation_id="my-session-123")
    check("conversation_id preserved in job", job["conversation_id"] == "my-session-123")

    # 1g: conversation_id auto-generated if not provided
    job2 = api.new_browser_job("test", domain="x.com", model="m")
    check("conversation_id auto-generated", job2["conversation_id"].startswith("conv_"))

    # 1h: Multi-turn with tool keyword in last user message
    tools = [{"type": "function", "function": {"name": "search", "description": "search web"}}]
    prompt = api.browser_prompt([
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there"},
        {"role": "user", "content": "请搜索天气"},
    ], tools)
    check("multi-turn + tool keyword: tool injection present", "tool_json" in prompt)
    check("multi-turn + tool keyword: history still present", "hello" in prompt)
    check("multi-turn + tool keyword: last user is current", "【当前用户问题】" in prompt)

    # 1i: Multi-turn without tool keyword in last message → no injection
    prompt = api.browser_prompt([
        {"role": "user", "content": "搜索"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "thanks"},
    ], tools)
    check("multi-turn no keyword in last: no tool injection", "tool_json" not in prompt)

    # 1j: Developer role preserved in multi-turn
    prompt = api.browser_prompt([
        {"role": "developer", "content": "dev instructions"},
        {"role": "user", "content": "hello"},
    ])
    check("developer role in multi-turn", "开发者：" in prompt and "dev instructions" in prompt)

    # 1k: Multi-turn messages normalized correctly
    messages = api.normalize_messages([
        {"role": "user", "content": "hello"},
        "",
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": ""},
        {"role": "assistant", "content": "bye"},
    ])
    check("normalize multi-turn: non-dict skipped and empty user dropped", len(messages) == 3)
    check("normalize multi-turn: first message is user", messages[0]["role"] == "user" and messages[0]["content"] == "hello")
    check("normalize multi-turn: empty user dropped, assistant kept", messages[1]["role"] == "assistant" and messages[1]["content"] == "hi")
    check("normalize multi-turn: last message is bye", messages[2]["role"] == "assistant" and messages[2]["content"] == "bye")


# ═══════════════════════════════════════════════════════════════════════════════
# 2. 同 conversation_id 重试: same-key replay, binding, claim
# ═══════════════════════════════════════════════════════════════════════════════
def probe_retry():
    print("\n=== 2. 同 conversation_id 重试 (Same conversation_id Retry) ===")

    # 2a: Idempotency key from header
    class FakeHeaders:
        def get(self, key, default=None):
            d = {"Idempotency-Key": "header-key-001"}
            return d.get(key, default)
    handler = type('obj', (object,), {'headers': FakeHeaders()})()
    key = api.idempotency_key(handler, {})
    check("idempotency_key from header", key == "header-key-001")

    # 2b: Idempotency key from body.idempotency_key
    key = api.idempotency_key(type('obj', (object,), {'headers': type('obj', (object,), {'get': lambda s, k, d=None: None})()})(), {"idempotency_key": "body-key-002"})
    check("idempotency_key from body field", key == "body-key-002")

    # 2c: Idempotency key from body.request_id
    key = api.idempotency_key(type('obj', (object,), {'headers': type('obj', (object,), {'get': lambda s, k, d=None: None})()})(), {"request_id": "req-id-003"})
    check("idempotency_key from request_id", key == "req-id-003")

    # 2d: No key → empty string
    key = api.idempotency_key(type('obj', (object,), {'headers': type('obj', (object,), {'get': lambda s, k, d=None: None})()})(), {})
    check("idempotency_key missing → empty", key == "")

    # 2e: Same key + same fingerprint → replay, not owner
    api.IDEMPOTENCY.clear()
    rec1, owner1, conflict1 = api.claim_idempotency("retry-key", "fp-same")
    check("first claim is owner", owner1 is True and conflict1 is False)

    rec2, owner2, conflict2 = api.claim_idempotency("retry-key", "fp-same")
    check("same key + same fp: not owner", owner2 is False)
    check("same key + same fp: no conflict", conflict2 is False)
    check("same key + same fp: same event object", rec2["event"] is rec1["event"])

    # 2f: Same key + different fingerprint → conflict
    _, _, conflict3 = api.claim_idempotency("retry-key", "fp-different")
    check("same key + different fp: conflict", conflict3 is True)

    # 2g: Same job with same conversation_id claimed correctly
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()
    job = api.new_browser_job("test", domain="retry.com", model="m", conversation_id="retry-conv")
    api.BROWSER_CLIENTS["7"] = {"tab_id": 7, "domain": "retry.com", "capabilities": {
        "can_observe": True, "can_execute": True,
    }, "last_seen": time.time()}
    claimed = api.claim_browser_job("retry.com", 7, conversation_id="retry-conv")
    check("claim with correct conversation_id succeeds", claimed is not None and claimed["conversation_id"] == "retry-conv")

    # 2h: Same job with wrong conversation_id → rejected
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    job2 = api.new_browser_job("test2", domain="retry.com", model="m", conversation_id="right-conv")
    claimed_wrong = api.claim_browser_job("retry.com", 7, conversation_id="wrong-conv")
    check("claim with wrong conversation_id rejected", claimed_wrong is None)

    # 2i: No conversation_id in claim but job has one → rejected
    claimed_none = api.claim_browser_job("retry.com", 7)
    check("claim without conversation_id when job expects one → rejected", claimed_none is None)

    # 2j: Retry after completion — idempotency replay
    api.IDEMPOTENCY.clear()
    rec, owner, _ = api.claim_idempotency("completed-retry", "fp-x")
    response = {"id": "chatcmpl-retry", "choices": [{"message": {"content": "retry ok"}}]}
    api.complete_idempotency("completed-retry", response)

    rec_replay, owner_replay, conflict_replay = api.claim_idempotency("completed-retry", "fp-x")
    check("replay after complete: not owner", owner_replay is False)
    check("replay after complete: no conflict", conflict_replay is False)
    check("replay after complete: status=completed", rec_replay["status"] == "completed")
    check("replay after complete: response matches", api.idempotency_response(rec_replay)["id"] == "chatcmpl-retry")

    # 2k: Retry with empty key → no idempotency
    api.IDEMPOTENCY.clear()
    rec_empty, owner_empty, conflict_empty = api.claim_idempotency("", "fp-any")
    check("empty key: None record", rec_empty is None)
    check("empty key: is owner", owner_empty is True)
    check("empty key: no conflict", conflict_empty is False)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. 幂等: claim/complete/fail lifecycle, TTL, stale cleanup
# ═══════════════════════════════════════════════════════════════════════════════
def probe_idempotency():
    print("\n=== 3. 幂等 (Idempotency Lifecycle) ===")

    api.IDEMPOTENCY.clear()

    # 3a: Fresh claim → processing status
    rec, owner, conflict = api.claim_idempotency("lifecycle-key", "fp-a")
    check("fresh claim: status=processing", rec["status"] == "processing")
    check("fresh claim: fingerprint stored", rec["fingerprint"] == "fp-a")
    check("fresh claim: event created", isinstance(rec["event"], threading.Event))
    check("fresh claim: event not set", not rec["event"].is_set())

    # 3b: Complete → event set, status=completed
    response = {"id": "chatcmpl-lifecycle", "choices": [{"message": {"content": "done"}}]}
    api.complete_idempotency("lifecycle-key", response)
    check("complete: status=completed", rec["status"] == "completed")
    check("complete: event is_set", rec["event"].is_set())
    check("complete: response stored", rec["response"]["id"] == "chatcmpl-lifecycle")

    # 3c: idempotency_response returns dict copy
    resp = api.idempotency_response(rec)
    check("idempotency_response returns dict", isinstance(resp, dict))
    check("idempotency_response correct id", resp["id"] == "chatcmpl-lifecycle")
    check("idempotency_response correct content", resp["choices"][0]["message"]["content"] == "done")

    # 3d: idempotency_response with None
    check("idempotency_response(None) → None", api.idempotency_response(None) is None)

    # 3e: idempotency_response with record without response
    api.IDEMPOTENCY.clear()
    rec2, _, _ = api.claim_idempotency("no-resp-key", "fp-b")
    check("idempotency_response without response → None", api.idempotency_response(rec2) is None)

    # 3f: Fail (non-terminal) → status stays "processing"
    api.IDEMPOTENCY.clear()
    rec3, _, _ = api.claim_idempotency("fail-key", "fp-c")
    api.fail_idempotency("fail-key", "temporary error", terminal=False)
    check("fail non-terminal: status stays processing", rec3["status"] == "processing")
    check("fail non-terminal: error stored", rec3["error"] == "temporary error")
    check("fail non-terminal: event NOT set", not rec3["event"].is_set())

    # 3g: Fail (terminal) → status failed, event set
    api.IDEMPOTENCY.clear()
    rec4, _, _ = api.claim_idempotency("fail-terminal-key", "fp-d")
    api.fail_idempotency("fail-terminal-key", "fatal error", terminal=True)
    check("fail terminal: status=failed", rec4["status"] == "failed")
    check("fail terminal: event is_set", rec4["event"].is_set())

    # 3h: fail_idempotency with empty key → no-op
    api.fail_idempotency("", "should not matter", terminal=True)
    check("fail_idempotency with empty key: no-op", True)

    # 3i: complete_idempotency with empty key → no-op
    api.complete_idempotency("", {"test": True})
    check("complete_idempotency with empty key: no-op", True)

    # 3j: request_fingerprint determinism
    fp1 = api.request_fingerprint("m1", [{"role": "user", "content": "hi"}], {})
    fp2 = api.request_fingerprint("m1", [{"role": "user", "content": "hi"}], {})
    check("request_fingerprint deterministic", fp1 == fp2)

    # 3k: request_fingerprint different for different models
    fp3 = api.request_fingerprint("m2", [{"role": "user", "content": "hi"}], {})
    check("request_fingerprint varies with model", fp1 != fp3)

    # 3l: request_fingerprint different for different messages
    fp4 = api.request_fingerprint("m1", [{"role": "user", "content": "bye"}], {})
    check("request_fingerprint varies with content", fp1 != fp4)

    # 3m: request_fingerprint different for different request_meta
    fp5 = api.request_fingerprint("m1", [{"role": "user", "content": "hi"}], {"temperature": 0.7})
    check("request_fingerprint varies with request_meta", fp1 != fp5)

    # 3n: Stale TTL cleanup on claim
    api.IDEMPOTENCY.clear()
    api.IDEMPOTENCY["old-record"] = {
        "fingerprint": "old", "status": "processing", "created_at": 0,
        "updated_at": 0, "event": threading.Event(), "response": None,
    }
    rec_new, owner_new, conflict_new = api.claim_idempotency("new-key", "fp-new")
    check("stale record cleaned on claim", "old-record" not in api.IDEMPOTENCY)
    check("new claim succeeds after stale cleanup", owner_new is True)

    # 3o: IDEMPOTENCY_TTL set correctly
    check("IDEMPOTENCY_TTL is 24 hours", api.IDEMPOTENCY_TTL == 24 * 60 * 60)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. completed replay: replay non-stream and stream paths
# ═══════════════════════════════════════════════════════════════════════════════
def probe_completed_replay():
    print("\n=== 4. Completed Replay ===")

    api.IDEMPOTENCY.clear()

    # 4a: Completed record replay returns same response
    rec, _, _ = api.claim_idempotency("replay-1", "fp-1")
    response = {
        "id": "chatcmpl-replay-1",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "replayed content"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }
    api.complete_idempotency("replay-1", response)

    # Replay claim
    rec2, owner2, conflict2 = api.claim_idempotency("replay-1", "fp-1")
    check("completed replay: not owner", owner2 is False)
    check("completed replay: no conflict", conflict2 is False)

    replayed = api.idempotency_response(rec2)
    check("completed replay: id matches", replayed["id"] == "chatcmpl-replay-1")
    check("completed replay: content matches", replayed["choices"][0]["message"]["content"] == "replayed content")
    check("completed replay: usage matches", replayed["usage"]["total_tokens"] == 15)

    # 4b: Multiple replays return same response (before clearing)
    rec_multi, _, _ = api.claim_idempotency("replay-1", "fp-1")
    check("3rd replay: still same id", api.idempotency_response(rec_multi)["id"] == "chatcmpl-replay-1")

    # 4c: Completed replay with tool calls (fresh key)
    rec3, _, _ = api.claim_idempotency("replay-tool", "fp-tool")
    tool_response = {
        "id": "chatcmpl-replay-tool",
        "choices": [{"message": api.openai_assistant_message(
            {"tool_call": {"tool": "search", "parameters": {"q": "test"}}}
        ), "finish_reason": "tool_calls"}],
    }
    api.complete_idempotency("replay-tool", tool_response)

    rec4, _, _ = api.claim_idempotency("replay-tool", "fp-tool")
    replayed_tool = api.idempotency_response(rec4)
    check("completed replay tool: tool_calls present",
          replayed_tool["choices"][0]["message"].get("tool_calls") is not None)
    check("completed replay tool: content is None",
          replayed_tool["choices"][0]["message"]["content"] is None)

    # 4d: Completed replay with stream flag (fresh key)
    rec5, _, _ = api.claim_idempotency("replay-stream", "fp-stream")
    rec5["stream"] = True
    response_stream = {"id": "chatcmpl-replay-stream", "choices": [{"message": {"content": "stream content"}}]}
    api.complete_idempotency("replay-stream", response_stream)

    rec6, _, _ = api.claim_idempotency("replay-stream", "fp-stream")
    check("completed replay stream: stream flag preserved", rec6.get("stream") is True)

    # 4e: Completed record event is set
    check("completed event is_set after completion", rec["event"].is_set())

    # 4f: openai_stream_chunks for replay response
    base = {"id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1, "model": "m"}
    chunks = api.openai_stream_chunks(replayed, base)
    check("replay stream chunks: 3 chunks", len(chunks) == 3)
    check("replay stream chunks: role delta", chunks[0]["choices"][0]["delta"]["role"] == "assistant")
    content_chunk = chunks[1]
    check("replay stream chunks: content present",
          content_chunk["choices"][0]["delta"]["content"] == "replayed content")
    check("replay stream chunks: finish_reason=stop",
          chunks[2]["choices"][0]["finish_reason"] == "stop")


# ═══════════════════════════════════════════════════════════════════════════════
# 5. processing wait: Event.wait(), processing status, timeout
# ═══════════════════════════════════════════════════════════════════════════════
def probe_processing_wait():
    print("\n=== 5. Processing Wait ===")

    api.IDEMPOTENCY.clear()
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear(); api.BROWSER_DELTAS.clear()

    # 5a: Processing record keeps status=processing
    rec, owner, conflict = api.claim_idempotency("processing-key", "fp-wait")
    check("processing: initial status=processing", rec["status"] == "processing")
    check("processing: event not set initially", not rec["event"].is_set())

    # 5b: Event.wait with timeout on unset event
    start = time.time()
    result = rec["event"].wait(timeout=0.1)
    elapsed = time.time() - start
    check("processing: event.wait(0.1) returns False (timed out)", result is False)
    check("processing: event.wait took at least 0.09s", elapsed >= 0.09)

    # 5c: Processing → completed during wait wakes waiter
    api.IDEMPOTENCY.clear()
    rec2, _, _ = api.claim_idempotency("wake-key", "fp-wake")

    # Simulate async completion in another "thread"
    completed = [False]
    def completer():
        time.sleep(0.1)
        api.complete_idempotency("wake-key", {"id": "wake-test", "choices": [{"message": {"content": "woke"}}]})
        completed[0] = True

    t = threading.Thread(target=completer)
    t.start()
    result = rec2["event"].wait(timeout=2.0)
    t.join()
    check("processing: event.set wakes waiter", result is True)
    check("processing: waiter sees completed status", rec2["status"] == "completed")
    check("processing: completed by other thread", completed[0] is True)

    # 5d: Processing record with job_id
    rec2["job_id"] = "job-processing-test"
    check("processing: job_id stored", rec2["job_id"] == "job-processing-test")

    # 5e: Non-owner replay of processing: can check status
    rec3, owner3, conflict3 = api.claim_idempotency("wake-key", "fp-wake")
    check("processing replay: status=completed (after completion)", rec3["status"] == "completed")
    check("processing replay: response available", api.idempotency_response(rec3)["id"] == "wake-test")

    # 5f: Processing with no event (edge case - should not happen normally)
    api.IDEMPOTENCY.clear()
    rec4, _, _ = api.claim_idempotency("no-event-key", "fp-noev")
    check("processing: event exists", rec4.get("event") is not None)

    # 5g: Multiple waiters on same event: both wake on set
    api.IDEMPOTENCY.clear()
    rec5, _, _ = api.claim_idempotency("multi-wait-key", "fp-mw")
    results = []

    def waiter(idx):
        w = rec5["event"].wait(timeout=2.0)
        results.append((idx, w))

    threads = [threading.Thread(target=waiter, args=(i,)) for i in range(3)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    api.complete_idempotency("multi-wait-key", {"id": "multi-wait", "choices": [{"message": {"content": "all"}}]})
    for t in threads:
        t.join()
    check("multi-waiter: all 3 woke up", all(woke for _, woke in results))
    check("multi-waiter: all 3 results True", len(results) == 3)

    # 5h: TTL-based stale cleanup
    api.IDEMPOTENCY.clear()
    rec_stale = {
        "key": "stale-wait", "fingerprint": "fp-stale", "status": "processing",
        "job_id": None, "event": threading.Event(), "response": None,
        "created_at": 0, "updated_at": 0,
    }
    api.IDEMPOTENCY["stale-wait"] = rec_stale
    # Trigger cleanup via claim
    rec_new, owner_new, conflict_new = api.claim_idempotency("fresh-wait-key", "fp-fresh")
    check("stale processing record reclaimed", "stale-wait" not in api.IDEMPOTENCY)
    check("fresh claim succeeds after stale cleanup", owner_new is True)

    # 5i: BROWSER_EVENTS lifecycle for job
    job = api.new_browser_job("test", domain="wait.com", model="m")
    ev = api.BROWSER_EVENTS.get(job["id"])
    check("BROWSER_EVENTS created for new job", ev is not None)
    check("BROWSER_EVENTS not set initially", not ev.is_set())

    # Simulate completion
    job["status"] = "claimed"
    job["tab_id"] = 1
    api.finish_browser_job(job["id"], "completed", result={"assistant": "ok"})
    check("BROWSER_EVENTS set after completion", ev.is_set())
    check("BROWSER_EVENTS removed after finish", job["id"] not in api.BROWSER_EVENTS)

    # 5j: Event wait with actual timeout (should not hang)
    api.BROWSER_EVENTS.clear()
    job2 = api.new_browser_job("test2", domain="wait.com", model="m")
    ev2 = api.BROWSER_EVENTS[job2["id"]]
    start = time.time()
    result = ev2.wait(timeout=0.5)
    elapsed = time.time() - start
    check("job event wait timeout returns False", result is False)
    check("job event wait respects timeout", elapsed < 1.0)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. CROSS-CUTTING: conversation_id ↔ binding ↔ claim integration
# ═══════════════════════════════════════════════════════════════════════════════
def probe_cross_cutting():
    print("\n=== 6. Cross-Cutting (conversation_id × binding × claim) ===")

    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()

    # 6a: Binding created on claim, same conversation reused
    job = api.new_browser_job("test", domain="cross.com", model="m", conversation_id="cross-conv")
    api.BROWSER_CLIENTS["10"] = {"tab_id": 10, "domain": "cross.com", "capabilities": {
        "can_observe": True, "can_execute": True,
    }, "last_seen": time.time()}
    claimed = api.claim_browser_job("cross.com", 10, conversation_id="cross-conv")
    check("cross: claim succeeds", claimed is not None)

    binding = api.conversation_binding("cross-conv", "cross.com")
    check("cross: binding created", binding is not None)
    check("cross: binding tab matches", binding["tab_id"] == 10)
    check("cross: binding conversation matches", binding["conversation_id"] == "cross-conv")

    # 6b: Second job with same conversation_id → blocked while first is still claimed
    # (One tab can only supervise one live conversation at a time)
    job2 = api.new_browser_job("test2", domain="cross.com", model="m", conversation_id="cross-conv")
    claimed2 = api.claim_browser_job("cross.com", 10, conversation_id="cross-conv")
    check("cross: second concurrent claim blocked (one tab/one live conv)", claimed2 is None)

    # 6b2: After first job completed, same tab can claim next job for same conversation
    api.finish_browser_job(job["id"], "completed", result={"assistant": "done"})
    claimed2b = api.claim_browser_job("cross.com", 10, conversation_id="cross-conv")
    check("cross: after first done, same tab claims next job for same conv", claimed2b is not None)

    # 6c: Different tab with same conversation_id → rejected by binding
    job3 = api.new_browser_job("test3", domain="cross.com", model="m", conversation_id="cross-conv")
    api.BROWSER_CLIENTS["20"] = {"tab_id": 20, "domain": "cross.com", "capabilities": {
        "can_observe": True, "can_execute": True,
    }, "last_seen": time.time()}
    claimed3 = api.claim_browser_job("cross.com", 20, conversation_id="cross-conv")
    check("cross: different tab with same conv_id rejected", claimed3 is None)

    # 6d: Stale binding cleaned, new tab can claim
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_BINDINGS.clear()
    api.BROWSER_BINDINGS[("cross-conv", "cross.com")] = {
        "conversation_id": "cross-conv", "domain": "cross.com", "tab_id": 10,
        "last_seen": 0,  # stale
    }
    job4 = api.new_browser_job("test4", domain="cross.com", model="m", conversation_id="cross-conv")
    claimed4 = api.claim_browser_job("cross.com", 20, conversation_id="cross-conv")
    check("cross: stale binding cleaned, new claim succeeds", claimed4 is not None)

    # Verify old stale binding removed
    check("cross: stale binding removed after claim",
          api.BROWSER_BINDINGS.get(("cross-conv", "cross.com"), {}).get("tab_id") == 20)

    # 6e: One tab can only claim one job at a time
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()
    job_a = api.new_browser_job("A", domain="cross.com", model="m", conversation_id="conv-a")
    job_b = api.new_browser_job("B", domain="cross.com", model="m", conversation_id="conv-b")
    api.BROWSER_CLIENTS["30"] = {"tab_id": 30, "domain": "cross.com", "capabilities": {
        "can_observe": True, "can_execute": True,
    }, "last_seen": time.time()}
    claimed_a = api.claim_browser_job("cross.com", 30, conversation_id="conv-a")
    check("cross: tab 30 claims job A", claimed_a is not None)

    # Tab 30 tries to claim job B (should be rejected: one tab, one conversation)
    claimed_b = api.claim_browser_job("cross.com", 30, conversation_id="conv-b")
    check("cross: tab 30 cannot claim second job B while A is claimed", claimed_b is None)

    # 6f: After job A completed, tab 30 can claim job B
    api.finish_browser_job(job_a["id"], "completed", result={"assistant": "done"})
    claimed_b2 = api.claim_browser_job("cross.com", 30, conversation_id="conv-b")
    check("cross: tab 30 can claim job B after A is done", claimed_b2 is not None)


# ═══════════════════════════════════════════════════════════════════════════════
def main():
    print("Audit #4: Multi-turn + Idempotency + Replay + Processing Wait")
    print("=" * 60)

    probe_multiturn()
    probe_retry()
    probe_idempotency()
    probe_completed_replay()
    probe_processing_wait()
    probe_cross_cutting()

    print("\n" + "=" * 60)
    total = PASS + FAIL
    print(f"Results: {PASS}/{total} passed")
    if FAIL > 0:
        print(f"FAILURES: {FAIL}")
        sys.exit(1)
    else:
        print("ALL AUDIT #4 PROBES PASSED ✅")
        sys.exit(0)

if __name__ == "__main__":
    main()
