# Qwen site features — factual regression record

- Domain: `chat.qwen.ai`
- Route: `qwen`
- Target URL: `https://chat.qwen.ai/`

## Recorded contract currently in workspace

- Input: `textarea.message-input-textarea`
- Send: `{kind: "enter", key: "Enter", modifiers: []}`
- Response: `[data-message-id],.qwen-chat-package-container`

## Acceptance status

- No current full real caller-level acceptance result is counted for this window.
- The workspace contains a response selector, but current live-page readiness and complete-response behavior have not been verified in this run.
- No model request is counted until the caller receives a non-empty HTTP response.

## Next action

Verify a real Qwen content-ready client and execute one short non-streaming request using only this recording.
