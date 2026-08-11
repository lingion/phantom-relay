const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/profile_contract.js');
require('../extension/profile_lifecycle.js');
const Store = require('../extension/profile_store.js');
const Lifecycle = require('../extension/profile_lifecycle.js');
const { validProfile } = require('./fixtures/profile_lifecycle.js');

const {
  loadProfileStore,
  getActiveProfile,
  stageProfile,
  bootstrapProfile,
  adoptSyncedProfile,
  promoteProfile,
  recordProfileHealth,
  recordProfileError,
  migrateLegacySelectors,
  saveProfileStore
} = Store;
const { createProfileEnvelope, createHealthReport } = Lifecycle;

function memoryStorage(initial = {}) {
  const writes = [];
  return {
    writes,
    async get() { return structuredClone(initial); },
    async set(value) { writes.push(structuredClone(value)); Object.assign(initial, structuredClone(value)); }
  };
}

test('loading an empty storage creates a versioned profile store', async () => {
  const store = await loadProfileStore(memoryStorage({}));
  assert.deepEqual(store, { version: 1, profiles: {}, diagnostics: [], legacyHints: [] });
});

test('staging a new revision preserves active last-known-good profile', async () => {
  const oldEnvelope = await createProfileEnvelope(validProfile({ input: { selector: '#old', kind: 'textarea' } }));
  const store = { version: 1, profiles: { [oldEnvelope.profile.profileId]: { active: oldEnvelope, pending: null, lastError: null } }, diagnostics: [], legacyHints: [] };
  const next = await stageProfile(store, validProfile({ input: { selector: '#new', kind: 'textarea' } }));
  assert.equal(next.profiles[oldEnvelope.profile.profileId].active.profile.input.selector.css, '#old');
  assert.equal(next.profiles[oldEnvelope.profile.profileId].pending.profile.input.selector.css, '#new');
  assert.equal(next.profiles[oldEnvelope.profile.profileId].pending.lifecycle.state, 'sync_pending');
});

test('staging against a remote revision advances a profile with no local active envelope', async () => {
  const staged = await stageProfile(
    { version: 1, profiles: {}, diagnostics: [], legacyHints: [] },
    validProfile(),
    { remoteRevision: 4 },
  );
  const id = validProfile().profileId;
  assert.equal(staged.profiles[id].pending.lifecycle.revision, 5);
  assert.equal(staged.profiles[id].pending.lifecycle.state, 'sync_pending');
});

test('bootstrapping a complete legacy profile creates one pending lifecycle envelope', async () => {
  const result = await bootstrapProfile(
    { version: 1, profiles: {}, diagnostics: [], legacyHints: [] },
    validProfile(),
    { remoteRevision: 0 },
  );
  const id = validProfile().profileId;
  assert.equal(result.state, 'staged');
  assert.equal(result.store.profiles[id].pending.lifecycle.revision, 1);
  assert.equal(result.store.profiles[id].pending.lifecycle.state, 'sync_pending');
});

test('bootstrapping an identical active profile is idempotent', async () => {
  const staged = await stageProfile({ version: 1, profiles: {}, diagnostics: [], legacyHints: [] }, validProfile());
  const id = validProfile().profileId;
  const pending = staged.profiles[id].pending;
  const synced = await promoteProfile(staged, id, {
    ok: true, revision: pending.lifecycle.revision, checksum: pending.lifecycle.checksum, state: 'synced'
  });
  const result = await bootstrapProfile(synced, validProfile(), { remoteRevision: 1 });
  assert.equal(result.state, 'already_active');
  assert.equal(result.store.profiles[id].active.lifecycle.revision, 1);
  assert.equal(result.store.profiles[id].pending, null);
});

test('adopting a matching remote profile preserves its persisted revision', async () => {
  const recorded = await createProfileEnvelope(validProfile());
  const result = await adoptSyncedProfile(
    { version: 1, profiles: {}, diagnostics: [], legacyHints: [] },
    validProfile(),
    { revision: 4, checksum: recorded.lifecycle.checksum, state: 'synced' },
  );
  const id = validProfile().profileId;
  assert.equal(result.state, 'adopted');
  assert.equal(result.store.profiles[id].active.lifecycle.revision, 4);
  assert.equal(result.store.profiles[id].active.lifecycle.state, 'synced');
  assert.equal(result.store.profiles[id].pending, null);
});

test('adopting a remote profile with a different checksum fails closed', async () => {
  await assert.rejects(
    adoptSyncedProfile(
      { version: 1, profiles: {}, diagnostics: [], legacyHints: [] },
      validProfile(),
      { revision: 4, checksum: 'sha256:' + '0'.repeat(64), state: 'synced' },
    ),
    error => error.code === 'profile_remote_checksum_mismatch'
  );
});

test('promotion requires matching backend acknowledgement and clears only pending', async () => {
  const staged = await stageProfile({ version: 1, profiles: {}, diagnostics: [], legacyHints: [] }, validProfile());
  const id = validProfile().profileId;
  const pending = staged.profiles[id].pending;
  const promoted = await promoteProfile(staged, id, {
    ok: true,
    revision: pending.lifecycle.revision,
    checksum: pending.lifecycle.checksum,
    state: 'synced'
  });
  assert.equal(promoted.profiles[id].pending, null);
  assert.equal(promoted.profiles[id].active.lifecycle.state, 'synced');
  await assert.rejects(promoteProfile(staged, id, { ok: true, revision: 99, checksum: pending.lifecycle.checksum }));
});

test('legacy selector-only profile is reported as migration hint, not executable', () => {
  const result = migrateLegacySelectors({ 'fixture.local': { input: '#prompt', send: '#send', response: '#answer' } });
  assert.equal(result.executable.length, 0);
  assert.equal(result.hints[0].reason, 'response_identity_missing');
});

test('health and errors update diagnostics without replacing active profile', async () => {
  const staged = await stageProfile({ version: 1, profiles: {}, diagnostics: [], legacyHints: [] }, validProfile());
  const id = validProfile().profileId;
  const pending = staged.profiles[id].pending;
  const synced = await promoteProfile(staged, id, {
    ok: true, revision: pending.lifecycle.revision, checksum: pending.lifecycle.checksum, state: 'synced'
  });
  const report = createHealthReport(id, pending.lifecycle.revision, {
    input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass'
  });
  const healthy = await recordProfileHealth(synced, report);
  assert.equal(healthy.profiles[id].active.lifecycle.state, 'verified');
  const errored = await recordProfileError(healthy, id, { code: 'profile_sync_failed', recoverable: true });
  assert.equal(errored.profiles[id].active.lifecycle.state, 'verified');
  assert.equal(errored.profiles[id].lastError.code, 'profile_sync_failed');
});

test('saveProfileStore performs one atomic phantomProfiles write', async () => {
  const storage = memoryStorage();
  const store = { version: 1, profiles: {}, diagnostics: [], legacyHints: [] };
  await saveProfileStore(storage, store);
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(Object.keys(storage.writes[0]), ['phantomProfiles']);
});
