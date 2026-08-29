# Phantom Relay P0 — Deterministic Conversation Ownership

## Overview

Make ordinary OpenAI-compatible requests reuse the correct browser conversation
without relying on a random per-job identifier. The browser extension remains
provider-neutral: it receives the server-owned conversation identity and uses
the existing claim/binding contract.

## Architecture decisions

- An explicit `conversation_id`, `session_id`, or `conversation` wins when sent
  by the client; the same keys are accepted under `phantom_relay`.
- Without an explicit identity, derive a stable default from the resolved model
  route and normalized domain: `default_<model>_<domain>`.
- Bind the conversation identity into the idempotency fingerprint so the same
  idempotency key cannot silently cross conversation boundaries.
- Keep the identity metadata-only. Never derive it from or store page text,
  prompt text, assistant text, cookies, or authorization data.
- Keep `/browser/submit` and `/v1/chat/completions` on the same identity
  resolver so direct browser jobs and OpenAI jobs obey one ownership contract.

## Task list

### Task O1: Define and test the conversation identity resolver

Acceptance criteria:

- [x] Explicit top-level and `phantom_relay` identities are normalized and win
  over the default.
- [x] Missing identity produces a deterministic model/domain default.
- [x] Empty or oversized identities fail closed instead of entering a binding.

Verification:

- [x] Focused conversation ownership tests pass.
- [x] Tests assert no page/content fields participate in identity resolution.

### Task O2: Wire identity through request and browser job creation

Acceptance criteria:

- [x] Chat completion jobs use the resolved deterministic conversation ID.
- [x] Direct browser submissions use the same resolver.
- [x] Idempotency fingerprints include conversation identity.

Verification:

- [x] Fake browser completion test observes stable identity across two turns.
- [x] Same idempotency key with a different conversation ID returns conflict.

### Task O3: P0 ownership checkpoint

Acceptance criteria:

- [x] Same model/domain requests reuse one ownership binding.
- [x] Explicitly separated conversations cannot claim the other conversation's
  tab.
- [x] Existing profile, runtime-recovery, and generic DOM tests remain green.

Verification:

- [x] Focused Node and Python tests pass.
- [x] Full Python suite and selected isolated Chromium matrix pass.

## Stop condition

The automated C3 checkpoint is complete, but the slice is not accepted until
the real-browser E2E gate below passes. Do not merge, push, or call this slice
complete based only on unit, fixture, or isolated-DOM evidence.

### Real-browser E2E gate

- [ ] A real `/v1/chat/completions` or `/browser/submit` request creates a
  uniquely identified job.
- [ ] A real Chrome instance with the extension reports a fresh
  `content-ready` client and claims that job exactly once.
- [ ] The extension invokes the recorded input/send contract on the real page.
- [ ] The extension captures a non-empty assistant result from the real page
  and posts it back with the matching claim, tab, client, domain, and
  conversation identity.
- [ ] The final API response and server job state are verified from the API;
  no page text, prompt, assistant body, cookies, storage, or authorization
  material is written to the evidence.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Two clients unintentionally share the default conversation | Medium | Allow explicit client-owned IDs and document the default scope as local server + model + domain. |
| Unbounded identity creates noisy bindings | Medium | Normalize and cap identity length before job creation. |
| Existing direct browser jobs change behavior | Medium | Test explicit IDs and keep random fallback only when no model/domain scope exists. |
