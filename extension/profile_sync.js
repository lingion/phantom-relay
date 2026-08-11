/* Provider-neutral profile sync and health transport. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayProfileSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const Store = root?.PhantomRelayProfileStore;

  class ProfileSyncError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'ProfileSyncError';
      this.code = code;
      this.details = details;
    }
  }

  function fail(code, message, details) {
    throw new ProfileSyncError(code, message, details);
  }

  function buildProfileUpsertPayload(clientId, envelope) {
    if (!envelope?.profile || !envelope.lifecycle) fail('profile_pending_invalid', 'pending profile envelope is incomplete');
    return {
      client_id: String(clientId || ''),
      profile: envelope.profile,
      revision: envelope.lifecycle.revision,
      checksum: envelope.lifecycle.checksum
    };
  }

  function buildProfileHealthPayload(profileId, revision, report) {
    const checks = {};
    for (const field of ['input', 'send', 'response', 'identity', 'streaming']) {
      checks[field] = String(report?.checks?.[field] || 'fail');
    }
    return {
      profile_id: String(profileId),
      revision: Number(revision),
      state: String(report?.state || 'degraded'),
      checks,
      reason_codes: Array.isArray(report?.reason_codes)
        ? [...new Set(report.reason_codes.filter(code => typeof code === 'string' && code.trim()).map(code => code.trim()))]
        : []
    };
  }

  async function responseJson(response) {
    try { return await response.json(); } catch (_) { return {}; }
  }

  async function syncPendingProfile(profileId, dependencies = {}) {
    if (!Store) fail('profile_store_unavailable', 'profile store module is not loaded');
    const store = dependencies.store;
    const entry = store?.profiles?.[profileId];
    const pending = entry?.pending;
    if (!pending) fail('profile_pending_missing', 'no pending profile is available', { profileId });
    const fetchImpl = dependencies.fetchImpl || root?.fetch;
    if (typeof fetchImpl !== 'function') fail('fetch_unavailable', 'profile sync fetch is unavailable');
    const baseUrl = String(dependencies.baseUrl || '').replace(/\/$/, '');
    const response = await fetchImpl(`${baseUrl}/browser/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildProfileUpsertPayload(dependencies.clientId, pending))
    }).catch(async error => {
      const next = await Store.recordProfileError(store, profileId, {
        code: 'profile_sync_failed', message: error?.message || String(error), recoverable: true
      });
      dependencies.setStore?.(next);
      throw Object.assign(new ProfileSyncError('profile_sync_failed', error?.message || String(error), { recoverable: true }), { store: next });
    });
    const payload = await responseJson(response);
    if (response.status === 409) {
      const next = await Store.recordProfileError(store, profileId, {
        code: payload?.error?.code || 'profile_conflict', message: payload?.error?.message || 'profile conflict', recoverable: false
      });
      dependencies.setStore?.(next);
      return { state: 'conflict', error: next.profiles[profileId].lastError, store: next };
    }
    if (!response.ok) {
      const next = await Store.recordProfileError(store, profileId, {
        code: 'profile_sync_failed', message: payload?.error?.message || `profile sync failed: ${response.status}`, recoverable: true
      });
      dependencies.setStore?.(next);
      throw Object.assign(new ProfileSyncError('profile_sync_failed', next.profiles[profileId].lastError.message, { recoverable: true }), { store: next });
    }
    const next = await Store.promoteProfile(store, profileId, {
      ok: true,
      revision: payload.revision,
      checksum: payload.checksum,
      state: payload.state
    });
    dependencies.setStore?.(next);
    return { state: 'synced', store: next, profile_id: profileId, revision: payload.revision, checksum: payload.checksum };
  }

  return { ProfileSyncError, buildProfileUpsertPayload, buildProfileHealthPayload, syncPendingProfile };
});
