# Stage 1 generic fixture closed loop — 2026-08-05 11:45 CST

## Baseline and scope

- Checkout: `/Users/lingion_k/Desktop/phantom-relay`
- Branch: `main`, ahead of `origin/main` by 14 commits; worktree remained dirty and was not reset or committed.
- Scope: provider-neutral recorded DOM profile, one short non-stream request, real isolated Chrome Canary, real extension, real caller body.
- Backend: isolated `PHANTOM_RELAY_REGISTRY_DIR` and `PHANTOM_RELAY_JOB_STORE`; no existing job database was reused.
- Fixture: repository-local `tests/fixtures/interactive-chat.html` served at `http://127.0.0.1:8788/interactive-chat.html`.

## Recorded contract

- Profile: `recorded-127-0-0-1-v1`
- Input: recorded `#prompt` textarea
- Send: recorded `#send` button
- Response: recorded `[data-role='assistant']` with `data-message-id` identity and explicit `identityVerification` evidence
- No provider name, provider domain, or model-specific branch was added.

## Runtime evidence

- The initial CLI `--load-extension` attempt was blocked by Chrome Canary 153: the isolated profile had no installed extension and the page had no content-script marker.
- The live harness was corrected to use WebDriver BiDi `webextension.install`, then fresh navigation.
- Updated harness evidence:
  - extension installed: `jdnglmjikhickphemoinoinihjjpbdfo`
  - page marker: `2026-08-04.05`
  - backend client: `source=content-ready`, `ready=true`, `input_ready=true`, `send_ready=true`
  - capabilities: `can_execute=true`, `can_observe=true`, `can_snapshot=true`, `can_stream=true`

## Caller results

- First real isolated-browser request: HTTP `200`, non-empty `choices[0].message.content`, `finish_reason=stop`.
- Second request through the updated `run_isolated_live_case.py --run`: HTTP `200`, non-empty `choices[0].message.content`, `finish_reason=stop`.
- The live fixture DOM after the second request contained exactly one new user message and two assistant messages (one previous fixture message plus one new response); input value was empty.
- Result relay evidence for the second job: `capture_result_ready → direct_result_relay_requested → direct_result_relay_dispatched → final_result_post_attempt_finished`.
- No manual `/browser/result`, CDP input, CDP click, or CDP Enter was used.

## Changes in this round

- `scripts/run_isolated_live_case.py`: install the extension through BiDi after isolated Chrome startup, support `--chromedriver`, and expose CDP only for observation.
- `tests/test_isolated_live_case.py`: assert the isolated extension/CDP command contract.
- `docs/ISOLATED_LIVE_HARNESS.md`: document the current Chrome Canary installation path and driver override.

## Verification

- Node full suite: `117 passed / 0 failed`
- Python full suite: `169 passed / 12 skipped`
- Focused live-harness tests: `5 passed`
- `node --check extension/content.js extension/background.js extension/popup.js`: passed
- `python3 -m py_compile scripts/run_isolated_live_case.py scripts/run_isolated_dom_case.py scripts/bidi_browser_host.py`: passed
- `git diff --check`: passed

## Conclusion

Status: **passed — generic isolated Stage 1 e2e**.

This proves the current provider-neutral extension and backend can complete a real caller-to-browser-to-caller request on a recorded DOM fixture. It does not yet prove any named vendor page, SSE, multi-turn, concurrency, or cross-browser behavior.

## Next single action

Run the same caller gate against one real, already authenticated user-recorded vendor profile, beginning with the existing Doubao recording; stop at the first vendor-specific runtime failure and add no vendor-specific code.
