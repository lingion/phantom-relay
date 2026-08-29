# Regression summary — 2026-07-22 23:58 CST

## Acceptance rule
Only real Canary + real extension + existing recorded input/send/response + real caller HTTP/SSE body counts. No re-recording was performed. No CDP chat actions, manual `/browser/result`, or excluded matrix helpers were used.

## PASS

### Doubao short non-streaming
Independent caller-level successful runs: **3/3 PASS**.
- Full assistant bodies returned: `PREFIX_GUARD_FIX_R1`, `PREFIX_GUARD_FIX_R2B`, `PREFIX_GUARD_FIX_R3D`.
- Fresh-prefix protection verified: prefix nodes (`P`, etc.) were not returned as final content.
- One Enter attempt on successful traces; no duplicate send counted.

### Doubao streaming
Independent caller-level successful runs: **3/3 PASS**.
- Real SSE delta received: `DOUBAO_STREAM_R1B`, `DOUBAO_STREAM_R2B`, `DOUBAO_STREAM_R3B`.
- Each included `finish_reason=stop` and `[DONE]`.
- Heartbeats were transport keepalives only, not counted as content.

### Doubao zero-state recovery
**PASS**.
- Before close: `ZERO_STATE_BEFORE_R1`, HTTP 200.
- Real Canary process terminated; client lease expired and `/browser/clients` became empty.
- Same real profile relaunched; new heartbeat established.
- After restart: `ZERO_STATE_AFTER_R1`, HTTP 200.

## FAIL / boundary

### Doubao long context
**NOT PASSING**.
- 1894/1895-character prompts entered as complete user nodes.
- Medium 580-character request rendered as 625-character user node.
- In all attempts no assistant node materialized; failures were caller `response_timeout`/`browser_timeout` before response extraction.
- This is recorded as a real provider/page generation boundary, not a response-selector failure.

### Consecutive same-page requests
Observed real page degradation after several consecutive requests: user node appears, assistant may remain absent or only expose a first character. Restarting the real Canary restored successful short/streaming runs. Failures are archived, not hidden.

## BLOCKED by prerequisites

- DeepSeek: recorded response selector is `null`; no selector guessing permitted.
- Qwen: recorded selector exists, but cold-start page never reached recorded input/send readiness; client reported `can_observe=false`, `can_execute=false`.
- Wenxin: recorded selector exists, but cold-start page never reached recorded input/send readiness.
- Multi-model same-context switching: not executed because required providers were not executable under the recorded standard.
- Cherry Studio GUI regression: no verifiable real Cherry Studio caller path was available in this run; no fabricated result counted.

## Engineering checks
All PASS:
- `node --check extension/content.js`
- `node --check extension/background.js`
- `python3 -m py_compile server/api_server.py`
- `git diff --check`
- `node tests/test_universal_bridge.js` → `UNIVERSAL_BRIDGE_TESTS_PASS`
- `/health` → `{"status":"ok","service":"phantom-relay-api"}`

## Key corrective changes
- Reused response nodes are accepted only when their text changes from the pre-send snapshot.
- Stale response text cannot prove a new send.
- Enter evidence is checked even when a recorded button exists; button remains failure-only fallback.
- Enter confirmation window covers observed Doubao delay.
- Strict prompt-prefix candidates are rejected until the recorded response region grows.
- Null snapshots are safe and do not expose internal JS errors.

## Evidence files
- `20260722-2120-prefix-guard-final.md`
- `20260722-2235-doubao-streaming.md`
- `20260722-2250-doubao-long-boundary.md`
- `20260722-2320-doubao-zero-state.md`
- `20260722-2325-deepseek-gate.md`
- `20260722-2335-qwen-gate.md`
- `20260722-2345-wenxin-gate.md`
- `20260722-2355-multimodel-cherry-gate.md`
