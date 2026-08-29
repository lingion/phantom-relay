# Phantom Relay — Concurrency & Race Condition Analysis

**Project:** Phantom Relay v3
**Date:** 2026-07-30
**Scope:** All components — `api_server.py`, `background.js`, `content.js`, `protocol.py`
**Threading Model:** Multi-threaded Flask (server), single-threaded JS event-loop (extension), isolated-world content scripts (per-tab)

---

## Severity Definitions

| Level | Definition |
|-------|-----------|
| **P0** | Data corruption, state loss, double-execution, or deadlock with high probability |
| **P1** | State inconsistency, lost updates, silent failures — moderate probability or limited blast radius |
| **P2** | Counter-intuitive behavior, resource leaks, degraded UX — unlikely or self-healing |

---

## P0 — Critical

### P0-1: BROWSER_QUEUE double-append causing duplicated claim_token

**File:** `server/api_server.py`
**Components:** `reap_expired_browser_jobs()` (L722), `purge_stale_browser_state()` (L489), `claim_browser_job()` (L757)

**Root Cause:** `BROWSER_QUEUE` is a list (not a set), and two separate lock-acquisition windows can each append the same job ID.

**Scenario:**
1. Thread A: `browser_poll()` → `reap_expired_browser_jobs()` acquires LOCK → re-queues job `J1` (lease expired) → `BROWSER_QUEUE.append("J1")` → releases LOCK
2. Thread B: `browser_clients()` → `purge_stale_browser_state()` acquires LOCK → detects tab disconnected for `J1` → `BROWSER_QUEUE.append("J1")` → releases LOCK  
3. Thread C: `browser_poll()` → `claim_browser_job()` acquires LOCK → dequeues first `J1` → claims it (status="claimed", claim_token=`TK1`) → releases LOCK
4. Thread D: `browser_poll()` → `claim_browser_job()` acquires LOCK → dequeues second `J1` → status already "claimed" → `BROWSER_QUEUE.remove("J1")` → skips (benign here)
5. BUT if `reap_expired_browser_jobs()` runs AGAIN between steps 3-4 and re-queues `J1` AGAIN (lease expires while in duplicate-queue state) → second `claim_browser_job` call on D **would** claim it → **new claim_token `TK2` generated** → Content script using `TK1` will be rejected by `validate_job_actor`

**Impact:** Job claim_token invalidated mid-execution, content script result rejected with 409, user request fails with timeout. Requires coincident timing but the queue-structure allows it.

**Fix:** Use a `set` for `BROWSER_QUEUE` (Python 3.7+ dict ordering for sets is insertion-ordered). OR use `collections.OrderedDict.fromkeys(queue).keys()` for ordered uniqueness.

```python
# Replace:
BROWSER_QUEUE = []
# With:
BROWSER_QUEUE = []  # list for ordering
BROWSER_QUEUE_SET = set()  # for O(1) membership
# And in all append/remove sites maintain both.
```

**Affected Lines:** L33, L504-505, L726-727, L754-755, L770, L773, L946

---

### P0-2: chat_completions reads BROWSER_EVENTS outside lock — race with browser_reset

**File:** `server/api_server.py`
**Components:** `chat_completions()` L1359, `browser_reset()` L939-947

**Root Cause:** `BROWSER_EVENTS.get(job["id"])` at L1359 is NOT under `BROWSER_LOCK`. `browser_reset` pops and sets events under lock. Between `get()` and `ev.wait()`, reset can pop the event.

**Scenario:**
1. Thread A: `chat_completions()` — L1359: `ev = BROWSER_EVENTS.get(job["id"])` → gets event object reference
2. Thread B: `browser_reset()` → acquires LOCK → `BROWSER_EVENTS.pop(jid, None)` → calls `ev.set()` → releases LOCK
3. Thread A: L1360: `ev.wait(timeout_sec)` → event was already set by B, returns `True` immediately
4. Thread A: L1365: reads `BROWSER_JOBS.get(job["id"])` → job status is "failed" (set by reset)
5. Thread A: L1368: `final["status"] != "completed"` → returns error 502 with "reset"

**Impact:** Legitimate request returns an error after the browser completed it. The response is lost because the API server "reset" was called (likely during debugging/admin). Moderate severity because it requires concurrent reset.

**Fix:** Hold `BROWSER_LOCK` when reading `BROWSER_EVENTS`. After event fires, re-validate job status under lock before reading the result.

---

### P0-3: SW Eviction between claim and dispatch — content script captures for a dead SW

**File:** `extension/background.js`
**Components:** `browserBridgeTick()` L447-645, `browser_result_relay` handler L698-740

**Root Cause:** MV3 Service Worker can be evicted at any async `await` boundary. Between `activeClaims.set()` (L557) and the content script completing `autoCapture`, the SW may restart with an empty `activeClaims` Map.

**Scenario:**
1. SW: `browserBridgeTick()` → claims job → `activeClaims.set(jobId, {...})` at L557 → dispatches `chrome.tabs.sendMessage({action:'auto_capture', ...})` at L605
2. SW evicted — `activeClaims` lost
3. Content script finishes capture → sends `{type:'browser_result_relay', payload:{job_id, tab_id, domain, ...}}`
4. SW restarts → handler at L698 runs → `activeClaims.get(jobId)` = `undefined`
5. L703: `canRecoverClaim` = `true` (payload has job_id, tab_id, domain)
6. L714: `sourceClaim = claim || msg.payload` → falls to `msg.payload`
7. L715: `!sourceClaim?.claim_token` → true → fetches `/browser/result-token` to recover token
8. If server has reaped the job → recovery fails → result lost

**Impact:** Moderate — the recovery path at L714-727 exists and works in most cases. However, if the server has *also* reaped the job in the same window, the result is permanently lost and the API client gets `browser_timeout`.

**Current Mitigation:** The content script retries 3 times (L163, `postBrowserResultWithRetry`), and the SW fallback recovery at L703-727 handles the claim_token reacquisition.

**Fix:** Persist `activeClaims` to `chrome.storage.session` (survives SW restart but not browser restart). OR: reduce reliance on in-memory `activeClaims` by always recovering from server (which the fallback already does).

---

### P0-4: DOM lock leak on content script re-injection during autoCapture

**File:** `extension/content.js`
**Components:** `autoCapture()` L632-1056, `ensureContentScript()` background.js L216

**Root Cause:** The DOM-based capture lock (`data-phantom-relay-capture-lock`, L660-664) is set by `document.documentElement.setAttribute()`. When `chrome.scripting.executeScript` reloads content.js, the old execution context is torn down — its `finally` block (L1046-1055) never executes. The stale DOM attribute persists permanently for the lifetime of the page.

**Scenario:**
1. Content script starts `autoCapture()` → sets `captureLock` attribute at L664
2. MV3 SW restarts, `ensureContentScript()` detects version mismatch → calls `chrome.scripting.executeScript` to re-inject `content.js`
3. Old content.js context destroyed — `finally` block NOT executed
4. New content.js initializes → `autoCapture()` called → L661: `document.documentElement.hasAttribute(captureLock)` → `true` → returns `{error:'capture_in_flight'}`
5. Tab is permanently un-capturable until page refresh

**Impact:** After a single failed capture concurrent with extension reload, the tab is deadlocked. Requires full page refresh.

**Fix:** In the content script initialization, check if the capture lock exists AND whether the owning generation is still alive. If the generation doesn't match the current one, clear the stale lock:

```javascript
if (document.documentElement.hasAttribute(captureLock)) {
  const lockGen = parseInt(document.documentElement.getAttribute(captureLock), 10);
  if (!window.__phantomRelayGeneration || lockGen !== window.__phantomRelayGeneration) {
    document.documentElement.removeAttribute(captureLock);
    clearInterval(captureHeartbeatInterval); // also clean up stale intervals
  } else {
    return { error: 'capture_in_flight' };
  }
}
```

---

## P1 — High

### P1-1: TOCTOU in browser_result claim recovery — validate_job_actor reads stale state

**File:** `server/api_server.py`
**Components:** `browser_result()` L1159-1187

**Root Cause:** `browser_result` acquires `BROWSER_LOCK` three separate times: once for claim recovery (L1160), once for queued recovery (L1177), and once inside `validate_job_actor` (L1187). Between acquisitions, another thread's `reap_expired_browser_jobs` or `finish_browser_job` can change the job state.

**Scenario:**
1. Thread A: `browser_result()` — L1160-1175: recovers claim_token from job `J1` (status="claimed", claim_token=`TK1`)
2. Thread B: `reap_expired_browser_jobs()` → sets `J1` to status="queued", claim_token=`TK2`
3. Thread A: L1177-1186: validates claim_token match — `TK1 !== TK2` → fails → skips queued recovery
4. Thread A: L1187: `validate_job_actor` with `require_claimed=True` → `job.get("status") != "claimed"` → returns `"job_not_claimed"` → **409 error**

**Impact:** Legitimate browser result is rejected. Content script retries 3 times; by then the job has been re-claimed by another poll, and the second claim's token mismatch causes permanent failure.

**Fix:** All three lock-guarded sections should be combined into a single lock acquisition. The claim recovery and validation should be atomic.

```python
def browser_result():
    ...
    with BROWSER_LOCK:
        # Claim recovery
        ...
        # Queued recovery
        ...
        # Validation
        actor_job, actor_error = _validate_job_actor_locked(body)
    ...
```

---

### P1-2: validate_tool_call_for_job reads actor_job outside lock

**File:** `server/api_server.py` L660-681, L1202

**Root Cause:** `validate_tool_call_for_job()` at L669 reads `job.get('request_meta')` but is called AFTER `validate_job_actor` released the lock. Between the validation and this read, the job could be finished/reaped.

**Scenario:**
1. Thread A: `browser_result()` → `validate_job_actor` → returns actor_job under lock → releases lock
2. Thread B: `reap_expired_browser_jobs()` → claims and re-queues job → `request_meta` potentially cleared
3. Thread A: `validate_tool_call_for_job(actor_job, ...)` → reads stale `request_meta` → validates against wrong tool set

**Impact:** Low probability. The `actor_job` is a dict reference — mutations by Thread B are visible to Thread A. But `reap` sets status but doesn't touch `request_meta`. `finish_browser_job` also leaves `request_meta` intact. So this is mostly a theoretical concern unless the dict entry is explicitly deleted elsewhere.

**Fix:** Clone the relevant fields from `actor_job` during the lock-guarded `validate_job_actor` call.

---

### P1-3: browser_result() creates daemon thread for save_conversation — concurrent file writes

**File:** `server/api_server.py` L1224-1230, L1391-1396

**Root Cause:** `save_conversation` acquires `CONVERSATION_LOCK` (L851), but multiple daemon threads can be started concurrently. While `CONVERSATION_LOCK` protects the `load_data() → modify → save_data()` cycle, the file I/O itself is not transactional.

**Scenario:**
1. Two browser results finish at the same time
2. Two daemon threads start `save_conversation`
3. Thread A acquires `CONVERSATION_LOCK` → loads data → appends conversation → saves data → releases lock
4. Thread B acquires `CONVERSATION_LOCK` → loads data → appends conversation → saves data → releases lock
5. ✅ This is safe because of the lock

BUT: `save_conversation` in browser_result passes `actor_job.get("message")` etc. from outside the lock. If the job was reaped, actor_job might have stale data. The conversation itself is still valid (user message + assistant response from the body), but the job_id could be wrong.

**Impact:** Low — conversation storage is best-effort. Wrong job_id in conversations.json is a cosmetic issue.

---

### P1-4: browserBridgeTick pollInFlight guard — non-atomic at function entry

**File:** `extension/background.js` L447-449

**Root Cause:** While JavaScript's single-threaded event loop makes synchronous code atomic, `browserBridgeTick` is `async`. The guard:
```javascript
if (browserPollInFlight) return;
browserPollInFlight = true;
```
is only safe because no `await` occurs between the two lines. However, if a future code change inserts an `await` between them, it becomes a TOCTOU.

**Current Status:** SAFE for existing code — the first `await` is at L456.

**Fix:** Document that no async operation should be inserted between the guard and the assignment. OR use a wrapper pattern:
```javascript
if (browserPollInFlight) return;
browserPollInFlight = true;
try { await _browserBridgeTick(); } finally { browserPollInFlight = false; }
```

---

### P1-5: POLL_LAST rate limiter not under BROWSER_LOCK

**File:** `server/api_server.py` L1137-1142

**Root Cause:** `POLL_LAST[poll_key] = now` at L1142 modifies a shared dict without lock protection.

**Scenario:**
1. Thread A reads `POLL_LAST.get(poll_key, 0.0)`, passes rate limit
2. Thread B reads `POLL_LAST.get(poll_key, 0.0)`, passes rate limit
3. Both proceed to `claim_browser_job()`
4. Only one gets the job under LOCK, other gets None

**Impact:** Benign — the rate limiter is advisory. A second poll that passes the limiter will simply get no job from `claim_browser_job`. However, since `time.monotonic()` is used, the dict write itself is safe (CPython GIL protects simple dict writes).

**Fix:** Move under `BROWSER_LOCK` for correctness, or use `threading.local()`.

---

## P2 — Low

### P2-1: SW setInterval (2s) vs alarm (10.2s) vs page_ready timeouts — triple trigger waste

**File:** `extension/background.js` L673-686, L659-661, L837

**Root Cause:** `browserBridgeTick()` is triggered by:
1. Alarm every 10.2s (L673-675)
2. `setInterval` every 2s (L680-685)  
3. `page_ready` handler: 4 staggered `setTimeout` calls at 0, 1s, 3s, 7s (L837)
4. `tabs.onUpdated` → `scheduleBrowserBridgeTick(0)` (L665)
5. `tabs.onCreated` → `scheduleBrowserBridgeTick(250)` (L669)
6. `tabs.onActivated` → `scheduleBrowserBridgeTick(250)` (L671)

The `browserPollInFlight` guard prevents concurrent execution, but the excessive scheduling wastes CPU wake-ups.

**Impact:** Minor — each wake-up is cheap (just checks `browserPollInFlight` and returns). Redundant scheduling.

**Fix:** Consolidate timers. Use alarm only as the reliable periodic trigger. Use event-driven triggers (tab updates, page_ready) for responsive polling. Remove `setInterval` — it's completely redundant with the alarm.

---

### P2-2: captureHeartbeatInterval leak on content script premature destruction

**File:** `extension/content.js` L678-686, L1046

**Root Cause:** `captureHeartbeatInterval` is created at L678 and cleared in the `finally` block at L1046. If the content script's context is destroyed (via `executeScript` re-injection) before the `finally` block runs, the interval continues firing via the background SW's message listener — but the `chrome.runtime.sendMessage` calls will fail silently.

**Impact:** Negligible — the interval fires every 5s and calls fail silently. No resource leak beyond a dropped message every 5s. Self-clears when the tab closes or script next re-injects.

---

### P2-3: browserBridgeTick `bridgeWakeTimer` and `scheduleBrowserBridgeTick` idempotency

**File:** `extension/background.js` L647-654

**Root Cause:** `scheduleBrowserBridgeTick` creates a `setTimeout` but the `bridgeWakeTimer` variable is not cleared if the SW is evicted before the timeout fires. On restart, `bridgeWakeTimer` is reset to `null` (globals reinitialize), so this is self-healing.

**Impact:** None — SW restart resets all globals. Within a single SW session, the guard prevents duplicate timers.

---

### P2-4: API server restart — all in-memory state lost

**File:** `server/api_server.py`

**Root Cause:** `BROWSER_JOBS`, `BROWSER_QUEUE`, `BROWSER_CLIENTS`, `BROWSER_BINDINGS`, `BROWSER_READY`, `BROWSER_EVENTS`, `BROWSER_DELTAS`, `IDEMPOTENCY`, `POLL_LAST`, `activeClaims`, `pendingTabCreation` — all in-process memory, lost on restart.

**Scenario:**
1. Server has 3 queued jobs, 1 claimed job
2. API server restarts
3. All jobs disappear → API clients get 504 timeout after `timeout_sec`
4. SW polls → gets no jobs → re-registers heartbeat → eventually picks up new jobs

**Impact:** In-flight requests time out. No data corruption, but poor UX during server restart. Extension self-heals on next poll. Selectors persist to disk via `selector_templates.json`.

**Mitigation:** This is inherent in the architecture. The extension's retry logic covers most cases. For production, consider persisting job state to SQLite or a file for crash recovery.

---

### P2-5: idempotency_key cleanup — O(n) scan under lock on every request

**File:** `server/api_server.py` L192-196

**Root Cause:** Every `claim_idempotency` call scans the entire `IDEMPOTENCY` dict to find stale entries. With many concurrent requests, this becomes O(n²).

**Impact:** Performance — not a correctness issue. For typical workloads (<100 concurrent keys), negligible.

**Fix:** Use a periodic background cleanup thread instead of per-request scanning. OR store `(key, timestamp)` tuples in a heap.

---

## Cross-Component Timing Race Scenarios

### Scenario A: SW restart during capture (handled ✓)

1. SW claims job → dispatches auto_capture → evicted
2. Content script finishes → sends `browser_result_relay`
3. SW restarts → `activeClaims` empty → **fallback recovery** at L703-727 reacquires token from server
4. Result posted successfully

**Resilience:** ✅ Covered by 3-layer defense: (1) content.js 3x retry (L163), (2) SW fallback recovery (L703-727), (3) server relaxed claim recovery (L1166-1175).

### Scenario B: API server restart during poll (partial coverage)

1. SW polls → HTTP error → tries next interval (2s)
2. Any queued jobs on old server instance: **lost**
3. New jobs created after restart: picked up normally

**Resilience:** ⚠️ Queued/claimed jobs lost. Unavoidable without persistent state.

### Scenario C: Browser crash during execution (self-healing)

1. Content script mid-capture → browser crashes
2. Server: `CLIENT_TTL` (45s) expires → `purge_stale_browser_state` removes client
3. `reap_expired_browser_jobs` (150s lease) re-queues job
4. On browser restart, SW polls → picks up re-queued job
5. New tab created via `new_tab` → `pendingTabCreation` guard → `ensureContentScript` → executes

**Resilience:** ✅ Self-healing, but recovery takes up to 150s (lease expiry).

### Scenario D: Dual poll with same domain, different tabs (handled ✓)

1. Tab A and Tab B both on `doubao.com` 
2. SW picks Tab A in `browserBridgeTick` → claims job on A
3. Server marks job claimed on tab_id=`A`
4. Tab B tries to claim → `claim_browser_job` skips (job claimed for A)
5. ✅ Safe

### Scenario E: SW alarm + setInterval + page_ready all fire browserBridgeTick on empty job queue (wasteful but safe)

1. No queued jobs
2. All three triggers fire `browserBridgeTick`
3. Each calls `fetch(/browser/pending-domains)` → `[]`
4. Each returns early
5. ✅ Safe, but 3x wasted HTTP requests to localhost

---

## Summary Table

| ID | Severity | Component | Issue | Current Protection |
|----|----------|-----------|-------|--------------------|
| P0-1 | **P0** | Server | BROWSER_QUEUE double-append → duplicated claim_token | None |
| P0-2 | **P0** | Server | BROWSER_EVENTS read outside lock | Event.set() persistence helps |
| P0-3 | **P0** | Extension | SW eviction during active claim | Recovery fallback at L703-727 |
| P0-4 | **P0** | Content | DOM capture lock leak on re-injection | None |
| P1-1 | **P1** | Server | TOCTOU in browser_result claim validation | 3-attempt retry |
| P1-2 | **P1** | Server | validate_tool_call reads stale actor_job | Reap doesn't touch request_meta |
| P1-3 | **P1** | Server | Daemon thread for conversation save | CONVERSATION_LOCK |
| P1-4 | **P1** | Extension | browserPollInFlight guard relies on no-await-before-set | Currently safe, fragile |
| P1-5 | **P1** | Server | POLL_LAST not under lock | CPython GIL, advisory limiter |
| P2-1 | **P2** | Extension | Triple trigger scheduling waste | browserPollInFlight guard |
| P2-2 | **P2** | Content | Heartbeat interval leak | Silent failure, tab-scoped |
| P2-3 | **P2** | Extension | bridgeWakeTimer reset on SW restart | Self-healing |
| P2-4 | **P2** | Server | In-memory state lost on restart | SW retry, extension self-heal |
| P2-5 | **P2** | Server | O(n) idempotency cleanup scan | Low n typical |

---

## Recommended Fix Priority

1. **P0-4** — DOM lock leak: add stale-lock cleanup on content script init (one-line fix, high-frequency trigger)
2. **P0-1** — BROWSER_QUEUE double-append: convert to set-based deduplication (5-line fix, prevents silent data loss)
3. **P0-2** — BROWSER_EVENTS lock safety: wrap in BROWSER_LOCK (2-line fix)
4. **P1-1** — TOCTOU in browser_result: combine into single lock acquisition (10-line refactor)
5. **P1-4** — Document browserPollInFlight guard constraint (comment-only fix)
6. **P2-1** — Remove redundant setInterval (1-line removal, reduces CPU wake-ups)
