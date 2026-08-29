# Phantom Relay — Master Audit Summary (2026-07-30)

## 0. Product Direction (finalized)

**Bidi / ChromeDriver / Chrome Canary are TEST HARNESS only, not product architecture.**

Target product shape:
- user installs extension into their **real browser** (Chrome / Edge / Chromium-based browsers first)
- user runs **local backend only**
- runtime path must be:
  - extension content script + background
  - localhost backend
- NOT required at runtime:
  - WebDriver
  - BiDi
  - Chrome Canary
  - chromedriver

Therefore:
- browser host scripts are diagnostic/testing infrastructure
- production reliability must come from **extension + backend**, not from BiDi rescue logic

---

## 1. What was audited

Large parallel audit completed across:
- `extension/background.js`
- `extension/content.js`
- `extension/universal_bridge.js`
- `extension/popup.js`, `popup.html`, `manifest.json`
- `server/api_server.py`
- `server/protocol.py`
- `server/model_routes.json`
- `server/selector_templates.json`
- `scripts/*.py`, `*.sh`, `install.scpt`
- all tests and audit files
- all docs and plans/specs
- external research on:
  - MV3 behavior
  - Chrome extension DOM automation
  - localhost Python service stability

Generated reports:
- `tests/COVERAGE_ANALYSIS.md`
- `tests/AUDIT_SYNTHESIS_REPORT.md`
- `tests/ERROR_HANDLING_AUDIT_REPORT.md`
- `docs/gap-analysis-report.md`
- `docs/context-management-analysis.md`
- `docs/memory-leak-analysis.md`
- `server/model_routes_audit.md`
- `/Users/lingion_k/python-localhost-deployment-research.md`

---

## 2. Executive conclusion

The current system is **not blocked by one bug**. It is blocked by a **stack of architectural misplacements**:

### Root problem A — runtime depends too much on MV3 background state
Symptoms:
- `activeClaims` only in memory
- SW restart loses execution ownership
- page readiness and claim logic depend on background-worker continuity
- timers/intervals are used in places where MV3 suspension is expected

### Root problem B — extension runtime has two conflicting realities
1. **recorded-selector product path**
2. **debugger/CDP/BiDi recovery/testing path**

These overlap and fight each other.

### Root problem C — server state is entirely in-memory
- jobs
- queue
- clients
- deltas
- idempotency
- bindings
all vanish on restart

### Root problem D — config truth is split
- `model_routes.json` says one thing
- `selector_templates.json` actually drives execution
- admin APIs are mostly stubs
- documented gateway redesign is only partially implemented

---

## 3. High-confidence top blockers

### P0 block 1 — `/v1/chat/completions` does not really implement streaming
- `stream=true` is parsed but ignored
- SSE helper functions exist but are orphaned
- delta pipeline exists but is not consumed by response path

**Impact:** Cherry Studio / OpenAI-compatible streaming clients cannot rely on true streaming.

### P0 block 2 — claim/ready gating can deadlock the whole queue
- `claim_browser_job()` rejects tabs with `can_execute:false`
- content script / SW readiness race can leave tabs permanently non-claimable
- queue accumulates jobs that nobody can take

**Impact:** total request timeout even when browser page is open.

### P0 block 3 — result path is still vulnerable to state loss
- SW restart can lose in-memory claim state
- result relay has incomplete retry/idempotency behavior
- some failure paths report nothing back

**Impact:** response captured but API call still times out.

### P0 block 4 — storage/state growth is unbounded
- `BROWSER_JOBS`
- `BROWSER_QUEUE`
- `BROWSER_DELTAS`
- `page-trace.jsonl`
- `conversations.json`

**Impact:** degradation → memory bloat → disk bloat → eventual crash.

### P0 block 5 — security posture is too open for real-user deployment
- localhost API CORS `*`
- extension on `<all_urls>` + `*://*/*`
- plaintext local chat logs
- admin endpoints unauthenticated

**Impact:** unsafe for public/user distribution as-is.

---

## 4. Product-grade direction (what to keep vs discard)

## Keep
- recorded selector contract (`input` / `send` / `response`)
- content-script-first DOM execution
- backend queue + OpenAI-compatible HTTP surface
- protocol translation layer concept

## Demote to test-only
- BiDi host
- Chrome Canary
- ChromeDriver
- AppleScript installer
- debugger-assisted rescue as default runtime assumption

## Remove from runtime critical path
- dependence on SW in-memory state for ownership continuity
- dependence on `chrome.debugger` for normal send path
- dependence on server in-memory queue durability

---

## 5. Recommended architecture change

## Runtime architecture should become:

### Layer 1 — Backend = durable coordinator
Responsibilities:
- accept OpenAI-compatible request
- persist job to durable store (SQLite, not dict only)
- expose claim/result/delta endpoints
- stream SSE from durable delta channel
- keep per-job state durable across restart

### Layer 2 — Background SW = thin router only
Responsibilities:
- install/inject content script
- popup coordination
- optional route metadata sync
- **not** the owner of long-running job state

### Layer 3 — Content script = actual executor
Responsibilities:
- page readiness
- recorded selector execution
- send action
- response detection
- direct heartbeat / direct result / direct delta to localhost backend
- survive SW restart as much as possible

### Layer 4 — Testing harness (BiDi etc.) = completely optional
Responsibilities:
- automated regression
- cold-start diagnostics
- CI-ish local testing
- never part of product runtime assumptions

---

## 6. Immediate prioritized fix plan

## Phase 1 — stop lying / stop deadlocking
1. implement real SSE path for `stream=true`
2. make backend durable enough to survive restart (at least SQLite/shelve/sqlitedict for jobs + queue + bindings)
3. remove hard dependency on SW memory for result relay
4. stop queue deadlock on `can_execute:false`
5. prune completed/failed jobs and trace growth

## Phase 2 — make extension runtime real-user-safe
6. reduce host permissions from `<all_urls>` to explicit AI domains
7. restrict localhost CORS to extension origin(s)
8. add auth/secret for admin and mutating backend routes
9. make popup recording flow actually honor send strategy
10. remove/optionalize `debugger` from default published runtime if possible

## Phase 3 — unify truth
11. make `selector_templates.json` the execution truth explicitly
12. either remove dead selectors from `model_routes.json` or build an explicit sync layer
13. make admin CRUD real or remove fake UI
14. enforce `max_input_chars` / `context_window` / tool capability fields for real

## Phase 4 — long-context correctness
15. add context window enforcement / truncation policy
16. add file upload path or remove advertised capability
17. normalize tool result formatting and multi-tool behavior
18. eliminate duplicate/contradictory tool-call parsers

---

## 7. What is currently misleading / fake / half-built

### Fake or stubbed
- admin create/update/delete model APIs
- stream=true support
- many model capability fields (declared, not enforced)
- idempotency system (partially built, not wired end-to-end)
- model_routes selectors as live execution data

### Contradictory
- docs say protocol redesign complete; runtime still split old/new
- `model_routes.json` and `selector_templates.json` overlap but do not reconcile
- popup UI suggests send strategy recording exists; current handler path breaks it

---

## 8. External research conclusions

### DOM automation in real browsers
Best production path is still:
- native input value setter + `input/change`
- full pointer/mouse sequence for click
- MutationObserver + message identity for response tracking
- content script on real pages

### Important conclusion
`chrome.debugger` is publishability-risky. It may be acceptable for testing or optional advanced mode, but it is a poor default dependency for a broadly installable extension.

### Backend stability
Best practical next step:
- keep launchd on macOS
- move in-memory queue/state into durable local store
- add health endpoint + restart-safe recovery

---

## 9. Final product judgment

### What Phantom Relay is good at already
- recorded-selector idea is correct
- transparent relay direction is correct
- content-script execution model is the right product path
- protocol layer concept is salvageable

### What is currently wrong
- too much engineering energy went into test harness survival
- not enough into runtime truth: durable queue, true SSE, direct executor reliability, security boundaries

---

## 10. One-sentence decision

**From here on, Phantom Relay should be rebuilt around: durable backend + content-script executor + recorded selectors, with SW and BiDi downgraded from “runtime dependency” to “support tooling.”**
