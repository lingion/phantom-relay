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

test('profile contract can replace the recorded input selector without changing response identity', () => {
  const original = recordedProfile();
  const updated = Profile.withInputSelector(original, {
    selector: { css: '#fresh-prompt', alternatives: ['[data-prompt]'] },
  });

  assert.equal(typeof Profile.withInputSelector, 'function');
  assert.deepEqual(updated.input.selector, {
    css: '#fresh-prompt',
    alternatives: ['[data-prompt]'],
  });
  assert.equal(updated.input.kind, original.input.kind);
  assert.deepEqual(updated.response.identity, original.response.identity);
  assert.equal(updated.profileId, original.profileId);
});

test('selector reconciliation exposes an input-only profile update', () => {
  const original = recordedProfile();
  const result = SelectorReconciliation.reconcileProfileInputSelector(
    original,
    { selector: '#fresh-prompt', alternatives: ['[data-prompt]'] },
    Profile,
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.input, {
    selector: '#fresh-prompt',
    alternatives: ['[data-prompt]'],
  });
  assert.equal(result.profile.input.selector.css, '#fresh-prompt');
  assert.deepEqual(result.profile.response.identity, original.response.identity);
});

test('background reconciles a newly recorded send action into the active profile', () => {
  assert.match(background, /role === 'send'[\s\S]{0,2600}PhantomRelayProfile\.withSendStrategy\(/);
  assert.match(background, /PhantomRelayProfile\.withSendStrategy\([\s\S]{0,900}profileChanged = true/);
  assert.match(background, /syncPendingProfile\(profileCandidate\.profileId\)/);
  assert.match(background, /code: 'profile_sync_failed'/);
});

test('background reconciles a newly recorded input selector into the active profile', () => {
  assert.match(background, /reconcileProfileInputSelector\(/);
  assert.match(background, /role === 'input'[\s\S]{0,2200}profileCandidate = reconciled\.profile/);
  assert.match(background, /syncPendingProfile\(profileCandidate\.profileId\)/);
  assert.match(background, /code: 'profile_sync_failed'/);
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
  const end = background.indexOf('\nfunction projectRecoveredProfileLocally', start);
  const reconcile = start >= 0 && end > start ? background.slice(start, end) : '';
  assert.match(reconcile, /bootstrapRecordedProfileLifecycle\(/);
});

test('unchanged fetched profiles short-circuit when the active lifecycle and selector bundle already match', () => {
  const start = background.indexOf('async function reconcileFetchedSelectors(');
  const end = background.indexOf('\nfunction projectRecoveredProfileLocally', start);
  const reconcile = start >= 0 && end > start ? background.slice(start, end) : '';
  assert.match(
    reconcile,
    /selectorBundleFingerprint\(/,
    'reconciliation needs a provider-neutral fingerprint for the already-published selector bundle',
  );
  assert.match(
    reconcile,
    /canReuseRecordedSelectorView\([\s\S]{0,900}return \{\s*selectors: existingSelectors/,
    'only an executable selector view with the identical embedded profile may short-circuit',
  );
});

test('a profile-null selector view cannot survive backend rehydration', () => {
  const start = background.indexOf('async function reconcileFetchedSelectors(');
  const end = background.indexOf('\nfunction projectRecoveredProfileLocally', start);
  const reconcile = start >= 0 && end > start ? background.slice(start, end) : '';
  assert.match(reconcile, /existingProfileChecksum/);
  assert.match(reconcile, /existingExecutable:\s*hasExecutableRecordedProfile\(existingSelectors\)/);
  assert.match(reconcile, /existingChecksum:\s*existingProfileChecksum/);
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
  const end = background.indexOf('\nfunction projectRecoveredProfileLocally', start);
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

test('input re-recording restores the authoritative profile before reconciliation when local cache is missing', () => {
  assert.match(
    background,
    /async function ensureAuthoritativeProfileForCapture\(/,
    'input recording must not silently downgrade to a selector-only update when the local profile replica is absent',
  );
  assert.match(
    background,
    /ensureAuthoritativeProfileForCapture\(domain\)/,
    'the selector capture path must load the authoritative backend profile before applying a new input selector',
  );
  assert.match(
    background,
    /ensureAuthoritativeProfileForCapture\(domain\)[\s\S]{0,2200}reconcileProfileInputSelector\(/,
    'the newly captured selector must be reconciled against the fetched full profile',
  );
  assert.match(
    background,
    /synced = await syncPendingProfile\(profileCandidate\.profileId\);[\s\S]{0,520}synced\.state !== 'synced'/,
    'input recording must fail closed when profile synchronization returns a conflict',
  );
});

test('selector capture reports persistence success or failure to the content runtime', () => {
  assert.match(
    background,
    /selector_capture_persist_failed/,
    'selector recording must expose backend persistence failures instead of showing a local-only success',
  );
  assert.match(
    background,
    /acknowledge\(\{\s*ok:\s*true,[\s\S]{0,300}profile_revision/,
    'selector recording must acknowledge the persisted profile revision',
  );
  assert.match(
    background,
    /selector_capture_processing_failed[\s\S]{0,300}acknowledge\(\{[\s\S]{0,220}ok:\s*false/,
    'selector recording must return an explicit failure acknowledgement when asynchronous processing throws',
  );
});

test('content runtime surfaces an ambiguous selector-capture acknowledgement', () => {
  const content = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'content.js'),
    'utf8',
  );
  assert.match(content, /selector_capture_ack_failed/);
  assert.match(content, /selector_capture_rejected/);
});
