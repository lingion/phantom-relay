const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/profile_contract.js');
require('../extension/profile_lifecycle.js');
require('../extension/profile_store.js');
const Sync = require('../extension/profile_sync.js');
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

test('health payload excludes page and conversation content', () => {
  const report = runProfileHealthCheck();
  const payload = Sync.buildProfileHealthPayload('fixture-profile', 2, report);
  assert.deepEqual(Object.keys(payload).sort(), ['checks', 'profile_id', 'reason_codes', 'revision', 'state']);
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['pageText', 'prompt', 'assistant_text', 'cookie', 'localStorage', 'sessionStorage', 'authorization']) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
  }
});
