const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const Claims = require('../extension/claim_recovery.js');

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function fakeServer() {
  const jobs = new Map();
  let attempts = 0;
  return {
    enqueue(id, tabId, domain, conversationId) {
      jobs.set(id, {
        id, status: 'queued', tabId, domain, conversationId,
        token: `token-${id}`,
      });
    },
    claim(id, tabId) {
      const job = jobs.get(id);
      if (!job || job.status !== 'queued' || job.tabId !== tabId) return null;
      if ([...jobs.values()].some(item => item.status === 'claimed' && item.tabId === tabId)) return null;
      job.status = 'claimed';
      job.claimedTabId = tabId;
      attempts += 1;
      return { ...job };
    },
    complete(id) {
      const job = jobs.get(id);
      if (job) job.status = 'completed';
    },
    reap(id) {
      const job = jobs.get(id);
      if (job) job.status = 'reaped';
    },
    tokenLookup(jobId, claim) {
      const job = jobs.get(jobId);
      const identityMatches = job && job.tabId === claim.tab_id &&
        job.domain === claim.domain && job.conversationId === claim.conversation_id;
      if (!identityMatches || !['claimed'].includes(job.status)) return response(409);
      return response(200, { claim_token: job.token });
    },
    get attempts() { return attempts; },
    get(id) { return jobs.get(id); },
  };
}

function metadataFromClaim(job) {
  return {
    job_id: job.id,
    conversation_id: job.conversationId,
    tab_id: job.tabId,
    domain: job.domain,
    claimed_at: 100,
    claim_token: job.token,
  };
}

test('worker restart preserves one live lease and resolves its token without a second claim', async () => {
  const server = fakeServer();
  server.enqueue('live-job', 17, 'fixture.example', 'conversation-1');
  const firstClaim = server.claim('live-job', 17);
  assert.ok(firstClaim);

  const session = Claims.serializeClaims(new Map([
    [firstClaim.id, metadataFromClaim(firstClaim)],
  ]));
  assert.equal(JSON.stringify(session).includes(firstClaim.token), false);

  const restored = Claims.deserializeClaims(session);
  const lookupCalls = [];
  const reconciled = await Claims.reconcileClaims(restored, async (jobId, claim) => {
    lookupCalls.push({ jobId, claim });
    return server.tokenLookup(jobId, claim);
  });

  assert.equal(reconciled.changed, false);
  assert.equal(server.attempts, 1);
  assert.deepEqual([...reconciled.claims.keys()], ['live-job']);
  assert.deepEqual(lookupCalls[0].claim, restored.get('live-job'));
  assert.equal(server.claim('live-job', 17), null, 'restored ownership must block a duplicate claim');

  const requests = [];
  const token = await Claims.lookupClaimToken(restored.get('live-job'), {
    baseUrl: 'http://127.0.0.1:8765',
    clientId: 'client-1',
    fetchImpl: async (url) => {
      requests.push(String(url));
      return server.tokenLookup('live-job', restored.get('live-job'));
    },
  });
  assert.deepEqual(token, { ok: true, status: 200, claim_token: firstClaim.token });
  assert.match(requests[0], /\/browser\/result-token\?/);
  assert.match(requests[0], /job_id=live-job/);
  assert.match(requests[0], /tab_id=17/);
  assert.match(requests[0], /client_id=client-1/);
});

test('completed or reaped claims are removed so the same tab can claim a new job', async () => {
  for (const terminalState of ['completed', 'reaped']) {
    const server = fakeServer();
    const oldId = `${terminalState}-job`;
    server.enqueue(oldId, 21, 'fixture.example', `${terminalState}-conversation`);
    const oldClaim = server.claim(oldId, 21);
    assert.ok(oldClaim);
    if (terminalState === 'completed') server.complete(oldId);
    else server.reap(oldId);

    const restored = Claims.deserializeClaims(Claims.serializeClaims(new Map([
      [oldId, metadataFromClaim(oldClaim)],
    ])));
    const reconciled = await Claims.reconcileClaims(restored, async (jobId, claim) => {
      return server.tokenLookup(jobId, claim);
    });
    assert.equal(reconciled.changed, true, terminalState);
    assert.equal(reconciled.claims.size, 0, terminalState);

    const nextId = `${terminalState}-next-job`;
    server.enqueue(nextId, 21, 'fixture.example', `${terminalState}-next-conversation`);
    assert.ok(server.claim(nextId, 21), `${terminalState}: tab should claim a new job`);
  }
});

test('token lookup keeps transport failures recoverable and rejects missing token fail-closed', async () => {
  const claim = { job_id: 'offline-job', conversation_id: 'c', tab_id: 4, domain: 'fixture.example' };
  await assert.rejects(
    Claims.lookupClaimToken(claim, {
      baseUrl: 'http://relay',
      fetchImpl: async () => { throw new Error('network offline'); },
    }),
    /network offline/
  );
  const unavailable = await Claims.lookupClaimToken(claim, {
    baseUrl: 'http://relay',
    fetchImpl: async () => response(409),
  });
  assert.deepEqual(unavailable, { ok: false, status: 409, claim_token: '' });
});

test('background recovery branch declares page session identity before using it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  const pageSessionDeclaration = source.indexOf("const pageSessionId = String(msg.page_session_id || '')");
  const existingClaimBranch = source.indexOf('const existingClaim = [...activeClaims.values()]');
  assert.ok(pageSessionDeclaration >= 0);
  assert.ok(existingClaimBranch >= 0);
  assert.ok(pageSessionDeclaration < existingClaimBranch, 'page session must be initialized before active-claim renewal');
  const activeClaimedTabs = source.indexOf('...activeClaims.values()');
  const pollCall = source.indexOf("fetch(`${LOCAL_API}/browser/poll`", activeClaimedTabs);
  assert.ok(activeClaimedTabs >= 0 && pollCall > activeClaimedTabs, 'restored claims must be considered before polling');
});
