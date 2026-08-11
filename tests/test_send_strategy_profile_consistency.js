const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const Profile = require('../extension/profile_contract.js');
const SelectorReconciliation = require('../extension/profile_selector_reconciliation.js');
const background = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background.js'),
  'utf8',
);

function recordedProfile() {
  return Profile.normalizeProfile({
    profileId: 'fixture-send-consistency-v1',
    origin: 'https://fixture-send-consistency.test/chat',
    domain: 'fixture-send-consistency.test',
    input: { selector: '#prompt', kind: 'textarea' },
    send: { kind: 'enter', key: 'Enter', modifiers: [] },
    response: {
      selector: '[data-message-id]',
      identity: { attributes: ['data-message-id'] },
      identityVerification: {
        status: 'verified',
        method: 'fixture-dom-unique',
        attributes: ['data-message-id'],
      },
      role: { assistant: ['assistant'] },
    },
  });
}

test('profile contract can replace the recorded send action without changing response identity', () => {
  const original = recordedProfile();
  const button = { kind: 'button', selector: '#send' };

  assert.equal(typeof Profile.withSendStrategy, 'function');
  const updated = Profile.withSendStrategy(original, button);

  assert.deepEqual(updated.send, {
    kind: 'button',
    selector: { css: '#send', alternatives: [] },
  });
  assert.deepEqual(updated.response.identity, original.response.identity);
  assert.equal(updated.profileId, original.profileId);
});

test('background reconciles a newly recorded send action into the active profile', () => {
  assert.match(background, /withSendStrategy\(/);
  assert.match(background, /role === 'send'[\s\S]{0,1800}stageProfile/);
  assert.match(background, /send_strategy_profile_reconciled/);
});

test('background projects restored selector views from the recorded profile without creating a revision', () => {
  assert.match(background, /function reconcileRestoredSendStrategies\(/);
  assert.match(background, /reconcileRestoredSendStrategies\(\)/);
  const start = background.indexOf('async function reconcileRestoredSendStrategies(');
  const end = background.indexOf('\nasync function reconcileFetchedSelectors', start);
  const reconcile = start >= 0 && end > start ? background.slice(start, end) : '';
  assert.match(reconcile, /projectProfileSelectorBundle\(/);
  assert.doesNotMatch(reconcile, /withSendStrategy\(|stageProfile\(|syncPendingProfile\(/);
});

test('background bootstraps complete legacy profiles into the lifecycle store', () => {
  assert.match(background, /async function bootstrapRecordedProfileLifecycle\(/);
  assert.match(background, /PhantomRelayProfileStore\.bootstrapProfile\(/);
  assert.match(background, /PhantomRelayProfileStore\.adoptSyncedProfile\(/);
  assert.match(background, /async function reconcileRestoredProfiles\(/);
  assert.match(background, /reconcileRestoredProfiles\(\)/);
});

test('unchanged fetched profiles still enter lifecycle bootstrap when local state is missing', () => {
  const start = background.indexOf('async function reconcileFetchedSelectors(');
  const end = background.indexOf('\nasync function applyRecoveredProfile', start);
  const reconcile = start >= 0 && end > start ? background.slice(start, end) : '';
  assert.match(reconcile, /bootstrapRecordedProfileLifecycle\(/);
});

test('unchanged fetched profiles short-circuit when the active lifecycle and selector bundle already match', () => {
  const start = background.indexOf('async function reconcileFetchedSelectors(');
  const end = background.indexOf('\nasync function applyRecoveredProfile', start);
  const reconcile = start >= 0 && end > start ? background.slice(start, end) : '';
  assert.match(
    reconcile,
    /selectorBundleFingerprint\(/,
    'reconciliation needs a provider-neutral fingerprint for the already-published selector bundle',
  );
  assert.match(
    reconcile,
    /activeChecksum[\s\S]{0,900}return \{\s*selectors: existingSelectors/,
    'an identical active profile must not bootstrap, persist, or sync routes again',
  );
});

test('server selector payload projection ignores a stale top-level send action', () => {
  const profile = recordedProfile();
  const bundle = SelectorReconciliation.projectProfileSelectorBundle({
    input: { selector: '#stale-prompt' },
    send: { selector: '#stale-send' },
    response: { selector: '#stale-answer' },
    profile,
  }, Profile);

  assert.deepEqual(bundle.send, profile.send);
  assert.deepEqual(bundle.input, profile.input);
  assert.deepEqual(bundle.response, profile.response.selector);
  assert.deepEqual(bundle.profile, profile);
});

test('server selector payload projection cannot update the recorded response boundary', () => {
  const profile = recordedProfile();
  const bundle = SelectorReconciliation.projectProfileSelectorBundle({
    input: profile.input,
    send: profile.send,
    response: { selector: '.answer-region', alternatives: ['[data-answer]'] },
    profile,
  }, Profile);

  assert.deepEqual(bundle.response, profile.response.selector);
  assert.deepEqual(bundle.profile.response.identity, profile.response.identity);
  assert.deepEqual(bundle.profile.response.identityVerification, profile.response.identityVerification);
});

test('server selector payload republishes the profile response at the top level', () => {
  const profile = recordedProfile();
  const incoming = {
    input: profile.input,
    send: profile.send,
    response: { selector: '.answer-region', alternatives: ['[data-answer]'] },
    profile,
  };
  const bundle = SelectorReconciliation.projectProfileSelectorBundle(incoming, Profile);
  assert.deepEqual(bundle.response, profile.response.selector);
  assert.equal(bundle.response.css, bundle.profile.response.selector.css);
  assert.deepEqual(bundle.profile.response.identity, profile.response.identity);
});

test('background treats a server-fetched profile as authoritative and never writes a derived revision', () => {
  assert.match(background, /importScripts\('profile_selector_reconciliation\.js'\)/);
  assert.match(background, /async function reconcileFetchedSelectors\(/);
  assert.match(background, /get_server_selectors[\s\S]{0,1200}reconcileFetchedSelectors/);
  assert.match(background, /selectorResponse = await fetch[\s\S]{0,500}reconcileFetchedSelectors/);
  const start = background.indexOf('async function reconcileFetchedSelectors(');
  const end = background.indexOf('\nasync function applyRecoveredProfile', start);
  const reconcile = start >= 0 && end > start ? background.slice(start, end) : '';
  const conflictGuard = reconcile.indexOf("profile_remote_checksum_mismatch");
  const bootstrapCall = reconcile.indexOf('bootstrapRecordedProfileLifecycle(');
  assert.match(reconcile, /projectProfileSelectorBundle\(/);
  assert.match(reconcile, /bootstrapRecordedProfileLifecycle\(/);
  assert.ok(
    conflictGuard >= 0 && conflictGuard < bootstrapCall,
    'an active local/remote checksum conflict must fail closed before lifecycle bootstrap can stage a revision',
  );
  assert.doesNotMatch(reconcile, /withSendStrategy\(|stageProfile\(|syncPendingProfile\(/);
  assert.doesNotMatch(reconcile, /fetch\(`\$\{LOCAL_API\}\/browser\/selectors`/);
});
