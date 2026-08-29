# Phantom Relay Phase B Runtime Recovery Slice

## Overview

Make the browser relay recoverable across Manifest V3 service-worker eviction and
content-script re-injection without changing the profile lifecycle contract or
adding provider-specific behavior.

## Architecture decisions

- Persist only claim metadata in `chrome.storage.session`; never persist the
  internal `claim_token`. A restarted worker recovers the token through the
  existing server-side `/browser/result-token` contract.
- Restore claims before the first browser poll and reconcile them against the
  backend. A claim that is no longer server-valid is removed so it cannot
  permanently block a tab.
- Treat the DOM capture lock as generation-scoped. Re-injection clears a lock
  owned by an older content generation; the current generation still rejects a
  concurrent capture.
- Keep profile state, browser claim state, and page capture state separate.

## Task list

### Task B1: Persist and recover claim metadata

Acceptance criteria:

- [x] Claim metadata survives a service-worker context restart through
  `chrome.storage.session`.
- [x] Serialized storage never contains `claim_token` or page/conversation
  content.
- [x] Restored claims are available to result relay and tab ownership logic.
- [x] Backend-invalid claims are removed while transport failures retain them.

Verification:

- [x] `node --test tests/test_claim_recovery.js`
- [x] `node --check extension/claim_recovery.js extension/background.js`
- [x] static background contract test confirms startup restore precedes polling.

Dependencies: Phase A profile lifecycle and existing result-token endpoint.

Files likely touched:

- `extension/claim_recovery.js`
- `extension/background.js`
- `extension/manifest.json`
- `tests/test_claim_recovery.js`

### Task B2: Clear stale capture locks after content re-injection

Acceptance criteria:

- [x] A lock from an older content generation is cleared during initialization.
- [x] A lock from the current generation still returns `capture_in_flight`.
- [x] No page text or credential data is used for lock recovery.

Verification:

- [x] `node --test tests/test_capture_lock_recovery.js`
- [x] `node --check extension/content.js`
- [x] isolated DOM reinjection case passes when enabled.

Dependencies: Task B1 is independent; both consume the existing generation
marker.

Files likely touched:

- `extension/content.js`
- `extension/capture_lock.js`
- `tests/test_capture_lock_recovery.js`

### Task B3: Recovery acceptance checkpoint

Acceptance criteria:

- [x] A worker restart with a live server claim does not create a second claim.
- [x] A completed/reaped claim is removed and the tab can execute a new job.
- [x] Existing Phase A generic DOM and lifecycle tests remain green.

Verification:

- [x] controlled extension runtime harness for restore/reconcile paths
- [x] Phase A Node, Python, and isolated Chromium matrices

Dependencies: Tasks B1 and B2.

## Checkpoint

Stop after B3 and review evidence before adding broader multi-tab scheduling,
cross-browser support, or Phase C advanced capabilities. **Completed 2026-07-31.**

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Old session claim blocks a usable tab | High | Reconcile each restored claim with result-token; delete only confirmed invalid claims. |
| Claim token leaks into session storage | High | Pure serializer strips the field and tests assert forbidden keys. |
| Re-injection clears a live capture | High | Compare lock owner generation with current generation, never clear equal generations. |
