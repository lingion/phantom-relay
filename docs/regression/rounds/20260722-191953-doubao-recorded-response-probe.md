# Regression continuation — 2026-07-22 19:19

## Scope
真实 Canary、真实 unpacked extension、豆包 warm 请求；未执行页面点击/输入以外的 CDP 动作，未手工 POST browser/result。

## Runtime verification
- Canary executable: `/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`
- Extension path: `/Users/lingion_k/Desktop/phantom-relay/extension`
- Real extension ID: `jdnglmjikhickphemoinoinihjjpbdfo`
- New content script trace version: `2026-07-22.20`
- Chrome log confirms background startup: `Phantom Relay background v3 ready`
- `--disable-extensions-except` is rejected by this Canary build; `--load-extension` is accepted and loaded the extension. This is a runtime launch pitfall.

## Code changes
- `extension/background.js`: heartbeat now sends explicit `background_version: 2026-07-22.20-reservation-commit` instead of relying on `globalThis` serialization.
- `extension/content.js`: `recorded_elements_ready` now reports `CONTENT_SCRIPT_VERSION`; added diagnostic-only `recorded_response_probe` preserving the recorded selector boundary.
- Checks: `node --check` for both JS files, `python3 -m py_compile server/api_server.py`, `git diff --check`, and `node tests/test_universal_bridge.js` all passed (`UNIVERSAL_BRIDGE_TESTS_PASS`).

## Real test
Request idempotency key: `recorded-probe-20260722-1915`
Job: `job_1784719007902_2bda200b`
Model: `doubao`
Expected: `RECORDED_PROBE_R1`
Result: `response_timeout`.

Trace evidence:
- `capture_boundary` before_send had no existing nodes.
- Enter was executed (`send_enter_attempt`).
- `visible_response_candidate` observed key `50722975757718786`, text `RE`.
- `recorded_response_probe` repeatedly observed exactly one recorded-region snapshot: key `50722975757718786`, text `RE`, `streaming=false`.
- No `fresh_response_candidate` or `fresh_response_complete` occurred.
- Final path safely emitted `fresh_response_timeout_with_candidate` and did not relay a partial answer.

## Bug conclusion
The currently recorded Doubao response selector is `div.relative.grid.w-full`. In the live page it exposes only the first two characters (`RE`) for the fresh assistant node and never grows to `RECORDED_PROBE_R1`. The monitor also sees only `RE`. This is not stale-key reuse, worker-version mismatch, queue claim failure, or API lease expiry.

Per `docs/RECORDED_STANDARD.md`, the selector is the only permitted response boundary. Do not broaden selectors, scan arbitrary DOM, or use monitor text outside the recorded region as a final answer. The safe behavior is timeout rather than returning `RE`.

## Current acceptance impact
- New worker loading: PASS.
- queued → claim → recorded Enter send: PASS.
- Full non-streaming response using the current Doubao recording: FAIL; partial-prefix protection works.
- Existing earlier warm short/stream PASS evidence remains historical but is not reclassified by this probe.

## Next required action
Re-record Doubao response region through the real GUI so the recorded selector identifies the complete assistant response node, then repeat short 3x, stream 3x, long, cold-start, and multi-model matrix. No code-side selector guessing is allowed.

## Final caller result

The real API caller completed with exit code 0 but received an OpenAI error body, not a successful completion:

```json
{"error":{"message":"response_timeout","type":"browser_error","job_id":"job_1784718607815_e2714e51"}}
```

This case is recorded as FAIL and is not counted toward any passing repetition.
