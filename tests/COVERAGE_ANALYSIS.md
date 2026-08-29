# Phantom Relay Test Coverage Gap Analysis
Generated: 2026-07-30

## Executive Summary

8 test files, ~58 tests total. **Zero tests** cover: SW restart state loss, content script injection failure recovery, multi-tab concurrent execution, selector template corruption, model_routes.json schema evolution, or long conversation context (>20 messages end-to-end). Several existing tests have **false positive risks** where assertions are too permissive or test the wrong layer.

---

## FILE-BY-FILE ANALYSIS

### 1. test_api_idempotency.py (17 tests)

**COVERS:**
- Idempotency claim/replay (same key+fingerprint → cache hit)
- Same key + different body → conflict detection
- Non-object chat body rejection (None, [])
- Tool followup prompt: tool result kept separate from user slot
- Completed response replayability + event signaling
- Browser prompt selective tool injection + conversation_id propagation
- Tool prompt schema + keyword gate
- Conversation persistence with identity metadata (tmp_path/monkeypatch)
- OpenAI tool message shape + arguments serialization
- Stream snapshot delta computation
- OpenAI stream chunks: tool_calls and text paths
- Browser extension availability (brand-neutral, domain filtering)
- Stale idempotency record reclamation (TTL-based cleanup)
- Browser capability profile normalization (source → transport mapping)
- Route capabilities + unsupported_capability detection
- Claim gate: requires observe AND execute capabilities
- Claim gate: rejects wrong/missing conversation_id
- Browser status snapshot excludes secrets (token not leaked)
- Conversation binding prevents cross-tab claim (BROWSER_BINDINGS)
- Job actor token + identity validation (claim_token, tab_id, conversation_id)
- Terminal job cannot be overwritten (finish_browser_job idempotency)

**MISSING (critical):**
- `fail_idempotency()` — exists in api_server.py L220–231, NEVER TESTED
- `idempotency_key()` — header vs body vs none precedence untested
- Idempotency TTL boundary conditions (exactly at TTL, 1s before/after)
- Concurrent idempotency claims under threading (race on IDEMPOTENCY dict)
- `browser_unavailable_response()` — untested
- `normalize_route_registry()` — untested
- `normalize_route_value()` with dict vs string inputs — untested
- `merge_selector_templates()` / `merge_recorded_selector_template()` — untested
- `relay_context_options()` with malformed phantom_relay values — untested
- `request_fingerprint()` — untested
- `resolve_domain()` — untested
- Large model_routes.json with 10+ entries → assertion about all routes loaded

**FALSE POSITIVE RISKS:**
1. `test_tool_followup_prompt_keeps_tool_result_out_of_current_user_slot`: Only checks substring presence. Could pass if prompt structure is rearranged but both substrings still appear.
2. `test_route_capabilities_and_unsupported_request`: Calls `route_entry('deepseek')` which uses the LEGACY `load_routes()` path (flat routes.json), NOT the new structured `load_model_config()` path. Gives false confidence in new config loading.
3. `test_browser_extension_available_is_brand_neutral`: Tests with 1 client + 1 domain. Doesn't exercise multi-client filtering, TTL edge cases, or missing `ready` flag.
4. `test_conversation_persistence_keeps_execution_identity`: Depends on `tmp_path` monkeypatching `DATA_FILE` — if API server has `DATA_FILE` resolution that doesn't honor monkeypatch for nested calls, test could pass vacuously.

---

### 2. test_protocol.py (23 tests)

**COVERS:**
- resolve_model: direct ID, alias, ModelNotFoundError
- messages_to_text: simple, 20 messages, empty skip, all-empty, tool role, tool_calls assistant, developer→System, Chinese
- inject_tool_defs: empty tools, unsupported capability, basic + schema + example text
- extract_tool_calls: empty, ```tool_json fenced, bare JSON, XML, first-wins, broken JSON
- text_to_openai_response: normal text, empty→error, tool_calls→tool_calls finish_reason
- SSE: chunk with role, content, tool_calls, [DONE]
- Errors: build_openai_error shape
- Model list: build_model_list
- Token estimation: empty, English, Chinese

**MISSING (critical):**
- `messages_to_text` with assistant that has BOTH content AND tool_calls
- `messages_to_text` with 30–100 messages (stress / context-window boundary)
- `messages_to_text` with null role (should be caught, not tested)
- `extract_tool_calls` with MULTIPLE valid tool_calls in one response (code returns list, test only checks first-wins)
- `extract_tool_calls` with `<tool_use>` XML format (handled in content.js but protocol.py doesn't test it)
- `extract_tool_calls` with >10KB of text containing tool call (performance)
- `inject_tool_defs` with 5+ tools and deeply nested parameters
- `text_to_sse_chunk` with empty string `""` delta_content vs `None`
- `build_sse_error()` — NEVER TESTED
- `text_to_openai_response` with `stream=True` parameter (accepted, behavior not verified)
- `text_to_openai_response` with `system_fingerprint` parameter
- `text_to_openai_response` with multiple tool_calls in one message (multi-tool)
- `estimate_tokens` with mixed CJK/English (typical GenAI chat)
- `ModelRoute` dataclass with extended selectors (thinking_area, error_indicator, etc.) — only basic selectors tested

**FALSE POSITIVE RISKS:**
1. `test_messages_to_text_20_messages`: Only counts role label frequency. Does NOT verify message ordering, truncation behavior, or that content is preserved correctly. If the formatter drops every other message, the assertion `text.count("User:") == 10` could still pass.
2. `test_extract_tool_calls_first_wins`: The "first-wins" semantic is correct for the implementation, but this masks that the code should arguably extract ALL tool_calls from a multi-tool response.
3. `test_sse_chunk_toolcalls`: Checks `'"tool_calls"' in c` and `'"finish_reason":"tool_calls"' in c` — doesn't verify the full SSE wire format (`data: ` prefix, `\n\n` terminator, JSON structure).

---

### 3. test_page_reuse.py (5 tests)

**COVERS:**
- Default conversation_id stability (case-insensitive domain)
- Default page reuse binding when idle (conversation_bound=False)
- Busy bound page won't claim second job
- Explicit context — wrong tab rejected, right tab accepted
- Extension namespace (`phantom_relay`) optionality

**MISSING (critical — all related to SW restart, which kills in-memory BROWSER_BINDINGS):**
- **SW restart: BROWSER_BINDINGS is in-memory dict** — all bindings lost on restart. No test simulates this.
- Page reuse after CLIENT_TTL expiration mid-capture
- Claim recovery: client disconnects, reconnects with new tab_id, tries same conversation_id
- Multiple tabs on same domain, different conversation_ids → which binding takes priority?
- Binding cleanup when tab is closed by user (real lifecycle)
- `new_context: true` flag preventing page reuse
- Claim recovery with mismatched claim_token but matching conversation_id + domain

**FALSE POSITIVE RISKS:**
1. `test_busy_bound_page_does_not_claim_second_job_on_same_tab`: Bypasses background.js entirely. In reality, `activeClaimedTabIds` in `browserBridgeTick()` excludes claimed tabs BEFORE claiming. This test only exercises the API server's claim logic, not the real multi-tab gate.
2. `test_explicit_context_is_bound_and_wrong_tab_rejected`: Tests tab_id mismatch only. Doesn't test claim_token mismatch or domain mismatch in the explicit-context flow.

---

### 4. test_capture_heartbeat.py (121 lines, 1 test)

**COVERS:**
- Heartbeat every 5s for 90s keeps BROWSER_CLIENTS entry alive (CLIENT_TTL=45s)

**MISSING (critical):**
- **Heartbeat failure recovery**: What if a heartbeat request fails? Capture continues silently with stale lease?
- **Heartbeat during real SSE streaming**: Test uses polling loop, not actual streaming capture
- **Heartbeat through extension SW relay**: Test hits `/browser/heartbeat` directly. The real flow is: content.js → `capture_heartbeat` message → background.js → `/browser/heartbeat`. None of that chain is tested.
- Heartbeat with wrong/lost conversation_id
- Heartbeat after job finishes but tab stays open (stale heartbeat)
- Two heartbeats simultaneously from same tab (idempotency)
- Client expiration exactly at TTL boundary (45.0s)

**FALSE POSITIVE RISKS:**
- The test only validates the API server's CLIENT_TTL path. The Chrome extension's `capture_heartbeat` message handler, background.js relay, and content.js heartbeat interval are all UNTESTED. The test could pass green while the actual browser capture silently times out because content.js stops sending heartbeats.

---

### 5. test_claim_recovery.py (107 lines, 3 tests)

**COVERS:**
- Valid claim_token → result accepted (200)
- Queued + matching identity → result accepted (200 or 404)
- Mismatched identity (wrong domain, wrong token) → rejected (!=200)

**MISSING (critical):**
- **SW restart recovery**: `activeClaims` Map in background.js is in-memory → lost on restart. The `browser_result_relay` handler has a fallback path via `/browser/result-token` (L716-726). **THIS PATH IS NEVER TESTED.**
- Claim recovery with stale/expired job
- Claim recovery with partially completed capture (streaming mid-flight)
- Claim recovery when network_capture was active (CDP debugger attached)
- Multiple concurrent claim recovery attempts (race on result submission)
- Recovery with malformed payload (missing job_id, domain, tab_id)
- Recovery timing: what if claim_token resolves but job was already re-queued?

**FALSE POSITIVE RISKS:**
1. `test_queued_recovery`: Accepts BOTH HTTP 200 AND 404 as pass: `assert s in (200, 404)`. A 404 means the job was cleaned up, not "recovered." This masks bugs where the recovery endpoint returns 404 for valid recoveries.
2. All 3 tests bypass `chrome.runtime.onMessage` — they test the API directly. The background.js relay adds claim_token resolution, activeClaims lookup, and payload reconstruction that are UNCOVERED.

---

### 6. test_universal_bridge.js (10 tests)

**COVERS:**
- Message normalization (roles, whitespace, null/invalid entries)
- Send plan building (button, keyboard, fallback, budget exhaustion)
- Logical message snapshot (row-based dedup, authoritative wins)
- Fresh user/assistant finding (by text match)
- Streaming state machine (observe→wait→complete)
- Reasoning/status line filtering (Chinese + English patterns)
- Snapshot deltas (appendSnapshot, mergeSnapshot)
- Timeout + duplicate safety
- Tool call parsing: ```tool_json fenced, tool_call XML, tool_use XML, bare JSON, nested braces, malformed rejection
- Status filtering edge cases (embedded status keywords in normal text)

**MISSING (critical):**
- `parseToolCall` with >65536 char input (length guard tested: always returns null)
- `parseToolCall` with unicode/non-ASCII tool names (regex allows only `[A-Za-z0-9_.:-]`)
- `parseToolCall` from provider-specific formats: Anthropic `function_calls`, OpenAI function calling JSON, Claude tool_use blocks with `id` attribute
- `parseToolCall` with deeply nested JSON (>20 levels)
- `mergeSnapshot` with CJK overlap (character vs byte boundaries)
- `mergeSnapshot` with completely non-overlapping text (100% different)
- `logicalMessageSnapshot` with 1000+ records (performance)
- `logicalMessageSnapshot` records with duplicate keys but different container domains (should be separate)
- `responseDecision` with `tracker.complete=true` AND `timeoutReached=true` simultaneously
- `observeResponse` with same key but completely different text (should reset stable counter)
- `buildSendPlan` with bare template (no send, keyboard=false) → 0 actions → no-send_strategy
- `buildSendPlan` with send as `{ kind: 'shortcut', key: 'Enter' }` strategy object
- `cleanAssistantText` with multi-line status headers (full thinking block)
- `isStatusLine` with >80 char strings (should reject, not tested)
- `comparableText` with bidirectional text / RTL content

**FALSE POSITIVE RISKS:**
1. `testToolCallParsing` — bare JSON test (L127–129): `{"name":"exec","arguments":{"command":"printf x}"}}` has trailing unbalanced `}`. The test asserts it parses correctly, but `balancedJsonCandidates` + `parsedToolObject` validation could silently fail on different inputs. The test data is too close to the implementation's exact path.
2. `testTimeoutAndDuplicateSafety` — `mergeSnapshot` test uses `'A'.repeat(40) + 'B'.repeat(12)` (52 chars) and `C'.repeat(20)` appended. The overlap search starts at `minOverlapLength=32` and the only overlap candidate is the `B`×12 segment (12 chars), which is below the threshold. The merge will return the full `C`×20, which is what the test expects — but not because overlap was correctly detected, but because NO overlap was found.
3. `testToolCallParsing` — nested braces test (L124–126) with `"brace } in text"`: Tests that `balancedJsonCandidates` correctly handles `}` inside string values. If the brace balancing is naive (just count { vs }), this test would fail. The implementation uses an in-string escape-aware parser — the test is valid but the assertion doesn't prove it works for ALL brace-in-string cases.

---

### 7. test_network_sse_parser.js (57 lines, 1 test)

**COVERS:**
- Parse a hardcoded SSE body with: fragments array, APPEND operations, bare string values, BATCH event, FINISHED status
- Returns `{ text, finished }` tuple

**MISSING (critical — SSE protocol compliance is almost entirely untested):**
- **SSE comment lines**: `: heartbeat` lines (used for keepalive) — not tested
- **SSE `event:` field**: named events like `event: ready`, `event: close` — body has them but parser ignores them (no test for this behavior)
- **SSE `id:` field**: last-event-ID for reconnection — not tested
- **SSE `retry:` field**: reconnection timeout — not tested
- **SSE multi-byte UTF-8**: Chinese text is tested, but multi-byte sequences at chunk boundaries — not tested
- **SSE `[DONE]` mid-stream**: if a previous response's [DONE] bleeds into the new stream
- **SSE body with corrupted JSON** in `data:` lines (malformed JSON that should be skipped)
- **SSE body with VERY large content** (>10MB) — no performance/buffer test
- **SSE body with fragments but no `content` field** — should not crash
- **SSE `response/status` SET to FINISHED before content arrives** — ordering test
- **Multiple concurrent SSE streams** interleaved (should not happen but parser should be defensive)
- **`data:` without space** after colon (non-compliant but common)
- **Truncated mid-line body** (simulating network interruption)

**FALSE POSITIVE RISKS:**
- The test hardcodes ONE specific API response format. It doesn't validate SSE protocol compliance — only that this exact known-good input produces the exact known-good output. If the API changes its SSE structure (different path patterns, different field names), the test would fail but the parser might still be "correct" for the new format. Conversely, the parser could be broken for other valid SSE and this test stays green.

---

### 8. streaming_matrix_live.py (95 lines, live integration)

**COVERS (requires running server + browser):**
- Short stream per model (deepseek, doubao, yiyan)
- Long answer stream (120 numbered lines)
- Multi-turn conversation in caller-provided context (4 turns)
- Ten sequential calls in one context
- Rapid model switching (6 switches)
- Independent context switch with new_context flag
- 3 parallel agents in separate contexts (ThreadPoolExecutor)

**MISSING (critical):**
- **SSE format compliance verification**: Only checks for `[DONE]` in raw output. Doesn't verify `data:` prefix on every line, JSON structure of chunks, heartbeat presence, or `\n\n` terminators.
- **SSE heartbeat timing**: Settings specify 15s interval — test records `has_heartbeat` but doesn't enforce it
- **Streaming with tool_calls**: Tool definitions in the prompt, tool_call extraction from stream
- **Stream interruption + reconnection**: What happens if the stream drops midway?
- **Mid-stream errors**: Model returns error after partial content
- **Empty response**: Model returns no content (just reasoning/thinking panel)
- **Non-streaming comparison**: Same prompt, streaming=true vs streaming=false parity
- **20+ message conversation** via streaming (only tests up to 10 turns for one model)
- **Concurrent access to SAME context**: 2 parallel requests for same context_id (should 2nd wait or conflict?)
- **`finish_reason: 'length'`**: Token limit truncation
- **`finish_reason: 'content_filter'`**: Safety filter blocks response
- **Phantom_relay metadata in response**: Verifying context_id, model routing info in response headers/body

**FALSE POSITIVE RISKS:**
1. Pass criteria (L48): `pass = not error and done and finish and finish[-1] == 'stop' and text_parts and returncode == 0`. This PASSES if the model returns "I cannot help with that" — content correctness is never verified. A hallucinated or wrong response would show green.
2. `has_heartbeat` (L47): `': heartbeat' in raw` — only recorded as metadata, never enforced as part of `pass`. The test always passes even if heartbeats are broken.
3. Intermediate file (`streaming_matrix_results.partial.json`) is written but never verified for parseability. A partial write during crash would leave corrupt file.
4. No assertion on number of events/chunks — a model that returns 1 chunk vs 100 chunks both pass.
5. Long answer test requests "1到120" numbered lines but never counts that 120 lines were received.

---

## CROSS-CUTTING COVERAGE GAPS

### SW Restart State Loss — ZERO COVERAGE

All in-memory state is lost when the Service Worker or API server restarts:
- **API server**: `IDEMPOTENCY`, `BROWSER_JOBS`, `BROWSER_CLIENTS`, `BROWSER_BINDINGS`, `BROWSER_QUEUE`, `BROWSER_DELTAS`, `BROWSER_EVENTS`
- **Extension background.js**: `activeClaims` Map, `activeNetworkCaptures` Map, `pendingTabCreation` Map, `browserPollInFlight` flag, `pageRuntime` Map

No test simulates a restart mid-job, mid-capture, or mid-stream-recovery. Every reconnection/recovery path in the code is untested inference.

### Content Script Injection Failure Recovery — ZERO COVERAGE

`ensureContentScript()` in background.js (L216–260) has 5+ failure modes:
1. ping returns wrong version → attempt injection
2. `chrome.scripting.executeScript` fails (restricted page, CSP block)
3. `prime()` fails (server unreachable, selector template missing)
4. `wait_until_ready` timeout (>12s / >30s)
5. `recorded_selectors_apply_failed` after 3 retries

Every one of these logs an error and returns false — **none are tested**.

### Multi-Tab Concurrent Execution — ZERO COVERAGE

`browserBridgeTick()` uses `activeClaimedTabIds` and `activeClaimedDomains` to prevent double-claim. The `pendingTabCreation` Map prevents duplicate tab creation. No test:
- Spawns 2+ tabs on same domain simultaneously
- Tests alarm race (alarm fires while previous tick still in-flight)
- Tests `chrome.tabs.onCreated` + `onUpdated` + alarm all firing near-simultaneously
- Tests what happens when `ensureContentScript` succeeds for both tabs

### Selector Template Corruption — ZERO COVERAGE

- `selector_templates.json` missing → `load_selector_templates()` returns `{}` → untested
- Malformed JSON in selector_templates.json → `except Exception: return {}` → untested
- Selector template with empty input → `recorded_input_template_missing` error → untested
- Selector template with CSS selector targeting zero elements → runtime failure → untested
- `merge_selector_templates()` with overlapping domains → untested

### model_routes.json Schema Evolution — ZERO COVERAGE

- `models` field as corrupted string (triggers `ast.literal_eval` fallback) → never tested
- `models` field as non-list (triggers type error path) → never tested
- Model with missing `provider.domain` → route domain="" → untested
- Model with missing `capabilities` entirely → defaults applied → partially covered
- Model with extra unknown fields → silently ignored → untested
- Aliases pointing to non-existent model IDs → `resolve_model` raises but untested at config-load level
- Settings with invalid types (e.g., `max_concurrent_jobs: "three"`) → no validation

---

## SUMMARY TABLE

| Gap Area | Any Coverage? | Severity |
|---|---|---|
| SW restart state loss | ❌ NONE | CRITICAL |
| Content script injection failure | ❌ NONE | CRITICAL |
| Multi-tab concurrency | ❌ NONE | HIGH |
| Response capture timeout handling | ⚠️ Partial (heartbeat only) | HIGH |
| model_routes.json schema changes | ❌ NONE | HIGH |
| Selector template corruption | ❌ NONE | HIGH |
| SSE streaming compliance | ⚠️ Partial (1 hardcoded body) | HIGH |
| Long conversation (20+ msgs E2E) | ⚠️ Partial (protocol unit test) | MEDIUM |
| Tool_call parsing edge cases | ⚠️ Partial (10 formats, missing edge) | MEDIUM |
| claim_token loss / SW restart | ❌ NONE | CRITICAL |
| Network capture stale debugger | ❌ NONE | MEDIUM |

**False positive count estimate**: ~8 tests have assertions too weak or test the wrong layer.
