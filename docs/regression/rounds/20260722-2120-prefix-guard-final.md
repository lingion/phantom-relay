# Prefix guard regression — final 3-run evidence — 2026-07-22 21:20 CST

## Scope
Real installed Canary + real unpacked extension + unchanged existing Doubao recorded template. No re-recording, no CDP input/click, no manual browser-result submission.

## Final real caller acceptance
- R1: PASS — HTTP 200, assistant `PREFIX_GUARD_FIX_R1`, length 19.
- R2 initial: FAIL — null dereference; fixed with null-safe snapshot access; not counted.
- R2B: PASS — HTTP 200, assistant `PREFIX_GUARD_FIX_R2B`, length 20.
- R3 initial: FAIL — stale assistant misclassified as send evidence; fixed with fresh key/text check; not counted.
- R3B: FAIL — browser timeout; one Enter, new user message, assistant only `P`, no growth for 120s.
- R3C: FAIL — same poisoned session; new user message but no assistant response.
- R3D: PASS after real Canary restart — HTTP 200, assistant `PREFIX_GUARD_FIX_R3D`, length 20.

## Count
Independent successful real-caller runs after the fixes: **3/3 PASS** (R1, R2B, R3D). R3B/R3C remain recorded failures and are not hidden.

## Trace confirmation R3D
- One Enter attempt.
- Assistant first exposed `P`, then grew to full `PREFIX_GUARD_FIX_R3D`.
- `fresh_response_complete` with full text.
- `capture_result_ready assistantLength=20`.
- Caller received the same full text in HTTP 200 body.

## Checks
- node syntax checks: PASS
- Python compile: PASS
- git diff check: PASS
- universal bridge tests: PASS (`UNIVERSAL_BRIDGE_TESTS_PASS`)
