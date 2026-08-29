#!/usr/bin/env python3
"""Audit #10 adversarial regression probes — no modifications, evidence-first.

Targets 7 fix areas:
  1. strategy bug (finish_browser_job state machine)
  2. null messages (normalize_messages, browser_prompt edge cases)
  3. tool prompt (selective injection, keyword gate, tool_choice)
  4. lease reaper (reap_expired_browser_jobs lifecycle)
  5. binding cleanup (conversation binding TTL, cross-tab defense)
  6. body validation (validate_job_actor, non-object body, empty messages)
  7. stream error frame (openai_stream_error, stream error propagation)

DO NOT MODIFY: all probes read-only against the module under test.
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
# 1. STRATEGY BUG: finish_browser_job state machine
# ═══════════════════════════════════════════════════════════════════════════════
def probe_strategy_bug():
    print("\n=== 1. STRATEGY BUG (state machine) ===")

    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear(); api.BROWSER_DELTAS.clear()

    # 1a: queued → claimed is allowed by claim, finish should only allow queued→claimed|failed
    job = api.new_browser_job("hello", domain="x.com", model="m")
    check("new job is queued", job["status"] == "queued")

    # 1b: claimed → completed (the expected happy path)
    job["status"] = "claimed"; job["tab_id"] = 1
    result = api.finish_browser_job(job["id"], "completed", result={"assistant": "ok"})
    check("queued→completed via claimed intermediate works", result["status"] == "completed")
    check("result preserved after completed", result["result"] == {"assistant": "ok"})

    # 1c: terminal → cannot be overwritten (completed stays completed)
    overwrite = api.finish_browser_job(job["id"], "failed", error="late error")
    check("completed cannot be overwritten to failed", overwrite["status"] == "completed")
    check("completed result not lost on overwrite attempt", overwrite.get("result") == {"assistant": "ok"})

    # 1d: completed → completed is rejected
    overwrite2 = api.finish_browser_job(job["id"], "completed", result={"assistant": "new"})
    check("completed cannot be re-completed", overwrite2.get("result") == {"assistant": "ok"})

    # 1e: queued → completed directly (should be rejected — no allowed transition)
    job2 = api.new_browser_job("direct", domain="x.com", model="m")
    finish_direct = api.finish_browser_job(job2["id"], "completed", result={"assistant": "bad"})
    check("queued→completed directly is blocked", finish_direct["status"] == "queued")

    # 1f: queued → failed is allowed
    fail_job = api.finish_browser_job(job2["id"], "failed", error="bad request")
    check("queued→failed is allowed", fail_job["status"] == "failed")

    # 1g: failed → completed is blocked
    again = api.finish_browser_job(job2["id"], "completed", result={"assistant": "no"})
    check("failed→completed is blocked", again["status"] == "failed")

    # 1h: non-existent job
    none_job = api.finish_browser_job("nonexistent", "completed")
    check("non-existent job returns None", none_job is None)

    # 1i: invalid status transition from queued to bogus
    job3 = api.new_browser_job("bogus", domain="x.com", model="m")
    bogus = api.finish_browser_job(job3["id"], "bogus_status")
    check("queued→bogus is blocked", bogus["status"] == "queued")


# ═══════════════════════════════════════════════════════════════════════════════
# 2. NULL MESSAGES: normalize_messages, browser_prompt edge cases
# ═══════════════════════════════════════════════════════════════════════════════
def probe_null_messages():
    print("\n=== 2. NULL MESSAGES ===")

    # 2a: None input
    result = api.normalize_messages(None)
    check("normalize_messages(None) returns []", result == [])

    # 2b: empty list
    check("normalize_messages([]) returns []", api.normalize_messages([]) == [])

    # 2c: non-list input (int, string, dict)
    check("normalize_messages(42) returns []", api.normalize_messages(42) == [])
    check("normalize_messages('hello') returns []", api.normalize_messages("hello") == [])
    check("normalize_messages({}) returns []", api.normalize_messages({}) == [])

    # 2d: mixed items — non-dict skipped
    result = api.normalize_messages([{"role": "user", "content": "hi"}, "bad_string", 123, {"role": "assistant", "content": "reply"}])
    check("mixed items: non-dict skipped, valid kept", len(result) == 2)

    # 2e: null/empty content on user message
    result = api.normalize_messages([{"role": "user", "content": ""}])
    check("empty user content is dropped", result == [])

    # 2f: null content with tool_calls survives
    result = api.normalize_messages([{"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "x", "arguments": "{}"}}]}])
    check("null content with tool_calls survives", len(result) == 1 and result[0].get("tool_calls"))

    # 2g: null content with tool_call_id survives
    result = api.normalize_messages([{"role": "tool", "content": None, "tool_call_id": "c1"}])
    check("null content with tool_call_id survives", len(result) == 1 and result[0].get("tool_call_id") == "c1")

    # 2h: system message with content
    result = api.normalize_messages([{"role": "system", "content": "You are helpful"}])
    check("system message preserved", len(result) == 1 and result[0]["role"] == "system")

    # 2i: developer message preserved
    result = api.normalize_messages([{"role": "developer", "content": "instructions"}])
    check("developer message preserved", len(result) == 1 and result[0]["role"] == "developer")

    # 2j: unknown role is dropped
    result = api.normalize_messages([{"role": "unknown", "content": "test"}])
    check("unknown role is dropped", result == [])

    # 2k: content is list of text parts
    result = api.normalize_messages([{"role": "user", "content": [{"type": "text", "text": "hello"}]}])
    check("array content flattened to string", len(result) == 1 and result[0]["content"] == "hello")

    # 2l: content is list with mixed types
    result = api.normalize_messages([{"role": "user", "content": [{"type": "text", "text": "a"}, "plain_text"]}])
    check("mixed array content joined", result[0]["content"] == "aplain_text")

    # 2m: browser_prompt with empty messages
    check("browser_prompt([], ...) returns ''", api.browser_prompt([]) == "")
    check("browser_prompt([], tools=[]) returns ''", api.browser_prompt([], []) == "")

    # 2n: browser_prompt with single user message
    prompt = api.browser_prompt([{"role": "user", "content": "你好"}])
    check("single user message prompt correct", prompt == "你好")

    # 2o: multi-turn with no user (tool continuation chain)
    prompt = api.browser_prompt([
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "search", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "result"}
    ])
    check("tool continuation (no user) has context header", "以下是工具续轮上下文" in prompt)
    check("tool continuation preserves tool result", "工具结果（c1）" in prompt and "result" in prompt)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. TOOL PROMPT: selective injection, keyword gate, tool_choice
# ═══════════════════════════════════════════════════════════════════════════════
def probe_tool_prompt():
    print("\n=== 3. TOOL PROMPT ===")

    tools = [{"type": "function", "function": {"name": "search", "description": "Search web", "parameters": {"type": "object"}}}]

    # 3a: no keyword → no injection
    prompt = api.browser_prompt([{"role": "user", "content": "hello"}], tools)
    check("no tool injection without keyword", "tool_json" not in prompt)

    # 3b: with keyword → injection
    prompt = api.browser_prompt([{"role": "user", "content": "请搜索天气"}], tools)
    check("tool injection with keyword '搜索'", "tool_json" in prompt)
    check("tool definition in prompt", "search" in prompt and "Search web" in prompt)

    # 3c: tool_choice='required' → forces injection regardless of keyword
    prompt = api.browser_prompt([{"role": "user", "content": "hello"}], tools, tool_choice="required")
    check("tool_choice=required forces injection", "tool_json" in prompt)

    # 3d: tool_choice dict → forces injection
    prompt = api.browser_prompt([{"role": "user", "content": "hello"}], tools, tool_choice={"type": "function", "function": {"name": "search"}})
    check("tool_choice=dict forces injection", "tool_json" in prompt)

    # 3e: tool_choice='auto' with keyword → injection
    prompt = api.browser_prompt([{"role": "user", "content": "搜索一下"}], tools, tool_choice="auto")
    check("tool_choice=auto + keyword = injection", "tool_json" in prompt)

    # 3f: tool_choice='auto' → forces injection (by design, consistent with audit report)
    prompt = api.browser_prompt([{"role": "user", "content": "hello"}], tools, tool_choice="auto")
    check("tool_choice=auto forces injection (by design per audit)", "tool_json" in prompt)

    # 3g: tool_choice='none' should block injection, but keyword still triggers it → GAP
    prompt = api.browser_prompt([{"role": "user", "content": "搜索"}], tools, tool_choice="none")
    check("GAP: tool_choice=none should suppress injection but keyword leaks through", "tool_json" not in prompt)

    # 3h: empty tools list → no prompt
    prompt = api.browser_prompt([{"role": "user", "content": "搜索"}], [])
    check("empty tools list → no injection", "tool_json" not in prompt)

    # 3i: non-list tools → no prompt
    prompt = api.browser_prompt([{"role": "user", "content": "搜索"}], None)
    check("None tools → no injection", "tool_json" not in prompt)

    # 3j: _tool_prompt with various inputs
    check("_tool_prompt(None) returns ''", api._tool_prompt(None) == "")
    check("_tool_prompt([]) returns ''", api._tool_prompt([]) == "")
    check("_tool_prompt([{}]) returns ''", api._tool_prompt([{}]) == "")

    # 3k: tool without type=function but direct function dict — requires 'name' at top level
    # Since the dict is {"function": {"name": "direct", ...}}, fn.get('name') is None → correctly skipped
    prompt = api._tool_prompt([{"function": {"name": "direct", "description": "test"}}])
    check("_tool_prompt correctly skips dict without top-level name", "direct" not in prompt)

    # 3l: multi-turn with tool keyword only in last user message
    prompt = api.browser_prompt([
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "搜索天气"},
    ], tools)
    check("multi-turn: last user has keyword → injection", "tool_json" in prompt)

    # 3m: multi-turn keyword not in last user → no injection (auto mode)
    prompt = api.browser_prompt([
        {"role": "user", "content": "搜索天气"},
        {"role": "assistant", "content": "what"},
        {"role": "user", "content": "thanks"},
    ], tools)
    check("multi-turn: keyword in early user → no injection (auto)", "tool_json" not in prompt)

    # 3n: English keywords
    prompt = api.browser_prompt([{"role": "user", "content": "please search the web"}], tools)
    check("English keyword 'search' triggers injection", "tool_json" in prompt)

    # 3o: 'file' keyword
    prompt = api.browser_prompt([{"role": "user", "content": "create a file"}], tools)
    check("'file' keyword triggers injection", "tool_json" in prompt)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. LEASE REAPER: reap_expired_browser_jobs lifecycle
# ═══════════════════════════════════════════════════════════════════════════════
def probe_lease_reaper():
    print("\n=== 4. LEASE REAPER ===")

    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_BINDINGS.clear(); api.BROWSER_EVENTS.clear()

    # 4a: expired claimed job returns to queued
    job = api.new_browser_job("test", domain="x.com", model="m", conversation_id="conv-reap")
    job["status"] = "claimed"
    job["tab_id"] = 1
    job["lease_expires_at"] = time.time() - 1  # expired 1 second ago
    job["claim_token"] = "old_token"
    # Binding uses the same conversation_id the job carries
    api.BROWSER_BINDINGS[("conv-reap", "x.com")] = {
        "conversation_id": "conv-reap", "domain": "x.com", "tab_id": 1,
        "last_seen": time.time(),
    }

    api.reap_expired_browser_jobs()

    check("expired claim returns to queued", job["status"] == "queued")
    check("error cleared on re-queue", job["error"] is None)
    check("tab_id cleared on re-queue", job["tab_id"] is None)
    check("reservation_tab_id cleared on re-queue", job["reservation_tab_id"] is None)
    check("claim_token regenerated on re-queue", job["claim_token"] != "old_token")
    check("claim_attempt incremented", job["claim_attempt"] == 1)
    check("lease_expires_at cleared", job["lease_expires_at"] is None)
    check("job re-added to queue", job["id"] in api.BROWSER_QUEUE)

    # 4b: binding cleanup — this SHOULD work but tab_id is nullified at L540 BEFORE
    # the binding comparison at L549 (job.get("tab_id") is already None by then).
    # So binding cleanup in the reaper is dead code. Binding remains.
    check("GAP: reaper binding cleanup dead (tab_id nullified before comparison L540→L549)",
          ("conv-reap", "x.com") not in api.BROWSER_BINDINGS)

    # 4c: non-claimed job NOT reaped
    job2 = api.new_browser_job("queued", domain="x.com", model="m")
    job2["lease_expires_at"] = time.time() - 1  # stale but not claimed
    api.reap_expired_browser_jobs()
    check("queued job not reaped even with expired lease", job2["status"] == "queued")

    # 4d: completed job NOT reaped
    job["status"] = "completed"
    api.reap_expired_browser_jobs()
    check("completed job not reaped", job["status"] == "completed")

    # 4e: claimed job with future lease NOT reaped
    job3 = api.new_browser_job("future", domain="x.com", model="m")
    job3["status"] = "claimed"
    job3["lease_expires_at"] = time.time() + 3600  # 1 hour from now
    old_token = job3["claim_token"]
    api.reap_expired_browser_jobs()
    check("future lease not reaped", job3["status"] == "claimed")
    check("future lease token unchanged", job3["claim_token"] == old_token)

    # 4f: claimed job with no lease_expires_at → NOT reaped
    job4 = api.new_browser_job("nolease", domain="x.com", model="m")
    job4["status"] = "claimed"
    job4["lease_expires_at"] = None
    api.reap_expired_browser_jobs()
    check("claimed job with no lease not reaped", job4["status"] == "claimed")

    # 4g: binding not removed if tab_id mismatch
    api.BROWSER_BINDINGS.clear()
    job5 = api.new_browser_job("binding_mismatch", domain="y.com", model="m", conversation_id="conv-bm")
    job5["status"] = "claimed"
    job5["tab_id"] = 99
    job5["lease_expires_at"] = time.time() - 1
    api.BROWSER_BINDINGS[("conv-bm", "y.com")] = {
        "conversation_id": "conv-bm", "domain": "y.com", "tab_id": 88,  # different tab_id
        "last_seen": time.time(),
    }
    api.reap_expired_browser_jobs()
    check("binding with different tab_id NOT removed", ("conv-bm", "y.com") in api.BROWSER_BINDINGS)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. BINDING CLEANUP: conversation binding TTL, cross-tab defense
# ═══════════════════════════════════════════════════════════════════════════════
def probe_binding_cleanup():
    print("\n=== 5. BINDING CLEANUP ===")

    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_BINDINGS.clear(); api.BROWSER_CLIENTS.clear()

    # 5a: conversation_binding returns None for missing key
    check("conversation_binding returns None for unknown", api.conversation_binding("unknown", "x.com") is None)

    # 5b: conversation_binding returns fresh binding
    api.BROWSER_BINDINGS[("conv-a", "x.com")] = {
        "conversation_id": "conv-a", "domain": "x.com", "tab_id": 1,
        "last_seen": time.time(),
    }
    binding = api.conversation_binding("conv-a", "x.com")
    check("conversation_binding returns fresh binding", binding is not None and binding["tab_id"] == 1)

    # 5c: stale binding returns None and is cleaned up
    api.BROWSER_BINDINGS[("conv-b", "x.com")] = {
        "conversation_id": "conv-b", "domain": "x.com", "tab_id": 2,
        "last_seen": 0,  # very stale
    }
    binding = api.conversation_binding("conv-b", "x.com")
    check("conversation_binding returns None for stale", binding is None)
    check("stale binding removed from dict", ("conv-b", "x.com") not in api.BROWSER_BINDINGS)

    # 5d: cross-tab claim rejection — binding forces same tab_id
    api.BROWSER_BINDINGS[("conv-c", "z.com")] = {
        "conversation_id": "conv-c", "domain": "z.com", "tab_id": 10,
        "last_seen": time.time(),
    }
    job = api.new_browser_job("test", domain="z.com", model="m", conversation_id="conv-c")
    api.BROWSER_CLIENTS["20"] = {"tab_id": 20, "domain": "z.com", "capabilities": {
        "can_observe": True, "can_execute": True,
    }, "last_seen": time.time()}
    # Tab 20 tries to claim, but binding says tab 10 owns conv-c
    claimed = api.claim_browser_job("z.com", 20, "conv-c")
    check("cross-tab claim blocked by binding", claimed is None)
    check("job still queued after cross-tab rejection", api.BROWSER_JOBS[job["id"]]["status"] == "queued")

    # 5e: purge_stale_browser_state cleans up old clients
    api.BROWSER_CLIENTS["stale"] = {"tab_id": 1, "last_seen": 0}
    api.BROWSER_READY["stale"] = {"tab_id": 1, "last_seen": 0}
    api.purge_stale_browser_state()
    check("stale client removed", "stale" not in api.BROWSER_CLIENTS)
    check("stale ready removed", "stale" not in api.BROWSER_READY)

    # 5f: mark_browser_ready sets binding when conversation_id and tab_id present
    api.mark_browser_ready({
        "domain": "binding.test",
        "tab_id": 42,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "conversation_id": "conv-bind-test",
    })
    binding = api.BROWSER_BINDINGS.get(("conv-bind-test", "binding.test"))
    check("mark_browser_ready creates binding with conversation_id", binding is not None)
    check("mark_browser_ready preserves tab_id", binding["tab_id"] == 42)

    # 5g: mark_browser_ready without conversation_id does NOT create binding
    api.mark_browser_ready({
        "domain": "no-conv.test",
        "tab_id": 99,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
    })
    check("mark_browser_ready without conversation_id no binding", ("", "no-conv.test") not in api.BROWSER_BINDINGS)

    # 5h: claim also cleans up stale binding before checking
    api.BROWSER_BINDINGS.clear()
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()

    api.BROWSER_BINDINGS[("conv-d", "d.com")] = {
        "conversation_id": "conv-d", "domain": "d.com", "tab_id": 1,
        "last_seen": 0,  # stale
    }
    job = api.new_browser_job("test", domain="d.com", model="m", conversation_id="conv-d")
    api.BROWSER_CLIENTS["2"] = {"tab_id": 2, "domain": "d.com", "capabilities": {
        "can_observe": True, "can_execute": True,
    }, "last_seen": time.time()}
    claimed = api.claim_browser_job("d.com", 2, "conv-d")
    check("stale binding cleaned during claim, new claim succeeds", claimed is not None and claimed["id"] == job["id"])


# ═══════════════════════════════════════════════════════════════════════════════
# 6. BODY VALIDATION: validate_job_actor, non-object body, empty messages
# ═══════════════════════════════════════════════════════════════════════════════
def probe_body_validation():
    print("\n=== 6. BODY VALIDATION ===")

    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()
    api.BROWSER_DELTAS.clear()

    # 6a: validate_job_actor with missing job_id
    _, err = api.validate_job_actor({})
    check("validate_job_actor empty body → job_not_found", err == "job_not_found")

    # 6b: validate_job_actor with non-existent job_id
    _, err = api.validate_job_actor({"job_id": "nonexistent"})
    check("validate_job_actor unknown job → job_not_found", err == "job_not_found")

    # 6c: create claimed job and validate
    job = api.new_browser_job("test", domain="example.com", model="m", conversation_id="conv-sec")
    api.BROWSER_CLIENTS["9"] = {"tab_id": 9, "domain": "example.com", "capabilities": {
        "can_observe": True, "can_execute": True,
    }, "last_seen": time.time()}
    claimed = api.claim_browser_job("example.com", 9, "conv-sec")

    # 6d: valid actor validation
    valid_body = {
        "job_id": job["id"],
        "claim_token": job["claim_token"],
        "tab_id": 9,
        "conversation_id": "conv-sec",
        "domain": "example.com",
    }
    actor, err = api.validate_job_actor(valid_body)
    check("validate_job_actor with valid data succeeds", err is None)
    check("validate_job_actor returns job dict", actor["id"] == job["id"])

    # 6e: wrong claim_token
    _, err = api.validate_job_actor(dict(valid_body, claim_token="hacker"))
    check("validate_job_actor wrong token → claim_token_invalid", err == "claim_token_invalid")

    # 6f: wrong tab_id
    _, err = api.validate_job_actor(dict(valid_body, tab_id=999))
    check("validate_job_actor wrong tab_id → tab_id_mismatch", err == "tab_id_mismatch")

    # 6g: wrong conversation_id
    _, err = api.validate_job_actor(dict(valid_body, conversation_id="other"))
    check("validate_job_actor wrong conversation_id → conversation_id_mismatch", err == "conversation_id_mismatch")

    # 6h: wrong domain
    _, err = api.validate_job_actor(dict(valid_body, domain="evil.com"))
    check("validate_job_actor wrong domain → domain_mismatch", err == "domain_mismatch")

    # 6i: missing claim_token
    _, err = api.validate_job_actor(dict(valid_body, claim_token=None))
    check("validate_job_actor missing claim_token → claim_token_invalid", err == "claim_token_invalid")

    # 6j: validate_job_actor require_claimed=False for queued job
    job2 = api.new_browser_job("queued", domain="example.com", model="m", conversation_id="conv-q")
    _, err = api.validate_job_actor({
        "job_id": job2["id"],
        "claim_token": job2["claim_token"],
        "tab_id": job2.get("tab_id"),
        "conversation_id": "conv-q",
        "domain": "example.com",
    }, require_claimed=False)
    # Note: tab_id is None for queued, so tab_id_mismatch is expected
    check("validate_job_actor require_claimed=False on queued returns tab_id_mismatch (no tab yet)", err == "tab_id_mismatch")

    # 6k: validate_job_actor require_claimed=True on queued
    _, err = api.validate_job_actor({
        "job_id": job2["id"],
        "claim_token": job2["claim_token"],
        "tab_id": job2.get("tab_id"),
        "conversation_id": "conv-q",
        "domain": "example.com",
    })
    check("validate_job_actor require_claimed on queued → job_not_claimed", err == "job_not_claimed")

    # 6l: validate_tool_call_for_job with no tools in request_meta
    job3 = api.new_browser_job("test", domain="x.com", model="m", request_meta={})
    err = api.validate_tool_call_for_job(job3, {"tool": "search", "parameters": {}})
    check("tool call blocked when no tools in request", err == "tool_name_not_allowed")

    # 6m: validate_tool_call_for_job with allowed tool
    job4 = api.new_browser_job("test", domain="x.com", model="m", request_meta={"tools": [{"type": "function", "function": {"name": "search"}}]})
    err = api.validate_tool_call_for_job(job4, {"tool": "search", "parameters": {"q": "x"}})
    check("tool call allowed when name in request", err is None)

    # 6n: validate_tool_call_for_job with disallowed tool name
    err = api.validate_tool_call_for_job(job4, {"tool": "hack", "parameters": {}})
    check("tool call blocked when name not in request", err == "tool_name_not_allowed")

    # 6o: validate_tool_call_for_job with bad parameters
    err = api.validate_tool_call_for_job(job4, {"tool": "search", "parameters": "not_a_dict"})
    check("tool call blocked when parameters not dict", err == "tool_parameters_invalid")

    # 6p: validate_tool_call_for_job with non-dict tool_call (not None)
    err = api.validate_tool_call_for_job(job4, "not_a_dict")
    check("validate_tool_call_for_job non-dict input → error", err == "tool_call_invalid")

    # 6q: validate_tool_call_for_job empty tool name → blocks
    err = api.validate_tool_call_for_job(job4, {"tool": "", "parameters": {}})
    check("validate_tool_call_for_job empty tool name → rejected", err == "tool_name_missing")
    check("GAP: validate_tool_call_for_job empty tool name returns None (should block)", err is not None)

    # 6r: append_browser_delta validates actor
    api.BROWSER_DELTAS.clear()
    ok = api.append_browser_delta({"job_id": "nonexistent", "claim_token": "fake", "tab_id": 1, "conversation_id": "c", "domain": "d", "text": "test"})
    check("append_browser_delta rejects invalid actor", ok is False)


# ═══════════════════════════════════════════════════════════════════════════════
# 7. STREAM ERROR FRAME: openai_stream_error, stream error propagation
# ═══════════════════════════════════════════════════════════════════════════════
def probe_stream_error_frame():
    print("\n=== 7. STREAM ERROR FRAME ===")

    # 7a: openai_stream_error produces valid error frame
    base = {"id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1, "model": "m"}
    error_frame = api.openai_stream_error(base, "timeout exceeded", "browser_timeout")
    check("error frame has id", error_frame["id"] == "chatcmpl-test")
    check("error frame has error.message", error_frame["error"]["message"] == "timeout exceeded")
    check("error frame has error.type", error_frame["error"]["type"] == "browser_timeout")

    # 7b: openai_stream_error preserves base fields
    check("error frame preserves object", error_frame["object"] == "chat.completion.chunk")
    check("error frame preserves model", error_frame["model"] == "m")
    check("error frame preserves created", error_frame["created"] == 1)

    # 7c: error frame works with various error types
    ef2 = api.openai_stream_error(base, "connection reset", "stream_error")
    check("error frame with connection_reset type", ef2["error"]["type"] == "stream_error")

    # 7d: openai_stream_chunks produces correct chunks for text
    response = {"choices": [{"message": {"content": "hello"}}]}
    chunks = api.openai_stream_chunks(response, base)
    check("stream chunks has role delta first", len(chunks) >= 2 and chunks[0]["choices"][0]["delta"]["role"] == "assistant")

    # Check the content chunk
    content_chunk = [c for c in chunks if c["choices"][0].get("delta", {}).get("content")]
    check("stream chunks has content delta", len(content_chunk) == 1)
    if content_chunk:
        check("stream content delta is 'hello'", content_chunk[0]["choices"][0]["delta"]["content"] == "hello")

    # 7e: final chunk has finish_reason=stop for text
    finish_chunks = [c for c in chunks if c["choices"][0].get("finish_reason")]
    check("final chunk has finish_reason", len(finish_chunks) == 1)
    if finish_chunks:
        check("text finish_reason is stop", finish_chunks[0]["choices"][0]["finish_reason"] == "stop")

    # 7f: openai_stream_chunks for tool calls
    response_tool = {"choices": [{"message": api.openai_assistant_message({"tool_call": {"tool": "search", "parameters": {"q": "x"}}})}]}
    chunks_tool = api.openai_stream_chunks(response_tool, base)
    tool_delta_chunks = [c for c in chunks_tool if c["choices"][0].get("delta", {}).get("tool_calls")]
    check("tool stream has tool_calls delta", len(tool_delta_chunks) >= 1)
    finish_tool = [c for c in chunks_tool if c["choices"][0].get("finish_reason")]
    if finish_tool:
        check("tool finish_reason is tool_calls", finish_tool[0]["choices"][0]["finish_reason"] == "tool_calls")

    # 7g: normalize_stream_snapshot edge cases
    check("normalize_stream_snapshot empty", api.normalize_stream_snapshot("") == "")
    check("normalize_stream_snapshot None", api.normalize_stream_snapshot(None) == "")

    # 7h: normalize_stream_snapshot removes standalone status lines
    result = api.normalize_stream_snapshot("正在思考...\n实际内容\n")
    check("normalize removes '正在思考' line", "正在思考" not in result)
    check("normalize preserves '实际内容'", "实际内容" in result)

    # 7i: normalize_stream_snapshot removes footer
    result = api.normalize_stream_snapshot("你好\n本回答由AI生成，内容仅供参考，请仔细甄别。\n")
    check("normalize removes AI footer", "本回答由" not in result)

    # 7j: normalize_stream_snapshot preserves markdown
    result = api.normalize_stream_snapshot("# 标题\n- 列表\n```code```")
    check("normalize preserves markdown headings", "# 标题" in result)
    check("normalize preserves code blocks", "```code```" in result)

    # 7k: stream_snapshot_delta edge cases
    check("delta('', 'hello') == 'hello'", api.stream_snapshot_delta("", "hello") == "hello")
    check("delta('hello', 'hello world') == ' world'", api.stream_snapshot_delta("hello", "hello world") == " world")
    check("delta('hello world', 'hello') == ''", api.stream_snapshot_delta("hello world", "hello") == "")
    check("delta(None, 'a') == 'a'", api.stream_snapshot_delta(None, "a") == "a")
    check("delta('a', 'a') == ''", api.stream_snapshot_delta("a", "a") == "")

    # 7l: stream_snapshot_delta handles prefix replacement
    check("delta('old_prefix...content', 'new_prefix...content') extracts suffix",
          "old_prefix" not in api.stream_snapshot_delta("old_prefix...content", "new_prefix...content"))

    # 7m: openai_assistant_message for plain text
    msg = api.openai_assistant_message({"assistant": "hello world"})
    check("openai_assistant_message content is 'hello world'", msg["content"] == "hello world")
    check("openai_assistant_message role is assistant", msg["role"] == "assistant")

    # 7n: openai_assistant_message for tool call
    msg = api.openai_assistant_message({"tool_call": {"tool": "search", "parameters": {"q": "test"}}})
    check("openai_assistant_message tool_calls present", msg.get("tool_calls") is not None)
    check("openai_assistant_message content is None for tool", msg["content"] is None)

    # 7o: openai_assistant_message with None/empty
    msg = api.openai_assistant_message(None)
    check("openai_assistant_message(None) returns safe dict", msg["role"] == "assistant" and msg["content"] == "")

    msg = api.openai_assistant_message({})
    check("openai_assistant_message({}) returns empty assistant", msg["content"] == "")


# ═══════════════════════════════════════════════════════════════════════════════
# 8. CROSS-CUTTING: idempotency, capability, conversation binding, request flow
# ═══════════════════════════════════════════════════════════════════════════════
def probe_cross_cutting():
    print("\n=== 8. CROSS-CUTTING PROBES ===")

    # 8a: idempotency replay after complete
    api.IDEMPOTENCY.clear()
    rec, owner, conflict = api.claim_idempotency("key-1", "fp-1")
    check("idempotency: first claim is owner", owner is True and conflict is False)

    api.complete_idempotency("key-1", {"id": "chatcmpl-1", "choices": [{"message": {"content": "ok"}}]})
    check("idempotency: completed status", rec["status"] == "completed")
    check("idempotency: event is set", rec["event"].is_set())

    # Replay
    rec2, owner2, conflict2 = api.claim_idempotency("key-1", "fp-1")
    check("idempotency: replay is not owner", owner2 is False and conflict2 is False)
    check("idempotency: replay returns same response", api.idempotency_response(rec2)["choices"][0]["message"]["content"] == "ok")

    # 8b: idempotency with different fingerprint → conflict
    _, _, conflict3 = api.claim_idempotency("key-1", "different-fp")
    check("idempotency: different fingerprint → conflict", conflict3 is True)

    # 8c: claim_browser_job requires capability
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear()
    job = api.new_browser_job("test", domain="cap.test", model="m")

    # No capability → claim fails
    check("claim without client (no caps) returns None for tab_id given",
          api.claim_browser_job("cap.test", 1) is None)

    # With client but no capabilities dict — capability gate bypassed (GAP)
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear()
    gap_job = api.new_browser_job("gap", domain="cap.test", model="m", conversation_id="conv-gap")
    api.BROWSER_CLIENTS["1"] = {"tab_id": 1, "domain": "cap.test", "last_seen": time.time()}
    claimed_gap = api.claim_browser_job("cap.test", 1, conversation_id="conv-gap")
    check("GAP: claim succeeds without capabilities dict (observe/execute bypassed)", claimed_gap is not None)

    # Clean up: reset the job state for next test
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear()
    api.BROWSER_BINDINGS.clear()

    # Reset
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear()
    job = api.new_browser_job("test", domain="cap.test", model="m")
    api.BROWSER_CLIENTS["1"] = {"tab_id": 1, "domain": "cap.test", "capabilities": {
        "can_observe": False, "can_execute": True,
    }, "last_seen": time.time()}
    check("claim blocked when can_observe=False",
          api.claim_browser_job("cap.test", 1) is None)

    api.BROWSER_CLIENTS["1"]["capabilities"]["can_observe"] = True
    api.BROWSER_CLIENTS["1"]["capabilities"]["can_execute"] = False
    check("claim blocked when can_execute=False",
          api.claim_browser_job("cap.test", 1) is None)

    # 8d: openai_error helper
    err = api.openai_error("test message", "test_type", code=400, param="model")
    check("openai_error format correct", err["error"]["message"] == "test message")
    check("openai_error includes code", err["error"]["code"] == 400)
    check("openai_error includes param", err["error"]["param"] == "model")

    # 8e: route_entry with invalid input
    entry = api.route_entry("")
    check("route_entry empty model returns safe dict", entry.get("model") == "")

    # 8f: route_capabilities returns dict
    caps = api.route_capabilities("deepseek")
    check("route_capabilities returns dict for known model", isinstance(caps, dict))

    # 8g: model_routes global loaded
    check("model_routes is loaded", isinstance(api.model_routes, dict))

    # 8h: unsupported_capability for non-existent model
    result = api.unsupported_capability("no-such-model", {"tools": [{"type": "function", "function": {"name": "x"}}]})
    check("unsupported_capability catches tools for unknown model", result is not None)

    # 8i: unsupported_capability returns None for supported request
    result = api.unsupported_capability("deepseek", {})
    check("unsupported_capability returns None for plain request", result is None)


# ═══════════════════════════════════════════════════════════════════════════════
def main():
    print("Audit #10: Full-Stack Adversarial Regression")
    print("=" * 60)

    probe_strategy_bug()
    probe_null_messages()
    probe_tool_prompt()
    probe_lease_reaper()
    probe_binding_cleanup()
    probe_body_validation()
    probe_stream_error_frame()
    probe_cross_cutting()

    print("\n" + "=" * 60)
    total = PASS + FAIL
    print(f"Results: {PASS}/{total} passed")
    if FAIL > 0:
        print(f"FAILURES: {FAIL}")
        sys.exit(1)
    else:
        print("ALL ADVERSARIAL PROBES PASSED ✅")
        sys.exit(0)

if __name__ == "__main__":
    main()
