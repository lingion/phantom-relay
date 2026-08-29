# Doubao site features — factual regression record

- Domain: `www.doubao.com`
- Route: `doubao`
- Target URL: `https://www.doubao.com/chat/`
- Evidence window: 2026-07-22, real Canary + real extension.

## Recorded contract

- Input: `textarea.semi-input-textarea.semi-input-textarea-autosize`
- Send recording: `{kind: "button", selector: "#flow-end-msg-send"}`
- Response recording: `div.relative.grid.w-full`

## Verified behavior

- Real content script version `2026-07-22.20` loaded.
- Real queued → claimed → recorded send path executed.
- Enter-first behavior and page user-message evidence were observed in trace.
- Earlier archived evidence records 3/3 warm short non-streaming and 3/3 warm streaming caller-level passes; these remain historical and are not re-run under the current response recording failure.

## Current failure

Probe `recorded-probe-20260722-1915`, job `job_1784719007902_2bda200b`, requested `RECORDED_PROBE_R1`.

- Caller result: `response_timeout`.
- The recorded response region exposed only fresh text `RE` and did not grow.
- The monitor also observed only `RE`.
- The implementation correctly refused to relay the partial prefix.

## Boundary and limitation

The current response recording is not sufficient for a current full-response acceptance run. This record does not authorize selector expansion, arbitrary DOM scanning, or using monitor text outside the recorded region as a final answer.

## Next action

Re-record the complete assistant response region through the real GUI, then repeat short 3x and streaming 3x before entering long/cold-start/multimodel scenarios.
