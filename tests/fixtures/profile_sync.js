const fakeStore = {
  version: 1,
  profiles: {
    'fixture-profile': {
      active: {
        profile: { profileId: 'fixture-profile', origin: 'https://fixture.example', domain: 'fixture.example' },
        lifecycle: { revision: 1, checksum: 'sha256:' + '1'.repeat(64), state: 'verified' },
        health: null
      },
      pending: {
        profile: { profileId: 'fixture-profile', origin: 'https://fixture.example', domain: 'fixture.example' },
        lifecycle: { revision: 2, checksum: 'sha256:' + '2'.repeat(64), state: 'sync_pending' },
        health: null
      },
      lastError: null
    }
  },
  diagnostics: [],
  legacyHints: []
};

const fetchMock = {
  failures: [],
  requests: [],
  rejectOnce(error) { this.failures.push(error); },
  reset() { this.failures.length = 0; this.requests.length = 0; },
  async request(url, options) {
    this.requests.push({ url, options });
    if (this.failures.length) throw this.failures.shift();
    const body = JSON.parse(options?.body || '{}');
    return { ok: true, status: 200, async json() {
      return { ok: true, profile_id: body.profile?.profileId, revision: body.revision, checksum: body.checksum, state: 'synced' };
    } };
  }
};

function resetFakeStore() {
  const entry = fakeStore.profiles['fixture-profile'];
  if (entry.active?.lifecycle) entry.active.lifecycle.state = 'verified';
  if (entry.pending?.lifecycle) entry.pending.lifecycle.state = 'sync_pending';
  entry.lastError = null;
  fetchMock.reset();
}

function runProfileHealthCheck() {
  return {
    state: 'verified',
    checks: { input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass' },
    reason_codes: []
  };
}

module.exports = { fakeStore, fetchMock, resetFakeStore, runProfileHealthCheck };
