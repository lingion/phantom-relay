/* Provider-neutral generation ownership for the page capture lock. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayCaptureLock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CAPTURE_LOCK_ATTRIBUTE = 'data-phantom-relay-capture-lock';

  function lockNeedsClear(lockOwner, currentGeneration) {
    if (lockOwner == null || String(lockOwner).trim() === '') return false;
    return String(lockOwner) !== String(currentGeneration);
  }

  return { CAPTURE_LOCK_ATTRIBUTE, lockNeedsClear };
});
