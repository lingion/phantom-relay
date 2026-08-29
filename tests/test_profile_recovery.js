'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/profile_contract.js');
const Lifecycle = require('../extension/profile_lifecycle.js');
const Recovery = require('../extension/profile_recovery.js');
const { validProfile } = require('./fixtures/profile_lifecycle.js');

const LOCAL_CHECKSUM = `sha256:${'a'.repeat(64)}`;
const REMOTE_CHECKSUM = `sha256:${'b'.repeat(64)}`;

async function validRemoteReplica(overrides = {}) {
  const { profile: profileOverrides = {}, ...responseOverrides } = overrides;
  const profile = validProfile({
    profileId: 'recorded-fixture-v1',
    origin: 'https://fixture.example/chat',
    domain: 'fixture.example',
    ...profileOverrides,
  });
  return {
    ok: true,
    profile_id: 'recorded-fixture-v1',
    profile,
    revision: 2,
    checksum: await Lifecycle.computeProfileChecksum(profile),
    state: 'synced',
    ...responseOverrides,
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function activeEntry({
  localRevision = 3,
  localChecksum = LOCAL_CHECKSUM,
  pending = null,
} = {}) {
  return {
    active: {
      profile: { profileId: 'recorded-fixture-v1', domain: 'fixture.example' },
      lifecycle: {
        revision: localRevision,
        checksum: localChecksum,
        state: 'synced',
      },
    },
    pending,
    lastError: null,
  };
}

function remoteProfile({
  remoteRevision = 2,
  remoteChecksum = REMOTE_CHECKSUM,
} = {}) {
  return {
    profile_id: 'recorded-fixture-v1',
    revision: remoteRevision,
    checksum: remoteChecksum,
    state: 'synced',
  };
}

function repairAck(entry, overrides = {}) {
  return {
    ok: true,
    profile_id: entry.active.profile.profileId,
    revision: entry.active.lifecycle.revision,
    checksum: entry.active.lifecycle.checksum,
    state: 'synced',
    ...overrides,
  };
}

function storeWithPending() {
  return {
    version: 1,
    profiles: {
      good: {
        active: null,
        pending: { profile: { profileId: 'good', domain: 'good.example' } },
        lastError: null
      },
      bad: {
        active: null,
        pending: { profile: { profileId: 'bad', domain: 'bad.example' } },
        lastError: null
      },
      empty: { active: null, pending: null, lastError: null }
    }
  };
}

test('recovery retries every pending profile and applies only successful active profiles', async () => {
  const applied = [];
  const calls = [];
  const result = await Recovery.recoverPendingProfiles(storeWithPending(), async (profileId) => {
    calls.push(profileId);
    if (profileId === 'bad') throw new Error('offline');
    return {
      state: 'synced',
      store: {
        version: 1,
        profiles: {
          good: {
            active: { profile: { profileId: 'good', domain: 'good.example' } },
            pending: null,
            lastError: null
          },
          bad: {
            active: null,
            pending: { profile: { profileId: 'bad', domain: 'bad.example' } },
            lastError: { code: 'profile_sync_failed' }
          }
        }
      }
    };
  }, ({ profileId, envelope }) => applied.push({ profileId, envelope }));

  assert.deepEqual(calls.sort(), ['bad', 'good']);
  assert.equal(result.recovered.length, 1);
  assert.deepEqual(result.failed, ['bad']);
  assert.equal(applied[0].profileId, 'good');
  assert.equal(applied[0].envelope.profile.domain, 'good.example');
});

test('recovery is a no-op when there are no pending profiles', async () => {
  const result = await Recovery.recoverPendingProfiles({ profiles: {} }, async () => {
    throw new Error('must not be called');
  });

  assert.deepEqual(result.recovered, []);
  assert.deepEqual(result.failed, []);
});

test('backend reconciliation completes only after an explicit completed result', () => {
  assert.equal(Recovery.isBackendReconciliationComplete(null), false);
  assert.equal(Recovery.isBackendReconciliationComplete(undefined), false);
  assert.equal(Recovery.isBackendReconciliationComplete({
    attempted: false,
    completed: false,
    reason: 'throttled',
  }), false);
  assert.equal(Recovery.isBackendReconciliationComplete({
    attempted: true,
    completed: true,
    reason: 'completed',
  }), true);
});

test('a previously synced local active revision can repair an older backend copy', () => {
  assert.deepEqual(
    Recovery.planActiveProfileBackendRepair(
      activeEntry(),
      remoteProfile(),
    ),
    {
      action: 'republish_active',
      reason: 'backend_revision_behind',
      localRevision: 3,
      remoteRevision: 2,
    },
  );
});

test('a missing backend copy can be restored from the acknowledged local active envelope', () => {
  assert.deepEqual(
    Recovery.planActiveProfileBackendRepair(activeEntry(), null),
    {
      action: 'republish_active',
      reason: 'backend_profile_missing',
      localRevision: 3,
      remoteRevision: 0,
    },
  );
});

test('an unsynced local recording blocks automatic active-profile repair', () => {
  const pending = {
    profile: { profileId: 'recorded-fixture-v1', domain: 'fixture.example' },
    lifecycle: { revision: 4, checksum: 'sha256:pending', state: 'sync_pending' },
  };
  assert.deepEqual(
    Recovery.planActiveProfileBackendRepair(
      activeEntry({ pending }),
      remoteProfile(),
    ),
    {
      action: 'conflict',
      reason: 'local_pending_preserved',
      localRevision: 3,
      remoteRevision: 2,
    },
  );
});

test('same-revision checksum divergence remains an explicit conflict', () => {
  assert.deepEqual(
    Recovery.planActiveProfileBackendRepair(
      activeEntry({ localRevision: 2 }),
      remoteProfile(),
    ),
    {
      action: 'conflict',
      reason: 'profile_checksum_conflict',
      localRevision: 2,
      remoteRevision: 2,
    },
  );
});

test('a newer divergent backend profile is never overwritten automatically', () => {
  assert.deepEqual(
    Recovery.planActiveProfileBackendRepair(
      activeEntry({ localRevision: 2 }),
      remoteProfile({ remoteRevision: 3 }),
    ),
    {
      action: 'conflict',
      reason: 'backend_revision_ahead',
      localRevision: 2,
      remoteRevision: 3,
    },
  );
});

test('matching lifecycle metadata requires no profile write', () => {
  assert.deepEqual(
    Recovery.planActiveProfileBackendRepair(
      activeEntry({ localRevision: 2, localChecksum: 'sha256:same' }),
      remoteProfile({ remoteRevision: 2, remoteChecksum: 'sha256:same' }),
    ),
    {
      action: 'matched',
      reason: 'profile_matches',
      localRevision: 2,
      remoteRevision: 2,
    },
  );
});

test('profile repair acknowledgement must match the exact active envelope', () => {
  const active = activeEntry().active;
  const valid = repairAck({ active });
  assert.equal(Recovery.isActiveProfileRepairAcknowledged(active, valid), true);
  for (const acknowledgement of [
    null,
    [],
    { revision: 3, checksum: LOCAL_CHECKSUM },
    { ...valid, ok: false },
    { ...valid, profile_id: 'recorded-other-v1' },
    { ...valid, revision: 2 },
    { ...valid, revision: 3.5 },
    { ...valid, checksum: 'sha256:bad' },
    { ...valid, checksum: `sha256:${'0'.repeat(64)}` },
    { ...valid, state: 'invalid' },
  ]) {
    assert.equal(
      Recovery.isActiveProfileRepairAcknowledged(active, acknowledgement),
      false,
      `unexpectedly accepted acknowledgement: ${JSON.stringify(acknowledgement)}`,
    );
  }
});

test('a fetched selector view is reusable only when its executable profile also matches', () => {
  const matching = {
    activeChecksum: 'sha256:same',
    incomingChecksum: 'sha256:same',
    existingChecksum: 'sha256:same',
    selectorBundleMatches: true,
    existingExecutable: true,
  };
  assert.equal(Recovery.canReuseRecordedSelectorView(matching), true);
  assert.equal(Recovery.canReuseRecordedSelectorView({
    ...matching,
    existingChecksum: '',
    existingExecutable: false,
  }), false, 'a stale profile:null view must be rehydrated');
  assert.equal(Recovery.canReuseRecordedSelectorView({
    ...matching,
    existingChecksum: 'sha256:stale',
  }), false, 'a different embedded profile must not be reused');
  assert.equal(Recovery.canReuseRecordedSelectorView({
    ...matching,
    selectorBundleMatches: false,
  }), false, 'a stale top-level selector projection must be replaced');
});

test('remote replica validation requires the exact profile identity and canonical content checksum', async () => {
  const valid = await validRemoteReplica();
  const normalized = await Recovery.validateRemoteProfileReplica(
    valid,
    'recorded-fixture-v1',
    'fixture.example',
  );
  assert.equal(normalized.profile.profileId, 'recorded-fixture-v1');
  assert.equal(normalized.revision, 2);

  const invalidCases = [
    null,
    { ...valid, profile_id: 'recorded-other-v1' },
    { ...valid, profile: null },
    { ...valid, profile: { ...valid.profile, domain: 'other.example' } },
    { ...valid, revision: 0 },
    { ...valid, checksum: 'sha256:bad' },
    { ...valid, checksum: 'sha256:' + '0'.repeat(64) },
    { ...valid, state: 'sync_pending' },
  ];
  for (const item of invalidCases) {
    await assert.rejects(
      Recovery.validateRemoteProfileReplica(
        item,
        'recorded-fixture-v1',
        'fixture.example',
      ),
      error => error.code === 'backend_profile_invalid',
    );
  }
});

test('remote replica origin must be HTTP or HTTPS and match the recorded domain', async () => {
  for (const origin of [
    'https://other.example/chat',
    'ftp://fixture.example/chat',
    'not-a-url',
  ]) {
    const replica = await validRemoteReplica({ profile: { origin } });
    await assert.rejects(
      Recovery.validateRemoteProfileReplica(
        replica,
        'recorded-fixture-v1',
        'fixture.example',
      ),
      error => error.code === 'backend_profile_invalid',
      `unexpectedly accepted origin: ${origin}`,
    );
  }
});

test('a malformed successful profile lookup cannot publish a profile or selector replica', async () => {
  const calls = [];
  const entry = activeEntry();
  const result = await Recovery.recoverActiveProfileReplica({
    candidateEntry: entry,
    profileId: 'recorded-fixture-v1',
    expectedDomain: 'fixture.example',
    getCurrentEntry: () => entry,
    loadRemote: async () => response(200, null),
    publishActive: async () => { calls.push('profile-post'); },
    inspectSelectors: async () => { calls.push('selector-get'); return true; },
    applySelectors: async () => { calls.push('selector-post'); },
  });

  assert.equal(result.action, 'conflict');
  assert.equal(result.reason, 'backend_profile_invalid');
  assert.deepEqual(calls, []);
});

test('a pending recording staged while the lookup is in flight blocks every repair write', async () => {
  const store = { profiles: { 'recorded-fixture-v1': activeEntry() } };
  const beforeActive = structuredClone(store.profiles['recorded-fixture-v1'].active);
  const calls = [];
  const remote = await validRemoteReplica();

  const result = await Recovery.recoverActiveProfileReplica({
    candidateEntry: store.profiles['recorded-fixture-v1'],
    profileId: 'recorded-fixture-v1',
    expectedDomain: 'fixture.example',
    getCurrentEntry: () => store.profiles['recorded-fixture-v1'],
    loadRemote: async () => {
      store.profiles['recorded-fixture-v1'] = activeEntry({
        pending: {
          profile: { profileId: 'recorded-fixture-v1', domain: 'fixture.example' },
          lifecycle: { revision: 4, checksum: 'sha256:pending', state: 'sync_pending' },
        },
      });
      return response(200, remote);
    },
    publishActive: async () => { calls.push('profile-post'); },
    inspectSelectors: async () => { calls.push('selector-get'); return true; },
    applySelectors: async () => { calls.push('selector-post'); },
  });

  assert.equal(result.action, 'conflict');
  assert.equal(result.reason, 'local_pending_preserved');
  assert.deepEqual(calls, []);
  assert.deepEqual(store.profiles['recorded-fixture-v1'].active, beforeActive);
  assert.ok(store.profiles['recorded-fixture-v1'].pending);
});

test('a current local active profile repairs an older replica in strict IO order', async () => {
  const entry = activeEntry();
  const remote = await validRemoteReplica();
  const calls = [];
  const result = await Recovery.recoverActiveProfileReplica({
    candidateEntry: entry,
    profileId: 'recorded-fixture-v1',
    expectedDomain: 'fixture.example',
    getCurrentEntry: () => entry,
    loadRemote: async () => { calls.push('profile-get'); return response(200, remote); },
    publishActive: async envelope => {
      calls.push('profile-post');
      assert.equal(envelope, entry.active);
      return repairAck(entry);
    },
    inspectSelectors: async () => { calls.push('selector-get'); return false; },
    applySelectors: async envelope => {
      calls.push('selector-post');
      assert.equal(envelope, entry.active);
    },
  });

  assert.equal(result.action, 'repaired');
  assert.deepEqual(calls, ['profile-get', 'profile-post', 'selector-post']);
});

test('a missing backend profile repairs from the exact current active envelope', async () => {
  const entry = activeEntry();
  const calls = [];
  const result = await Recovery.recoverActiveProfileReplica({
    candidateEntry: entry,
    profileId: 'recorded-fixture-v1',
    expectedDomain: 'fixture.example',
    getCurrentEntry: () => entry,
    loadRemote: async () => { calls.push('profile-get'); return response(404, {}); },
    publishActive: async envelope => {
      calls.push('profile-post');
      assert.equal(envelope, entry.active);
      return repairAck(entry);
    },
    applySelectors: async envelope => {
      calls.push('selector-post');
      assert.equal(envelope, entry.active);
    },
  });

  assert.equal(result.action, 'repaired');
  assert.equal(result.reason, 'backend_profile_missing');
  assert.deepEqual(calls, ['profile-get', 'profile-post', 'selector-post']);
});

test('matching profile and selector replicas perform no writes', async () => {
  const remote = await validRemoteReplica();
  const entry = {
    active: {
      profile: remote.profile,
      lifecycle: { revision: 2, checksum: remote.checksum, state: 'synced' },
    },
    pending: null,
    lastError: null,
  };
  const calls = [];
  const result = await Recovery.recoverActiveProfileReplica({
    candidateEntry: entry,
    profileId: 'recorded-fixture-v1',
    expectedDomain: 'fixture.example',
    getCurrentEntry: () => entry,
    loadRemote: async () => { calls.push('profile-get'); return response(200, remote); },
    publishActive: async () => { calls.push('profile-post'); },
    inspectSelectors: async () => { calls.push('selector-get'); return false; },
    applySelectors: async () => { calls.push('selector-post'); },
  });

  assert.equal(result.action, 'matched');
  assert.equal(result.selectorsRepaired, false);
  assert.deepEqual(calls, ['profile-get', 'selector-get']);
});

test('a pending recording staged after profile acknowledgement blocks selector publication', async () => {
  const store = { profiles: { 'recorded-fixture-v1': activeEntry() } };
  const remote = await validRemoteReplica();
  const calls = [];
  const result = await Recovery.recoverActiveProfileReplica({
    candidateEntry: store.profiles['recorded-fixture-v1'],
    profileId: 'recorded-fixture-v1',
    expectedDomain: 'fixture.example',
    getCurrentEntry: () => store.profiles['recorded-fixture-v1'],
    loadRemote: async () => response(200, remote),
    publishActive: async () => {
      calls.push('profile-post');
      store.profiles['recorded-fixture-v1'].pending = {
        profile: { profileId: 'recorded-fixture-v1', domain: 'fixture.example' },
        lifecycle: { revision: 4, checksum: 'sha256:pending', state: 'sync_pending' },
      };
      return repairAck(store.profiles['recorded-fixture-v1']);
    },
    applySelectors: async () => { calls.push('selector-post'); },
  });

  assert.equal(result.action, 'conflict');
  assert.equal(result.reason, 'local_pending_preserved');
  assert.deepEqual(calls, ['profile-post']);
});

test('a pending recording staged during selector inspection blocks selector publication', async () => {
  const remote = await validRemoteReplica();
  const store = {
    profiles: {
      'recorded-fixture-v1': {
        active: {
          profile: remote.profile,
          lifecycle: { revision: 2, checksum: remote.checksum, state: 'synced' },
        },
        pending: null,
        lastError: null,
      },
    },
  };
  const calls = [];
  const result = await Recovery.recoverActiveProfileReplica({
    candidateEntry: store.profiles['recorded-fixture-v1'],
    profileId: 'recorded-fixture-v1',
    expectedDomain: 'fixture.example',
    getCurrentEntry: () => store.profiles['recorded-fixture-v1'],
    loadRemote: async () => response(200, remote),
    inspectSelectors: async () => {
      calls.push('selector-get');
      store.profiles['recorded-fixture-v1'].pending = {
        profile: { profileId: 'recorded-fixture-v1', domain: 'fixture.example' },
        lifecycle: { revision: 3, checksum: 'sha256:pending', state: 'sync_pending' },
      };
      return true;
    },
    applySelectors: async () => { calls.push('selector-post'); },
  });

  assert.equal(result.action, 'conflict');
  assert.equal(result.reason, 'local_pending_preserved');
  assert.deepEqual(calls, ['selector-get']);
});

console.log('PROFILE_RECOVERY_TESTS_DEFINED');
