# Phantom Relay — Memory & Resource Leak Analysis

**Date:** 2026-07-30
**Scope:** All Phantom Relay components (server, extension background, extension content script)

---

## P0 — Critical (will cause crash/degradation within hours)

### P0.1: BROWSER_JOBS never prunes completed/failed jobs
- **File:Line:** `server/api_server.py:32` (declaration), `server/api_server.py:825-840` (`finish_browser_job`)
- **Cleanup?** ❌ No. `finish_browser_job()` transitions status to `completed`/`failed` but the job dict is **never deleted** from `BROWSER_JOBS`. `reap_expired_browser_jobs()` only re-queues claimed jobs — terminal jobs stay forever.
- **1 hr:** If job rate is ~10/min, ~600 dict entries in memory (~1-2 MB).
- **1 day:** ~14,400 entries (~30 MB). Noticeable on repeated requests.
- **1 week:** ~100,000 entries (~200 MB). Server memory exhausted → OOM crash.
- **Trigger?** Nothing. No TTL, no cap, no periodic purge.
- **Failure mode:** Python memory ballooning → `MemoryError` → API crash. `BROWSER_JOBS` dict grows with every request, terminal or not. Also: `BROWSER_DELTAS[jid]` entries (line 38) are never cleaned for completed jobs, doubling the leak.
- **Severity:** P0 — guaranteed leak on production use.

### P0.2: TRACE_FILE (page-trace.jsonl) unbounded growth
- **File:Line:** `server/api_server.py:22` (declaration), `server/api_server.py:881-886` (`trace_api_event`), `server/api_server.py:1056-1066` (`/trace` POST), `server/api_server.py:1069-1077` (`/browser/debug` POST)
- **Cleanup?** ❌ No. Three separate codepaths append to the same JSONL file. No size limit, no rotation, no logrotate config, no max-line count.
- **1 hr:** With active page trace (MutationObserver on document), ~5-50 MB depending on page activity.
- **1 day:** ~500 MB to 5 GB — page-trace observer fires on EVERY DOM mutation.
- **1 week:** Multiple GB → disk full → API server I/O errors, machine unusable.
- **Trigger?** Every `page_trace` message (hundreds/sec on active AI chat page), every API event, every debug log. The page trace MutationObserver in content.js (line 101-124) observes ALL `subtree: true, childList, characterData, attributes` mutations and sends them to the server.
- **Failure mode:** Disk space exhaustion → `OSError: [Errno 28] No space left on device` → API crashes, log writes fail silently (line 885-886 `pass` on exception), data loss.
- **Severity:** P0 — guaranteed disk exhaustion with active use.

### P0.3: BROWSER_QUEUE accumulates unclaimable jobs
- **File:Line:** `server/api_server.py:33` (declaration), `server/api_server.py:563` (`new_browser_job` appends), `server/api_server.py:770-823` (`claim_browser_job`)
- **Cleanup?** Partial. Jobs are removed on claim (line 794), but if a job's domain has no matching client tab, it stays in the queue forever. `reap_expired_browser_jobs()` re-queues claimed jobs (line 754-755). No job-age-based eviction. `browser_reset()` clears queue but is manual-action only.
- **1 hr:** If misconfigured model creates jobs with no matching domain, queue grows linearly with requests.
- **1 day:** Queue reaches hundreds/thousands of blocked entries.
- **1 week:** Massive queue → `claim_browser_job()` iterates the full queue on every claim (line 770), O(n) per poll → increasing latency per claim, eventual timeout storms.
- **Trigger?** Any request to an unknown model, wrong domain, or when no browser tab matches.
- **Failure mode:** Claim latency grows O(n) with queue size (full scan every claim). Eventually: `claim_browser_job` CPU time exceeds poll interval → cascading timeouts → API 504 for ALL models.
- **Severity:** P0 — cascading failure; bad jobs poison good ones.

---

## P1 — High (will cause degradation within days)

### P1.1: activeClaims Map never purged of stale entries
- **File:Line:** `extension/background.js:278` (declaration), `extension/background.js:557-562` (set), `extension/background.js:736` (delete on success only)
- **Cleanup?** ❌ No. Entries are added on claim (line 557-562) but only deleted on successful `/browser/result` relay (line 736). Failed claims, timeouts, tab closures, SW eviction → stale entries persist forever.
- **1 hr:** Moderate; depends on claim rate and failure rate.
- **1 day:** If 10% of claims fail, dozens of stale entries accumulate.
- **1 week:** Hundreds of stale entries → Map memory leaks, plus stale claims can block re-claiming the same tab (line 492 check: `activeClaimedDomains` includes every stale domain).
- **Trigger?** Any failed claim (timeout, crash, tab navigate-away mid-capture) leaves a zombie entry.
- **Failure mode:** Stale `activeClaims` entries block future jobs from the same domain/tab via `activeClaimedTabIds`/`activeClaimedDomains` filtering in `browserBridgeTick()` (line 467-473). Service degraded to no-op for affected domains.
- **Severity:** P1 — blocks future work for affected domains.

### P1.2: responseMonitorObserver never disconnected
- **File:Line:** `extension/content.js:2047-2061` (`startResponseMonitor`), content.js:1980 (declaration)
- **Cleanup?** ❌ No. `startResponseMonitor()` is called on every page that loads the content script (line 2599). There is **no `stopResponseMonitor()`** function anywhere. The observer persists for the entire page lifetime.
- **1 hr:** One observer per open tab with content script injected. The observer callback fires on every DOM mutation, running `emitResponseMonitorSnapshot('mutation')` debounced by 250ms.
- **1 day:** Each open tab keeps an active `MutationObserver` on documentElement with `subtree:true, childList, characterData, attributes`. Memory: observer + closure references.
- **1 week:** Multiple tabs = multiple observers. Each observer holds a reference to the content script's closure scope, preventing GC of the entire script's state.
- **Trigger?** Content script injection on any page.
- **Failure mode:** Tab memory growth; each open Phantom Relay tab leaks (observer + debounce timer + snapshot data). Can contribute to Chrome "Aw, snap!" tab crashes on memory-constrained machines.
- **Severity:** P1 — persistent per-tab leak; no path to stop.

### P1.3: readyLeaseInterval never cleared
- **File:Line:** `extension/content.js:2457` (declaration), `extension/content.js:2589` (set)
- **Cleanup?** ❌ No. `readyLeaseIntervalId` is assigned `setInterval(requestReadyLease, 3000)` but **never cleared** via `clearInterval()`. Runs forever on every page with injected content script.
- **1 hr:** Acceptable — one 3s timer per tab.
- **1 day:** Acceptable on few tabs. But each `requestReadyLease()` sends `chrome.runtime.sendMessage({type:'page_ready'})` to background, which then calls `/browser/heartbeat` API. On stale tabs (navigated away, minimized), the heartbeat still fires every 3s.
- **1 week:** On tabs left open (e.g., pinned AI chat pages), the 3s interval wastes SW wake cycles and API heartbeat payloads indefinitely. Also prevents the content script closure from being GC'd (timer holds reference to `requestReadyLease` closure).
- **Trigger?** Content script injection — always. No tab-close or navigation cleanup.
- **Failure mode:** Unnecessary SW wake-up every 3s per stale tab → battery drain, API noise. Content script closure retained forever → memory not reclaimed.
- **Severity:** P1 — always-on timer never cleaned; SW/API noise pollution.

### P1.4: BROWSER_DELTAS never pruned for completed jobs
- **File:Line:** `server/api_server.py:38` (declaration), `server/api_server.py:631-656` (`append_browser_delta`)
- **Cleanup?** Partial. Each job's delta list is capped at 500 entries (line 654-655). But the entire delta list for a completed/failed job remains in `BROWSER_DELTAS` forever — it's never popped or deleted after job terminal state.
- **1 hr:** ~500 deltas × ~10 jobs = ~5,000 entries. Manageable.
- **1 day:** ~500 deltas × ~200 jobs = ~100,000 entries. Noticeable memory.
- **1 week:** ~500 deltas × ~1,400 jobs = ~700,000 entries plus list overhead. Significant memory.
- **Trigger?** Every job that receives streaming deltas. No cleanup on job completion.
- **Failure mode:** Combined with P0.1 (BROWSER_JOBS leak), exponential memory usage. Each completed job retains a 500-entry delta list.
- **Severity:** P1 — compounds P0.1; doubles per-job memory retention.

---

## P2 — Medium (slow accumulation, non-critical degradation)

### P2.1: pageRuntime Map never cleaned on tab close
- **File:Line:** `extension/background.js:26` (declaration), `extension/background.js:807` (set), `extension/background.js:848-885` (read)
- **Cleanup?** ❌ No. Entries are added on `page_ready` messages but there is **no `chrome.tabs.onRemoved` listener** to clean up. MV3 SW eviction resets the Map, but that's not intentional cleanup.
- **1 hr/1 day/1 week:** Slow accumulation of entries for closed tabs. Each entry is ~100 bytes × closed tabs.
- **Trigger?** Every new tab that sends `page_ready`. Tab close doesn't clean.
- **Failure mode:** Small incremental leak. Won't crash but wastes memory over very long sessions. Also causes `page_trace`/`capture_progress`/`capture_delta` stale-page-session-ID checks to reference dead tabs (lines 851-853).
- **Severity:** P2 — slow leak, bounded by SW eviction resets.

### P2.2: POLL_LAST never cleaned
- **File:Line:** `server/api_server.py:43` (declaration), `server/api_server.py:1139-1142` (set)
- **Cleanup?** ❌ No. Every `(tab_id or domain)` that polls gets an entry. Stale tabs leave entries forever.
- **1 hr/1 day/1 week:** Gradual accumulation. Each entry is just a timestamp (~24 bytes), but over weeks with many unique tab_ids, the dict grows.
- **Trigger?** Every `/browser/poll` call from a unique tab ID.
- **Failure mode:** Memory negligible per entry, but dict resizing overhead. Low impact.
- **Severity:** P2 — trivial per-entry cost.

### P2.3: IDEMPOTENCY cleanup is on-demand only
- **File:Line:** `server/api_server.py:41` (declaration), `server/api_server.py:194-196` (purge in `claim_idempotency`)
- **Cleanup?** Partial. Stale entries (>24h TTL) are removed **only when** `claim_idempotency()` is called with a new key. If no idempotency-keyed requests come in, stale entries accumulate.
- **1 hr:** Fine — 24h TTL.
- **1 day:** Some stale entries from 24h ago but purged on next idempotency request.
- **1 week:** If idempotency keys are rarely used, entries build up. Each entry includes a `threading.Event` object.
- **Trigger?** New idempotency-keyed request (runs stale sweep, line 194-196).
- **Failure mode:** `threading.Event` objects per entry consume OS resources (file descriptors on some platforms if not cleaned). Low probability.
- **Severity:** P2 — functional but fragile; depends on traffic patterns.

### P2.4: no background purge thread for server state
- **File:Line:** `server/api_server.py:470-505` (`purge_stale_browser_state`)
- **Cleanup?** Partial. `purge_stale_browser_state()` exists and correctly cleans `BROWSER_CLIENTS`, `BROWSER_READY`, and `BROWSER_BINDINGS`. But it's **only called from** `/browser/status` (line 526) and `/browser/clients` (line 994). If those endpoints are never hit, stale state accumulates.
- **1 hr:** If status endpoint called regularly — clean.
- **1 day:** If only API requests (no status polling) — BROWSER_CLIENTS grows with stale tabs.
- **1 week:** Significant BROWSER_CLIENTS bloat if no status endpoint access.
- **Trigger?** Only explicit `/browser/status` or `/browser/clients` calls.
- **Failure mode:** Stale clients occupy dict space. `claim_browser_job()` checks `CLIENT_TTL` (line 762-763) as defense, so stale entries won't claim jobs — but they waste memory.
- **Severity:** P2 — purge logic exists but not invoked automatically.

### P2.5: debugLogs persisted to chrome.storage.local on every push
- **File:Line:** `extension/background.js:28` (declaration), `extension/background.js:93-107` (`addDebugLog`)
- **Cleanup?** ✅ Yes. Capped at 500 entries (line 101). But persists to `chrome.storage.local` **on every single push** (line 102). This is a write-amplification problem, not a leak.
- **1 hr/1 day/1 week:** Memory bounded (500 entries). But `chrome.storage.local` has a per-minute write quota. Heavy debug logging could hit quota limits.
- **Trigger?** Every `addDebugLog()` call → `chrome.storage.local.set()`.
- **Failure mode:** `chrome.storage.local` quota exceeded → storage operations fail silently → selectors/conversations stop persisting.
- **Severity:** P2 — write amplification, not memory leak. Properly bounded.

---

## P3 — Low (properly bounded or self-cleaning)

### P3.1: captureDebug (content.js)
- **File:Line:** `extension/content.js:53` (declaration), `extension/content.js:137-138` (cap)
- **Cleanup?** ✅ Yes. Capped at 30 entries.
- **Severity:** None.

### P3.2: captureHeartbeatInterval (content.js)
- **File:Line:** `extension/content.js:678` (set), `extension/content.js:1046` (clear)
- **Cleanup?** ✅ Yes. Cleared in capture cleanup.
- **Severity:** None.

### P3.3: activeStreamDeltaTimer (content.js)
- **File:Line:** `extension/content.js:963` (set), `extension/content.js:976-977` (clear)
- **Cleanup?** ✅ Yes. Cleared on stop and cleanup.
- **Severity:** None.

### P3.4: pageTraceObserver (content.js)
- **File:Line:** `extension/content.js:117` (create), `extension/content.js:128-132` (disconnect), `extension/content.js:2090` (cleanup in capture)
- **Cleanup?** ✅ Yes. Properly disconnected via `stopPageTrace()`.
- **Severity:** None (but feeds P0.2 — trace file growth).

### P3.5: browserBridgeInterval (background.js)
- **File:Line:** `extension/background.js:680-686`
- **Cleanup?** ✅ Self-resetting on SW lifecycle. 2s polling interval.
- **Severity:** None.

### P3.6: pendingTabCreation (background.js)
- **File:Line:** `extension/background.js:275`, `extension/background.js:525`
- **Cleanup?** ✅ Self-cleaning via `finally` block.
- **Severity:** None.

### P3.7: readyFlights (background.js)
- **File:Line:** `extension/background.js:32`
- **Cleanup?** Transient — promises resolve or reject.
- **Severity:** None.

---

## Summary Table

| Resource | Cleanup? | 1hr | 1day | 1week | Triggers | Fails On |
|---|---|---|---|---|---|---|
| **BROWSER_JOBS** (P0) | ❌ | MBs | 10s MB | 100s MB | Nothing | OOM crash |
| **TRACE_FILE** (P0) | ❌ | 5-50 MB | 500MB-5GB | Many GB | Every mutation | Disk full |
| **BROWSER_QUEUE** (P0) | ❌ | Low | Medium | Large | Unclaimable jobs | O(n) claim → timeout cascade |
| **activeClaims** (P1) | ❌ | Low | Medium | Large | Failed claims | Blocks future domain jobs |
| **responseMonitorObserver** (P1) | ❌ | Per-tab | Per-tab × days | Per-tab × week | Every injected page | Tab memory + no GC |
| **readyLeaseInterval** (P1) | ❌ | Per-tab timer | 3s noise × stale tabs | Same | Every injected page | SW wake noise + closure leak |
| **BROWSER_DELTAS** (P1) | ❌ | ~500/job | ×200 jobs | ×1400 jobs | Every streaming job | Compounds P0.1 |
| **pageRuntime** (P2) | ❌ | Trivial | Small | Small | Tabs closed | Stale checks reference dead tabs |
| **POLL_LAST** (P2) | ❌ | Trivial | Small | Small | Polling | Negligible per-entry |
| **IDEMPOTENCY** (P2) | On-demand | Clean | Partial | Needs key | Next idempotency call | Stale Event objects |
| **BROWSER_READY** (P2) | ✅ (on-demand) | Clean | Clean | Clean | `/browser/status` | Status call dependent |
| **BROWSER_CLIENTS** (P2) | ✅ (on-demand) | Clean | Partial | Partial | `/browser/status` | Status call dependent |
| **BROWSER_BINDINGS** (P2) | ✅ (on-demand) | Clean | Clean | Clean | Purge functions | Status call dependent |
| **debugLogs** (P3) | ✅ | Bounded 500 | Bounded | Bounded | Every log | Storage write amp |
| **captureDebug** (P3) | ✅ | Bounded 30 | Bounded | Bounded | Capture | None |
| **pageTraceObserver** (P3) | ✅ | Clean | Clean | Clean | Stop function | None (but feeds P0.2) |
| **captureHeartbeatInterval** (P3) | ✅ | Clean | Clean | Clean | Cleanup in capture | None |

---

## Recommended Fix Priority

### Immediate (P0 — crash prevention):
1. **TRACE_FILE**: Add max file size (~100MB) with rotation. Or disable page-trace MutationObserver by default, enable only for debugging. The MutationObserver feeding every DOM change to a JSONL file is the single largest resource drain.
2. **BROWSER_JOBS**: Add a background thread or per-request sweep that removes jobs older than some TTL (e.g., 1 hour for completed/failed). Or a periodic `gc_browser_jobs()` called from `reap_expired_browser_jobs()`.
3. **BROWSER_QUEUE**: Cap queue depth (e.g., max 100). Reject new jobs with `server_busy` when queue is full. Also evict jobs older than 5 minutes if unclaimed.

### Short-term (P1 — degradation):
4. **BROWSER_DELTAS**: Clear `BROWSER_DELTAS[jid]` in `finish_browser_job()`.
5. **activeClaims**: Add `chrome.tabs.onRemoved` listener to delete entries for closed tabs. Add a periodic sweep (on alarm) for claims older than 5 minutes.
6. **responseMonitorObserver**: Add `stopResponseMonitor()` and call it when the tab navigates away or the content script detects destruction.
7. **readyLeaseInterval**: Clear on tab navigation (`beforeunload`/`pagehide` event listener in content script). Use `visibilitychange` to pause/resume.

### Long-term (P2):
8. **pageRuntime**: Add `chrome.tabs.onRemoved` listener.
9. **POLL_LAST**: Sweep stale entries periodically (e.g., in `reap_expired_browser_jobs()`).
10. **IDEMPOTENCY**: Periodic sweep independent of new key creation.
11. **Background purge thread**: Run `purge_stale_browser_state()` on a timer (e.g., every 30s) rather than only on endpoint hits.
