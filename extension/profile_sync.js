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

  function pendingEnvelopeMatches(current, submitted) {
    return String(current?.profile?.profileId || '') === String(submitted?.profile?.profileId || '')
      && Number(current?.lifecycle?.revision || 0) === Number(submitted?.lifecycle?.revision || 0)
      && String(current?.lifecycle?.checksum || '') === String(submitted?.lifecycle?.checksum || '');
  }

  function currentStoreFor(dependencies, fallback) {
    return typeof dependencies.getStore === 'function' ? dependencies.getStore() : fallback;
  }

  function supersededResult(store, profileId, submitted) {
    return {
      state: 'superseded',
      store,
      profile_id: profileId,
      revision: Number(submitted?.lifecycle?.revision || 0),
      checksum: String(submitted?.lifecycle?.checksum || ''),
    };
  }

  async function rebaseConflictingPendingProfile(profileId, submitted, dependencies, fetchImpl, baseUrl, conflict) {
    const conflictCode = String(conflict?.error?.code || 'profile_conflict');
    if (!['profile_conflict', 'profile_revision_conflict'].includes(conflictCode)
      || dependencies.allowConflictRebase === false) {
      return null;
    }

    let currentStore = currentStoreFor(dependencies, dependencies.store);
    let currentPending = currentStore?.profiles?.[profileId]?.pending;
    if (!pendingEnvelopeMatches(currentPending, submitted)) {
      return supersededResult(currentStore, profileId, submitted);
    }

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/browser/profiles/${encodeURIComponent(profileId)}`, {
        method: 'GET',
      });
    } catch (error) {
      const next = await Store.recordProfileError(currentStore, profileId, {
        code: 'profile_conflict_rebase_failed',
        message: error?.message || String(error),
        recoverable: true,
      });
      dependencies.setStore?.(next);
      return { state: 'conflict', error: next.profiles[profileId].lastError, store: next };
    }

    const payload = await responseJson(response);
    const validateRemote = dependencies.validateRemoteProfile
      || root?.PhantomRelayProfileRecovery?.validateRemoteProfileReplica;
    let remote;
    try {
      if (!response.ok || typeof validateRemote !== 'function') {
        throw new ProfileSyncError(
          'profile_conflict_rebase_failed',
          payload?.error?.message || `profile lookup failed: ${response.status}`,
          { recoverable: response.status >= 500 },
        );
      }
      remote = await validateRemote(payload, profileId, currentPending.profile.domain);
    } catch (error) {
      const recoverable = error?.details?.recoverable === true;
      const next = await Store.recordProfileError(currentStore, profileId, {
        code: error?.code || 'profile_conflict_rebase_failed',
        message: error?.message || String(error),
        recoverable,
      });
      dependencies.setStore?.(next);
      return { state: 'conflict', error: next.profiles[profileId].lastError, store: next };
    }

    currentStore = currentStoreFor(dependencies, currentStore);
    currentPending = currentStore?.profiles?.[profileId]?.pending;
    if (!pendingEnvelopeMatches(currentPending, submitted)) {
      return supersededResult(currentStore, profileId, submitted);
    }

    const rebased = await Store.stageProfile(currentStore, currentPending.profile, {
      remoteRevision: remote.revision,
    });
    dependencies.setStore?.(rebased);
    return syncPendingProfile(profileId, {
      ...dependencies,
      store: rebased,
      allowConflictRebase: false,
    });
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
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/browser/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildProfileUpsertPayload(dependencies.clientId, pending))
      });
    } catch (error) {
      const currentStore = currentStoreFor(dependencies, store);
      const currentPending = currentStore?.profiles?.[profileId]?.pending;
      if (!pendingEnvelopeMatches(currentPending, pending)) {
        return supersededResult(currentStore, profileId, pending);
      }
      const next = await Store.recordProfileError(currentStore, profileId, {
        code: 'profile_sync_failed', message: error?.message || String(error), recoverable: true
      });
      dependencies.setStore?.(next);
      throw Object.assign(new ProfileSyncError('profile_sync_failed', error?.message || String(error), { recoverable: true }), { store: next });
    }
    const payload = await responseJson(response);
    if (response.status === 409) {
      const rebased = await rebaseConflictingPendingProfile(
        profileId,
        pending,
        dependencies,
        fetchImpl,
        baseUrl,
        payload,
      );
      if (rebased) return rebased;
      const currentStore = currentStoreFor(dependencies, store);
      const currentPending = currentStore?.profiles?.[profileId]?.pending;
      if (!pendingEnvelopeMatches(currentPending, pending)) {
        return supersededResult(currentStore, profileId, pending);
      }
      const next = await Store.recordProfileError(currentStore, profileId, {
        code: payload?.error?.code || 'profile_conflict', message: payload?.error?.message || 'profile conflict', recoverable: false
      });
      dependencies.setStore?.(next);
      return { state: 'conflict', error: next.profiles[profileId].lastError, store: next };
    }
    if (!response.ok) {
      const currentStore = currentStoreFor(dependencies, store);
      const currentPending = currentStore?.profiles?.[profileId]?.pending;
      if (!pendingEnvelopeMatches(currentPending, pending)) {
        return supersededResult(currentStore, profileId, pending);
      }
      const next = await Store.recordProfileError(currentStore, profileId, {
        code: 'profile_sync_failed', message: payload?.error?.message || `profile sync failed: ${response.status}`, recoverable: true
      });
      dependencies.setStore?.(next);
      throw Object.assign(new ProfileSyncError('profile_sync_failed', next.profiles[profileId].lastError.message, { recoverable: true }), { store: next });
    }
    const currentStore = currentStoreFor(dependencies, store);
    const currentPending = currentStore?.profiles?.[profileId]?.pending;
    if (!pendingEnvelopeMatches(currentPending, pending)) {
      return supersededResult(currentStore, profileId, pending);
    }
    const next = await Store.promoteProfile(currentStore, profileId, {
      ok: true,
      revision: payload.revision,
      checksum: payload.checksum,
      state: payload.state
    });
    dependencies.setStore?.(next);
    return { state: 'synced', store: next, profile_id: profileId, revision: payload.revision, checksum: payload.checksum };
  }

  return {
    ProfileSyncError,
    buildProfileUpsertPayload,
    buildProfileHealthPayload,
    pendingEnvelopeMatches,
    rebaseConflictingPendingProfile,
    syncPendingProfile,
  };
});
