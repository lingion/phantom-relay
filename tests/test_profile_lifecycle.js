const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/profile_contract.js');
const Lifecycle = require('../extension/profile_lifecycle.js');
const { validProfile } = require('./fixtures/profile_lifecycle.js');

const {
  PROFILE_SCHEMA_VERSION,
  PROFILE_STATES,
  PROFILE_HEALTH_REASONS,
  canonicalizeProfile,
  computeProfileChecksum,
  createProfileEnvelope,
  transitionProfileEnvelope,
  createHealthReport
} = Lifecycle;

test('exports the lifecycle schema and complete state set', () => {
  assert.equal(PROFILE_SCHEMA_VERSION, 2);
  assert.deepEqual(PROFILE_STATES, [
    'draft', 'recorded', 'sync_pending', 'synced', 'verified', 'degraded', 'invalid', 'archived'
  ]);
  assert.equal(PROFILE_HEALTH_REASONS.IDENTITY_UNAVAILABLE, 'profile_identity_unavailable');
});

test('canonical checksum ignores object key insertion order', async () => {
  const base = validProfile();
  const a = { ...base, response: { ...base.response, selector: '#a', identity: { attributes: ['id'] } } };
  const b = {
    capabilities: a.capabilities,
    response: {
      identity: { attributes: ['id'] },
      selector: '#a',
      role: a.response.role,
      streamingIndicators: a.response.streamingIndicators,
      excludedSelectors: a.response.excludedSelectors,
      textNormalization: a.response.textNormalization
    },
    send: a.send,
    input: a.input,
    domain: a.domain,
    origin: a.origin,
    profileId: a.profileId
  };
  assert.equal(canonicalizeProfile(a), canonicalizeProfile(b));
  assert.equal(await computeProfileChecksum(a), await computeProfileChecksum(b));
});

test('new profile starts as recorded revision one', async () => {
  const envelope = await createProfileEnvelope(validProfile());
  assert.equal(envelope.profile.__normalizedProfile, true);
  assert.equal(envelope.lifecycle.schemaVersion, 2);
  assert.equal(envelope.lifecycle.revision, 1);
  assert.equal(envelope.lifecycle.state, 'recorded');
  assert.match(envelope.lifecycle.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(envelope.lifecycle.lastVerifiedAt, null);
  assert.equal(envelope.health, null);
});

test('invalid response identity fails closed before an envelope is created', async () => {
  await assert.rejects(
    createProfileEnvelope({ ...validProfile(), response: { selector: '#answer' } }),
    error => error.code === 'response_contract_missing'
  );
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
  assert.equal(verified.lifecycle.lastVerifiedAt !== null, true);
});

test('sync failure returns a recorded envelope instead of verified', async () => {
  const envelope = await createProfileEnvelope(validProfile());
  assert.equal(transitionProfileEnvelope(envelope, 'sync_failed').lifecycle.state, 'recorded');
});

test('health failure degrades but does not archive the profile', async () => {
  const synced = transitionProfileEnvelope(
    transitionProfileEnvelope(await createProfileEnvelope(validProfile()), 'sync_requested'),
    'sync_accepted'
  );
  const degraded = transitionProfileEnvelope(synced, 'health_check_failed');
  assert.equal(degraded.lifecycle.state, 'degraded');
  assert.equal(transitionProfileEnvelope(degraded, 'archived').lifecycle.state, 'archived');
});

test('health reports contain only structured checks and reason codes', () => {
  const report = createHealthReport('fixture-profile-v1', 1, {
    input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass'
  });
  assert.deepEqual(report, {
    profile_id: 'fixture-profile-v1',
    revision: 1,
    state: 'verified',
    checks: { input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass' },
    reason_codes: []
  });
});
