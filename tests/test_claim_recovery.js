const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const Claims = require('../extension/claim_recovery.js');

test('session serialization preserves ownership metadata but strips claim token', () => {
  const source = new Map([['job-1', {
    claim_token: 'secret-claim-token',
    conversation_id: 'conversation-1',
    tab_id: '7',
    domain: 'Example.COM',
    claimed_at: 100
  }]]);
  const serialized = Claims.serializeClaims(source);
  assert.deepEqual(serialized, {
    version: 1,
    claims: {
      'job-1': {
        job_id: 'job-1', conversation_id: 'conversation-1', tab_id: 7,
        domain: 'example.com', claimed_at: 100
      }
    }
  });
  assert.equal(JSON.stringify(serialized).includes('secret-claim-token'), false);
});

test('worker restart restores a token-free claim for result-token recovery', () => {
  const restored = Claims.deserializeClaims({ version: 1, claims: {
    'job-2': { job_id: 'job-2', conversation_id: 'c-2', tab_id: 8, domain: 'fixture.example', claimed_at: 200 }
  }});
  assert.equal(restored.size, 1);
  assert.deepEqual(restored.get('job-2'), {
    job_id: 'job-2', conversation_id: 'c-2', tab_id: 8,
    domain: 'fixture.example', claimed_at: 200
  });
  assert.equal('claim_token' in restored.get('job-2'), false);
  assert.equal(Claims.claimMatchesTab(restored.get('job-2'), 8, 'FIXTURE.EXAMPLE'), true);
});

test('malformed or unsupported session data is fail-closed and does not create claims', () => {
  assert.equal(Claims.deserializeClaims({ version: 99, claims: {} }).size, 0);
  const restored = Claims.deserializeClaims({ version: 1, claims: {
    missingDomain: { tab_id: 1 },
    badTab: { domain: 'fixture.example', tab_id: 'not-a-number' },
    valid: { domain: 'fixture.example', tab_id: 2, conversation_id: 'c' }
  }});
  assert.deepEqual([...restored.keys()], ['valid']);
});

test('claim serializer never carries page-content-shaped fields', () => {
  const serialized = JSON.stringify(Claims.serializeClaims({ job: {
    tab_id: 1, domain: 'fixture.example', conversation_id: 'c',
    message: 'page text must not be stored', assistant: 'answer', claim_token: 'token'
  }}));
  for (const forbidden of ['message', 'assistant', 'pageText', 'prompt', 'claim_token', 'token']) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
  }
});

test('background restores claims before polling and persists changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  const restoreIndex = source.indexOf('const activeClaimsReady = restoreActiveClaims()');
  const tickIndex = source.indexOf('async function browserBridgeTick()');
  const awaitRestoreIndex = source.indexOf('await activeClaimsReady;', tickIndex);
  const registerIndex = source.indexOf('await registerBrowserClient(', tickIndex);
  assert.ok(restoreIndex >= 0);
  assert.ok(awaitRestoreIndex > tickIndex);
  assert.ok(registerIndex > awaitRestoreIndex);
  assert.match(source, /await persistActiveClaims\(\);/);
  assert.match(source, /PhantomRelayClaimRecovery\.lookupClaimToken/);
});

test('reconciliation removes only backend-invalid claims', () => {
  assert.equal(Claims.shouldRemoveAfterTokenLookup(404), true);
  assert.equal(Claims.shouldRemoveAfterTokenLookup(409), true);
  assert.equal(Claims.shouldRemoveAfterTokenLookup(200), false);
  assert.equal(Claims.shouldRemoveAfterTokenLookup(500), false);
  assert.equal(Claims.shouldRemoveAfterTokenLookup(0), false);
});

test('reconciliation keeps live claims, removes invalid claims, and retains transport failures', async () => {
  const source = new Map([
    ['live', { tab_id: 1, domain: 'fixture.example', conversation_id: 'c1', claimed_at: 1, claim_token: 't1' }],
    ['done', { tab_id: 2, domain: 'fixture.example', conversation_id: 'c2', claimed_at: 2, claim_token: 't2' }],
    ['offline', { tab_id: 3, domain: 'fixture.example', conversation_id: 'c3', claimed_at: 3, claim_token: 't3' }]
  ]);
  const result = await Claims.reconcileClaims(source, async jobId => {
    if (jobId === 'live') return { ok: true, status: 200 };
    if (jobId === 'done') return { ok: false, status: 409 };
    throw new Error('api offline');
  });
  assert.equal(result.changed, true);
  assert.deepEqual([...result.claims.keys()], ['live', 'offline']);
  assert.deepEqual(result.removedClaims.map(item => item.job_id), ['done']);
  assert.equal(result.claims.get('live').claim_token, 't1');
});

test('backend-invalid result responses also invalidate the local claim', () => {
  assert.equal(Claims.shouldRemoveAfterBackendResponse(404), true);
  assert.equal(Claims.shouldRemoveAfterBackendResponse(409), true);
  assert.equal(Claims.shouldRemoveAfterBackendResponse(408), false);
  assert.equal(Claims.shouldRemoveAfterBackendResponse(503), false);

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  assert.match(source, /backendRejectedClaim/);
  assert.match(source, /shouldRemoveAfterBackendResponse\(response\.status\)/);
  assert.match(source, /if \(response\.ok \|\| backendRejectedClaim\)/);
});

test('background cancels the page capture before removing an invalid claim', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  assert.match(source, /async function cancelClaimedPageCapture\(claim, reason\)/);
  assert.match(source, /action:\s*'cancel_auto_capture'/);
  assert.match(source, /for \(const removed of removedClaims/);
  assert.match(source, /await cancelClaimedPageCapture\(removed\.claim/);
  assert.match(source, /claimsBeforeReconcile/);
  assert.match(source, /filter\(\(\[jobId\]\) => !result\.claims\.has\(jobId\)\)/);
});
