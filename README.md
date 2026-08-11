# Phantom Relay

> Turn a logged-in AI chat website into a local OpenAI-compatible endpoint by recording its browser UI once.

[中文说明](README-zh-CN.md) | **English**

Current extension version: **2.5.7**

Current browser runtime protocol: **2026-08-11.05**

Phantom Relay is a local browser-session gateway. You install the unpacked extension in your own Chromium-based browser, run the Python backend, record a page's input, send action, and completed response, then call that recorded site through `POST /v1/chat/completions`.

It is not a provider SDK and it does not contain built-in credentials, cookies, recorded selectors, or provider-specific integrations. Each installation uses the user's existing browser login and user-recorded DOM profile.

## Product Contract

```text
OpenAI-compatible client
          |
          v
Local Flask API on 127.0.0.1:8765
          |
          v
User model alias -> recorded site/profile
          |
          v
Backend wakes or reuses the user's browser
          |
          v
MV3 extension executes one recorded send action
          |
          v
Only a fresh recorded response identity is returned
          |
          v
OpenAI-compatible JSON or SSE
```

The runtime follows several deliberate boundaries:

- The recorded DOM profile is the response authority.
- The extension does not invent selectors during an API request.
- The extension background worker does not create, navigate, close, or foreground provider tabs.
- The backend owns browser activation and opens the recorded target URL only when no ready page can be reused.
- One request executes one recorded send action. An uncertain send is not blindly retried.
- A response must prove a fresh recorded identity or a valid changed projection under that identity.
- Ambiguous ownership fails closed instead of returning an old assistant message or the user's prompt.
- Network interception is disabled in the product path. The supported path is recorded DOM capture.

## What Works Today

| Capability | Current status |
| --- | --- |
| Manifest V3 extension | Implemented |
| User-recorded input, Enter, shortcut, or send button | Implemented |
| User-recorded response identity | Required for execution |
| Per-site profiles and model aliases | Implemented |
| Backend browser wake/reuse | Implemented |
| `GET /v1/models` | Implemented |
| `POST /v1/chat/completions` JSON | Implemented and live-tested |
| SSE response envelope | Implemented, page-dependent |
| Provider-native token streaming | Not provided |
| Network response interception | Disabled |
| Unified tools, vision, files, audio, or structured output | Not yet provided |

The current runtime has been exercised with real backend requests against user-recorded Mimo and Doubao pages, including repeated Mimo requests, a long-input user-echo regression, and a cross-site switchback. Those are test targets, not bundled integrations or a promise that every revision of those sites will continue to work.

## Requirements

- Python 3.10 or newer.
- A Chromium-based browser that can load an unpacked Manifest V3 extension.
- An existing login to the AI website you want to record.
- The browser profile in which Phantom Relay is installed must be the profile that opens the recorded target URL.

The primary development and live-test environment is macOS with Chrome for Testing. Chrome, Edge, Brave, and other Chromium-based browsers are intended targets, but browser-specific behavior must be verified on the target installation.

## Quick Start

### 1. Clone and start the backend

```bash
git clone https://github.com/lingion/phantom-relay.git
cd phantom-relay

python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 -m server.api_server
```

The API listens on `http://127.0.0.1:8765` by default.

On macOS or Linux, the repository launcher is also available:

```bash
./launch.sh
```

Check the service before recording:

```bash
curl http://127.0.0.1:8765/health
```

Expected fields include:

```json
{
  "browser_activation_owner": "api",
  "service": "phantom-relay-api",
  "status": "ok"
}
```

### 2. Install the extension

1. Open the extension management page:
   - Chrome / Chromium: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository's `extension/` directory.
5. Pin Phantom Relay if you want the popup available from the toolbar.

The extension requests broad page access because the product is user-recorded and is not restricted to a hard-coded provider list. Review `extension/manifest.json` before installation.

### 3. Record a site profile

1. Open the target AI chat page and sign in.
2. Open the Phantom Relay popup on that page.
3. Confirm the backend address, normally `http://127.0.0.1:8765`.
4. Record **Input** and click the page's real input editor.
5. Choose one send strategy:
   - **Enter**: adopt Enter; no send button needs to be recorded.
   - **Shortcut**: record the exact keyboard shortcut.
   - **Send button**: record the page's real send control.
6. Record **Response** and click one completed assistant response. The page overlay shows candidate boxes so the selection is visible.
7. Keep or change the model alias shown in the popup. A complete profile binds that alias to the current recorded site.
8. Wait for the profile state to report that it is synchronized and ready.

Recording a completed response is mandatory. A generic conversation container without stable message identity is rejected because it cannot reliably distinguish a new assistant reply from an old response or a user message.

### 4. Call the local API

List models created by your local recordings:

```bash
curl http://127.0.0.1:8765/v1/models
```

Send a non-streaming request:

```bash
curl -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-chat",
    "messages": [
      {"role": "user", "content": "Reply with exactly: relay-ok"}
    ]
  }'
```

Request an SSE response:

```bash
curl -N -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-chat",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

SSE describes the caller-facing transport, not guaranteed provider-native streaming. Some pages expose growing DOM snapshots; others expose only one qualified terminal snapshot. Phantom Relay must not be described as token-streaming unless the recorded page actually produces qualified incremental snapshots.

## Request Behavior

The backend accepts normalized `system`, `developer`, `user`, `assistant`, and `tool` message records. Historical messages are rendered into browser-readable context; they are not mapped to a universal provider-native conversation ID.

Useful request fields include:

```text
model             required local model alias
messages          OpenAI-style message array
stream            false for JSON, true for SSE
conversation_id   optional stable local conversation identity
```

`Idempotency-Key` is supported for repeated HTTP submissions. It does not turn an uncertain browser action into permission to send twice.

OpenAI sampling parameters such as `temperature`, `top_p`, or provider-specific reasoning controls are not automatically translated into website UI controls.

## Browser Activation

When a request arrives:

1. The backend resolves the model alias to a user-recorded target.
2. A ready extension page for that domain is reused when available.
3. Otherwise, the backend asks the operating system to open the recorded target URL.
4. The extension validates the page, recorded profile, runtime generation, and response identity before claiming the job.

On macOS, the default opener uses background LaunchServices activation. Other platforms use Python's default browser integration and may have different foreground behavior. Managed installations can configure `PHANTOM_RELAY_BROWSER_BUNDLE_ID` or `PHANTOM_RELAY_BROWSER_WAKE_COMMAND`.

The optional BiDi host under `scripts/` is test infrastructure. It is disabled by default and must not run beside the normal API-owned activation path.

## Local Data and Privacy

All browser login state stays in the user's browser. Phantom Relay does not read or export browser cookies, passwords, or OAuth refresh tokens.

Local runtime files include:

```text
server/model_routes.json        generic source configuration
server/user_bindings.json       local model aliases and recorded targets
server/selector_templates.json  local recorded selectors and profiles
server/conversations.json       local conversation history
server/browser_jobs.sqlite3     durable browser job state
server/page-trace.jsonl         metadata-oriented runtime diagnostics
```

User bindings, profiles, conversations, job databases, logs, screenshots, and browser profiles are excluded from Git. A clean clone contains no recorded sites.

The API binds to `127.0.0.1` by default and has no authentication layer. Do not expose port `8765` to the public Internet or an untrusted LAN.

## Troubleshooting

### `Failed to fetch` or `profile_sync_failed`

- Confirm `curl http://127.0.0.1:8765/health` succeeds.
- Confirm the popup backend address uses the same host and port.
- Save the backend address, then reverify or rerecord the profile.

### `recording_route_missing`

- Open the intended target page in the same browser profile.
- Complete input, send strategy, and response recording on that page.
- Confirm the alias is bound only after the complete profile exists.

### Request times out

A timeout means the job did not produce a qualified terminal response within the configured limit. Check the popup diagnostics and `/trace/tail`; do not repeatedly submit the same prompt until you know whether the page accepted the first send.

### Old response or user text appears as output

Runtime `2026-08-11.05` rejects known user echoes and compares send evidence through the same canonical recorded boundary used for final capture. If a site redesign invalidates the recorded identity, rerecord a completed assistant message instead of broadening the selector to a page or conversation container.

### Extension was updated but the page uses an older runtime

Reload the extension on the browser's extension page, then refresh the recorded site. The popup diagnostics expose content-script version drift.

## Updating

```bash
git pull --ff-only
python3 -m pip install -r requirements.txt
```

Then reload Phantom Relay on the browser's extension page, refresh recorded tabs, and restart the backend process.

Existing local profiles remain outside Git. Back them up before destructive browser-profile or local-data operations.

## Development and Verification

Install the development-only test dependencies:

```bash
python3 -m pip install -r requirements-dev.txt
```

Run the repository's current static suites:

```bash
node --test tests/*.js
python3 -m pytest -q

node --check extension/content.js
node --check extension/background.js
node --check extension/profile_contract.js
node --check extension/response_observation.js
git diff --check
```

Static tests prove contracts and regressions; they do not prove a logged-in website still works. A release-quality browser change also requires a real backend request, a real recorded send action, a fresh response identity, a non-leaking user sentinel, and a queue that returns to zero.

## Repository Layout

```text
phantom-relay/
├── extension/              MV3 popup, worker, recorder, and DOM runtime
├── server/                 Flask API, route/profile registry, and job store
├── scripts/                migration and isolated browser-test helpers
├── tests/                  Node and pytest contract/regression suites
├── docs/                   architecture, decisions, and test evidence
├── launch.sh               portable backend launcher
├── requirements.txt        Python runtime dependency
├── requirements-dev.txt    development and browser-test dependencies
└── README.md
```

## Current Limitations

- Every site must be recorded by the user and may need rerecording after UI changes.
- Logged-in browser state is required.
- Cross-browser behavior is not yet continuously tested.
- DOM capture is not provider-native token streaming.
- Website latency and generation state remain external sources of timeout variance.
- Multi-account and high-concurrency production scheduling are not finished.
- Tools, vision, uploads, audio, structured output, and provider-native reasoning are not a unified reliable contract.
- Network interception is intentionally outside the current product path.

## License

Phantom Relay is licensed under the [GNU General Public License v3.0](LICENSE).
