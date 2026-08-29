# Doubao zero-state recovery — real evidence — 2026-07-22 23:20 CST

## Scope
Real installed Canary + real extension + same user profile; no re-recording, no CDP chat action, no manual result submission.

## Sequence
1. Clean real Canary session established and heartbeat verified.
2. Before-close caller request: `ZERO_STATE_BEFORE_R1` → HTTP 200, complete assistant body.
3. Canary terminated; process list confirmed empty. API client lease was allowed to expire; `/browser/clients` became `{}`.
4. Same real profile and extension relaunched; new tab heartbeat verified.
5. After-restart caller request: `ZERO_STATE_AFTER_R1` → HTTP 200, complete assistant body.

## Result
Zero-state close/reopen recovery: **PASS**.
