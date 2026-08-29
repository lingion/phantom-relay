# Phantom Relay — Local Bug Tracker (2026-07-30)

> Purpose: local continuously-updated issue ledger for reproduced bugs and audit findings.
> Scope: product runtime first (extension + local backend), test harness second (BiDi/ChromeDriver/Canary).

---

## Status legend
- `REPRODUCED` = reproduced with direct evidence
- `AUDITED` = found by source audit / static trace / architectural analysis
- `OPEN` = not fixed
- `FIXED` = fixed in code
- `WONTFIX-TESTHARNESS` = issue belongs to BiDi/Canary test tooling, not runtime product path

---

## Priority framing

### Runtime product path
- extension in real user browser
- localhost backend

### Test harness only
- BiDi
- ChromeDriver
- Chrome Canary
- AppleScript installer

---

# A. Reproduced bugs

## A1. `stream=true` does not return SSE
- Status: `REPRODUCED` `OPEN`
- Severity: P0
- Runtime path: backend
- Evidence date: 2026-07-30
- Repro method:
  - invoked `/v1/chat/completions`
  - forced completed job in-process to avoid browser wait
  - requested `stream: true`
- Actual result:
  - HTTP 200
  - `Content-Type: application/json`
  - body is single JSON completion, not `text/event-stream`
- Expected result:
  - SSE chunks with `data: ...\n\n`
  - final `data: [DONE]\n\n`
- Key files:
  - `server/api_server.py`
  - `server/protocol.py`
- Notes:
  - `stream` is parsed but response path still returns `jsonify(...)`
  - SSE helper functions exist but are orphaned

## A2. Claim/readiness gate prevents queued jobs from being claimed
- Status: `REPRODUCED` `OPEN`
- Severity: P0
- Runtime path: extension + backend
- Evidence date: 2026-07-30
- Repro method:
  - checked `/browser/status`
  - found real client heartbeat with:
    - `can_execute: false`
    - `can_observe: false`
  - confirmed pending queued Doubao job in `/browser/pending-domains`
  - posted `/browser/poll` using real `domain` + `tab_id`
- Actual result:
  - `/browser/poll` returned `{"job": null}`
  - queued job remained unclaimed
- Expected result:
  - queued job should either be claimable or transition into a recoverable state
- Key files:
  - `server/api_server.py` (`claim_browser_job` capability gate)
  - `extension/background.js`
  - `extension/content.js`
- Notes:
  - this is a direct explanation for “browser open but API keeps timing out”

## A3. Popup send-strategy flow is disconnected
- Status: `REPRODUCED` `OPEN`
- Severity: P0
- Runtime path: extension popup
- Evidence date: 2026-07-30
- Repro method:
  - static proof from source
- Evidence:
  - `popup.html` step-2 button uses `data-role="send_strategy"`
  - `popup.js` binds `btnSend` to `handleRecord('send')`
  - `handleRecord()` only enters send-strategy logic when `role === 'send_strategy'`
- Actual result:
  - step-2 send strategy UI exists but click path bypasses intended branch
- Expected result:
  - step-2 should call `handleRecord('send_strategy')`
- Key files:
  - `extension/popup.html`
  - `extension/popup.js`

## A4. Admin CRUD endpoints return success but do not persist any change
- Status: `REPRODUCED` `OPEN`
- Severity: P1
- Runtime path: backend admin
- Evidence date: 2026-07-30
- Repro method:
  - captured SHA256 of `server/model_routes.json`
  - called:
    - `POST /admin/api/models` with new model id `zzz-test-model`
    - `PUT /admin/api/models/doubao`
    - `DELETE /admin/api/models/doubao`
  - re-read `server/model_routes.json`
  - re-fetched `/admin/api/models`
- Actual result:
  - POST returned `201 {"model":"zzz-test-model","status":"ok"}`
  - GET after POST did **not** include `zzz-test-model`
  - PUT returned 200 ok
  - DELETE returned 200 ok
  - file hash before/after stayed identical
- Expected result:
  - create/update/delete should modify runtime state and persisted config
- Key files:
  - `server/api_server.py`
  - `server/model_routes.json`

## A5. `max_input_chars` is dead field and oversized payloads are accepted
- Status: `REPRODUCED` `OPEN`
- Severity: P1
- Runtime path: backend protocol path
- Evidence date: 2026-07-30
- Repro method:
  - used in-process test client for `/v1/chat/completions`
  - sent `model="doubao"` with user content length `9001`
  - model config for Doubao declares `max_input_chars: 8000`
  - intercepted `new_browser_job(...)` to capture actual prompt length
- Actual result:
  - request returned HTTP 200
  - created browser job message length was `9007`
  - no validation error, no truncation, no rejection
- Expected result:
  - request should be rejected, truncated, or rerouted via file-upload path according to model capability
- Key files:
  - `server/model_routes.json`
  - `server/api_server.py`
  - `server/protocol.py`

## A6. Localhost API CORS is fully open to arbitrary web origins
- Status: `REPRODUCED` `OPEN`
- Severity: P0
- Runtime path: backend security boundary
- Evidence date: 2026-07-30
- Repro method:
  - sent requests with `Origin: https://evil.example`
  - checked response headers on:
    - `/health`
    - `/admin/api/models`
- Actual result:
  - both returned:
    - `Access-Control-Allow-Origin: *`
    - `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
- Expected result:
  - localhost API should be restricted to extension origin(s) or authenticated trusted clients
- Key files:
  - `server/api_server.py`

## A7. Long-conversation real request returns polluted/wrong answer
- Status: `REPRODUCED` `OPEN`
- Severity: P1
- Runtime path: real browser + real backend context handling
- Evidence date: 2026-07-31
- Repro method:
  - sent real `/v1/chat/completions` request with 20+ historical turns
  - final user question asked the model to answer only remembered digits
- Actual result:
  - HTTP 200
  - returned unrelated weather-style answer content instead of the requested memory summary
- Expected result:
  - answer should follow the final conversation context, not leak/continue unrelated prior page state
- Interpretation:
  - real runtime still has context contamination / page-state contamination risk
- Key files:
  - `server/protocol.py`
  - `server/api_server.py`
  - `extension/content.js`

## A8. Multimodal/file-upload request silently drops non-text parts
- Status: `REPRODUCED` `OPEN`
- Severity: P1
- Runtime path: request normalization / file-upload capability
- Evidence date: 2026-07-31
- Repro method:
  - sent real `/v1/chat/completions` request with content array:
    - text part
    - `image_url` part
- Actual result:
  - HTTP 200
  - assistant returned only the text instruction result (`FILE_UPLOAD_TEST`)
  - image part was silently ignored
- Expected result:
  - image/file part should be processed, uploaded, or explicitly rejected
- Interpretation:
  - advertised file/vision path is still fake at runtime
- Key files:
  - `server/api_server.py`
  - `server/model_routes.json`

## A9. Selector truth mismatch is real for qwen-turbo
- Status: `REPRODUCED` `OPEN`
- Severity: P1
- Runtime path: model config vs execution template truth
- Evidence date: 2026-07-31
- Repro method:
  - compared real config files on disk
- Actual result:
  - `model_routes.json`: `qwen-turbo -> tongyi.aliyun.com`
  - `selector_templates.json`: no `tongyi.aliyun.com` entry
  - therefore runtime template lookup for qwen domain has no recorded selector truth
- Expected result:
  - every routable execution domain should have matching recorded selector template truth
- Key files:
  - `server/model_routes.json`
  - `server/selector_templates.json`

## A10. Long conversation on fresh-page path now fails with `response_timeout`
- Status: `REPRODUCED` `OPEN`
- Severity: P1
- Runtime path: real browser + real backend long-context execution
- Evidence date: 2026-07-31
- Repro method:
  - after switching API jobs to fresh-page/new-tab execution by default
  - sent real 20+ turn request to `/v1/chat/completions`
- Actual result:
  - HTTP 502
  - `{"error":{"code":"browser_error","message":"response_timeout","type":"server_error"}}`
- Expected result:
  - long pure-text request should complete, not die in response extraction
- Interpretation:
  - context contamination was reduced, but long-context stability is still not solved
- Key files:
  - `server/api_server.py`
  - `extension/content.js`

## A11. `deepseek-chat` real backend path still times out
- Status: `REPRODUCED` `OPEN`
- Severity: P1
- Runtime path: alternate model/tool-capable path
- Evidence date: 2026-07-31
- Repro method:
  - real `/v1/chat/completions` request with `model=deepseek-chat`
  - tested both plain text and `tool_choice=none`
- Actual result:
  - both requests timed out at 120s
- Expected result:
  - tool-capable model path should complete or fail fast with explicit reason
- Interpretation:
  - current real stable path is still effectively Doubao-first
- Key files:
  - `server/model_routes.json`
  - runtime browser/execution path

---

# B. Highest-confidence runtime bugs from audit

## B1. Backend state is in-memory only
- Status: `AUDITED` `OPEN`
- Severity: P0
- Runtime path: backend
- Impact:
  - restart loses jobs
  - restart loses queue
  - restart loses bindings
  - restart loses deltas
  - restart loses client state
- Key file:
  - `server/api_server.py`

## B2. `model_routes.json` and `selector_templates.json` are split truths
- Status: `AUDITED` `OPEN`
- Severity: P0
- Runtime path: backend + extension
- Impact:
  - `selector_templates.json` is actual execution truth
  - `model_routes.json` selectors are mostly dead data
  - admin/UI/config become misleading
- Key files:
  - `server/model_routes.json`
  - `server/selector_templates.json`
  - `server/api_server.py`

## B3. `stream=true` infrastructure exists but is not wired end-to-end
- Status: `AUDITED` `OPEN`
- Severity: P0
- Runtime path: backend
- Impact:
  - OpenAI-compatible streaming clients cannot rely on protocol behavior
- Key files:
  - `server/api_server.py`
  - `server/protocol.py`

## B4. Queue/resource growth is unbounded
- Status: `AUDITED` `OPEN`
- Severity: P0
- Runtime path: backend
- Impact:
  - memory bloat
  - queue scan slowdown
  - disk growth via `page-trace.jsonl`
  - eventual crash / timeouts
- Key files:
  - `server/api_server.py`
  - `docs/memory-leak-analysis.md`

## B5. Security posture unsafe for user distribution
- Status: `AUDITED` `OPEN`
- Severity: P0
- Runtime path: extension + backend
- Impact:
  - localhost API readable from arbitrary webpages due to permissive CORS
  - extension injects on all URLs
  - plaintext chat logs on disk
- Key files:
  - `server/api_server.py`
  - `extension/manifest.json`

---

# C. Important protocol/config/runtime gaps

## C1. `max_input_chars` not enforced
- Status: `AUDITED` `OPEN`
- Severity: P1
- Key files:
  - `server/model_routes.json`
  - `server/api_server.py`
  - `server/protocol.py`

## C2. `context_window` not enforced
- Status: `AUDITED` `OPEN`
- Severity: P1

## C3. `file_upload` capability is declared but non-functional
- Status: `AUDITED` `OPEN`
- Severity: P1

## C4. Admin CRUD endpoints are mostly stubs / fake success
- Status: `AUDITED` `OPEN`
- Severity: P1
- Key file:
  - `server/api_server.py`

## C5. Tool-call parsing is duplicated and divergent
- Status: `AUDITED` `OPEN`
- Severity: P1
- Paths:
  - content script parses tool calls one way
  - server reparses tool calls another way

---

# D. Test harness issues (not product-core)

## D1. BiDi/Canary/browser-host instability
- Status: `AUDITED` `OPEN` `WONTFIX-TESTHARNESS` (unless needed for regression tooling)
- Severity: P1 for testing, not runtime product
- Notes:
  - keep for regression tooling only
  - not a valid reason to distort product architecture

## D2. AppleScript installer targets wrong browser family/path assumptions
- Status: `AUDITED` `OPEN` `WONTFIX-TESTHARNESS`
- Severity: P1 for tooling

---

# E. Next repro candidates

## E1. model_routes selectors are dead data
- Target: reproduce by editing `model_routes.json` selectors and observing no runtime effect
- Status: `OPEN`

## E2. Admin CRUD is fake write-success
- Target: call admin POST/PUT/DELETE and confirm file/state unchanged
- Status: `OPEN`

## E3. `max_input_chars` dead field
- Target: submit oversized payload beyond configured limit and observe no enforcement
- Status: `OPEN`

## E4. File upload capability false advertising
- Target: send multi-part / multimodal content and observe image/file parts dropped
- Status: `OPEN`

## E5. CORS `*` local API exposure
- Target: reproduce with browser page fetch against localhost API
- Status: `OPEN`

---

# F. Related audit reports

- `docs/MASTER_AUDIT_SUMMARY_20260730.md`
- `docs/gap-analysis-report.md`
- `docs/context-management-analysis.md`
- `docs/memory-leak-analysis.md`
- `tests/COVERAGE_ANALYSIS.md`
- `tests/AUDIT_SYNTHESIS_REPORT.md`
- `tests/ERROR_HANDLING_AUDIT_REPORT.md`
- `server/model_routes_audit.md`
- `/Users/lingion_k/python-localhost-deployment-research.md`

---

# G. Product decision checkpoint

Current conclusion remains:

**Phantom Relay should move toward**
- durable backend state
- content-script executor as runtime owner
- recorded selectors as execution truth
- SW as thin coordinator
- BiDi/ChromeDriver/Canary as optional regression tooling only

---

# H. Update rule for this file

When a new issue is found:
1. if directly proven by execution/logs/http/codepath, add under section A or E and mark `REPRODUCED`
2. if from source audit only, add under B/C/D and mark `AUDITED`
3. if fixed, keep the record and add `FIXED` with date + commit reference

---

# I. Fixed items verified by real backend + real browser

## I1. Popup send-strategy entry path fixed
- Status: `FIXED`
- Verification date: 2026-07-31
- Fix:
  - `extension/popup.js`
  - `btnSend` now calls `handleRecord('send_strategy')`
- Notes:
  - this fixes the step-2 UI routing bug recorded as A3

## I2. `max_input_chars` basic enforcement fixed
- Status: `FIXED`
- Verification date: 2026-07-31
- Real backend test:
  - request to real `http://127.0.0.1:8765/v1/chat/completions`
  - `model=doubao`
  - payload content length `9001`
- Real result:
  - HTTP 400
  - `code=input_too_long`
- Notes:
  - this fixes A5 at the basic validation layer
  - no auto file-upload fallback yet

## I3. Admin CRUD now really persists `model_routes.json`
- Status: `FIXED`
- Verification date: 2026-07-31
- Real backend test:
  - `POST /admin/api/models`
  - `PUT /admin/api/models/<id>`
  - `DELETE /admin/api/models/<id>`
- Real result:
  - new model visible via `GET /admin/api/models`
  - file contents changed on disk
  - update visible after PUT
  - model gone after DELETE
- Notes:
  - this fixes A4

## I4. Real non-stream `/v1/chat/completions` path works again
- Status: `FIXED`
- Verification date: 2026-07-31
- Real browser + real backend test:
  - `POST /v1/chat/completions`
  - `model=router`
  - message `hi`
- Real result:
  - HTTP 200
  - assistant content `Hi`
- Supporting runtime changes:
  - removed bad claim hard-gate on stale `can_execute/can_observe`
  - startup re-primes open tabs
  - restored logged-in test profile from real Canary profile
  - forced fresh extension reload in test host
  - reduced CDP send-message hang via timeout fallback

## I5. Real `stream=true` SSE path works again
- Status: `FIXED`
- Verification date: 2026-07-31
- Real browser + real backend test:
  - `POST /v1/chat/completions`
  - `model=router`
  - `stream=true`
- Real result:
  - HTTP 200
  - `Content-Type: text/event-stream; charset=utf-8`
  - actual body observed:
    - assistant role chunk
    - content chunk `Hi`
    - finish chunk with `stop`
    - final `[DONE]`
- Notes:
  - this fixes A1 at the externally visible protocol level
  - current implementation is still completion-buffered SSE, not true incremental browser-to-client token streaming

## I6. Runtime blockers discovered and fixed during real recovery
- Status: `FIXED`
- Verification date: 2026-07-31
- Fixed blockers:
  1. stale capability hard-gate in `claim_browser_job`
  2. no proactive re-prime of already-open tabs after backend restart
  3. `cdp_dispatch_key` request could stall too long before fallback
  4. `findUniversalSendButton` crashed on non-string `className` (`SVGAnimatedString`)
- Real effect:
  - queue no longer deadlocked at the first gate
  - real browser client reconnected to backend
  - real request completed successfully

## I7. Fresh-page execution is now the default for API requests
- Status: `FIXED`
- Verification date: 2026-07-31
- Fix:
  - API requests now default to `new_tab=True` unless `phantom_relay.reuse_page=true`
  - background tab-selection logic no longer reuses same-domain tabs when the job explicitly requests a fresh page
- Real effect:
  - reduced page-state contamination on short text requests
  - short pure-text path now returns correct answers more consistently
- Notes:
  - long-context path is still unstable (see A10)

## I8. Basic tool policy enforcement added
- Status: `FIXED`
- Verification date: 2026-07-31
- Fixes:
  - if request supplies tools to a non-tool-capable model, backend now returns 400 `unsupported_tools`
  - if `tool_choice='required'` but no tools are supplied, backend now returns 400 `missing_tools`
  - if content script already captured a structured tool call, backend now prefers that over reparsing raw text
- Real verification:
  - real backend request to `doubao` + `tools=[...]` now returns HTTP 400 `unsupported_tools`
- Notes:
  - true real tool-capable success path is still not verified because `deepseek-chat` real path still times out (A11)
