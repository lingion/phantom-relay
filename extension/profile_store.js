/*
 * Phantom Relay — local profile store.
 *
 * The store is deliberately independent from Chrome except for the injected
 * storage adapter. It keeps pending and active envelopes separate so a new
 * recording cannot replace the last-known-good profile.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayProfileStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STORE_VERSION = 1;
  const ProfileLifecycle = root?.PhantomRelayProfileLifecycle;
  const ProfileContract = root?.PhantomRelayProfile;

  class ProfileStoreError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'ProfileStoreError';
      this.code = code;
      this.details = details;
    }
  }

  function fail(code, message, details) {
    throw new ProfileStoreError(code, message, details);
  }

  function requireLifecycle() {
    if (!ProfileLifecycle) fail('profile_lifecycle_unavailable', 'profile lifecycle module is not loaded');
    return ProfileLifecycle;
  }

  function requireContract() {
    if (!ProfileContract) fail('profile_contract_unavailable', 'profile contract module is not loaded');
    return ProfileContract;
  }

  function clone(value) {
    if (value == null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function emptyStore() {
    return { version: STORE_VERSION, profiles: {}, diagnostics: [], legacyHints: [] };
  }

  function storageCall(storage, method, args) {
    if (!storage || typeof storage[method] !== 'function') {
      return Promise.reject(new ProfileStoreError('storage_unavailable', `storage.${method} is unavailable`));
    }
    const fn = storage[method];
    if (fn.length >= args.length + 1) {
      return new Promise((resolve, reject) => {
        try {
          fn.call(storage, ...args, result => {
            const runtimeError = root?.chrome?.runtime?.lastError;
            if (runtimeError) reject(new ProfileStoreError('storage_failed', runtimeError.message));
            else resolve(result);
          });
        } catch (error) {
          reject(error);
        }
      });
    }
    try {
      return Promise.resolve(fn.call(storage, ...args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function diagnostic(profileId, slot, raw, error) {
    return {
      profile_id: profileId,
      slot,
      code: error?.code || 'profile_envelope_invalid',
      message: error?.message || String(error),
      raw: clone(raw)
    };
  }

  async function normalizeSlot(profileId, slot, raw, diagnostics) {
    if (raw == null) return null;
    try {
      const lifecycle = requireLifecycle();
      const envelope = lifecycle.normalizeProfileEnvelope(raw);
      if (envelope.profile.profileId !== profileId) {
        fail('profile_id_mismatch', 'stored profile key does not match envelope profileId', { profileId });
      }
      if (!(await lifecycle.verifyProfileChecksum(envelope))) {
        fail('profile_checksum_mismatch', 'stored profile checksum does not match profile content', { profileId, slot });
      }
      return envelope;
    } catch (error) {
      diagnostics.push(diagnostic(profileId, slot, raw, error));
      return null;
    }
  }

  async function loadProfileStore(storage) {
    const data = await storageCall(storage, 'get', [['phantomProfiles']]);
    const rawStore = data?.phantomProfiles;
    if (rawStore == null) return emptyStore();
    if (!rawStore || typeof rawStore !== 'object' || Array.isArray(rawStore)) {
      return {
        ...emptyStore(),
        diagnostics: [{ slot: 'store', code: 'profile_store_invalid', message: 'phantomProfiles must be an object', raw: clone(rawStore) }]
      };
    }
    const store = emptyStore();
    const sourceProfiles = rawStore.profiles && typeof rawStore.profiles === 'object' ? rawStore.profiles : {};
    for (const [profileId, rawEntry] of Object.entries(sourceProfiles)) {
      const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
      const normalized = {
        active: await normalizeSlot(profileId, 'active', entry.active, store.diagnostics),
        pending: await normalizeSlot(profileId, 'pending', entry.pending, store.diagnostics),
        lastError: entry.lastError ? clone(entry.lastError) : null
      };
      if (normalized.active || normalized.pending || normalized.lastError) store.profiles[profileId] = normalized;
    }
    if (Array.isArray(rawStore.legacyHints)) store.legacyHints = clone(rawStore.legacyHints);
    return store;
  }

  function getActiveProfile(store, profileId) {
    return store?.profiles?.[profileId]?.active || null;
  }

  function entryFor(store, profileId) {
    if (!store || typeof store !== 'object') fail('profile_store_invalid', 'profile store must be an object');
    const next = clone(store);
    next.version = STORE_VERSION;
    next.profiles = next.profiles && typeof next.profiles === 'object' ? next.profiles : {};
    next.diagnostics = Array.isArray(next.diagnostics) ? next.diagnostics : [];
    next.legacyHints = Array.isArray(next.legacyHints) ? next.legacyHints : [];
    if (!next.profiles[profileId]) next.profiles[profileId] = { active: null, pending: null, lastError: null };
    return next;
  }

  async function stageProfile(store, profile) {
    const lifecycle = requireLifecycle();
    const normalized = requireContract().normalizeProfile(profile);
    const profileId = normalized.profileId;
    const next = entryFor(store, profileId);
    const previous = next.profiles[profileId].active;
    const recorded = await lifecycle.createProfileEnvelope(normalized, previous || undefined);
    next.profiles[profileId].pending = lifecycle.transitionProfileEnvelope(recorded, 'sync_requested');
    next.profiles[profileId].lastError = null;
    return next;
  }

  async function promoteProfile(store, profileId, syncAck) {
    const lifecycle = requireLifecycle();
    const next = entryFor(store, profileId);
    const entry = next.profiles[profileId];
    const pending = entry.pending;
    if (!pending) fail('profile_pending_missing', 'cannot promote a profile without pending data', { profileId });
    if (!syncAck || syncAck.ok !== true) fail('profile_sync_not_accepted', 'backend did not accept the pending profile', { profileId });
    if (Number(syncAck.revision) !== pending.lifecycle.revision || String(syncAck.checksum) !== pending.lifecycle.checksum) {
      fail('profile_sync_ack_mismatch', 'backend acknowledgement does not match pending profile', { profileId });
    }
    if (!(await lifecycle.verifyProfileChecksum(pending))) {
      fail('profile_checksum_mismatch', 'pending profile checksum is invalid', { profileId });
    }
    entry.active = lifecycle.transitionProfileEnvelope(pending, 'sync_accepted');
    entry.pending = null;
    entry.lastError = null;
    return next;
  }

  async function recordProfileHealth(store, report) {
    const lifecycle = requireLifecycle();
    const profileId = String(report?.profile_id || '');
    const next = entryFor(store, profileId);
    const entry = next.profiles[profileId];
    if (!entry.active) fail('profile_active_missing', 'cannot record health without an active profile', { profileId });
    if (Number(report.revision) !== entry.active.lifecycle.revision) {
      fail('profile_revision_mismatch', 'health report revision does not match active profile', { profileId });
    }
    const state = String(report.state || '');
    const event = state === 'verified' ? 'health_check_passed' : state === 'invalid' ? 'contract_invalid' : 'health_check_failed';
    const updated = lifecycle.transitionProfileEnvelope(entry.active, event);
    updated.health = clone(report);
    entry.active = updated;
    return next;
  }

  async function recordProfileError(store, profileId, error) {
    const next = entryFor(store, profileId);
    next.profiles[profileId].lastError = clone(error || { code: 'profile_unknown_error' });
    return next;
  }

  function migrateLegacySelectors(raw) {
    const executable = [];
    const hints = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { executable, hints };
    const contract = requireContract();
    for (const [domain, selectors] of Object.entries(raw)) {
      const profile = selectors?.profile;
      if (!profile || typeof profile !== 'object') {
        hints.push({ domain, reason: 'response_identity_missing' });
        continue;
      }
      try {
        executable.push({ domain, profile: contract.normalizeProfile(profile) });
      } catch (error) {
        hints.push({ domain, reason: error.code === 'response_contract_missing' ? 'response_identity_missing' : error.code || 'profile_invalid' });
      }
    }
    return { executable, hints };
  }

  async function saveProfileStore(storage, store) {
    await storageCall(storage, 'set', [{ phantomProfiles: clone(store) }]);
  }

  return {
    ProfileStoreError,
    STORE_VERSION,
    loadProfileStore,
    getActiveProfile,
    stageProfile,
    promoteProfile,
    recordProfileHealth,
    recordProfileError,
    migrateLegacySelectors,
    saveProfileStore
  };
});
