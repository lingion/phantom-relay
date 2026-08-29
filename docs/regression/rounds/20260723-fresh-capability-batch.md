# Fresh capability batch — 2026-07-23

本记录从零开始。此前所有测试数据作废，不引用、不继承、不折算为本批次结果。

- batch_id: `fresh-20260723-01`
- evidence: originating caller HTTP/SSE body only
- models: doubao, deepseek, qwen, yiyan
- scenarios: short non-stream, real SSE, same-conversation multi-turn, long input, cross-model concurrency, same-model concurrency

## Round 1 — fresh concurrent short gate

| model | status | HTTP | job | raw caller evidence | elapsed |
|---|---:|---:|---|---|---:|
| doubao | FAIL | 502 | `job_1784801479738_b05ff8fd` | `send_no_effect` | 55.99s |
| deepseek | PASS | 200 | `job_1784801479738_2825c2a1` | assistant=`FRESH_GATE_DEEPSEEK`, `finish_reason=stop` | 29.45s |
| qwen | FAIL | 504 | `job_1784801479739_5897a48b` | `browser timeout`, `retryable=true` | 90.16s |
| yiyan | FAIL | 504 | `job_1784801479739_fa64ee56` | `browser timeout`, `retryable=true` | 90.16s |

This was a concurrent gate round. It does not establish isolated per-model capability; subsequent rounds must run one model at a time from a clean ready state.
