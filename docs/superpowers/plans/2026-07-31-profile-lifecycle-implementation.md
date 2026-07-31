# Phantom Relay Phase A Profile Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Each task is a vertical slice with a focused RED → GREEN → verification cycle.

**Goal:** Make a user-recorded browser profile durable, versioned, synchronized, health-checked, recoverable after reload/restart, and safely diagnosable without provider-specific code or credential access.

**Architecture:** Keep the existing normalized DOM execution contract as the profile payload and wrap it in a lifecycle envelope. The extension owns the local pending/active profile store and page health evidence; the backend owns the persisted profile copy, revision/checksum comparison, model bindings, and structured profile errors. Legacy selector endpoints remain compatibility adapters only.

**Tech Stack:** Chrome MV3 extension, JavaScript browser runtime, `chrome.storage.local`, Web Crypto SHA-256, Python 3.11, Flask test client, JSON registry documents, Selenium isolated Chromium fixtures, Node `node:test`, pytest.

## Global Constraints

- Core runtime must not contain named-provider branches, named-provider selectors, fixed real-site URLs, fixed tab IDs, or fixed author browser profiles.
- A recorded profile is the only site-specific input to the generic DOM engine.
- Never read or transmit cookies, `localStorage`, `sessionStorage`, Keychain data, passwords, tokens, authorization headers, page text, prompt text, or assistant text during profile lifecycle operations.
- New profile data is written to `pending`; `active` remains the last-known-good profile until local validation and backend sync succeed.
- Profile conflicts are explicit; CSS selectors, identity rules, and capability fields are never auto-merged.
- Missing or invalid response identity fails closed with a structured profile error; it must not fall back to broad page scraping.
- Preserve all existing uncommitted user artifacts and unrelated changes.
- Use `apply_patch` for edits and make one focused commit per task after its verification commands pass.
- Download/package operations use the configured China mirrors; this plan adds no dependency.

## Current File Boundaries

- `extension/profile_contract.js`: normalize and execute the provider-neutral DOM profile contract.
- `extension/background.js`: service-worker storage, browser client registration, server synchronization, job polling, and tab ownership.
- `extension/content.js`: page-side recording, profile loading, health checks, send execution, and response capture.
- `extension/popup.js`: recording controls, model/profile status, and user-facing diagnostics.
- `extension/manifest.json`: MV3 script loading order for content and worker contexts.
- `server/registry.py`: model/profile/binding document normalization and migration boundaries.
- `server/api_server.py`: profile resource endpoints, binding resolution, browser status, and structured API errors.
- `tests/test_profile_contract.js`: pure profile contract tests.
- `tests/test_registry_contract.py`, `tests/test_registry_runtime.py`: registry boundaries and isolated backend runtime tests.
- `scripts/run_isolated_dom_case.py`, `tests/test_isolated_dom_runtime.py`: generic isolated Chromium execution harness.

## Task 1: Add the Pure Profile Lifecycle Contract

**Description:** Create a browser/runtime-neutral lifecycle module that wraps the existing normalized profile contract with schema version, revision, checksum, lifecycle state, and health report primitives. Keep the module free of Chrome APIs, network calls, and page access.

**Files:**

- Create: `extension/profile_lifecycle.js`
- Create: `tests/fixtures/profile_lifecycle.js`
- Modify: `extension/manifest.json` content-script list so the lifecycle module loads before `content.js`
- Modify: `extension/background.js` to load the lifecycle module with `importScripts()` before worker code runs
- Modify: `extension/popup.js` dynamic injection list so the lifecycle module loads before `content.js`
- Test: `tests/test_profile_lifecycle.js`

**Interfaces:**

- Consumes: `window.PhantomRelayProfile.normalizeProfile(profile)` from `extension/profile_contract.js`.
- Produces:
  - `PROFILE_SCHEMA_VERSION: number`
  - `PROFILE_STATES: readonly string[]`
  - `canonicalizeProfile(value: unknown): string`
  - `profileChecksumInput(profile: object): string`
  - `computeProfileChecksum(profile: object): Promise<string>`
  - `normalizeProfileEnvelope(raw: object): ProfileEnvelope`
  - `verifyProfileChecksum(envelope: ProfileEnvelope): Promise<boolean>`
  - `createProfileEnvelope(profile: object, previous?: ProfileEnvelope): Promise<ProfileEnvelope>`
  - `transitionProfileEnvelope(envelope: ProfileEnvelope, event: string): ProfileEnvelope`
  - `createHealthReport(profileId: string, revision: number, checks: object, reasonCodes?: string[]): HealthReport`

**Envelope shape:**

```js
{
  profile: normalizedProfile,
  lifecycle: {
    schemaVersion: 2,
    revision: 1,
    checksum: 'sha256:<64 lowercase hex chars>',
    createdAt: '<ISO timestamp>',
    updatedAt: '<ISO timestamp>',
    lastVerifiedAt: null,
    source: 'user-recorded',
    state: 'recorded'
  },
  health: null
}
```

- [ ] **Step 1: Write failing pure contract tests.**

Put the shared fixture in `tests/fixtures/profile_lifecycle.js` and import it from the Node test. Use a shallow top-level override so a test that removes response identity can replace the whole `response` object deliberately:

```js
const BASE_PROFILE = {
  profileId: 'fixture-profile-v1',
  origin: 'https://fixture.example/chat',
  domain: 'fixture.example',
  input: { selector: '#prompt', kind: 'textarea' },
  send: { kind: 'button', selector: '#send' },
  response: {
    selector: '[data-message-id]',
    identity: { attributes: ['data-message-id'] },
    role: { assistant: ['assistant'] },
    streamingIndicators: [{ field: 'busy', equals: true }],
    excludedSelectors: [],
    textNormalization: [{ kind: 'trim' }]
  },
  capabilities: { text: true, streaming: 'dom-snapshot' }
};

function validProfile(overrides = {}) {
  return { ...BASE_PROFILE, ...overrides };
}

module.exports = { BASE_PROFILE, validProfile };
```

The test imports `validProfile` from `tests/fixtures/profile_lifecycle.js` and imports the lifecycle API from `extension/profile_lifecycle.js` after the test harness has loaded `extension/profile_contract.js`.

```js
test('canonical checksum ignores object key insertion order', async () => {
  const base = validProfile();
  const a = { ...base, response: { ...base.response, selector: '#a', identity: { attributes: ['id'] } } };
  const b = {
    capabilities: a.capabilities,
    response: { identity: { attributes: ['id'] }, selector: '#a', role: a.response.role,
      streamingIndicators: a.response.streamingIndicators, excludedSelectors: a.response.excludedSelectors,
      textNormalization: a.response.textNormalization },
    send: a.send, input: a.input, domain: a.domain, origin: a.origin, profileId: a.profileId
  };
  assert.equal(canonicalizeProfile(a), canonicalizeProfile(b));
  assert.equal(await computeProfileChecksum(a), await computeProfileChecksum(b));
});

test('new profile starts as recorded revision one', async () => {
  const envelope = await createProfileEnvelope(validProfile());
  assert.equal(envelope.lifecycle.revision, 1);
  assert.equal(envelope.lifecycle.state, 'recorded');
  assert.match(envelope.lifecycle.checksum, /^sha256:[0-9a-f]{64}$/);
});

test('invalid response identity fails closed before an envelope is created', async () => {
  await assert.rejects(
    createProfileEnvelope({ ...validProfile(), response: { selector: '#answer' } }),
    error => error.code === 'response_contract_missing'
  );
});

test('sync failure returns a recorded envelope instead of verified', async () => {
  const envelope = await createProfileEnvelope(validProfile());
  assert.equal(transitionProfileEnvelope(envelope, 'sync_failed').lifecycle.state, 'recorded');
});

test('successful lifecycle events move through the declared states', async () => {
  const recorded = await createProfileEnvelope(validProfile());
  const pending = transitionProfileEnvelope(recorded, 'sync_requested');
  const synced = transitionProfileEnvelope(pending, 'sync_accepted');
  const verified = transitionProfileEnvelope(synced, 'health_check_passed');
  assert.deepEqual(
    [recorded.lifecycle.state, pending.lifecycle.state, synced.lifecycle.state, verified.lifecycle.state],
    ['recorded', 'sync_pending', 'synced', 'verified']
  );
});

test('health failure degrades but does not archive the profile', async () => {
  const synced = transitionProfileEnvelope(
    transitionProfileEnvelope(await createProfileEnvelope(validProfile()), 'sync_requested'),
    'sync_accepted'
  );
  assert.equal(transitionProfileEnvelope(synced, 'health_check_failed').lifecycle.state, 'degraded');
});
```

The extension loading order is fixed and must be recorded in the implementation, not chosen ad hoc by the implementer:

```json
[
  "universal_bridge.js",
  "profile_contract.js",
  "profile_lifecycle.js",
  "content.js"
]
```

Use that exact order in `manifest.json` and in the `chrome.scripting.executeScript()` list in `popup.js`. Add `importScripts('profile_lifecycle.js')` at the beginning of the background worker before any code reads lifecycle symbols. Do not add a second loading order or a provider-specific branch.

- [ ] **Step 2: Run the focused test to prove RED.**

Run:

```bash
node --test tests/test_profile_lifecycle.js
```

Expected: FAIL because `extension/profile_lifecycle.js` does not exist yet.

- [ ] **Step 3: Implement canonicalization, SHA-256, envelope creation, validation, and state transitions.**

Canonicalization must recursively sort object keys, preserve array order, normalize profile through `PhantomRelayProfile`, and exclude lifecycle timestamps and health data from the checksum input. The transition function must reject invalid events rather than silently changing state.

- [ ] **Step 4: Run focused tests and syntax checks.**

Run:

```bash
node --test tests/test_profile_lifecycle.js tests/test_profile_contract.js
node --check extension/profile_lifecycle.js
git diff --check
```

Expected: all focused tests pass; no syntax or whitespace errors.

- [ ] **Step 5: Commit the pure contract.**

```bash
git add extension/profile_lifecycle.js extension/manifest.json tests/fixtures/profile_lifecycle.js tests/test_profile_lifecycle.js
git commit -m "feat: add profile lifecycle contract"
```

## Task 2: Add the Extension Profile Store and Legacy Migration

**Description:** Replace direct writes of selector maps with a small storage adapter that keeps `pending`, `active`, and `lastError` per profile. Preserve `phantomSelectors` as a read-only migration source and never allow an incomplete legacy selector set to become executable.

**Files:**

- Create: `extension/profile_store.js`
- Modify: `extension/background.js` storage initialization, recorder persistence, and server sync entrypoints
- Modify: `extension/popup.js` only where recording completion currently writes selector state
- Test: `tests/test_profile_store.js`

**Interfaces:**

- Consumes: `normalizeProfileEnvelope`, `createProfileEnvelope`, `verifyProfileChecksum`, and `transitionProfileEnvelope` from Task 1.
- Produces:
  - `loadProfileStore(storage): Promise<ProfileStoreState>`
  - `getActiveProfile(store, profileId): ProfileEnvelope | null`
  - `stageProfile(store, profile): Promise<ProfileStoreState>`
  - `promoteProfile(store, profileId, syncAck): Promise<ProfileStoreState>`
  - `recordProfileHealth(store, report): Promise<ProfileStoreState>`
  - `recordProfileError(store, profileId, error): Promise<ProfileStoreState>`
  - `migrateLegacySelectors(raw): MigrationResult`
  - `saveProfileStore(storage, store): Promise<void>`

- [ ] **Step 1: Write failing storage tests with an in-memory Chrome storage fake.**

The test imports `validProfile` from `tests/fixtures/profile_lifecycle.js` and imports the store API from `extension/profile_store.js`; the in-memory storage fake implements `get(keys)` and `set(values)` and records each write so atomic update behavior can be asserted.

```js
test('staging a new revision preserves active last-known-good profile', async () => {
  const oldEnvelope = await createProfileEnvelope(validProfile({ input: { selector: '#old', kind: 'textarea' } }));
  const store = { profiles: { [oldEnvelope.profile.profileId]: { active: oldEnvelope, pending: null, lastError: null } } };
  const next = await stageProfile(store, validProfile({ input: { selector: '#new', kind: 'textarea' } }));
  assert.equal(next.profiles[oldEnvelope.profile.profileId].active.profile.input.selector.css, '#old');
  assert.equal(next.profiles[oldEnvelope.profile.profileId].pending.profile.input.selector.css, '#new');
});

test('legacy selector-only profile is reported as migration hint, not executable', () => {
  const result = migrateLegacySelectors({ 'fixture.local': { input: '#prompt', send: '#send', response: '#answer' } });
  assert.equal(result.executable.length, 0);
  assert.equal(result.hints[0].reason, 'response_identity_missing');
});

test('a failed pending validation leaves every active profile untouched', async () => {
  const active = await createProfileEnvelope(validProfile());
  const other = await createProfileEnvelope(validProfile({ profileId: 'other-profile' }));
  const store = {
    profiles: {
      [active.profile.profileId]: { active, pending: null, lastError: null },
      [other.profile.profileId]: { active: other, pending: null, lastError: null }
    }
  };
  await assert.rejects(stageProfile(store, validProfile({ response: { selector: '#broken' } })));
  assert.equal(store.profiles[active.profile.profileId].active.lifecycle.state, 'recorded');
  assert.equal(store.profiles[other.profile.profileId].active.profile.profileId, 'other-profile');
});
```

- [ ] **Step 2: Run the focused test to prove RED.**

Run:

```bash
node --test tests/test_profile_store.js
```

Expected: FAIL because the store module and functions do not exist.

- [ ] **Step 3: Implement the store with atomic single-key updates.**

Use one `chrome.storage.local.set({ phantomProfiles: nextProfiles })` operation per logical update. Do not clear `phantomSelectors`; read it once, produce migration hints, and leave the original value untouched. A failed checksum or contract validation records `lastError` and leaves `active` unchanged. `loadProfileStore()` must preserve malformed or unsupported entries under a diagnostic field, mark that profile `invalid`, and never silently coerce it into an executable envelope.

- [ ] **Step 4: Route recorder completion through `stageProfile`.**

The response-recording path must create a full profile envelope. A complete profile goes to `pending`; the old selector map remains only as compatibility data. The background worker must not send a profile to the server until local normalization and checksum creation succeed.

- [ ] **Step 5: Run focused tests, extension syntax checks, and the existing profile contract suite.**

Run:

```bash
node --test tests/test_profile_store.js tests/test_profile_lifecycle.js tests/test_profile_contract.js
node --check extension/background.js
node --check extension/popup.js
git diff --check
```

- [ ] **Step 6: Commit the local store slice.**

```bash
git add extension/profile_store.js extension/background.js extension/popup.js tests/test_profile_store.js
git commit -m "feat: persist pending and active browser profiles"
```

## Task 3: Add Backend Profile Resource and Conflict Semantics

**Description:** Add a dedicated backend profile resource while preserving `/browser/selectors` as a compatibility adapter. The backend must validate profile identity, domain, revision, checksum, and conflict behavior without accepting selectors inside model metadata.

**Files:**

- Modify: `server/registry.py` profile normalization and checksum helpers
- Modify: `server/api_server.py` profile resource endpoints and structured errors
- Create: `tests/profile_lifecycle_helpers.py`
- Test: `tests/test_profile_lifecycle_api.py`
- Test: `tests/test_registry_contract.py`
- Test: `tests/test_registry_runtime.py`

**Interfaces:**

- Consumes: profile envelope JSON from Task 2 and existing `normalize_profile_registry`, `normalize_user_bindings`, and `resolve_binding`.
- Produces:
  - `server.registry.canonical_profile_payload(profile) -> str`
  - `server.registry.profile_checksum(profile) -> str`
  - `server.registry.validate_profile_envelope(envelope, expected_domain=None) -> dict`
  - `POST /browser/profiles`
  - `GET /browser/profiles/<profile_id>`
  - `POST /browser/profiles/health`

- [ ] **Step 1: Write failing Flask test-client tests for create, idempotent update, conflict, domain mismatch, and missing binding.**

Create `tests/profile_lifecycle_helpers.py` before the API tests so every example below has a concrete fixture contract. The helper must use the same sorted-key JSON and SHA-256 representation that the production registry will implement:

```python
import hashlib
import json
from pathlib import Path


def valid_profile() -> dict:
    return {
        "profileId": "fixture-profile",
        "origin": "https://fixture.example/chat",
        "domain": "fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        "response": {
            "selector": {"css": "[data-message-id]", "alternatives": []},
            "identity": {"attributes": ["data-message-id"]},
            "role": {"user": ["user"], "assistant": ["assistant"]},
            "streamingIndicators": [],
            "excludedSelectors": [],
            "textNormalization": [{"kind": "trim"}],
        },
        "capabilities": {"text": True, "streaming": "dom-snapshot"},
    }


def profile_checksum(profile: dict) -> str:
    canonical = json.dumps(profile, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def configure_registry_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PHANTOM_RELAY_REGISTRY_DIR", str(tmp_path))
    return tmp_path


def profile_payload(revision=1, selector="#answer") -> dict:
    profile = valid_profile()
    profile["response"]["selector"] = {"css": selector, "alternatives": []}
    return {
        "client_id": "client-a",
        "profile": profile,
        "revision": revision,
        "checksum": profile_checksum(profile),
    }


def write_bound_registry(tmp_path) -> None:
    profile = valid_profile()
    Path(tmp_path, "model_registry.json").write_text(json.dumps({
        "version": 1,
        "models": [{"id": "fixture-model", "name": "Fixture", "api": "browser",
                     "profile_id": profile["profileId"], "capabilities": {}}],
        "aliases": {"fixture": "fixture-model"}, "settings": {}
    }), encoding="utf-8")
    Path(tmp_path, "profile_registry.json").write_text(json.dumps({
        "version": 1, "profiles": {profile["profileId"]: profile}
    }), encoding="utf-8")
    Path(tmp_path, "user_bindings.json").write_text(json.dumps({
        "version": 1, "bindings": {"fixture-model": {"profile_id": profile["profileId"]}}
    }), encoding="utf-8")


def write_unbound_registry(tmp_path) -> None:
    Path(tmp_path, "model_registry.json").write_text(json.dumps({
        "version": 1,
        "models": [{"id": "unbound-fixture-model", "name": "Fixture", "api": "browser",
                     "profile_id": "missing-profile", "capabilities": {}}],
        "aliases": {}, "settings": {}
    }), encoding="utf-8")
    Path(tmp_path, "profile_registry.json").write_text(json.dumps({
        "version": 1, "profiles": {}
    }), encoding="utf-8")
    Path(tmp_path, "user_bindings.json").write_text(json.dumps({
        "version": 1, "bindings": {}
    }), encoding="utf-8")


def load_api(module_name, monkeypatch, registry_dir):
    import importlib.util
    from pathlib import Path

    configure_registry_dir(registry_dir, monkeypatch)
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(module_name, root / "server" / "api_server.py")
    api = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(api)
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_REGISTRATIONS.clear()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    return api
```

Each test calls `api = load_api("profile_lifecycle_case", monkeypatch, tmp_path)` and then creates its client explicitly with `app_client = api.app.test_client()`; no bare `client` variable is assumed.

```python
def test_profile_upsert_is_idempotent_for_same_revision_and_checksum(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_idempotent", monkeypatch, tmp_path)
    profile = valid_profile()
    payload = {"client_id": "client-a", "profile": profile, "revision": 1, "checksum": profile_checksum(profile)}
    app_client = api.app.test_client()
    first = app_client.post("/browser/profiles", json=payload)
    second = app_client.post("/browser/profiles", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.get_json()["state"] == "synced"

def test_profile_upsert_rejects_same_revision_with_different_checksum(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_conflict", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    first = app_client.post("/browser/profiles", json=profile_payload(revision=1))
    conflict = app_client.post("/browser/profiles", json=profile_payload(revision=1, selector="#changed"))
    assert first.status_code == 200
    assert conflict.status_code == 409
    assert conflict.get_json()["error"]["code"] == "profile_conflict"

def test_profile_get_returns_the_persisted_revision_and_checksum(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_get", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    payload = profile_payload()
    created = app_client.post("/browser/profiles", json=payload)
    fetched = app_client.get("/browser/profiles/fixture-profile")
    assert created.status_code == 200
    assert fetched.status_code == 200
    assert fetched.get_json()["revision"] == 1
    assert fetched.get_json()["checksum"] == payload["checksum"]

def test_profile_upsert_rejects_a_domain_mismatch_with_structured_error(tmp_path, monkeypatch):
    write_bound_registry(tmp_path)
    api = load_api("profile_lifecycle_domain", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    payload = profile_payload()
    payload["profile"]["domain"] = "other.example"
    payload["checksum"] = profile_checksum(payload["profile"])
    response = app_client.post("/browser/profiles", json=payload)
    assert response.status_code == 422
    assert response.get_json()["error"]["code"] == "profile_domain_mismatch"

def test_profile_without_a_binding_cannot_execute_chat(tmp_path, monkeypatch):
    write_unbound_registry(tmp_path)
    api = load_api("profile_lifecycle_binding", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    response = app_client.post("/v1/chat/completions", json={
        "model": "unbound-fixture-model",
        "messages": [{"role": "user", "content": "hello"}],
    })
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "profile_incomplete"

def test_health_report_persists_only_structured_evidence(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_health", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    app_client.post("/browser/profiles", json=profile_payload())
    response = app_client.post("/browser/profiles/health", json={
        "profile_id": "fixture-profile",
        "revision": 1,
        "state": "verified",
        "checks": {"input": "pass", "send": "pass", "response": "pass", "identity": "pass", "streaming": "pass"},
        "reason_codes": []
    })
    assert response.status_code == 200
    stored = app_client.get("/browser/profiles/fixture-profile").get_json()
    assert stored["health"]["checks"]["identity"] == "pass"
    assert "assistant" not in json.dumps(stored)
```

- [ ] **Step 2: Run the focused API tests to prove RED.**

Run:

```bash
PYTHONPATH=. python3 -m pytest -q tests/test_profile_lifecycle_api.py tests/test_registry_contract.py tests/test_registry_runtime.py
```

Expected: FAIL because the new profile endpoints and checksum helpers do not exist.

- [ ] **Step 3: Implement canonical profile checksum and envelope validation in `server/registry.py`.**

The Python canonicalization must produce the same sorted-key JSON payload and `sha256:<hex>` format as the browser module. Reject profile IDs that do not match registry keys, reject domain mismatches, reject selector-bearing model registry entries, and reject envelopes without response identity.

- [ ] **Step 4: Implement `/browser/profiles` and `/browser/profiles/health`.**

Use the existing atomic JSON write helper. Same revision and same checksum returns success without rewriting. A higher revision replaces the server copy only after validation. Same revision with another checksum returns HTTP 409. Health reports update only lifecycle state, `lastVerifiedAt`, checks, and reason codes.

- [ ] **Step 5: Keep `/browser/selectors` as a compatibility adapter.**

When a complete `profile` is present, route it through the new resource semantics. Selector-only payloads remain readable for migration diagnostics but cannot promote a binding to executable without response identity.

- [ ] **Step 6: Run focused backend tests and commit.**

```bash
PYTHONPATH=. python3 -m pytest -q tests/test_profile_lifecycle_api.py tests/test_registry_contract.py tests/test_registry_runtime.py
python3 -m py_compile server/registry.py server/api_server.py
git diff --check
git add server/registry.py server/api_server.py tests/profile_lifecycle_helpers.py tests/test_profile_lifecycle_api.py tests/test_registry_contract.py tests/test_registry_runtime.py
git commit -m "feat: add versioned profile resource and conflict handling"
```

## Task 4: Connect Extension Sync and Backend Health Reporting

**Description:** Connect the extension profile store to the new backend resource. Synchronization must be idempotent, preserve pending state on network failure, promote only after server acknowledgement, and send health reports containing no page content.

**Files:**

- Modify: `extension/background.js` profile sync and storage initialization
- Modify: `extension/profile_store.js` sync state transitions
- Modify: `extension/content.js` message route for profile health requests
- Create: `tests/fixtures/profile_sync.js`
- Test: `tests/test_profile_sync.js`
- Test: `tests/test_content_runtime_symbols.js`

**Interfaces:**

- Consumes: `stageProfile`, `promoteProfile`, `recordProfileHealth`, `recordProfileError` from Task 2 and `/browser/profiles` from Task 3.
- Produces:
  - `syncPendingProfile(profileId): Promise<SyncResult>` in `extension/background.js`
  - `buildProfileHealthPayload(profileId, revision, report): object` in `extension/background.js`
  - message action `get_profile_status`
  - message action `run_profile_health_check`
  - message event `profile_health_report`

- [ ] **Step 1: Write failing sync tests with fetch and storage fakes.**

Create `tests/fixtures/profile_sync.js` as a CommonJS test-only fake module, matching the repository's existing `node --test` loading style. It must export a resettable store, a queued fetch fake, and a content-health fake; none of these symbols belong in production extension code:

```js
const fakeStore = {
  profiles: {
    'fixture-profile': {
      active: { lifecycle: { state: 'verified' } },
      pending: { lifecycle: { revision: 2, state: 'sync_pending' } },
      lastError: null
    }
  }
};

const fetchMock = {
  failures: [],
  rejectOnce(error) { this.failures.push(error); },
  async request() {
    if (this.failures.length) throw this.failures.shift();
    return { ok: true, status: 200, async json() { return { state: 'synced' }; } };
  },
  reset() { this.failures.length = 0; }
};

function resetFakeStore() {
  fakeStore.profiles['fixture-profile'] = {
    active: { lifecycle: { state: 'verified' } },
    pending: { lifecycle: { revision: 2, state: 'sync_pending' } },
    lastError: null
  };
}

function runProfileHealthCheck() {
  return {
    state: 'verified',
    checks: { input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass' },
    reason_codes: []
  };
}

module.exports = { fakeStore, fetchMock, resetFakeStore, runProfileHealthCheck };
```

The test setup calls `resetFakeStore()` and `fetchMock.reset()` before each case, then injects `fetchMock.request` into the sync boundary. This keeps network behavior deterministic without teaching the production code about the fixture.

```js
test('successful profile upsert promotes pending to active', async () => {
  const result = await syncPendingProfile('fixture-profile');
  assert.equal(result.state, 'synced');
  assert.equal(fakeStore.profiles['fixture-profile'].pending, null);
  assert.equal(fakeStore.profiles['fixture-profile'].active.lifecycle.state, 'synced');
});

test('network failure retains pending and last-known-good active profile', async () => {
  fetchMock.rejectOnce(new Error('offline'));
  await assert.rejects(syncPendingProfile('fixture-profile'));
  assert.ok(fakeStore.profiles['fixture-profile'].pending);
  assert.equal(fakeStore.profiles['fixture-profile'].active.lifecycle.state, 'verified');
});

test('health payload excludes page and conversation content', async () => {
  const payload = await runProfileHealthCheck();
  assert.equal('pageText' in payload, false);
  assert.equal('prompt' in payload, false);
  assert.equal('assistant' in payload, false);
});

test('health transport uses an explicit allowlist of fields', () => {
  const report = runProfileHealthCheck();
  const payload = buildProfileHealthPayload('fixture-profile', 2, report);
  assert.deepEqual(Object.keys(payload).sort(), ['checks', 'profile_id', 'reason_codes', 'revision', 'state']);
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['cookie', 'localStorage', 'sessionStorage', 'authorization', 'pageText', 'prompt', 'assistant']) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
  }
});
```

- [ ] **Step 2: Run focused sync tests to prove RED.**

Run:

```bash
node --test tests/test_profile_sync.js
```

Expected: FAIL because the sync action and health message routes are not wired.

- [ ] **Step 3: Implement idempotent background sync.**

Send `client_id`, profile envelope, revision, and checksum. On HTTP 200, promote pending. On HTTP 409, record `profile_conflict` without replacing active. On network or 5xx failure, retain pending and record a recoverable `profile_sync_failed` error. Never retry with a different profile or domain.

- [ ] **Step 4: Add health-report message routing.**

The worker requests health from the content runtime only after the page reports ready. The response contains check statuses and reason codes. The worker posts it to `/browser/profiles/health`; it does not include DOM text, input value, response text, or browser storage.

- [ ] **Step 5: Run sync, contract, and syntax tests; commit.**

```bash
node --test tests/test_profile_sync.js tests/test_profile_contract.js tests/test_content_runtime_symbols.js
node --check extension/background.js
node --check extension/content.js
git diff --check
git add extension/background.js extension/profile_store.js extension/content.js tests/fixtures/profile_sync.js tests/test_profile_sync.js tests/test_content_runtime_symbols.js
git commit -m "feat: synchronize profile lifecycle and health reports"
```

## Task 5: Add Provider-Neutral Page Health Checks and Fail-Closed Errors

**Description:** Implement page-side health checks against the active profile and integrate them with readiness and capture. A missing input, send action, response region, identity, or declared streaming indicator must produce a bounded structured result before API timeout.

**Files:**

- Modify: `extension/content.js` profile loading, readiness, message routing, and capture preflight
- Modify: `extension/profile_lifecycle.js` to export the fixed profile-health reason constants used by page checks and API errors
- Create: `tests/fixtures/profile_health.js`
- Test: `tests/test_profile_health.js`
- Test: `tests/test_isolated_dom_runtime.py`
- Test: `tests/fixtures/interactive-chat.html`

**Interfaces:**

- Consumes: active envelope from `profile_store`, normalized `activeProfile`, and the existing `findElement`, `messageIdentity`, `messageIsStreaming` helpers.
- Produces:
  - `runProfileHealthCheck(profile = activeProfile): ProfileHealthReport`
  - `profileHealthError(report): { error: string, detail: string, reason_codes: string[] }`
  - message action `get_profile_health`

- [ ] **Step 1: Write failing health tests for pass, missing input, missing response, and identity failure.**

Create `tests/fixtures/profile_health.js` as a content-free fixture module:

```js
const { validProfile } = require('./profile_lifecycle.js');

function validPageProfile() {
  return validProfile({
    response: {
      selector: '[data-message-id]',
      identity: { attributes: ['data-message-id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });
}

function profileWithMissingIdentity() {
  return validProfile({
    response: { selector: '[data-message-id]' }
  });
}

function profileWithMissingInput() {
  return validProfile({ input: null });
}

function profileWithMissingResponse() {
  return validProfile({ response: {} });
}

module.exports = {
  validPageProfile,
  profileWithMissingIdentity,
  profileWithMissingInput,
  profileWithMissingResponse
};
```

In `extension/profile_lifecycle.js`, define and export this exact allowlist of reason codes before implementing the page checks:

```js
const PROFILE_HEALTH_REASONS = Object.freeze({
  INPUT_UNAVAILABLE: 'profile_input_unavailable',
  SEND_UNAVAILABLE: 'profile_send_unavailable',
  RESPONSE_UNAVAILABLE: 'profile_response_unavailable',
  IDENTITY_UNAVAILABLE: 'profile_identity_unavailable',
  STREAMING_UNAVAILABLE: 'profile_streaming_unavailable'
});
```

The health test imports all four fixture builders and calls the production `runProfileHealthCheck` through the existing content-runtime test harness; the fixture never contains prompt or assistant text.

```js
test('health check passes only when response identity resolves', () => {
  const report = runProfileHealthCheck(validPageProfile());
  assert.equal(report.state, 'verified');
  assert.deepEqual(report.checks, { input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass' });
});

test('missing input and response selectors return bounded reason codes', () => {
  const inputFailure = runProfileHealthCheck(profileWithMissingInput());
  const responseFailure = runProfileHealthCheck(profileWithMissingResponse());
  assert.equal(inputFailure.state, 'invalid');
  assert.ok(inputFailure.reason_codes.includes('profile_input_unavailable'));
  assert.equal(responseFailure.state, 'invalid');
  assert.ok(responseFailure.reason_codes.includes('profile_response_unavailable'));
});

test('missing response identity is invalid and never ready', () => {
  const report = runProfileHealthCheck(profileWithMissingIdentity());
  assert.equal(report.state, 'invalid');
  assert.ok(report.reason_codes.includes('profile_identity_unavailable'));
});
```

- [ ] **Step 2: Run focused health tests to prove RED.**

Run:

```bash
node --test tests/test_profile_health.js
```

Expected: FAIL because health functions and message routes do not exist.

- [ ] **Step 3: Implement bounded health checks.**

Check only selector existence/visibility, action readiness, response selector resolution, identity extraction from the declared container, and indicator syntax. Do not inspect or return node text. Use the profile’s selectors only; do not call broad page discovery as a health fallback.

- [ ] **Step 4: Integrate health with `wait_until_ready` and `auto_capture`.**

`wait_until_ready` returns `profile_health` and `reason_codes`. `auto_capture` returns a profile error immediately when the active profile is invalid or the page is not ready. A degraded profile can execute text only when the requested capability remains healthy.

- [ ] **Step 5: Run generic isolated browser tests.**

Run:

```bash
PYTHONPATH=. python3 -m pytest -q tests/test_isolated_dom_runtime.py --disable-warnings
PHANTOM_RELAY_RUN_ISOLATED_DOM=1 PYTHONPATH=. python3 -m pytest -q tests/test_isolated_dom_runtime.py -vv --disable-warnings
```

Expected: the existing direct, contenteditable, nested, and virtualized cases remain green, and the health report remains content-free.

- [ ] **Step 6: Commit the page health slice.**

```bash
git add extension/content.js extension/profile_lifecycle.js tests/fixtures/profile_health.js tests/test_profile_health.js tests/test_isolated_dom_runtime.py tests/fixtures/interactive-chat.html
git commit -m "feat: add provider-neutral profile health checks"
```

## Task 6: Surface Profile State and Recovery Evidence in the Popup

**Description:** Make the lifecycle understandable to a real user. Reuse the existing popup status area and debug panel to show active profile ID, revision, state, last verification time, and the first actionable reason code. Do not display page content or credentials.

**Files:**

- Modify: `extension/popup.js`
- Modify: `extension/popup.html`
- Test: `tests/test_popup_profile_status.js`

**Interfaces:**

- Consumes: `get_profile_status`, `get_profile_health`, and `profile_health_report` from Task 4/5.
- Produces: `renderProfileStatus(status)`, `profileStatusLabel(state, reasonCodes)`, and a user-facing “重新验证” action that requests health only.

- [ ] **Step 1: Write failing DOM/status tests.**

```js
test('popup shows profile revision and reason code without page content', () => {
  const html = renderProfileStatus({ profileId: 'p', revision: 3, state: 'degraded', reasonCodes: ['profile_response_unavailable'] });
  assert.match(html, /p/);
  assert.match(html, /3/);
  assert.match(html, /profile_response_unavailable/);
  assert.doesNotMatch(html, /assistant text|prompt text/);
});
```

- [ ] **Step 2: Run the focused test to prove RED.**

Run:

```bash
node --test tests/test_popup_profile_status.js
```

Expected: FAIL because profile status rendering is not defined.

- [ ] **Step 3: Add the minimal profile status block and re-verify action.**

The popup must distinguish `recorded`, `sync_pending`, `synced`, `verified`, `degraded`, `invalid`, and `archived`. The re-verify action must call the content health route; it must not auto-record new selectors or auto-switch domains.

- [ ] **Step 4: Run popup syntax and status tests; commit.**

```bash
node --test tests/test_popup_profile_status.js
node --check extension/popup.js
git diff --check
git add extension/popup.js extension/popup.html tests/test_popup_profile_status.js
git commit -m "feat: show profile lifecycle health in popup"
```

## Task 7: Add Profile Reload and Backend-Restart Acceptance Coverage

**Description:** Extend the isolated generic browser harness to prove the entire Phase A lifecycle rather than only one in-memory capture. The test must simulate profile persistence, content runtime reload, page refresh, backend registry restart, and a deliberate selector failure.

**Files:**

- Modify: `scripts/run_isolated_dom_case.py`
- Create: `scripts/run_isolated_profile_lifecycle_case.py`
- Create: `tests/test_profile_lifecycle_runtime.py`
- Modify: `tasks/todo.md` to record the checkpoint

**Interfaces:**

- Consumes: profile store, profile API, health report, and generic DOM runner from Tasks 1-6.
- Produces: `run_profile_lifecycle_case(case_name='interactive') -> dict` with:

```python
{
    "profile_id": str,
    "revision_before": int,
    "revision_after_reload": int,
    "state_after_reload": str,
    "capture": {"success": True, "assistant": str},
    "broken_profile_error": {"code": str, "recoverable": bool},
}
```

- [ ] **Step 1: Write failing lifecycle acceptance tests.**

```python
def test_profile_survives_runtime_reload_and_page_refresh():
    result = run_profile_lifecycle_case("interactive")
    assert result["revision_after_reload"] == result["revision_before"]
    assert result["state_after_reload"] == "verified"
    assert result["capture"]["success"] is True

def test_broken_response_selector_returns_profile_error_before_capture_timeout():
    result = run_profile_lifecycle_case("interactive-broken-response")
    assert result["broken_profile_error"]["code"] == "profile_response_unavailable"
    assert result["broken_profile_error"]["recoverable"] is True
```

- [ ] **Step 2: Run the focused lifecycle test to prove RED.**

Run:

```bash
PYTHONPATH=. python3 -m pytest -q tests/test_profile_lifecycle_runtime.py
```

Expected: FAIL because the lifecycle runner does not exist.

- [ ] **Step 3: Implement isolated lifecycle orchestration.**

Use a temporary Chromium profile and temporary registry directory. Inject the profile through the same path the extension uses, close and reload the content runtime, refresh the page, restart the in-process backend registry fixture, and perform a second capture. Do not connect to a shared browser or real site.

- [ ] **Step 4: Add deliberate failure and recovery assertions.**

Change only the recorded response selector in the pending test profile. Confirm the active last-known-good profile still captures successfully after the failed promotion. Then restore the selector and confirm health returns to `verified`.

- [ ] **Step 5: Run the complete Phase A verification matrix.**

```bash
PYTHONPATH=. python3 -m pytest -q --disable-warnings
PHANTOM_RELAY_RUN_ISOLATED_DOM=1 PYTHONPATH=. python3 -m pytest -q tests/test_isolated_dom_runtime.py tests/test_profile_lifecycle_runtime.py -vv --disable-warnings
node --test tests/test_profile_lifecycle.js tests/test_profile_store.js tests/test_profile_sync.js tests/test_profile_health.js tests/test_profile_contract.js tests/test_content_runtime_symbols.js tests/test_network_sse_parser.js
python3 -m py_compile server/registry.py server/api_server.py scripts/run_isolated_profile_lifecycle_case.py
node --check extension/profile_lifecycle.js extension/profile_store.js extension/background.js extension/content.js extension/popup.js
git diff --check
```

- [ ] **Step 6: Update the A checkpoint and commit the acceptance slice.**

Mark only the Phase A lifecycle items complete in `tasks/todo.md`. Do not mark B or C complete. Then commit:

```bash
git add scripts/run_isolated_dom_case.py scripts/run_isolated_profile_lifecycle_case.py tests/test_profile_lifecycle_runtime.py tasks/todo.md
git commit -m "test: verify profile lifecycle across reload and restart"
```

## Checkpoint: Phase A Complete

- [ ] A profile can be recorded, normalized, checksummed, and staged without overwriting active.
- [ ] Backend upsert is idempotent and rejects same-revision checksum conflicts.
- [ ] Profile health is structured and content-free.
- [ ] Page refresh and runtime reload recover the same profile ID and revision.
- [ ] Broken response selectors produce bounded profile errors.
- [ ] Generic direct, contenteditable, nested, and virtualized DOM cases remain green.
- [ ] Full Python and Node verification commands pass.
- [ ] No provider-specific core branch or credential access was added.

After this checkpoint, stop and review the evidence before starting Phase B. Phase B must consume the lifecycle and health interfaces above; it must not redesign them.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Browser Web Crypto and Python hashlib produce different payloads | High | Use one recursively sorted canonical JSON format and assert identical checksum fixtures in Node and Python. |
| A pending profile replaces a working profile | High | Keep `active` and `pending` separate; promote only after local validation and backend acknowledgement. |
| Existing selector compatibility bypasses identity requirements | High | Keep `/browser/selectors` readable but block executable promotion without a complete profile. |
| Health reporting leaks page content | High | Define an allowlist of check fields and test serialized payloads for forbidden keys. |
| Popup status becomes a second source of truth | Medium | Popup reads status from worker/store and never mutates profile state directly. |
| Backend restart loses a profile/binding relationship | High | Use atomic registry writes and restart tests with a temporary registry directory. |
| Existing uncommitted changes overlap the same files | Medium | Inspect current diff before each task, make focused patches, and stage only task files. |

## Execution Order

```text
Task 1 pure lifecycle contract
    ↓
Task 2 local pending/active store
    ↓
Task 3 backend profile resource
    ↓
Task 4 extension sync and health transport
    ↓
Task 5 page-side health and fail-closed capture
    ↓
Task 6 popup status and re-verify UX
    ↓
Task 7 isolated reload/restart acceptance
    ↓
Phase A checkpoint
```

Tasks 1-3 are sequential because they define the data contract. Tasks 5 and 6 can be implemented independently after Task 4, but Task 7 must wait for all preceding interfaces.
