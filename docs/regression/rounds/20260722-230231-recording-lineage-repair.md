# 2026-07-22 23:02 CST — recorded-template lineage repair

## User correction
用户明确说明：DeepSeek、豆包、千问均已真实完成 input/send/response 录制；文心一言尚未录制，要求后续由助手完成。此前把派生配置中的 `response: null` 解释成“用户未录制”是错误判断。

## Evidence checked
- Historical `server/page-trace.jsonl` contains repeated real DeepSeek response capture completions, including `DS_OK`, `DS_FINAL_7F3A`, and `DS_STREAM_REAL_7F3A`.
- Current service templates: Doubao has all three roles; Qwen has all three roles; DeepSeek currently has input/send but response null.
- Historical traces alone do not contain the original DeepSeek response selector string, so no selector was guessed or synthesized.

## Root cause fixed
The extension had legacy third-step storage under `copy`, while current runtime/config used `response`. Loading and sync paths therefore discarded an existing recorded response. A partial sync could also overwrite a complete template.

## Changes
- `extension/background.js`: normalize legacy `copy` as `response` during storage load, domain selection, and `selector_captured`; replay sync sends the normalized response role.
- `extension/content.js`: `set_selectors` accepts `response` or legacy `copy`.
- `server/api_server.py`: selector POST is monotonic per role; null/empty/missing roles cannot erase a previously non-empty recorded role.
- On extension startup, restored local templates are re-synced using normalized roles.

## Verification
- `node --check extension/background.js`: PASS
- `node --check extension/content.js`: PASS
- `node --check extension/popup.js`: PASS
- `python3 -m py_compile server/api_server.py`: PASS
- `git diff --check`: PASS
- `node tests/test_universal_bridge.js`: `UNIVERSAL_BRIDGE_TESTS_PASS`
- API `/health`: `{"status":"ok","service":"phantom-relay-api"}`
- Real Canary restarted with the existing Default profile and workspace extension; two real Doubao content clients reported `ready=true`, `input_ready=true`, `send_ready=true`.
- Template readback: `www.doubao.com` input/send/response all present; `chat.qwen.ai` input/send/response all present; `chat.deepseek.com` input/send present, response still missing from the current derived store.

## Boundary
This round repaired the recording lineage/overwrite bug. It did not invent or replace DeepSeek's missing response selector, did not re-record Doubao/DeepSeek/Qwen, and did not claim a new DeepSeek HTTP E2E pass. Wenxin recording remains a separate planned task.
