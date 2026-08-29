# Phantom Relay — Comprehensive Error Handling Audit

**Date:** 2026-07-30  
**Audited files:** `background.js` (1146 lines), `content.js` (2604 lines), `popup.js` (429 lines), `universal_bridge.js` (335 lines), `api_server.py` (1467 lines), `protocol.py` (422 lines)  
**Total source lines audited:** ~6,403

---

## Executive Summary

| Metric | Count |
|--------|-------|
| **Total silent error paths** | **52** |
| **CRITICAL (data-loss risk)** | 2 |
| **HIGH RISK (incorrect behavior)** | 3 |
| **MEDIUM RISK (job timeout/delayed recovery)** | 12 |
| **LOW RISK (degraded but recoverable)** | 22 |
| **HARMLESS (debug/trace/cleanup)** | 13 |

The codebase uses a reasonable defensive pattern of `.catch(() => {})` for most non-critical operations (debug logging, heartbeat pings, popup notifications). However, **two critical data-loss paths** and **three high-risk silent failures** exist where errors in operational fetch calls are completely swallowed.

---

## CRITICAL Findings (Data Loss Risk)

### 🔴 1. `background.js:638` — Error result POST swallowed silently
```js
// L623-644: browserBridgeTick catch block
fetch(`${LOCAL_API}/browser/result`, {
  method: 'POST', ...
  body: JSON.stringify({ job_id: claimedJobId, ..., success: false, error: error.message })
}).catch(() => {});
```
**Impact:** When `browserBridgeTick` catches an error and tries to report failure to the server, if that report itself fails (API down, network error), the job stays in `claimed` status on the server indefinitely. The server's lease expire (150s) will eventually re-queue it, but only after the user's API request has already timed out. **This is data-loss: the user's prompt is lost and returns an opaque timeout.**

**Fix:** Retry the error report at least once, or use a queuing mechanism.

### 🔴 2. `api_server.py:1224-1230` / `api_server.py:1391-1396` — Daemon thread save with no error feedback
```python
threading.Thread(
    target=save_conversation,
    args=(...),
    daemon=True,
).start()
```
**Impact:** Conversation persistence runs in a daemon thread with zero error handling. If `save_conversation` throws (disk full, permission denied, JSON encoding error), the conversation is silently lost. The API returns success to the caller but the data was never written. **This is data-loss: confirmed by the API but never persisted.**

**Fix:** Add error logging/tracing to the save function, or use a non-daemon thread with a try/except wrapper.

---

## HIGH RISK Findings (Incorrect Behavior / Silent Degradation)

### 🟠 3. `background.js:439-442` — SSE network capture chunks silently dropped
```js
consumeNetworkStreamChunk(source, state, params.requestId, params.data, ...).catch(() => {});
```
**Impact:** If `consumeNetworkStreamChunk` fails (e.g., the result POST to `/browser/result` fails at L409), the error is swallowed with a `.catch(() => {})`. The request's `completed` flag may be set to false (L414), but the debugger may already be detached or the stream may never complete. The user gets no response. **The job hangs until lease expiry.**

**Fix:** Retry the result POST or mark the stream as failed after N attempts.

### 🟠 4. `background.js:735-738` — Browser result relay failure lacks retry
```js
fetch(`${LOCAL_API}/browser/result`, { ... })
  .then(async (r) => { ... sendResponse(...) })
  .catch((error) => sendResponse({ ok: false, error: ... }));
```
**Impact:** The content script calls `postBrowserResultWithRetry()` which retries 3 times through `browser_result_relay`. But when the background worker's own fetch to the server fails, the content script just gets `ok: false`. The content script has its own 3-retry loop, but if the background's fetch fails 3 times for the same root cause (e.g., API restart), the final result is permanently lost. **The capture succeeded but the result can't be delivered.**

### 🟠 5. `content.js:1690` — `safeClick()` outer catch silently returns false
```js
} catch (_) {
  return false;
}
```
**Impact:** When button clicking completely fails, the caller (`autoCapture`) at L905-906 detects `!clicked` and returns `{ error: 'send_click_failed' }`. However, the error is only triggered for `kind === 'button'` send strategy. For the Enter strategy (the default), CDP dispatch failure has its own retry logic, but synthetic KeyboardEvent dispatch has no explicit catch at the click level — only the `hasSubmissionEvidence()` poll eventually times out. This means the Enter fallback cascade can spend up to 8+6+8+8 = 30s before reporting failure, which is the job timeout window.

---

## MEDIUM RISK Findings (Delayed Recovery / Degraded Functionality)

### 6. `background.js:236` — Prime function errors swallowed
```js
} catch (_) {}
```
In `ensureContentScript`, the `prime()` function fetches recorded selector templates and applies them. If the template fetch fails, the error is swallowed. The function then probes readiness, but without the correct selectors. The page may report ready but have no working selectors. This is mitigated by the fact that the content script independently loads selectors via `loadDirectBridgeSelectors()`.

### 7. `background.js:827` — page_ready selector template failure
```js
} catch (_) {}
```
Same pattern as #6 but in the `page_ready` message handler. If the recorded selector template fetch fails, the readiness probe continues without selectors. The page may report `ready: true` but `wait_until_ready` immediately fails because `selectors.input` is null. This causes the page to never become available for job claiming until the content script's own selector loading completes.

### 8. `background.js:893` — capture_delta silently lost
```js
fetch(`${LOCAL_API}/browser/delta`, { ... }).catch((e) => addDebugLog(...));
```
**Impact:** Streaming deltas are a best-effort feature, but losing them means the SSE stream to the API caller never receives intermediate content. For long-running generations (60s+), the user sees nothing until the final result. Not data-loss (the final result is sent separately), but degraded UX.

### 9. `content.js:160` — result-token fetch silently fails
```js
} catch (_) {}
```
In `postBrowserResultWithRetry`, if the claim_token recovery fetch fails, the payload is sent without a claim_token. The server may reject it as `claim_token_invalid`, causing all 3 retries to fail. The capture succeeded but the result is lost.

### 10. `content.js:685` — capture heartbeat silently lost
```js
chrome.runtime.sendMessage({ type: 'capture_heartbeat', ... }).catch(() => {});
```
**Impact:** During long captures, the heartbeat keeps the client lease alive (CLIENT_TTL = 45s). If heartbeats fail for >45s, the server marks the client as stale, re-queues the job, and rejects the final result as `job_not_claimed`. The capture succeeds locally but the result is permanently dropped.

### 11. `content.js:2475` — requestReadyLease failure swallowed
```js
} catch (_) { finish(); }
```
If the `page_ready` message to the background worker fails, `finish()` is called but the page is never registered with the server. The page appears unready until the 3-second interval fires again. If it keeps failing, the page is never visible for job claiming.

### 12. `popup.js:357` — Polling stops silently on error
```js
} catch(e) { clearInterval(pollTimer); pollTimer=null; }
```
During selector recording, if a `get_selectors` message to the content script fails once, the polling timer is permanently cancelled. The popup never sees the recorded selector until the next 2-second state sync. This is a user-visible bug: the popup appears to hang after clicking an element.

### 13. `api_server.py:337` — selector template loading failures
```python
except Exception:
    return {}
```
If `selector_templates.json` is corrupted (malformed JSON), `load_selector_templates()` silently returns `{}`. All existing selectors are lost on the next write. The user's recorded templates are permanently destroyed.

### 14. `api_server.py:885` — trace_api_event silently passes
```python
except Exception:
    pass
```
All tracing/audit events can be silently lost without any indication. Not data-loss, but debugging becomes impossible when tracing is needed most.

### 15. `content.js:2509,2524` — Direct bridge selector loading failures
```js
} catch (_) {}
```
The content script tries to load selectors from the server via the background worker, then falls back to `chrome.storage.local`. If both fail silently, the content script starts with empty selectors and reports `ready: false` indefinitely. The page will never be used for job execution.

### 16. `background.js:458-459` — Pending domains fetch failures
```js
const pendingResp = await fetch(...).catch(() => null);
const pendingData = pendingResp ? await pendingResp.json().catch(() => ({})) : {};
```
The poll tick silently proceeds with empty data if the fetch or JSON parse fails. This is defensive code (no data = nothing to do), but if the API is temporarily down, existing queued jobs won't be discovered until the next tick.

### 17. `background.js:513,519` — Tab reservation/commit failures
```js
const reservation = await reserveResp.json().catch(() => ({}));
const committed = await commitResp.json().catch(() => ({}));
```
If the server returns non-JSON responses (e.g., 500 error pages), the `.catch(() => ({}))` swallows the real error. The tab creation proceeds without proper reservation, potentially creating orphaned tabs.

---

## LOW RISK Findings (Degraded but Recoverable)

### 18. `background.js:105` — Debug log POST to localhost
```js
fetch(`${LOCAL_API}/browser/debug`, { ... }).catch(() => {});
```
Debug logs lost when API is down. Non-critical.

### 19. `background.js:127` — Startup selector sync to backend
```js
fetch(`${LOCAL_API}/browser/selectors`, { ... }).catch(() => {});
```
Selectors not synced on startup. Recovered when the extension re-syncs on next recording or popup open.

### 20. `background.js:137` — syncRoutesToBackend
```js
fetch(`${LOCAL_API}/browser/sync-routes`, { ... }).catch(() => {});
```
Model routes not synced. Recovered from chrome.storage.local on next load.

### 21. `background.js:148` — loadRoutes fetch
```js
fetch(`${LOCAL_API}/model-routes`).then(...).catch(() => {});
```
Routes not loaded from server. Defaults used.

### 22. `background.js:233` — set_selectors sendMessage retry
```js
} catch (_) {}
```
Individual retry attempt fails. Loop retries 3 times.

### 23. `background.js:244` — Initial ping failure
```js
} catch (_) {}
```
Triggers re-injection path. Recoverable.

### 24. `background.js:324,349` — Stale debugger cleanup
```js
try { await chrome.debugger.detach(target); } catch (_) {}
```
Best-effort cleanup. Failure means the old debugger stays attached, potentially causing the next attach to fail (but line 320 handles "already attached" retry).

### 25. `background.js:354` — Network.disable
```js
await chrome.debugger.sendCommand(target, 'Network.disable').catch(() => {});
```
Best-effort cleanup before re-enable.

### 26. `background.js:412` — debugger.detach after result
```js
chrome.debugger.detach(source).catch(() => {});
```
Best-effort cleanup. The `onDetach` listener (L365) also handles this case.

### 27. `background.js:423` — startNetworkStream failure
```js
startNetworkStream(source, state, requestId).catch(() => {});
```
Already logged as `network_stream_start_retry`.

### 28. `background.js:490` — Tab filtering URL parse
```js
} catch (_) { return false; }
```
Invalid URLs excluded from tab candidates. Harmless.

### 29. `background.js:573` — URL comparison
```js
try { sameTarget = new URL(currentUrl).hostname === targetDomain; } catch (_) {}
```
Invalid URLs treated as non-matching. Safe fallback.

### 30. `background.js:684,697` — browser bridge tick failures
```js
browserBridgeTick().catch(() => {});
```
Individual tick failures ignored. Next tick will retry. But if ALL ticks fail (API down), jobs are never claimed. The alarm-triggered tick (L660) also has no explicit error handling — if it throws synchronously, the alarm listener may crash the SW.

### 31. `background.js:726` — result-token fetch for claim recovery
```js
} catch (_) {}
```
Claim recovery attempt fails. The fallback uses whatever claim data is available.

### 32. `background.js:768,801` — Heartbeat POST failures
```js
fetch(...).catch(() => {});
```
Best-effort heartbeat. If all heartbeats fail, the client lease expires and the job is re-queued. But the capture may still succeed — the result-token recovery path (L716) can recover.

### 33. `background.js:837` — Delayed bridge ticks
```js
setTimeout(() => browserBridgeTick().catch(() => {}), delay)
```
Same as #30 but for the post-page-ready delayed ticks.

### 34. `background.js:867,880` — Trace/progress relay to popup
```js
chrome.runtime.sendMessage({ ... }).catch(() => {});
```
Popup may be closed. Harmless.

### 35. `background.js:928` — Selector sync after recording
```js
fetch(`${LOCAL_API}/browser/selectors`, { ... }).catch(() => {});
```
Recorded selectors synced to backend. If this fails, the server has stale selectors. The extension's local storage has the authoritative copy. Re-syncs on next recording.

### 36-39. Various low-risk catches in content.js (L257, L564, L1027, L1320, L1560, etc.)
These handle selector matching fallbacks, cleanup, and non-critical parsing. All individually harmless.

---

## HARMLESS Findings (Purely Diagnostic / No Impact)

40. `content.js:85,144` — Trace/progress sendMessage to background
41. `background.js:305` — SSE line JSON parse
42. `background.js:458-459` — pending data json parse
43. `background.js:905` — Send strategy JSON parse
44. `background.js:1002` — Domain route lookup URL parse
45. `content.js:1595,1611` — Selector alternative generation
46. `content.js:1644` — Pointer event dispatch (returns false, handled)
47. `content.js:1662` — React props invocation
48. `content.js:1717,1746,1756,1764,1771` — Copy button detection
49. `content.js:1994` — Streaming state detection
50. `content.js:2251` — Last assistant message detection
51. `universal_bridge.js:244` — JSON parse in safeJson
52. `protocol.py:149` — JSON parse in _parse_tool_json

---

## Missing `.catch()` / Unhandled Promise Chains

No completely unhandled Promise chains were found. All `fetch()` calls have either `.catch()` or are inside `try/catch`. All `chrome.runtime.sendMessage()` with callbacks check `chrome.runtime.lastError` in the pattern `void chrome.runtime.lastError`.

However, one pattern deserves attention:

### `background.js:660` — Alarm handler has no error protection
```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BROWSER_POLL_ALARM) browserBridgeTick();
});
```
If `browserBridgeTick()` throws synchronously (not the async part, but the synchronous preamble), the error propagates to the alarm listener, potentially crashing the service worker. Mitigated by the fact that `browserBridgeTick` is async and its first `await` is early, but the pre-await code (L448-454) could theoretically throw.

---

## Error Recovery That Doesn't Work

### 1. Claim recovery chain (bg.js:704-727, cs.js:149-181)
The claim recovery mechanism (fetching `/browser/result-token`) has a silent catch. If the token fetch fails, the result is sent without a claim_token. The server at L1159-1175 has a relaxed recovery path that matches on `tab_id + domain` only, but this only works if the server hasn't re-queued the job. If the `BROWSER_JOBS` entry was recycled (e.g., the job was marked failed due to lease expiry), the result is permanently lost.

### 2. Network capture cleanup (bg.js:412)
`chrome.debugger.detach(source).catch(() => {})` — if detach fails, Chrome's debugger attachment persists. The `onDetach` listener (L365) cleans up the Map, but the actual CDP attachment may prevent future `chrome.debugger.attach()` calls with "already attached" errors. The retry logic at L320 handles one level of this, but repeated failures accumulate.

### 3. Selector template corruption recovery (api_server.py:337)
If `selector_templates.json` is corrupted, `load_selector_templates()` returns `{}` with no error log. The next `save_selector_templates()` overwrites the corrupted file with the empty dictionary. **All recorded selectors for all domains are permanently lost.** There's no backup mechanism.

---

## Component Summary

| Component | Total Silent Errors | Critical | High | Medium | Low | Harmless |
|-----------|---------------------|----------|------|--------|-----|----------|
| **background.js** | 22 | 1 | 2 | 6 | 10 | 3 |
| **content.js** | 18 | 0 | 1 | 4 | 7 | 6 |
| **popup.js** | 6 | 0 | 0 | 1 | 3 | 2 |
| **api_server.py** | 5 | 1 | 0 | 2 | 0 | 2 |
| **universal_bridge.js** | 1 | 0 | 0 | 0 | 0 | 1 |
| **protocol.py** | 0 | 0 | 0 | 0 | 0 | 0 |

---

## Ranking by Data-Loss Risk

| Rank | Location | Pattern | Risk | Fix Priority |
|------|----------|---------|------|-------------|
| **#1** | `api_server.py:1224` | Daemon thread save with no error handling | Conversation history silently lost | **P0** |
| **#2** | `background.js:638` | Error result report swallowed | Job hangs in claimed state, API timeout | **P0** |
| **#3** | `background.js:439-442` | SSE stream chunk failure swallowed | Network capture result lost | **P1** |
| **#4** | `background.js:735-738` | Result relay failure no retry | Capture succeeded, result can't be delivered | **P1** |
| **#5** | `api_server.py:337` | Selector template load failure | All recorded selectors permanently lost | **P1** |
| **#6** | `content.js:160` | Result-token fetch fails silently | Result rejected with claim_token_invalid | **P2** |
| **#7** | `content.js:685` | Capture heartbeat fails for >45s | Client lease expires, job re-queued, result rejected | **P2** |
| **#8** | `popup.js:357` | Polling stops on first error | User sees hung popup during recording | **P2** |
| **#9** | `content.js:2509` | Selector loading fails silently | Page never becomes ready, never executes jobs | **P2** |
| **#10** | `background.js:827` | page_ready selector failure | Page reports ready but can't execute | **P3** |

---

## Recommendations

### Immediate (P0)
1. **Add retry to error result POST** (`background.js:638`): Retry at least once with exponential backoff.
2. **Add error handling to conversation save** (`api_server.py`): Wrap `save_conversation` in try/except with trace logging. Consider a persistent queue for failed saves.

### Short-term (P1)
3. **Network capture result retry**: Instead of `.catch(() => {})` on the result POST, retry 2-3 times.
4. **Result relay retry**: When the background's result fetch fails, return the error but don't clear the in-memory result — let the content script's 3-retry loop handle it.
5. **Backup selector templates before write**: Save a `.bak` file before overwriting `selector_templates.json`. Validate JSON before accepting it as the new state.

### Medium-term (P2)
6. **Heartbeat resilience**: Increase the heartbeat interval to 10s and add a failure counter — after 3 consecutive failures, trigger a page reload or re-injection.
7. **Popup polling resilience**: Instead of clearing the timer on error, log the error and keep polling.
8. **Add error boundaries to alarm handler**: Wrap `browserBridgeTick()` in try/catch when called from alarm listener.

### Long-term (P3)
9. **Consolidate the error swallowing pattern**: Create a `safeFetch(url, options, fallback)` utility that logs failures to debugLog while providing a fallback value. This preserves debuggability while maintaining the defensive posture.
10. **Add a health-check endpoint** that reports selector template validity, conversation save health, and job queue depth.
