# Browser Client Registration Contract

## Purpose

The Phantom Relay extension is a dynamic browser client, not a fixed tab or a developer-owned Chrome process. The backend uses this contract to discover browser instances, their tabs, capabilities, and freshness.

## Registration

```http
POST /browser/register
Content-Type: application/json
```

Request:

```json
{
  "client_id": "client-install-uuid",
  "extension_version": "2.5.1",
  "browser": {
    "name": "Chromium",
    "version": "140"
  },
  "profile_id": "client-install-uuid",
  "tabs": [
    {
      "tab_id": 42,
      "url": "https://chat.deepseek.com/",
      "domain": "chat.deepseek.com",
      "ready": true,
      "input_ready": true,
      "send_ready": true,
      "conversation_id": "conv-local-id",
      "capabilities": {
        "can_execute": true,
        "can_observe": true,
        "can_stream": true,
        "can_create_tab": true,
        "can_close_tab": false,
        "can_snapshot": true
      }
    }
  ]
}
```

Required registration fields:

- `client_id`: stable per extension installation and persisted in `chrome.storage.local`;
- `extension_version`: extension version or build identifier;
- `tabs`: an array of current usable browser tabs.

The backend does not receive cookies, page content, or conversation text in this contract.

## Response

Successful registration returns:

```json
{
  "ok": true,
  "client": {
    "client_id": "client-install-uuid",
    "state": "ready",
    "fresh": true,
    "tabs": []
  }
}
```

Malformed external payloads return the existing structured error format:

```http
400 Bad Request
```

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_browser_registration",
    "message": "client_id_required"
  }
}
```

## Client and tab identity

- `client_id` identifies one extension installation/profile instance.
- `tab_id` identifies a browser tab within that client.
- `conversation_id` identifies the page conversation binding when available.
- A tab is eligible for a job only when its registration is fresh, its domain matches, its page is ready, and both `can_execute` and `can_observe` are true.
- The backend retains legacy tab-indexed heartbeat behavior while clients migrate to registration.

## Freshness and recovery

The current client freshness window is 45 seconds. Registration is not a lease for a job; job ownership still requires the job claim token and the request state machine.

```text
new -> registered -> ready -> stale -> disconnected
                         \-> replaced
```

The extension periodically re-registers the client and sends `client_id` on heartbeat messages. A service-worker restart must reuse the stored ID rather than create a new identity.

## Privacy boundary

The registration/status payload may contain browser metadata, URLs, domains, tab IDs, and capability flags. It must not contain cookies, authorization headers, page text, or conversation content.

