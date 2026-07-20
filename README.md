# Phantom Relay

> A local, browser-based AI proxy that exposes logged-in web AI sessions through an OpenAI-compatible API.

[中文文档](README-zh-CN.md) · **English**

Phantom Relay connects a local HTTP API to AI chat websites running in Google Chrome Canary. Instead of calling a provider's private API directly, it uses a browser session owned by the user and a site template recorded from that website's interface.

The project is designed as a reusable browser-agent framework: users can record the input field, submission method, and response area for a website, bind a model name to that site, and then access it through a local OpenAI-compatible endpoint.

## How It Works

```text
OpenAI-compatible client
        |
        v
Local Python API (:8765)
        |
        v
Model-to-site route
        |
        v
Chrome Canary extension
        |
        v
Recorded site template
        |
        v
Web page interaction and DOM response extraction
        |
        v
OpenAI-compatible JSON or SSE response
```

Phantom Relay does not ship with the author's browser profile, login sessions, conversations, or recorded selectors. A clean installation starts without site configuration; each user records and binds their own sites locally.

## Features

- Chrome extension built with Manifest V3.
- Local Python HTTP server.
- OpenAI-compatible `GET /v1/models` endpoint.
- OpenAI-compatible `POST /v1/chat/completions` endpoint.
- Non-streaming JSON responses.
- Browser-backed SSE responses based on growing DOM snapshots.
- Per-hostname site templates.
- Manual recording of:
  - input fields;
  - Enter submission;
  - keyboard shortcuts;
  - send buttons;
  - response anchors.
- Selector generation with stable CSS and attribute-based fallbacks.
- Generic input/send discovery when a complete template is not available.
- Logical message detection for virtualized chat interfaces.
- Markdown-oriented response extraction.
- Reasoning and UI-status text filtering where the page exposes identifiable status elements.
- Single-submission protection to reduce accidental duplicate messages.
- Idempotency handling for repeated API requests.
- Local conversation storage and popup JSON export.
- Browser heartbeat and page trace endpoints for adapter debugging.

## Compatibility Status

The adapter is designed to be site-configurable rather than hard-coded to a fixed provider list.

DeepSeek and Doubao have been successfully tested by the author in the local browser environment. These results demonstrate current compatibility; they are not bundled integrations. Users still need to log in to their own accounts and record their own site templates after installation.

Other websites may be connected through the same recording workflow, but compatibility depends on the site's DOM structure, message rendering, and submission behavior. A hostname listed in the extension's permissions is not, by itself, a completed integration.

## Requirements

### Browser-only installation

The Phantom Relay extension itself is a Manifest V3 browser extension. It can be installed in any Chromium-based browser that supports unpacked Manifest V3 extensions, including:

- Google Chrome;
- Google Chrome Canary;
- Microsoft Edge;
- Brave;
- Chromium and other compatible Chromium-based browsers.

To use the browser extension, users need:

- an AI website open in the browser;
- an account already logged in to that website;
- permission to load an unpacked extension;
- a client capable of sending OpenAI-compatible HTTP requests if they want to use the local API.

### Optional local API server

The local Python API is required only for the OpenAI-compatible proxy workflow. It requires Python 3 and a machine capable of running the server. The browser extension and the local API are separate components; users who only need the extension's recording and browser-side features do not need to treat macOS or Chrome Canary as hard requirements.

The project is developed and tested on macOS with Chrome Canary, but those are development environments, not product requirements. Browser-specific behavior may vary between Chromium-based browsers and should be verified in the target browser.

## Installation

### 1. Install the extension in your browser

Phantom Relay can be installed as an unpacked Manifest V3 extension in a compatible Chromium-based browser. The exact menu names may vary slightly by browser.

1. Open the browser's extensions page:
   - Chrome / Chromium: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `extension/` directory.
5. Open the AI website you want to connect.
6. Open the Phantom Relay extension popup.

The optional `launch.sh` helper is only a development convenience for Chrome Canary on macOS. It is not required for installation and is not the project's browser requirement.

### 2. Start the local API (optional)

The local API is needed when you want to access the browser agent through `/v1/chat/completions`.

```bash
cd phantom-relay
python3 server/api_server.py
```

The server listens on:

```text
http://127.0.0.1:8765
```

Alternatively:

```bash
./server/run-api.sh
```

The launcher reuses an already healthy API process instead of starting a duplicate listener.

## First-Time Site Setup

Site configuration is intentionally user-owned and local.

### 1. Record the input field

In the extension popup, start input recording and click the website's textarea, input, or contenteditable element.

The extension generates a selector using stable identifiers where possible, including:

1. unique `id`;
2. `data-*` attributes;
3. `aria-label`;
4. unique tag/class combinations;
5. a CSS path fallback.

### 2. Record the submission method

Choose one of the available methods:

- **Enter** — dispatches one Enter key action.
- **Shortcut** — records and replays a keyboard shortcut.
- **Send button** — records and clicks the website's send control once it is visible and enabled.

The extension requires evidence of a new user message after submission and does not blindly submit again when the result is uncertain.

### 3. Record a response anchor

Click an existing AI response in the page. The anchor helps the extension identify the relevant message area, while the main extraction path uses logical message nodes exposed by the page.

### 4. Bind a model name

Enter a model alias in the popup and bind it to the current hostname. For example, a user may choose an alias such as `my-deepseek` or `chat-model-1`.

The alias is local configuration. It is not a provider API key and does not create a provider account connection.

After recording and binding are complete, the alias becomes available through `/v1/models` on that user's installation.

## API Usage

### Health check

```bash
curl http://127.0.0.1:8765/health
```

### List configured models

```bash
curl http://127.0.0.1:8765/v1/models
```

A clean installation returns no user-configured models until a site has been recorded and bound.

### Chat completion

```bash
curl -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-deepseek",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### Streaming chat completion

```bash
curl -N -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-deepseek",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

The current streaming implementation converts successive browser DOM snapshots into SSE deltas. It is not a provider-native token stream and does not guarantee token-level boundaries.

### Supported message input

The server accepts normalized `system`, `developer`, `user`, `assistant`, and `tool` message roles. Because the browser bridge is provider-neutral, previous messages are currently formatted as text context for the web page rather than mapped to a provider-native conversation ID.

## Runtime Data

Runtime data is generated locally and is excluded from the repository:

```text
server/model_routes.json       model aliases and hostname routes
server/selector_templates.json recorded site selectors
server/conversations.json      local conversation history
server/page-trace.jsonl        local page diagnostics
```

These files are intentionally not part of the source distribution. They contain user-specific configuration, browser behavior, and conversation data.

The Chrome extension also stores per-user state in `chrome.storage.local`.

## API Endpoints

### Public client endpoints

```text
GET  /health
GET  /model-routes
GET  /v1/models
POST /v1/chat/completions
```

### Browser bridge endpoints

```text
GET  /browser/clients
GET  /browser/pending-domains
GET  /browser/selectors?domain=<hostname>
POST /browser/sync-routes
POST /browser/selectors
POST /browser/submit
POST /browser/poll
POST /browser/heartbeat
POST /browser/ready
POST /browser/delta
POST /browser/result
```

### Diagnostics

```text
POST /trace
GET  /trace/tail?limit=20
```

The local server does not currently expose a server-side `/export` or `/export/jsonl` endpoint. Conversation export is provided by the extension popup as JSON.

## Project Structure

```text
phantom-relay/
├── extension/
│   ├── background.js          MV3 service worker and job scheduler
│   ├── content.js             recording, replay, and DOM extraction
│   ├── popup.html              extension interface
│   ├── popup.js                popup controller
│   └── universal_bridge.js     provider-neutral bridge primitives
├── server/
│   ├── api_server.py           local HTTP API and browser job queue
│   ├── run-api.sh              API launcher
│   └── *.json                  local runtime data, ignored by Git
├── tests/
│   ├── test_universal_bridge.js
│   ├── test_api_idempotency.py
│   └── fixtures/
├── docs/
│   └── universal-adapter-architecture.md
├── launch.sh
└── README.md
```

## Limitations

Phantom Relay is a browser automation proxy, not a complete replacement for a provider's native API.

Current limitations include:

- A target website must be logged in within the user's browser.
- Each website must be recorded and maintained when its UI changes.
- The browser execution path is designed around a local queue and does not provide production-grade multi-account parallelism.
- Streaming is DOM-snapshot-based rather than token-based.
- OpenAI request parameters such as `temperature` and `top_p` are not automatically translated into controls on the target website.
- Native provider conversation IDs are not currently unified across websites.
- Tool calls, vision, file uploads, audio, structured output, and native reasoning are not currently provided as a unified capability layer.
- The local API has no authentication layer by default. Do not expose port `8765` to the public Internet or an untrusted network.
- Browser login credentials and cookies remain in the user's browser; Phantom Relay does not implement OAuth refresh.

## Development

Run syntax checks and the repository tests:

```bash
node --check extension/universal_bridge.js
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
python3 -m py_compile server/api_server.py tests/test_api_idempotency.py
node tests/test_universal_bridge.js
python3 tests/test_api_idempotency.py
git diff --check
```

The automated tests cover bridge primitives, message normalization, response tracking, snapshot merging, send-action safety, and API idempotency. They do not replace a real browser regression against a logged-in website.

## Roadmap

- Add repeatable end-to-end browser tests for recorded site templates.
- Improve adapter capability declarations and site-specific error reporting.
- Separate provider adapters from the core HTTP lifecycle.
- Add explicit unsupported-capability responses for request features that cannot be mapped to a website.
- Improve streaming event semantics when a website exposes reliable incremental boundaries.
- Add optional multi-profile and multi-session scheduling.
- Add authentication, access control, and stronger production security defaults.
- Explore unified support for tools, vision, files, structured output, and provider-native conversations where the target website makes those capabilities observable and reliable.

## License

Phantom Relay is licensed under the [GNU General Public License v3.0](LICENSE).
