/* Startup storage reads for the MV3 execution worker. */
(function attachStartupStorage(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayStartupStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const CRITICAL_KEYS = Object.freeze([
    'phantomBackendUrl',
    'phantomBrowserClientId',
    'phantomSelectors',
    'phantomDomainState',
    'phantomModelRoutes',
    'phantomProfiles',
  ]);
  const OPTIONAL_KEYS = Object.freeze([
    'phantomConversations',
    'phantomDebugLogs',
  ]);

  function read(storage, keys, timeoutMs = 10000) {
    if (!storage || typeof storage.get !== 'function') {
      return Promise.reject(new Error('storage_unavailable'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        const error = Object.assign(new Error('startup storage read timed out'), {
          code: 'startup_storage_timeout',
          keys: [...keys],
        });
        finish(null, error);
      }, Math.max(1, Number(timeoutMs) || 10000));
      const finish = (value, error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value && typeof value === 'object' ? value : {});
      };
      const callback = value => {
        const runtimeError = root?.chrome?.runtime?.lastError;
        if (runtimeError) finish(null, new Error(runtimeError.message || 'storage_read_failed'));
        else finish(value);
      };
      try {
        const pending = storage.get(keys, callback);
        if (pending && typeof pending.then === 'function') {
          pending.then(value => finish(value), error => finish(null, error));
        }
      } catch (error) {
        finish(null, error);
      }
    });
  }

  function loadCritical(storage) {
    return read(storage, [...CRITICAL_KEYS]);
  }

  function loadOptional(storage) {
    return read(storage, [...OPTIONAL_KEYS]);
  }

  return { CRITICAL_KEYS, OPTIONAL_KEYS, read, loadCritical, loadOptional };
});
