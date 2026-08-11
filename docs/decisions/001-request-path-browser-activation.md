# ADR-001: Activate the user browser from the request path

## Status

Accepted

## Date

2026-08-06

## Context

Phantom Relay exposes a local OpenAI-compatible API backed by a user-owned
browser extension. A queued job cannot execute if the browser process is
closed, and waiting for a periodic extension poll makes the API appear hung.
The previous implementation only woke the browser when an opt-in environment
flag was enabled, while the main execution path explicitly recorded
`browser_wake_skipped` by default.

The product boundary remains provider-neutral and user-owned:

- the backend must not select a model-specific browser process or profile;
- the extension remains responsible for DOM execution and response capture;
- BiDi/WebDriver hosts remain optional test infrastructure, not the product
  execution path;
- a browser wake must not create a second browser when a fresh same-domain
  executable extension client already exists.

## Decision

After creating a browser job, `/v1/chat/completions` and `/browser/submit`
immediately call the provider-neutral browser wake coordinator.

The coordinator:

1. reuses a fresh same-domain ready client without launching anything;
2. otherwise wakes an explicitly configured command or browser bundle;
3. otherwise opens the job's validated `target_url` in the operating system's
   default browser;
4. applies a short global cooldown so concurrent requests do not launch a
   browser storm;
5. keeps an explicit `PHANTOM_RELAY_AUTO_WAKE_BROWSER=0` opt-out for headless
   and test deployments.

Once the extension is alive, it only discovers, validates, and reuses the
target page opened by the wake coordinator. The automatic execution worker
never creates or navigates a provider tab. The popup's explicit user-driven
recording action remains allowed to open or navigate a recording page. This
gives automatic execution one activation owner and prevents a backend wake
from racing an extension-created duplicate.

## Alternatives considered

### Rely only on periodic extension polling

Rejected: it requires an already running browser and makes a cold-start API
request wait indefinitely for an external process to appear.

### Always launch the repository's BiDi/Chrome host

Rejected for the product path: it uses a test profile and may not contain the
user's login state. It remains available as an explicit diagnostic harness.

### Always launch a new browser process for every request

Rejected: it duplicates user sessions, risks profile locks, and creates a
browser storm under concurrent requests.

## Consequences

- Cold-start requests now have an immediate activation action visible in the
  API trace.
- The installed extension and logged-in user profile remain the execution
  authority.
- Users whose extension is installed in a non-default browser can provide an
  explicit bundle or wake command.
- Opening the browser does not itself prove readiness; the existing extension
  registration, recorded-profile validation, claim, submission, and response
  evidence gates still must pass.
