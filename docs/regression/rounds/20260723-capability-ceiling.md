# Capability ceiling run — 2026-07-23 (updated)

## Scope

真实 API caller → 本地 relay → BiDi-installed Phantom Relay → 录制网页 selector/send → 原始 HTTP/SSE caller body。历史测试结果不计入本轮。

## Raw outcomes

- Doubao short: HTTP 200, `BIDI_HOST_OK`.
- Doubao stream: role chunk → `DOU_STREAM_OK` content delta → stop → `[DONE]`.
- Yiyan short: HTTP 200, `yiyan_CAP_GATE_OK`.
- Yiyan stream: role chunk → `YIYAN_STREAM_OK` content delta → stop → `[DONE]`.
- Qwen short/retry/create-tab: no successful caller body; last create-tab run reached ready + claim, then async message channel closed and caller received `browser_timeout`.
- DeepSeek: page reached `/sign_in`, `can_execute=false`, no content-ready, caller blocked.
- Yiyan concurrent with Doubao: Yiyan HTTP 200 `CONC_YIYAN_OK`; Doubao `response_timeout`.
- Doubao same-conversation second turn: `response_timeout`; DOM snapshot remained at prior assistant response.
- Doubao same-model concurrency: first HTTP 200 `CONC2_DOUBAO_OK`; second `browser_timeout`.
- Yiyan long input: `browser_timeout` after 150 seconds.
- DeepSeek authenticated rerun: HTTP 200, `DEEPSEEK_AUTH_OK_FINAL`, `finish_reason=stop`, job `job_1784799171024_29804c41`.

## Implementation changes

- Corrected response probe path to never pass empty recorded-selector objects into `document.querySelector`.
- Added queued-job target-tab creation using extension self-healing capability.
- Added active claim tab/domain exclusion to avoid busy-tab reuse.
- Fixed BiDi host target switching so a claimed job keeps its model domain active.

## Verification

- `node --check extension/background.js`: PASS
- `node --check extension/content.js`: PASS
- `node tests/test_universal_bridge.js`: PASS
- `node tests/test_network_sse_parser.js`: PASS
- `git diff --check`: PASS
- `python3 -m py_compile scripts/bidi_browser_host.py`: PASS

## Honest ceiling

Current proven ceiling is: Doubao, Yiyan, and authenticated DeepSeek short non-stream; Doubao and Yiyan true SSE; Yiyan cross-model concurrency; Doubao first-turn execution. Qwen relay, Doubao second-turn freshness, same-model concurrency, and Yiyan long input remain failures.
