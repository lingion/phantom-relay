/*
 * Phantom Relay — provider-neutral profile lifecycle contract.
 *
 * This module owns profile envelope integrity and state transitions only. It
 * does not access Chrome APIs, the network, page DOM, or authentication data.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayProfileLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const PROFILE_SCHEMA_VERSION = 2;
  const PROFILE_STATES = Object.freeze([
    'draft', 'recorded', 'sync_pending', 'synced', 'verified', 'degraded', 'invalid', 'archived'
  ]);
  const PROFILE_HEALTH_REASONS = Object.freeze({
    INPUT_UNAVAILABLE: 'profile_input_unavailable',
    SEND_UNAVAILABLE: 'profile_send_unavailable',
    RESPONSE_UNAVAILABLE: 'profile_response_unavailable',
    IDENTITY_UNAVAILABLE: 'profile_identity_unavailable',
    STREAMING_UNAVAILABLE: 'profile_streaming_unavailable'
  });
  const HEALTH_FIELDS = Object.freeze(['input', 'send', 'response', 'identity', 'streaming']);

  class ProfileLifecycleError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'ProfileLifecycleError';
      this.code = code;
      this.details = details;
    }
  }

  function fail(code, message, details) {
    throw new ProfileLifecycleError(code, message, details);
  }

  function clone(value) {
    if (value == null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = canonicalValue(value[key]);
    }
    return output;
  }

  function canonicalizeProfile(value) {
    const serialized = JSON.stringify(canonicalValue(value));
    return serialized === undefined ? 'null' : serialized;
  }

  function profileContract() {
    const contract = root?.PhantomRelayProfile;
    if (!contract || typeof contract.normalizeProfile !== 'function') {
      fail('profile_contract_unavailable', 'PhantomRelayProfile contract is not loaded');
    }
    return contract;
  }

  function profileChecksumInput(profile) {
    const normalized = profileContract().normalizeProfile(profile);
    const checksumProfile = clone(normalized);
    delete checksumProfile.lifecycle;
    delete checksumProfile.health;
    delete checksumProfile.__normalizedProfile;
    return canonicalizeProfile(checksumProfile);
  }

  async function computeProfileChecksum(profile) {
    const cryptoApi = root?.crypto || globalThis.crypto;
    const subtle = cryptoApi?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
      fail('crypto_unavailable', 'Web Crypto SHA-256 is unavailable');
    }
    const bytes = new TextEncoder().encode(profileChecksumInput(profile));
    const digest = await subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
  }

  function validChecksum(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
  }

  function validIso(value, field, nullable = false) {
    if (nullable && value == null) return null;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      fail('profile_lifecycle_invalid', `${field} must be an ISO timestamp`, { field });
    }
    return value;
  }

  function normalizeHealth(health) {
    if (health == null) return null;
    if (!health || typeof health !== 'object' || Array.isArray(health)) {
      fail('profile_health_invalid', 'health must be an object or null');
    }
    const checks = {};
    for (const field of HEALTH_FIELDS) {
      if (health.checks?.[field] !== undefined) checks[field] = String(health.checks[field]);
    }
    const reasonCodes = Array.isArray(health.reason_codes)
      ? [...new Set(health.reason_codes.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
      : [];
    return {
      profile_id: String(health.profile_id || ''),
      revision: Number(health.revision),
      state: String(health.state || 'degraded'),
      checks,
      reason_codes: reasonCodes
    };
  }

  function normalizeProfileEnvelope(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('profile_envelope_invalid', 'profile envelope must be an object');
    }
    if (!raw.profile || typeof raw.profile !== 'object' || Array.isArray(raw.profile)) {
      fail('profile_envelope_invalid', 'profile envelope.profile is required');
    }
    const profile = profileContract().normalizeProfile(raw.profile);
    const lifecycle = raw.lifecycle || {};
    const schemaVersion = Number(lifecycle.schemaVersion);
    if (schemaVersion !== PROFILE_SCHEMA_VERSION) {
      fail('profile_schema_unsupported', 'unsupported profile lifecycle schema', { schemaVersion });
    }
    const revision = Number(lifecycle.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      fail('profile_revision_invalid', 'profile revision must be a positive integer', { revision });
    }
    if (!validChecksum(lifecycle.checksum)) {
      fail('profile_checksum_invalid', 'profile checksum must be sha256:<64 lowercase hex>', { field: 'lifecycle.checksum' });
    }
    if (!PROFILE_STATES.includes(lifecycle.state)) {
      fail('profile_state_invalid', 'profile state is unsupported', { state: lifecycle.state });
    }
    const source = typeof lifecycle.source === 'string' && lifecycle.source.trim()
      ? lifecycle.source.trim()
      : 'user-recorded';
    return {
      profile,
      lifecycle: {
        schemaVersion,
        revision,
        checksum: lifecycle.checksum,
        createdAt: validIso(lifecycle.createdAt, 'lifecycle.createdAt'),
        updatedAt: validIso(lifecycle.updatedAt, 'lifecycle.updatedAt'),
        lastVerifiedAt: validIso(lifecycle.lastVerifiedAt, 'lifecycle.lastVerifiedAt', true),
        source,
        state: lifecycle.state
      },
      health: normalizeHealth(raw.health)
    };
  }

  async function verifyProfileChecksum(envelope) {
    const normalized = normalizeProfileEnvelope(envelope);
    const expected = await computeProfileChecksum(normalized.profile);
    return expected === normalized.lifecycle.checksum;
  }

  async function createProfileEnvelope(profile, previous) {
    const normalized = profileContract().normalizeProfile(profile);
    const revision = previous?.lifecycle?.revision ? Number(previous.lifecycle.revision) + 1 : 1;
    if (!Number.isInteger(revision) || revision < 1) {
      fail('profile_revision_invalid', 'previous profile revision is invalid');
    }
    const now = new Date().toISOString();
    return {
      profile: normalized,
      lifecycle: {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        revision,
        checksum: await computeProfileChecksum(normalized),
        createdAt: previous?.lifecycle?.createdAt || now,
        updatedAt: now,
        lastVerifiedAt: null,
        source: String(profile.source || previous?.lifecycle?.source || 'user-recorded'),
        state: 'recorded'
      },
      health: null
    };
  }

  const TRANSITIONS = Object.freeze({
    draft: { local_validate: 'recorded', archived: 'archived' },
    recorded: { sync_requested: 'sync_pending', sync_failed: 'recorded', archived: 'archived' },
    sync_pending: { sync_failed: 'recorded', sync_accepted: 'synced', archived: 'archived' },
    synced: { health_check_passed: 'verified', health_check_failed: 'degraded', contract_invalid: 'invalid', archived: 'archived' },
    verified: { health_check_failed: 'degraded', contract_invalid: 'invalid', archived: 'archived' },
    degraded: { health_check_passed: 'verified', contract_invalid: 'invalid', archived: 'archived' },
    invalid: { local_validate: 'recorded', archived: 'archived' },
    archived: {}
  });

  function transitionProfileEnvelope(envelope, event) {
    const current = normalizeProfileEnvelope(envelope);
    const nextState = TRANSITIONS[current.lifecycle.state]?.[event];
    if (!nextState) {
      fail('profile_transition_invalid', `event ${event} is not valid from ${current.lifecycle.state}`, {
        state: current.lifecycle.state,
        event
      });
    }
    const now = new Date().toISOString();
    const next = clone(current);
    next.lifecycle.updatedAt = now;
    next.lifecycle.state = nextState;
    if (event === 'health_check_passed') next.lifecycle.lastVerifiedAt = now;
    return next;
  }

  function createHealthReport(profileId, revision, checks, reasonCodes = []) {
    const normalizedChecks = {};
    for (const field of HEALTH_FIELDS) normalizedChecks[field] = String(checks?.[field] || 'fail');
    const reasons = [...new Set((Array.isArray(reasonCodes) ? reasonCodes : [])
      .filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))];
    const state = HEALTH_FIELDS.every(field => normalizedChecks[field] === 'pass') ? 'verified' : 'degraded';
    return {
      profile_id: String(profileId),
      revision: Number(revision),
      state,
      checks: normalizedChecks,
      reason_codes: reasons
    };
  }

  return {
    ProfileLifecycleError,
    PROFILE_SCHEMA_VERSION,
    PROFILE_STATES,
    PROFILE_HEALTH_REASONS,
    canonicalizeProfile,
    profileChecksumInput,
    computeProfileChecksum,
    normalizeProfileEnvelope,
    verifyProfileChecksum,
    createProfileEnvelope,
    transitionProfileEnvelope,
    createHealthReport
  };
});
