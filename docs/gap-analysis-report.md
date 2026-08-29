# Phantom Relay Documentation-to-Code Gap Analysis

**Generated**: 2026-07-30  
**Scope**: All docs/*.md, regression rounds, spec/plan files vs. actual source code  
**Code baseline**: api_server.py (1467 lines), protocol.py (422 lines), background.js (1146 lines), content.js (2604 lines), universal_bridge.js

---

## GAP CATEGORY 1: Features Documented in Spec/Plan But NOT Implemented

### 1.1 Stop Button Detection (P0 – Critical)
- **Doc**: `docs/dom-completion-audit-v2.md:229-251`, `docs/20-strategy-test-matrix-zh.md:51-61`
- **Status**: ❌ MISSING. `content.js` `messageIsStreaming()` (line ~815-818) only checks `data-streaming` and `aria-busy` attributes. Has NO stop button detection.
- **Code gap**: `extension/content.js` — no global stop button query exists. `isPageStillGenerating()` was designed in the audit but never created.
- **Impact**: DeepSeek, Qwen, Kimi, Wenxin streaming detection is broken; `data-streaming` is Doubao-only.

### 1.2 `selector_templates.json` Deprecation & Merge into `model_routes.json`
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:125-126` ("selector_templates.json → 废弃：字段合并进 model_routes.json")
- **Status**: ❌ NOT DONE. `server/selector_templates.json` still exists as a separate file (85 lines). `api_server.py` still has `load_selector_templates()` (line 331) and `save_selector_templates()` (line 341).
- **Code gap**: `server/api_server.py:331-363` — selector templates are loaded from separate file, NOT from model_routes.json

### 1.3 Admin Test Endpoint `POST /admin/api/test`
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:1958-1987`
- **Status**: ❌ NOT IMPLEMENTED. No `/admin/api/test` route in `api_server.py`.
- **Code gap**: `server/api_server.py` — route is missing entirely. Admin page has test panel UI sending to a non-existent endpoint.

### 1.4 `PUT /admin/api/settings` + Global Settings Persistence
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:2119`
- **Status**: ❌ NOT IMPLEMENTED. No settings management endpoint.
- **Code gap**: `server/api_server.py` — no `/admin/api/settings` route.

### 1.5 Full Admin Page (`server/static/admin.html` ~400 lines)
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:2050-2105` (complete UI design)
- **Status**: ⚠️ STUB ONLY. Actual `admin.html` is 123 lines with a basic model list table. Missing: alias management editor, test panel with model selector, streaming toggle, global settings editor, editable model selectors, live connection status indicators.
- **Code gap**: `server/static/admin.html:1-123` — minimal stub, not near the ~400 lines spec'd.

### 1.6 `server/static/admin.js` (~200 lines)
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:130`
- **Status**: ❌ MISSING. File does not exist.
- **Code gap**: No `server/static/admin.js` file.

### 1.7 `server/protocol.py` Migration Plan — api_server.py Slimming (1685 → ~700 lines)
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:1577-1877` (Section 7: "api_server.py 行级瘦身指南")
- **Status**: ⚠️ PARTIAL. `api_server.py` is now 1467 lines (was 1685). Functions listed for deletion still exist: `browser_prompt()` (line 300+), `normalize_messages()` (line 400+), `parse_network_sse_body()` style functions in background.js. The spec called for deletion of `_tool_prompt`, `_tool_injection_needed`, `browser_prompt`, `normalize_messages`, `parse_network_sse_body`, `unsupported_capability`.
- **Code gap**: `server/api_server.py` — legacy functions still present. Still ~700 lines above target.

### 1.8 SSE Stream Engine Overhaul
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:1702-1797` (full `_handle_streaming()` with generator pattern)
- **Status**: ❌ NOT IMPLEMENTED. Current `api_server.py` has no SSE streaming endpoint for `/v1/chat/completions`. The `stream=True` code path in the `/v1/chat/completions` handler (line ~1337) does NOT produce SSE — it waits for the non-streaming result.
- **Code gap**: `server/api_server.py:1337` — `stream = body.get('stream', False)` is read but the handler always returns JSON. No `Response(generate(), mimetype='text/event-stream')` exists.

### 1.9 Per-Site Streaming Indicators Configuration
- **Doc**: `docs/20-strategy-test-matrix-zh.md:206-215` (Strategy 14)
- **Status**: ❌ NOT IMPLEMENTED. No `streaming_indicators` field in any config or selector templates.
- **Code gap**: `extension/content.js` — `messageIsStreaming()` has no per-site configuration.

### 1.10 Clipboard Read (`navigator.clipboard.readText()`)
- **Doc**: `docs/20-strategy-test-matrix-zh.md:152-159` (Strategy 10)
- **Status**: ⚠️ PERMISSION ONLY. `manifest.json` has `clipboardRead` but content.js never calls `readText()`.
- **Code gap**: `extension/content.js` — `enableCopyMonitor()` exists but never reads actual clipboard content.

### 1.11 Network Request Interception via CDP
- **Doc**: `docs/20-strategy-test-matrix-zh.md:97-103` (Strategy 6), `docs/response-capture-strategy-matrix.md:14`
- **Status**: ⚠️ CDP ATTACH ONLY. `background.js` has `chrome.debugger.attach()` and Network domain events (lines 314-444), but this only captures SSE response bodies AFTER they arrive. No request interception, no provider-native protocol parsing. This is a subset of Strategy 6.
- **Code gap**: The documented "full network interception with per-provider SSE parsing" does not exist.

### 1.12 `completion_reason` Structured Enum (Aligned with ds2api)
- **Doc**: `docs/dom-completion-audit-v2.md:440-479` (Fix 6)
- **Status**: ❌ NOT IMPLEMENTED. Current `completion_reason` only has `'stable_snapshot'` and `'idle_timeout'`. Missing: `'stop_button_gone_and_stable'`, `'extended_quiet_no_generation'`, `'send_no_effect'`, `'no_content_timeout'`.
- **Code gap**: `server/api_server.py` and `extension/content.js` — no structured completion reason enum.

### 1.13 `completion_evidence` Trace Fields
- **Doc**: `docs/dom-completion-audit-v2.md:463-479`
- **Status**: ❌ NOT IMPLEMENTED. No `stop_button_visible`, `data_streaming_attr`, `stable_rounds`, `quiet_period_ms` in browser_delta items.
- **Code gap**: `server/api_server.py:648-656` — `append_browser_delta()` item dict has no `completion_evidence` sub-object.

### 1.14 `model_routes.json` `ernie-bot` / Wenxin Model Entry
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:1260-1262` (aliases: wenxin→ernie-bot, ernie→ernie-bot, yiyan→ernie-bot)
- **Status**: ❌ MISSING. Current `model_routes.json` only has 4 models (doubao, deepseek-chat, deepseek-reasoner, qwen-turbo). No wenxin/ernie model entry, no wenxin aliases.
- **Code gap**: `server/model_routes.json` — missing ernie-bot model definition and wenxin/ernie/yiyan aliases.

### 1.15 `doubao-default` and `seed` Aliases
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:1251-1253`
- **Status**: ❌ MISSING. Current aliases don't include `doubao-default` or `seed`.
- **Code gap**: `server/model_routes.json` — aliases section missing `doubao-default` and `seed`.

---

## GAP CATEGORY 2: Architectural Decisions That Contradict Actual Implementation

### 2.1 "Protocol Layer Zero Side Effects" vs. api_server.py's `messages_to_text` Usage
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:45` (Principle 5: "协议层零副作用 — protocol.py 不读文件、不发网络、不依赖环境变量")
- **Reality**: `protocol.py` IS clean (zero side effects). However, `api_server.py` loads model config at import time (line 128: `_routes, _aliases, _settings = load_model_config()`) and ALSO has a legacy `load_routes()` function (line 262) that reads `model_routes.json` separately in a different format. Two parallel config loading mechanisms coexist.
- **Code ref**: `server/api_server.py:128` vs `server/api_server.py:262-272`

### 2.2 "Extension Does No Protocol Judgment" vs. Extension's Tool Call Processing
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:47` (Principle 7: "扩展不做协议判断")
- **Reality**: `background.js` has `parseNetworkSseBody()` (line 281) which parses SSE events looking for `response/fragments/*/content`, `APPEND` operations, and `FINISHED` status — this IS protocol-level parsing in the extension.
- **Code ref**: `extension/background.js:281-308`

### 2.3 "selector_templates.json is Deprecated" vs. Active Usage
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:113` (selector_templates.json → 废弃)
- **Reality**: `api_server.py` actively loads, saves, and merges selector templates from this file. Extension syncs to it.
- **Code ref**: `server/api_server.py:331-363` (load/save/merge functions), `server/api_server.py:950-969` (GET/POST /browser/selectors)

### 2.4 "model_routes.json is Sole Config Source" vs. Dual Config System
- **Doc**: `docs/superpowers/specs/2026-07-30-phantom-relay-gateway-redesign.md:46` (Principle 6: "model_routes.json 是唯一配置源")
- **Reality**: Two configuration systems exist simultaneously:
  1. `model_routes.json` (new format, loaded by `load_model_config()` at line 56)
  2. Legacy flat routes (loaded by `load_routes()` at line 262, saved from extension-synced data)
  The `/model-routes` endpoint (line 897) returns the LEGACY format, while `/v1/models` (line 1419) returns the new format.
- **Code ref**: `server/api_server.py:56-128` vs `server/api_server.py:262-272` vs `server/api_server.py:896-898`

### 2.5 "New Context Per Conversation" vs. Tab Reuse with Binding
- **Doc**: `docs/upstream-audit-report.md:16` ("每个 conversation 创建独立执行 tab")
- **Reality**: Current code reuses tabs via `BROWSER_BINDINGS` (line 39) and `conversation_binding()` (line 459). Tabs are NOT created per conversation unless `new_tab=true`. The binding `(conversation_id, domain) → tab_id` is a soft reuse, not strict isolation.
- **Code ref**: `server/api_server.py:39, 449-468`

### 2.6 "Account Pool / Multi-Account" vs. Single Session
- **Doc**: `docs/universal-adapter-architecture.md:213-237` (Section 7: Account/Session boundary), `docs/ds2api-internal-audit.md:71-96` (detailed pool state machine)
- **Reality**: No account pool, no credential management, no session rotation. Single browser profile. The `upstream-audit-report.md:203` explicitly acknowledges this is NOT built.
- **Code ref**: No account pool code exists.

### 2.7 "Provider Adapter Pattern" vs. Monolithic Extension Code
- **Doc**: `docs/universal-adapter-architecture.md:17-26` (layered architecture with Provider Adapter: Authenticator, Browser Runtime, Request Builder, Stream Parser, Error Classifier)
- **Reality**: All provider logic is inlined in `content.js` and `background.js`. No adapter pattern, no interface for plugging new providers. Each site gets hardcoded selector lookups and heuristic detection.
- **Code ref**: `extension/content.js` — `classifyElement()`, `generateSelector()`, `findUniversalSendButton()` are monolithic, not adapter-based.

---

## GAP CATEGORY 3: Gateway Redesign (94KB Spec) vs. Current Flask api_server.py

The redesign spec (`2026-07-30-phantom-relay-gateway-redesign.md`, 2615 lines) describes a two-layer architecture. Here is what was designed but NOT built:

### 3.1 File-Level Gaps

| File | Spec Target | Actual | Delta |
|------|-------------|--------|-------|
| `server/protocol.py` | ~350 lines | 422 lines | ✅ Close (extra ~70 lines of comments) |
| `server/model_routes.json` | ~500 lines (JSON Schema, 5+ models) | 333 lines (4 models, no schema) | ❌ Missing: JSON Schema, ernie-bot model, extended aliases |
| `server/api_server.py` | ~700 lines | 1467 lines | ❌ 767 lines over target; NOT slimmed |
| `server/selector_templates.json` | DELETED | 85 lines, still active | ❌ Not deleted |
| `server/static/admin.html` | ~400 lines | 123 lines | ❌ Stub only |
| `server/static/admin.js` | ~200 lines | DOES NOT EXIST | ❌ Missing |
| `extension/content.js` | NOT MODIFIED | 2604 lines | ✅ Correct |
| `extension/background.js` | NOT MODIFIED | 1146 lines | ✅ Correct |
| `tests/test_protocol.py` | ~500 lines | 244 lines (25 tests) | ⚠️ ~50% of spec target |

### 3.2 Protocol Functions Designed vs. Built

| Function | Spec Status | Actual Status |
|----------|-------------|---------------|
| `resolve_model()` | ✅ Designed (Sec 5) | ✅ Built |
| `messages_to_text()` | ✅ Designed (Sec 5) | ✅ Built |
| `inject_tool_defs()` | ✅ Designed (Sec 5) | ✅ Built |
| `extract_tool_calls()` | ✅ Designed (Sec 5) | ✅ Built |
| `text_to_openai_response()` | ✅ Designed (Sec 5) | ✅ Built |
| `text_to_sse_chunk()` | ✅ Designed (Sec 5) | ✅ Built |
| `build_sse_done()` | ✅ Designed (Sec 5) | ✅ Built |
| `build_sse_error()` | ✅ Designed (Sec 5) | ✅ Built |
| `build_openai_error()` | ✅ Designed (Sec 5) | ✅ Built |
| `build_model_list()` | ✅ Designed (Sec 5) | ✅ Built |
| `estimate_tokens()` | ✅ Designed (Sec 5) | ✅ Built |

### 3.3 API Endpoints Designed vs. Built

| Endpoint | Spec Section | Actual Status |
|----------|-------------|---------------|
| `POST /v1/chat/completions` | Sec 7.2 | ✅ Built (but no SSE streaming path) |
| `GET /v1/models` | Sec 8.1 | ✅ Built |
| `GET /v1/capabilities` | NOT IN SPEC | ✅ Built (organic add) |
| `GET /admin` | Sec 10 | ⚠️ Stub only |
| `GET /admin/api/models` | Sec 8.2 | ✅ Built |
| `PUT /admin/api/models/{id}` | Sec 8.3 | ⚠️ Stub (returns ok, doesn't actually update model_routes.json) |
| `POST /admin/api/models` | Sec 8.4 | ⚠️ Stub (returns ok, doesn't actually write) |
| `DELETE /admin/api/models/{id}` | Sec 8.5 | ⚠️ Stub (returns ok, doesn't actually delete) |
| `POST /admin/api/test` | Sec 8.6 | ❌ NOT BUILT |
| `PUT /admin/api/settings` | Sec 10.3 | ❌ NOT BUILT |
| `/browser/*` endpoints | Sec 7.1 | ✅ Built (preserved) |

### 3.4 SSE Streaming Engine Gap

The spec (Sec 7.2, lines 1702-1797) designs a complete SSE streaming generator with:
- Initial role chunk with `delta_role="assistant"`
- Per-delta text emission via `text_to_sse_chunk(delta_content=...)`
- Tool calls as single chunk with `tool_calls_delta`
- Final `finish_reason` chunk + `[DONE]`
- 3-second heartbeat intervals
- `X-Accel-Buffering: no` header

**Actual**: NONE of this exists. The current `/v1/chat/completions` handler (line 1265-1398) reads `stream` from the body but ignores it, always returns JSON via `jsonify(dataclasses.asdict(response))`.

**Code ref**: `server/api_server.py:1337-1398`

---

## GAP CATEGORY 4: Regression Test Plan vs. Actual Test Coverage

### 4.1 Test Files Present

| File | Type | Lines |
|------|------|-------|
| `tests/test_protocol.py` | Unit | 244 |
| `tests/test_api_idempotency.py` | Integration | 224 |
| `tests/test_capture_heartbeat.py` | Integration | exists |
| `tests/test_claim_recovery.py` | Integration | exists |
| `tests/test_page_reuse.py` | Integration | exists |
| `tests/audit_2_sse_streaming.py` | Audit | exists |
| `tests/audit_03_conversation_context.py` | Audit | exists |
| `tests/audit_04_multiturn_idempotency.py` | Audit | exists |
| `tests/audit_05_concurrency_queue_lease.py` | Audit | exists |
| `tests/audit_10_adversarial.py` | Audit | exists |
| `tests/streaming_matrix_live.py` | Live | exists |

### 4.2 24-Hour Regression Plan vs. Actual Execution

- **Doc**: `docs/REGRESSION_24H_PLAN.md:23-44` — "必达" thresholds:
  1. ✅ Doubao short non-streaming 3x PASS (regression-summary confirms)
  2. ✅ Doubao refresh + short non-streaming (regression-summary confirms)
  3. ❌ "至少一个站点：真实短 SSE 通过" — regression summary says Doubao streaming PASS, but the actual `/v1/chat/completions` handler does NOT produce SSE
  4. ✅ "所有每轮结果写入 docs/regression/rounds/" — done

- **Doc**: `docs/REGRESSION_24H_PLAN.md:33-38` — "有条件达成":
  - ❌ 第二站点真实非流式闭环 — DeepSeek blocked by missing response selector
  - ❌ 同站点多轮 — not executed
  - ❌ 模型切换 — not executed (Qwen/Wenxin blocked)
  - ❌ 两个独立 conversation 并发 — not executed

### 4.3 Spec-Designed Test Cases vs. Actual

The redesign spec's test strategy (Sec 11, lines 2123-2615) defines 36+ test cases. Actual `test_protocol.py` has only 25. Missing from spec:

| Test | Spec Line | Actual |
|------|-----------|--------|
| `test_resolve_model_alias_overrides_direct` | 2188 | ❌ Missing |
| `test_messages_to_text_chinese` | 2289 | ✅ Built |
| `test_extract_tool_calls_openai_format` | 2375 | ❌ Missing |
| `test_extract_tool_calls_multiple_first_wins` | 2359 | ❌ Missing |
| `test_text_to_response_empty` | 2395 | ✅ Built |
| `test_text_to_response_with_toolcalls` | (in spec) | ✅ Built |
| SSE tests (multiple) | Sec 11.1 | ❌ Missing |
| Error handling tests | Sec 11.1 | ❌ Missing |
| Integration: `POST /v1/models` | Sec 11.2 | ❌ Missing |
| Integration: model CRUD | Sec 11.2 | ❌ Missing |

### 4.4 Regression Matrix: Strategy Coverage

From `docs/20-strategy-test-matrix-zh.md`:

| Strategy | Status in Docs | Status in Code | Test Coverage |
|----------|---------------|----------------|---------------|
| S1 MutationObserver | 🔧 Deployed | ✅ Working | ⚠️ Trace-based only |
| S2 Copy Button | 🔧 Deployed | ✅ Working | ⚠️ Trace-based only |
| S3 Stop Button | ❌ P0 Missing | ❌ NOT BUILT | ❌ None |
| S4 ARIA/Role | ⚠️ Partial | ⚠️ Partial | ❌ None |
| S5 DOM Text Diff | 🔧 Deployed | ✅ Working | audit_2_sse_streaming.py |
| S6 Network Intercept | ❌ Missing | ⚠️ CDP only (SSE body) | ❌ None |
| S7 Accessibility Tree | ❌ Missing | ❌ NOT BUILT | ❌ None |
| S8 Shadow DOM | ❌ Missing | ❌ NOT BUILT | ❌ None |
| S9 Iframe | ❌ Missing | ❌ NOT BUILT | ❌ None |
| S10 Clipboard | ⚠️ Partial | ⚠️ Permission only | ❌ None |
| S11 Page Source Hash | ⚠️ Partial | ⚠️ Trace has bodyLen | ❌ None |
| S12 React Fiber | ❌ Missing | ❌ NOT BUILT | ❌ None |
| S13 Virtual Row Merge | 🔧 Deployed | ✅ Working | ⚠️ Trace-based |
| S14 Gen Markers | ⚠️ Partial | ⚠️ Partial | ❌ None |
| S15 Quiet Windows | 🔧 Deployed | ✅ Working | ⚠️ Manual only |
| S16 Ports | ❌ Missing | ❌ NOT BUILT | ❌ None |
| S17 Polling Optimize | 🔧 Deployed | ✅ Working | audit_05 |
| S18 Direct Fetch | ❌ Missing | ❌ NOT BUILT | ❌ None |
| S19 Background Relay | 🔧 Deployed | ✅ Working | audit_05 |
| S20 Offscreen+CDP | ❌ Missing | ❌ NOT BUILT | ❌ None |

---

## GAP CATEGORY 5: Documented Strategies vs. Evidence of What Actually Works

### 5.1 What Actually Works (Regression Evidence)

From `docs/regression/REGRESSION_SUMMARY_20260722.md`:

| Claim | Evidence | Reality Check |
|-------|----------|---------------|
| Doubao short non-streaming 3/3 PASS | Trace-based via `/browser/result` POST | ✅ Documented as real Canary + real extension |
| Doubao streaming 3/3 PASS | SSE delta received | ⚠️ Claims SSE — but code shows the `/v1/chat/completions` handler does NOT produce SSE, only JSON |
| Doubao zero-state recovery PASS | Process restart then HTTP 200 | ✅ |
| Doubao long context FAIL | 1894-char prompts, no assistant node | ✅ Documented as real boundary |

### 5.2 Documented Strategies vs. Code Reality

| Strategy | What Docs Say | What Code Actually Does |
|----------|---------------|------------------------|
| "Universal Send Cascade" (RECORDED_STANDARD.md:12-24) | 4-stage: CDP Enter → synth Enter → auto-discover → recorded button | `content.js` does NOT use CDP `Input.dispatchKeyEvent`. It dispatches synthetic KeyboardEvent (line 51: `sendStrategy = { kind: 'enter', key: 'Enter', modifiers: [] }`). CDP Enter is NOT the default — content.js dispatches events directly. |
| "Selectors in model_routes.json only" | Config is sole source of truth | Selectors actually come from `selector_templates.json` AND extension's `chrome.storage.local` sync AND `model_routes.json`. Three sources. |
| "One submission budget" (universal-adapter-architecture.md:137) | Never re-submit | Code has retry logic: `background.js` `ensureContentScript()` retries selectors 3x (line 228), `content.js` `postBrowserResultWithRetry()` retries 3x (line 163). |
| "Provider capability catalog" (upstream-audit-report.md:176) | Full catalog with auth profiles | Only `model_routes.json` capability flags. No auth profile management, no cookie/session rotation. |
| "Transcript store with compaction" (upstream-audit-report.md:188-189) | JSONL/SQLite, partial runtime, tool-result pairing | Only `conversations.json` — flat user/assistant pairs. No compaction, no reset lineage. |
| "20 strategy response capture matrix" | 20 strategies documented | 6 partially working (S1, S2, S5, S13, S15, S17, S19); 14 missing or incomplete. |

### 5.3 Architectural Claims vs. Reality

| Claim (Source) | Reality |
|----------------|---------|
| "Phantom Relay is a transporter, not an agent runtime" (spec:42) | True — no tool execution, no agent loop |
| "Extension is sole browser channel, no CDP bypass" (spec:43) | Partially true — CDP IS used for network capture (background.js debugger.attach), but not for DOM manipulation |
| "protocol.py pure functions, zero side effects" (spec:45) | ✅ True — protocol.py is clean |
| "model_routes.json is sole config source" (spec:46) | ❌ False — dual config system |
| "No provider-specific code in core layer" (universal-adapter-architecture.md:122-131) | ❌ False — content.js has hardcoded Doubao/DeepSeek-specific CSS selectors in `classifyElement()` and `findUniversalSendButton()` |
| "Tab isolation per conversation" (upstream-audit-report.md:16) | ⚠️ Partial — tabs are reused via binding unless explicitly `new_tab=true` |

---

## Summary Statistics

| Category | Gaps Found | Critical (P0) | Major | Minor |
|----------|-----------|---------------|-------|-------|
| 1. Documented but unimplemented features | 15 | 2 (stop button, SSE streaming) | 8 | 5 |
| 2. Architectural contradictions | 7 | 3 (dual config, extension protocol parsing, deprecated file still active) | 3 | 1 |
| 3. Gateway redesign vs. current code | 10 design gaps | 2 (SSE engine, admin completeness) | 5 (api_server slimming, model CRUD, test endpoint, selector merge) | 3 |
| 4. Regression test plan vs. coverage | 12 test gaps | 1 (SSE endpoint testing) | 6 | 5 |
| 5. Strategy vs. evidence gaps | 8 discrepancies | 2 (CDP Enter claim, selector source of truth) | 4 | 2 |

**Most Dangerous Gaps**:
1. SSE streaming designed but NOT implemented in `/v1/chat/completions` — claims of SSE success in regression docs may be testing the legacy delta/result mechanism, not real SSE
2. Stop button detection completely missing (P0 audit finding, still unfixed)
3. Dual config system (legacy routes + model_routes.json) with conflicting data
4. `selector_templates.json` documented as "deprecated" but actively used
5. Admin model CRUD endpoints are stubs — return success but don't actually write config
