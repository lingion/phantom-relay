# Doubao long-context regression — boundary evidence — 2026-07-22 22:50 CST

## Scope
Real Canary + real extension + unchanged existing recording; no re-recording, no CDP chat action, no manual result submission.

## Results
- Long R1: FAIL — prompt 1894 chars entered as a complete user node; no assistant node; caller `response_timeout`.
- Long R1B after real Canary restart: FAIL — prompt 1895 chars entered as a complete user node; no assistant node; caller `response_timeout`.
- Medium isolation after another real Canary restart: FAIL — prompt 580 chars / rendered user text 625 chars; input became disabled, no assistant node; caller `browser_timeout`.

## Boundary
The failure happens before recorded response extraction: the real Doubao page accepts the user message but does not materialize an assistant response. Therefore this is not evidence that the recorded response selector is wrong, and no recording was changed.

## Current status
Doubao long-context acceptance: **NOT PASSING**. Short non-streaming and streaming remain independently 3/3 after real Canary restarts.
