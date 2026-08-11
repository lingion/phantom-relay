/*
 * Phantom Relay — service-worker claim recovery contract.
 *
 * The in-memory claim may contain the short-lived result claim token, but the
 * session-storage representation intentionally excludes it. A worker that is
 * recreated asks the backend for the current token through result-token.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayClaimRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLAIM_SCHEMA_VERSION = 1;

  function normalizeClaim(jobId, raw, options = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = String(jobId || raw.job_id || '').trim();
    const domain = String(raw.domain || '').trim().toLowerCase();
    const tabId = Number(raw.tab_id);
    if (!id || !domain || !Number.isInteger(tabId) || tabId < 0) return null;
    const claimedAt = Number(raw.claimed_at || 0);
    const claim = {
      job_id: id,
      conversation_id: String(raw.conversation_id || ''),
      tab_id: tabId,
      domain,
      claimed_at: Number.isFinite(claimedAt) && claimedAt > 0 ? claimedAt : Date.now()
    };
    if (options.includeToken !== false && typeof raw.claim_token === 'string' && raw.claim_token.trim()) {
      claim.claim_token = raw.claim_token.trim();
    }
    return claim;
  }

  function entriesOf(source) {
    if (source instanceof Map) return [...source.entries()];
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    return Object.entries(source);
  }

  function serializeClaims(source) {
    const claims = {};
    for (const [jobId, raw] of entriesOf(source)) {
      const claim = normalizeClaim(jobId, raw, { includeToken: false });
      if (!claim) continue;
      claims[claim.job_id] = claim;
    }
    return { version: CLAIM_SCHEMA_VERSION, claims };
  }

  function deserializeClaims(raw) {
    const restored = new Map();
    if (!raw || typeof raw !== 'object' || raw.version !== CLAIM_SCHEMA_VERSION) return restored;
    const claims = raw.claims;
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return restored;
    for (const [jobId, value] of Object.entries(claims)) {
      const claim = normalizeClaim(jobId, value, { includeToken: false });
      if (claim) restored.set(claim.job_id, claim);
    }
    return restored;
  }

  function claimMatchesTab(claim, tabId, domain = '') {
    if (!claim) return false;
    return Number(claim.tab_id) === Number(tabId) &&
      (!domain || String(claim.domain || '').toLowerCase() === String(domain).trim().toLowerCase());
  }

  function shouldRemoveAfterBackendResponse(status) {
    return [404, 409].includes(Number(status));
  }

  function shouldRemoveAfterTokenLookup(status) {
    return shouldRemoveAfterBackendResponse(status);
  }

  function tokenLookupUrl(baseUrl, claim, clientId = '') {
    const root = String(baseUrl || '').replace(/\/+$/, '');
    const params = new URLSearchParams({
      job_id: String(claim?.job_id || ''),
      tab_id: String(claim?.tab_id ?? ''),
      domain: String(claim?.domain || ''),
      conversation_id: String(claim?.conversation_id || ''),
      client_id: String(clientId || ''),
    });
    return `${root}/browser/result-token?${params.toString()}`;
  }

  async function lookupClaimToken(claim, options = {}) {
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchImpl !== 'function') throw new Error('claim_token_lookup_fetch_unavailable');
    const response = await fetchImpl(tokenLookupUrl(options.baseUrl, claim, options.clientId));
    const status = Number(response?.status || 0);
    if (!response?.ok) return { ok: false, status, claim_token: '' };
    const body = typeof response.json === 'function' ? await response.json() : null;
    const token = typeof body?.claim_token === 'string' ? body.claim_token.trim() : '';
    return token ? { ok: true, status, claim_token: token } : { ok: false, status, claim_token: '' };
  }

  async function reconcileClaims(source, lookup) {
    const claims = new Map(entriesOf(source).map(([jobId, raw]) => {
      const claim = normalizeClaim(jobId, raw);
      return claim ? [claim.job_id, claim] : null;
    }).filter(Boolean));
    let changed = false;
    const removedClaims = [];
    for (const [jobId, claim] of [...claims.entries()]) {
      let result;
      try {
        result = await lookup(jobId, claim);
      } catch (_) {
        // A transport failure is not proof that the server claim ended.
        continue;
      }
      if (result?.ok || !shouldRemoveAfterTokenLookup(result?.status)) continue;
      claims.delete(jobId);
      removedClaims.push({ job_id: jobId, claim });
      changed = true;
    }
    return { claims, changed, removedClaims };
  }

  return {
    CLAIM_SCHEMA_VERSION,
    normalizeClaim,
    serializeClaims,
    deserializeClaims,
    claimMatchesTab,
    shouldRemoveAfterBackendResponse,
    shouldRemoveAfterTokenLookup,
    tokenLookupUrl,
    lookupClaimToken,
    reconcileClaims
  };
});
