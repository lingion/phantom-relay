# Phantom Relay Context Management Analysis

**Generated**: 2026-07-30  
**Scope**: Full message flow from Cherry Studio → api_server → protocol → browser → response  
**Code baseline**: api_server.py (1467 lines), protocol.py (422 lines), content.js (2604 lines), background.js (1146 lines)

---

## 1. Complete Message Flow Trace

```
Cherry Studio (OpenAI client)
  │
  │ POST /v1/chat/completions  { model, messages[], stream, tools }
  ▼
api_server.py:1265  chat_completions()
  │
  ├─ Line 1293: resolve_model(model_id, _routes, _aliases)
  ├─ Line 1302-1316: Parse raw messages → ProtoMessage objects
  │   └─ Only extracts `text` parts from multi-part content arrays;
  │      image_url and file_url parts are silently dropped.
  │
  ├─ Line 1319: browser_text = messages_to_text(messages)
  │   └─ protocol.py:189-216 — ALL messages concatenated as:
  │      "RoleLabel: content\n\nRoleLabel: content\n\n..."
  │      NO TRUNCATION. NO TOKEN CHECK. NO CONTEXT WINDOW GATE.
  │
  ├─ Line 1334: tool_prompt = inject_tool_defs(tools, ...)
  ├─ Line 1335: full_prompt = browser_text + tool_prompt
  │   └─ NO SIZE CHECK. Could be arbitrarily large.
  │
  ├─ Line 1337: stream = body.get('stream', False)  ← READ but IGNORED
  │
  ├─ Line 1340-1351: new_browser_job(full_prompt, ...)
  │   └─ message=full_prompt, messages=[{role:user, content:full_prompt}]
  │      Entire conversation flattened into a single user message.
  │
  ├─ Line 1353-1363: Wait for extension to complete (blocking, up to 300s)
  │
  ├─ Line 1374: result_text = final.result.assistant
  ├─ Line 1377: tool_calls = extract_tool_calls(result_text)
  ├─ Line 1379-1388: Build OpenAI response (JSON only, never SSE)
  │
  └─ Line 1391-1396: save_conversation(full_prompt, result_text, ...)
      └─ Appends to conversations.json (flat JSON, append-only, NO SIZE LIMIT)
```

---

## 2. What Happens with 50+ Message Conversations?

### 2.1 The Path

`messages_to_text()` (protocol.py:189-216) iterates ALL messages without any limit:

```python
# protocol.py:189-216
def messages_to_text(messages: list[Message]) -> str:
    lines: list[str] = []
    for msg in messages:               # ← NO BREAK, NO LIMIT
        role = msg.role
        label = ROLE_LABELS.get(role, role.capitalize())
        content = msg.content or ""
        ...
        lines.append(f"{label}: {content}")
    return "\n\n".join(lines)
```

### 2.2 The Result

For 50 turns (100 messages: user + assistant each), the entire history becomes one giant text string sent to the browser textarea. Example output for 50 turns:

```
System: You are a helpful assistant.

User: Hello
Assistant: Hi there! How can I help?

User: What's 1+1?
Assistant: 2

... [96 more messages] ...

User: What's 50+50?
```

This text then gets:
1. Concatenated with tool definitions (if any) → `full_prompt`
2. Passed to `new_browser_job(full_prompt, ...)` as a single `message` field
3. Sent to the extension via `background.js:607` as `data.job.message`
4. Pasted into the browser's textarea via `content.js:708`: `setInputValue(inputEl, userMessage)`

### 2.3 What Breaks

- **Browser textarea limits**: Most web chat UIs have input field character limits (Doubao ~4000 chars, DeepSeek ~8000 chars visible). Exceeding this will cause the browser to truncate the input silently or the web app to reject it.
- **UI overflow**: A 100-turn conversation could be 20,000+ characters. `setInputValue()` (content.js:1086-1106) uses `el.value = value` which works but the browser's UI may not display it properly.
- **No server-side protection**: Nothing in api_server.py checks `full_prompt` length before creating the job.

---

## 3. Is `max_input_chars` Enforced? — ❌ NO

### 3.1 Where It's Defined

| Location | Line | Purpose |
|----------|------|---------|
| `model_routes.json` | per-model | `"max_input_chars": 8000` etc. |
| `protocol.py` | 34 | `max_input_chars: int = 8000` (dataclass default) |
| `api_server.py` | 96 | Loaded into `ModelCapabilities` |
| `server/static/admin.html` | 81 | Displayed in admin UI |

### 3.2 Where It's Used

**NOWHERE.** A codebase-wide search for `max_input_chars` finds only:
- Definitions (protocol.py:34, api_server.py:96)
- Config (model_routes.json)
- Display (admin.html:81)

**It is never read or enforced in any logic path.**

The `/v1/chat/completions` handler (api_server.py:1265-1398) does not reference `max_input_chars` at all. The value is loaded into `route.capabilities.max_input_chars` but never checked.

### 3.3 Also Not Enforced: `context_window`

| Model | `context_window` |
|-------|-----------------|
| doubao | 32000 |
| deepseek-chat | 64000 |
| deepseek-reasoner | 64000 |
| qwen-turbo | 32000 |

Also defined but never used as a gate. No code checks if `len(full_prompt)` or `estimate_tokens(full_prompt)` exceeds the model's context window.

---

## 4. Does `file_upload` Work? — ❌ NO

### 4.1 What the Config Says

All 4 models have `"supports_file_upload": true` in `model_routes.json`.

Each model has a `"file_upload": "input[type='file']"` selector defined.

### 4.2 What the API Handler Does

In `chat_completions()` (api_server.py:1305-1309):

```python
for m in raw_messages:
    content = m.get('content', '')
    if isinstance(content, list):
        text_parts = [p.get('text', '') for p in content if p.get('type') == 'text']
        content = '\n'.join(text_parts)
```

**Only `type: "text"` parts are extracted.** If a message contains:

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Describe this image"},
    {"type": "image_url", "image_url": {"url": "https://example.com/img.png"}}
  ]
}
```

The `image_url` part is silently dropped. Only `"Describe this image"` survives.

### 4.3 What the Extension Does

`content.js:632 autoCapture()` calls `setInputValue(inputEl, userMessage)` which only sets text content. There is no code that:
- Downloads files from URLs
- Uploads files to `<input type="file">` elements
- Injects `DataTransfer` or `File` objects into the DOM

### 4.4 The `supports_file_upload` Flag

It is loaded, stored in `ModelCapabilities.supports_file_upload`, but **never gates any behavior**. It's dead metadata.

---

## 5. How Are Tool Call Results Fed Back?

### 5.1 Protocol-Level Formatting

In `messages_to_text()` (protocol.py:196-211):

```python
# Assistant tool_calls:
"Assistant: <tool_call id=\"c1\" name=\"search\">{\"q\":\"test\"}</tool_call>"

# Tool results:
"Tool search returned: Sunny 25°C"
```

### 5.2 The Feed-Back Loop

```
Turn 1: User asks → Assistant returns tool_call → extracted by extract_tool_calls()
Turn 2: Client sends [user msg, assistant(tool_calls), tool(result), user(followup)]
        → messages_to_text() formats ALL into one prompt
        → Sent to browser as one text blob
```

**Problem**: The browser web UI (Doubao, DeepSeek, etc.) doesn't understand this format. It sees one giant text block with "Tool search returned: ..." embedded. The browser AI then tries to interpret tool results as part of the conversation context — it's not a native tool call round-trip.

### 5.3 Browser vs. Real Tool Calls

The browser AI site has no tool execution capability. The tool call extraction (`extract_tool_calls`) works at the protocol level (Cherry Studio → api_server), but the browser never executes tools. The `messages_to_text` function embeds tool results as plain text in the next turn's prompt.

### 5.4 `requires_tool_result_name` / `requires_assistant_after_tool_result`

These capability flags (protocol.py:27-28) are defined for deepseek models but **not used in any logic**. They appear to be forward-looking metadata for future tool-call-aware prompt formatting.

---

## 6. Identified Gaps (with Line Numbers)

### 6.1 CRITICAL: No Context Window Enforcement

| Gap | Location | Details |
|-----|----------|---------|
| No input size check | `api_server.py:1319` | `browser_text = messages_to_text(messages)` — no guard |
| No token budget check | `api_server.py:1335` | `full_prompt = browser_text + tool_prompt` — unchecked |
| `max_input_chars` dead field | `protocol.py:34/96` | Defined, loaded, never enforced |
| `context_window` dead field | `protocol.py:32/94` | Defined per-model, never checked |
| No HTTP body limit | `api_server.py` | Existing audit finding: no `_read_body` max_bytes protection |

### 6.2 CRITICAL: No Message Truncation

| Gap | Location | Details |
|-----|----------|---------|
| `messages_to_text` has no limit | `protocol.py:189-216` | Iterates all messages unconditionally |
| No oldest-message pruning | N/A | No FIFO/LRU truncation |
| No summarization/compaction | N/A | No context compression |
| `conversations.json` unlimited growth | `api_server.py:850-864` | Append-only flat JSON, ~784KB and growing |

### 6.3 HIGH: System Message Handling

| Gap | Location | Details |
|-----|----------|---------|
| System messages treated as conversation history | `protocol.py:91` | `"system": "System"` — sent to browser as `"System: ..."` |
| No system injection via separate mechanism | `api_server.py:1318-1335` | System messages mixed into `browser_text` |
| Developer role treated same as system | `protocol.py:92` | `"developer": "System"` — collapsed |
| No system message persistence across turns | N/A | System only present if client re-sends it each turn |

### 6.4 HIGH: Tool Result Formatting

| Gap | Location | Details |
|-----|----------|---------|
| Tool results as plain text | `protocol.py:210-211` | `"Tool {name} returned: {content}"` |
| No structured tool result envelope | N/A | Browser AI sees raw text, not tool messages |
| No alignment with provider-native formats | N/A | DeepSeek web UI has its own tool display format |
| `requires_tool_result_name` unused | `protocol.py:27` | Flag loaded but never checked |
| `requires_assistant_after_tool_result` unused | `protocol.py:28` | Flag loaded but never checked |

### 6.5 HIGH: File Upload Not Implemented

| Gap | Location | Details |
|-----|----------|---------|
| image_url parts silently dropped | `api_server.py:1307-1308` | Only `type: "text"` extracted |
| No file download/upload pipeline | `content.js:632+` | `setInputValue` is text-only |
| `supports_file_upload` flag dead | Multiple | Loaded, never gates behavior |
| `file_upload` selector unused | `model_routes.json` | Defined in selectors, never read for file operations |

### 6.6 MEDIUM: Full Message Flow Gaps

| Gap | Location | Details |
|-----|----------|---------|
| `stream=true` ignored | `api_server.py:1337` | Read, then handler returns JSON only |
| Entire conversation flattened to one message | `api_server.py:1346` | `messages=[{"role":"user","content":full_prompt}]` |
| No multi-turn via browser | `api_server.py:1344` | `new_tab=False` — reuses same tab, doesn't track turns |
| `estimate_tokens` called only in response | `protocol.py:287-288` | Not used for input gating |
| No `stop` sequence passthrough | N/A | Stop sequences accepted but not forwarded to browser |

### 6.7 LOW: Code Quality

| Gap | Location | Details |
|-----|----------|---------|
| `browser_prompt` still exists (legacy) | `api_server.py` | Referenced by tests but deprecated in new flow |
| `normalize_messages` still exists (legacy) | `api_server.py` | Old system, parallel to new protocol |  
| Dual config system | `api_server.py:128 vs 262` | `_routes` (new) vs `model_routes` (legacy) |
| `selector_templates.json` still active | `api_server.py:331-363` | Marked deprecated but actively loaded/saved |

---

## 7. Summary: What Must Be Fixed

### P0 (Must Fix Before Production Use)

1. **Add input truncation**: In `chat_completions()` (api_server.py:1319), enforce `route.capabilities.max_input_chars` on `browser_text`, truncating oldest messages first.
2. **Add context window enforcement**: Check `estimate_tokens(full_prompt)` against `route.capabilities.context_window`, reject or truncate if exceeded.
3. **Add HTTP body limit**: Protect `_read_body` with a `max_bytes` (suggest 10 MB).

### P1 (Feature Gaps)

4. **Implement file upload**: Handle `image_url` in content arrays, download files, inject into browser file inputs.
5. **Improve tool result formatting**: Use model-specific formatting (e.g., DeepSeek's native format) instead of plain-text `"Tool X returned: ..."`.
6. **Enable SSE streaming**: The `stream=true` parameter should produce real SSE output with deltas.

### P2 (Architectural)

7. **Remove dead flags or use them**: Either delete `max_input_chars`, `context_window`, `supports_file_upload` from the config, or actually enforce them.
8. **Consolidate config**: Merge legacy `model_routes` dict with new `_routes` system.
9. **Add compaction to conversations.json**: Rotate, truncate, or use SQLite instead of flat JSON.
10. **Clean up legacy functions**: Remove `browser_prompt`, `normalize_messages`, and other deprecated code paths.

---

## 8. Direct Answer to Task Questions

| Question | Answer | Line(s) |
|----------|--------|---------|
| What happens with 50+ message conversations? | All messages concatenated into one giant text blob, sent to browser textarea. No truncation, no limit enforcement. | `protocol.py:189-216`, `api_server.py:1319` |
| Is `max_input_chars` enforced? | **No.** Defined and loaded but never checked. | `protocol.py:34`, `api_server.py:96` |
| Does `file_upload` work? | **No.** Content arrays only extract text parts; extension only sets text values. | `api_server.py:1307-1308`, `content.js:1086` |
| How are tool call results fed back? | Formatted as `"Tool {name} returned: {content}"` and embedded in the next turn's prompt as plain text sent to the browser. | `protocol.py:210-211`, `api_server.py:1319-1335` |
| Context window enforcement? | **Missing entirely.** | `api_server.py:1319` (should be here) |
| Message truncation? | **None.** | `protocol.py:189-216` (no limit) |
| System message handling? | System messages labeled "System:" and included in browser prompt; developer role collapsed to "System:". | `protocol.py:91-92` |
| Tool result formatting? | Plain text only; no model-specific formatting. | `protocol.py:210-211` |
