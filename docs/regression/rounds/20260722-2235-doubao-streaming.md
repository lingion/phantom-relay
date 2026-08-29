# Doubao streaming regression — 3-run evidence — 2026-07-22 22:35 CST

## Scope
Real Canary + real extension + unchanged existing Doubao recording. No re-recording, no CDP chat actions, no manual browser/result submission.

## Caller acceptance
- R1 initial: FAIL — heartbeat only, `response_timeout`; page had new user node but no assistant. Not counted.
- R1B: PASS — real SSE delta `DOUBAO_STREAM_R1B`, `finish_reason=stop`, `[DONE]`.
- R2 initial: FAIL — same poisoned session; heartbeat only, `response_timeout`; no assistant node. Not counted.
- R2B: PASS — real SSE delta `DOUBAO_STREAM_R2B`, `finish_reason=stop`, `[DONE]`.
- R3 initial: FAIL — same poisoned session; heartbeat only, `browser_timeout`; no assistant node. Not counted.
- R3B: PASS — real SSE delta `DOUBAO_STREAM_R3B`, `finish_reason=stop`, `[DONE]`.

## Count
Independent successful real-caller streaming runs after real Canary restart: **3/3 PASS** (R1B, R2B, R3B).

## Boundary
Consecutive requests in one Doubao page can enter a no-assistant/broken generation state. Restarting the real Canary clears it; this was observed and recorded, not hidden.
