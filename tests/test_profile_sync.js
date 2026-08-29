const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/profile_contract.js');
require('../extension/profile_lifecycle.js');
require('../extension/profile_store.js');
const Sync = require('../extension/profile_sync.js');
require('../extension/profile_recovery.js');
const Lifecycle = require('../extension/profile_lifecycle.js');
const { fakeStore, fetchMock, resetFakeStore, runProfileHealthCheck } = require('./fixtures/profile_sync.js');
const { validProfile } = require('./fixtures/profile_lifecycle.js');

test.beforeEach(async () => {
  resetFakeStore();
  const recorded = await Lifecycle.createProfileEnvelope(validProfile());
  const synced = Lifecycle.transitionProfileEnvelope(
    Lifecycle.transitionProfileEnvelope(recorded, 'sync_requested'),
    'sync_accepted'
  );
  const active = Lifecycle.transitionProfileEnvelope(synced, 'health_check_passed');
  const pending = Lifecycle.transitionProfileEnvelope(
    await Lifecycle.createProfileEnvelope(validProfile({ input: { selector: '#new-prompt', kind: 'textarea' } }), active),
    'sync_requested'
  );
  fakeStore.profiles['fixture-profile'].active = active;
  fakeStore.profiles['fixture-profile'].pending = pending;
});

test('successful profile upsert promotes pending to active', async () => {
  const result = await Sync.syncPendingProfile('fixture-profile', {
    store: fakeStore,
    clientId: 'client-a',
    baseUrl: 'http://localhost:8765',
    fetchImpl: fetchMock.request.bind(fetchMock),
    setStore(next) { Object.assign(fakeStore, next); }
  });
  assert.equal(result.state, 'synced');
  assert.equal(fakeStore.profiles['fixture-profile'].pending, null);
  assert.equal(fakeStore.profiles['fixture-profile'].active.lifecycle.state, 'synced');
  assert.equal(fetchMock.requests[0].options.method, 'POST');
});

test('network failure retains pending and last-known-good active profile', async () => {
  fetchMock.rejectOnce(new Error('offline'));
  await assert.rejects(
    Sync.syncPendingProfile('fixture-profile', {
      store: fakeStore,
      clientId: 'client-a',
      fetchImpl: fetchMock.request.bind(fetchMock),
      setStore(next) { Object.assign(fakeStore, next); }
    }),
    error => error.code === 'profile_sync_failed'
  );
  assert.ok(fakeStore.profiles['fixture-profile'].pending);
  assert.equal(fakeStore.profiles['fixture-profile'].active.lifecycle.state, 'verified');
  assert.equal(fakeStore.profiles['fixture-profile'].lastError.code, 'profile_sync_failed');
});

test('a re-recording rebases once when the backend has a newer profile revision', async () => {
  const remoteProfile = validProfile();
  const profileId = remoteProfile.profileId;
  const remoteEnvelope = await Lifecycle.createProfileEnvelope(remoteProfile);
  const freshInstallStore = {
    version: 1,
    profiles: {
      [profileId]: {
        active: null,
        pending: Lifecycle.transitionProfileEnvelope(
          await Lifecycle.createProfileEnvelope(
            validProfile({ input: { selector: '#fresh-recording', kind: 'textarea' } }),
          ),
          'sync_requested',
        ),
        lastError: null,
      },
    },
    diagnostics: [],
    legacyHints: [],
  };
  let currentStore = freshInstallStore;
  const requests = [];

  const result = await Sync.syncPendingProfile(profileId, {
    store: currentStore,
    getStore() { return currentStore; },
    setStore(next) { currentStore = next; },
    clientId: 'client-a',
    baseUrl: 'http://localhost:8765',
    async fetchImpl(url, options = {}) {
      requests.push({ url, options });
      if (options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              profile_id: profileId,
              profile: remoteEnvelope.profile,
              revision: 3,
              checksum: remoteEnvelope.lifecycle.checksum,
              state: 'synced',
            };
          },
        };
      }
      const submitted = JSON.parse(options.body);
      if (submitted.revision === 1) {
        return {
          ok: false,
          status: 409,
          async json() {
            return { error: { code: 'profile_revision_conflict', message: 'backend is newer' } };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            profile_id: submitted.profile.profileId,
            revision: submitted.revision,
            checksum: submitted.checksum,
            state: 'synced',
          };
        },
      };
    },
  });

  assert.equal(result.state, 'synced');
  assert.equal(currentStore.profiles[profileId].active.lifecycle.revision, 4);
  assert.equal(currentStore.profiles[profileId].active.profile.input.selector.css, '#fresh-recording');
  assert.equal(currentStore.profiles[profileId].pending, null);
  assert.deepEqual(requests.map(request => request.options.method), ['POST', 'GET', 'POST']);
});

test('profile conflict rebasing stops after one retry', async () => {
  const remoteProfile = validProfile();
  const profileId = remoteProfile.profileId;
  const remoteEnvelope = await Lifecycle.createProfileEnvelope(remoteProfile);
  let currentStore = {
    version: 1,
    profiles: {
      [profileId]: {
        active: null,
        pending: Lifecycle.transitionProfileEnvelope(
          await Lifecycle.createProfileEnvelope(
            validProfile({ input: { selector: '#fresh-recording', kind: 'textarea' } }),
          ),
          'sync_requested',
        ),
        lastError: null,
      },
    },
    diagnostics: [],
    legacyHints: [],
  };
  const methods = [];

  const result = await Sync.syncPendingProfile(profileId, {
    store: currentStore,
    getStore() { return currentStore; },
    setStore(next) { currentStore = next; },
    clientId: 'client-a',
    baseUrl: 'http://localhost:8765',
    async fetchImpl(_url, options = {}) {
      methods.push(options.method);
      if (options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              profile_id: profileId,
              profile: remoteEnvelope.profile,
              revision: 3,
              checksum: remoteEnvelope.lifecycle.checksum,
              state: 'synced',
            };
          },
        };
      }
      return {
        ok: false,
        status: 409,
        async json() {
          return { error: { code: 'profile_revision_conflict', message: 'backend changed again' } };
        },
      };
    },
  });

  assert.equal(result.state, 'conflict');
  assert.equal(currentStore.profiles[profileId].pending.lifecycle.revision, 4);
  assert.equal(currentStore.profiles[profileId].lastError.code, 'profile_revision_conflict');
  assert.deepEqual(methods, ['POST', 'GET', 'POST']);
});

test('an acknowledgement for an older pending envelope cannot erase a newer recording', async () => {
  let currentStore = structuredClone(fakeStore);
  let releaseResponse;
  let requestStartedResolve;
  const requestStarted = new Promise(resolve => { requestStartedResolve = resolve; });
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });

  const sync = Sync.syncPendingProfile('fixture-profile', {
    store: currentStore,
    getStore() { return currentStore; },
    setStore(next) { currentStore = next; },
    clientId: 'client-a',
    baseUrl: 'http://localhost:8765',
    async fetchImpl(_url, options) {
      const submitted = JSON.parse(options.body);
      requestStartedResolve();
      await responseGate;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            profile_id: submitted.profile.profileId,
            revision: submitted.revision,
            checksum: submitted.checksum,
            state: 'synced',
          };
        },
      };
    },
  });

  await requestStarted;
  const oldPending = currentStore.profiles['fixture-profile'].pending;
  const newerRecorded = await Lifecycle.createProfileEnvelope(
    validProfile({ input: { selector: '#newest-prompt', kind: 'textarea' } }),
    oldPending,
  );
  const replacementStore = structuredClone(currentStore);
  replacementStore.profiles['fixture-profile'].pending = Lifecycle.transitionProfileEnvelope(
    newerRecorded,
    'sync_requested',
  );
  currentStore = replacementStore;
  releaseResponse();

  const result = await sync;
  assert.equal(result.state, 'superseded');
  assert.equal(currentStore.profiles['fixture-profile'].active.lifecycle.state, 'verified');
  assert.equal(currentStore.profiles['fixture-profile'].pending.lifecycle.revision, 3);
  assert.equal(currentStore.profiles['fixture-profile'].pending.profile.input.selector.css, '#newest-prompt');
});

test('a late failure for an older envelope cannot attach an error to a newer recording', async () => {
  let currentStore = structuredClone(fakeStore);
  let rejectRequest;
  let requestStartedResolve;
  const requestStarted = new Promise(resolve => { requestStartedResolve = resolve; });
  const requestGate = new Promise((_resolve, reject) => { rejectRequest = reject; });

  const sync = Sync.syncPendingProfile('fixture-profile', {
    store: currentStore,
    getStore() { return currentStore; },
    setStore(next) { currentStore = next; },
    clientId: 'client-a',
    async fetchImpl() {
      requestStartedResolve();
      return requestGate;
    },
  });

  await requestStarted;
  const oldPending = currentStore.profiles['fixture-profile'].pending;
  const newerRecorded = await Lifecycle.createProfileEnvelope(
    validProfile({ input: { selector: '#replacement-prompt', kind: 'textarea' } }),
    oldPending,
  );
  const replacementStore = structuredClone(currentStore);
  replacementStore.profiles['fixture-profile'].pending = Lifecycle.transitionProfileEnvelope(
    newerRecorded,
    'sync_requested',
  );
  currentStore = replacementStore;
  rejectRequest(new Error('old request failed'));

  const result = await sync;
  assert.equal(result.state, 'superseded');
  assert.equal(currentStore.profiles['fixture-profile'].pending.lifecycle.revision, 3);
  assert.equal(currentStore.profiles['fixture-profile'].lastError, null);
});

test('health payload excludes page and conversation content', () => {
  const report = runProfileHealthCheck();
  const payload = Sync.buildProfileHealthPayload('fixture-profile', 2, report);
  assert.deepEqual(Object.keys(payload).sort(), ['checks', 'profile_id', 'reason_codes', 'revision', 'state']);
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['pageText', 'prompt', 'assistant_text', 'cookie', 'localStorage', 'sessionStorage', 'authorization']) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
  }
});
