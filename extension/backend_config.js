/* Shared backend endpoint contract for the service worker and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayBackendConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_BACKEND_URL = 'http://localhost:8765';

  function normalizeBackendUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('backend_url_empty');

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      throw new Error('backend_url_invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('backend_url_scheme');
    if (!parsed.hostname) throw new Error('backend_url_host');
    if (parsed.username || parsed.password) throw new Error('backend_url_credentials');
    if (parsed.search) throw new Error('backend_url_query');
    if (parsed.hash) throw new Error('backend_url_fragment');

    return parsed.toString().replace(/\/+$/, '');
  }

  function backendUrlOrDefault(value) {
    try {
      return normalizeBackendUrl(value);
    } catch (_) {
      return DEFAULT_BACKEND_URL;
    }
  }

  return { DEFAULT_BACKEND_URL, normalizeBackendUrl, backendUrlOrDefault };
});
