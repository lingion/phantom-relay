# Phantom Relay Audit Synthesis Report
## All Bug Findings — 5 Audit Files Cross-Referenced Against Current Code

**Date**: 2026-07-30
**Source files audited**:
- `tests/audit_2_sse_streaming.py` (680 lines)
- `tests/audit_03_conversation_context.py` (701 lines)
- `tests/audit_04_multiturn_idempotency.py` (601 lines)
- `tests/audit_05_concurrency_queue_lease.py` (1035 lines)
- `tests/audit_10_adversarial.py` (734 lines)

**Current code**: `server/api_server.py` (1467 lines) + `server/protocol.py` (422 lines)

---

## EXECUTIVE SUMMARY

The codebase has undergone a **significant refactoring** since the audits were written. Key functions probed by the audits — `_format_prompt_message`, `browser_prompt`, `_tool_prompt` — no longer exist in the source. They've been replaced by protocol.py's `messages_to_text()` and `inject_tool_defs()`. This code change **silently fixed 3 bugs, left 2 bugs open, and introduced 1 behavioral regression**.

### Quick Tally
| Status | Count | Details |
|--------|-------|---------|
| **SILENTLY FIXED** | 3 | Python repr leak, binding cleanup dead code, claim_attempt limit |
| **STILL OPEN** | 2 | Capability gate bypass, tool_choice not respected |
| **OBSOLETE (code removed)** | 1 | tool_choice=none keyword leak |
| **INFO advisories** | 4 | Queue capacity, lease duration, Content-Length, HTTP concurrency |

---

## DETAILED FINDINGS BY COMPONENT

### A. CONVERSATION CONTEXT FORMATTING (audit_03)

#### A1. [_format_prompt_message array content Python repr leak_](audit_03 line 207) — **MEDIUM** — ✅ **SILENTLY FIXED**
- **Original bug**: `_format_prompt_message` used `str(item.get('content') or '')` on array content (e.g. `[{"type":"text","text":"hello"}]`), producing Python repr like `"[{'type': 'text', 'text': 'hello'}]"` instead of `"hello"`
- **Current status**: `_format_prompt_message` and `browser_prompt` **no longer exist**. Replaced by `protocol.py:messages_to_text()` which properly handles content via structured `Message` dataclass. The `chat_completions()` handler at api_server.py:1306-1309 explicitly flattens array content: `if isinstance(content, list): text_parts = [p.get('text', '') for p in content if p.get('type') == 'text']`
- **Verdict**: ✅ **FIXED by code removal/refactor**

#### A2. [browser_prompt no length truncation](audit_03 line 435) — **MEDIUM** — ⚠️ **OBSOLETE**
- The function no longer exists. The new `messages_to_text()` does not truncate either, but this is by design in the new architecture.
- **Verdict**: ⚠️ OBSOLETE (function removed; length concern transferred to new code path)

#### A3. [No Content-Length hard limit](audit_03 line 426) — **INFO** — ⚠️ **STILL PRESENT**
- HTTP body is read via Python `http.server` with no max_bytes guard. Large requests could consume unbounded memory.
- **Verdict**: ⚠️ STILL PRESENT (advisory)

---

### B. CONCURRENCY & QUEUE (audit_05)

#### B1. [reap_expired_browser_jobs binding cleanup dead code](audit_05 line 585; audit_10 line 284) — **HIGH** — ✅ **SILENTLY FIXED**
- **Original bug**: In the original code, L540 set `job["tab_id"] = None`, then L549 compared `binding.get("tab_id") == None` — since the binding still had the original tab_id (e.g., 777), the comparison was always False and the binding was never cleaned up. Dead code.
- **Current status**: api_server.py:736-753 — the code now captures `old_tab_id = job.get("tab_id")` at line 736 BEFORE nullifying at line 737, then compares `binding.get("tab_id") == old_tab_id` at line 752. **Binding cleanup is now functional.**
- **Verdict**: ✅ **FIXED** — `old_tab_id` snapshot pattern resolves the dead code

#### B2. [claim_attempt has no maximum](audit_05 line 539) — **MEDIUM** — ✅ **SILENTLY FIXED**
- **Original bug**: No limit on how many times a stale job could be reaped; zombie jobs could permanently occupy the queue.
- **Current status**: api_server.py:741-746 — `if job["claim_attempt"] > 5: job["status"] = "failed"; job["error"] = "max_claim_attempts_exceeded"` — **5-claim-attempt limit added.**
- **Verdict**: ✅ **FIXED**

#### B3. [Queue has no capacity limit](audit_05 line 368) — **INFO** — ⚠️ **STILL PRESENT**
- `BROWSER_QUEUE` and `BROWSER_JOBS` have no max size; unbounded growth possible under high concurrency.
- **Verdict**: ⚠️ STILL PRESENT (advisory)

#### B4. [lease fixed 150s, no renewal beyond that window](audit_05 line 496) — **INFO** — ⚠️ **STILL PRESENT**
- `lease_expires_at` is always set to `time.time() + 150.0` on claim and delta. Long-running tasks (>150s) could be prematurely reaped.
- **Verdict**: ⚠️ STILL PRESENT (advisory)

---

### C. TOOL PROMPT / TOOL_CHOICE (audit_10, audit_03)

#### C1. [tool_choice=none keyword leak](audit_10 line 203-204) — **GAP** — ⚠️ **OBSOLETE**
- **Original bug**: `browser_prompt` had a keyword-based gate (e.g., "搜索", "search", "tool") that injected tool definitions even when `tool_choice="none"` was specified. The `none` flag was not checked against the keyword gate.
- **Current status**: The entire keyword-gate mechanism (`browser_prompt`, `_tool_prompt`) no longer exists. `tool_choice` is now listed as `"capability_gated"` in `/v1/capabilities` but is **NOT read or used** by the chat_completions handler. Tool injection happens unconditionally via `inject_tool_defs()` based on `supports_tool_calling`.
- **Verdict**: ⚠️ OBSOLETE (affected code removed) — but see C2 below for the regression

#### C2. [tool_choice is completely ignored in new code path] — **GAP** — 🔴 **NEW REGRESSION**
- **Finding**: In the new `chat_completions()` handler (api_server.py:1265-1400+), `tool_choice` is never extracted from the request body. The old `browser_prompt(tools, tool_choice=...)` call chain is gone. `inject_tool_defs()` always injects tool definitions when tools are present and `supports_tool_calling` is True.
- **Impact**: `tool_choice="none"`, `tool_choice="required"`, and `tool_choice={"type":"function","function":{"name":"x"}}` are all silently ignored. A user requesting `tool_choice="none"` will still get tool definitions injected into the prompt.
- **Verdict**: 🔴 **NEW REGRESSION** — tool_choice should be read from body and passed to `inject_tool_defs()` (or a wrapper that respects choice semantics)

---

### D. CAPABILITY GATE (audit_10)

#### D1. [Capability gate bypass — claim succeeds without capabilities dict](audit_10 line 658-663) — **GAP** — ⚠️ **STILL OPEN**
- **Original bug**: `claim_browser_job` checked `caps.get("can_observe")` and `caps.get("can_execute")`, but if a client registered without a `capabilities` dict, `caps` was None and the check was silently skipped. The claim succeeded without any capability verification.
- **Current status**: api_server.py:764-765 — the check is still `if tab_id is not None and client and caps is not None:`. If `caps` is None (no capabilities key on the client), the entire guard is skipped. **Claim still succeeds for clients without capabilities.**
- **Verdict**: ⚠️ **STILL OPEN** — fix: treat `caps is None` as lacking capabilities and deny claim, or enforce that capabilities must always be set.

#### D2. [capability gate blocks correctly when can_observe=False or can_execute=False](audit_10 line 675-681) — ✅ WORKS
- The gate DOES work when capabilities dict is present but contains `False` values.

---

### E. SSE STREAMING & IDEMPOTENCY (audit_2, audit_04)

#### No bugs found in SSE streaming, snapshot delta, finish_reason, DONE signal, or idempotency lifecycle.
- audit_2: All 9 probe categories passed on the unit-level functions.
- audit_04: All 6 probe categories (multi-turn, retry, idempotency, replay, processing wait, cross-cutting) passed.

---

## SYNTHESIS TABLE

| # | Audit | Severity | Component | Bug | Status |
|---|-------|----------|-----------|-----|--------|
| 1 | audit_03 L207 | MEDIUM | Context Formatting | `_format_prompt_message` Python repr leak on array content | ✅ SILENTLY FIXED (function removed) |
| 2 | audit_03 L435 | MEDIUM | Context Formatting | `browser_prompt` no length truncation | ⚠️ OBSOLETE (function removed) |
| 3 | audit_03 L426 | INFO | HTTP | No Content-Length hard limit | ⚠️ OPEN (advisory) |
| 4 | audit_05 L585 | HIGH | Lease Reaper | `reap_expired_browser_jobs` binding cleanup dead code (tab_id nullified before comparison) | ✅ SILENTLY FIXED (old_tab_id snapshot) |
| 5 | audit_05 L539 | MEDIUM | Lease Reaper | `claim_attempt` has no maximum | ✅ SILENTLY FIXED (max 5) |
| 6 | audit_05 L368 | INFO | Queue | Queue has no capacity limit | ⚠️ OPEN (advisory) |
| 7 | audit_05 L496 | INFO | Lease | Lease fixed at 150s, long tasks may be prematurely reaped | ⚠️ OPEN (advisory) |
| 8 | audit_10 L203 | GAP | Tool Prompt | `tool_choice=none` keyword leak | ⚠️ OBSOLETE (mechanism removed) |
| 9 | audit_10 L658 | GAP | Capability Gate | Claim succeeds without capabilities dict (observe/execute bypassed) | ⚠️ STILL OPEN |
| 10 | — | GAP | Tool Prompt | `tool_choice` completely ignored in new chat_completions handler | 🔴 NEW REGRESSION |

---

## FIXES VERIFIED IN CURRENT CODE

1. **Binding cleanup dead code** (api_server.py:736-753): `old_tab_id` is captured before nullification, then compared correctly at line 752.

2. **claim_attempt limit** (api_server.py:741-746): After 5 claim attempts, job is marked `failed` with error `max_claim_attempts_exceeded`.

3. **Array content handling** (api_server.py:1306-1309, protocol.py:messages_to_text): Content arrays are now flattened to `'\n'.join(text_parts)` before constructing `Message` objects — no Python repr leak.

## BUGS STILL OPEN (requiring action)

### PRIORITY 1 — NEW REGRESSION
- **tool_choice is completely ignored** in the new `/v1/chat/completions` handler. The body field is never read. Users specifying `tool_choice="none"` still get tool definitions injected. Fix: read `tool_choice` from body and gate `inject_tool_defs()` accordingly.

### PRIORITY 2 — STILL OPEN
- **Capability gate bypass** (api_server.py:764-765): Clients without a `capabilities` dict can still claim jobs. Fix: treat missing `capabilities` as incapable and deny the claim, or add a default `{"can_observe": False, "can_execute": False}`.

### PRIORITY 3 — ADVISORIES
- No Content-Length limit on HTTP body reads
- Queue unbounded capacity (BROWSER_QUEUE, BROWSER_JOBS)
- Lease fixed at 150s — long-running tasks may be prematurely reaped
