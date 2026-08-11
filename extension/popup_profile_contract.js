'use strict';

// Popup-only contract merging. Provider behavior stays in the recorded profile;
// this helper only prevents a network calibration result from erasing a DOM
// fallback that the background worker deliberately preserved.
(function attachPopupProfileContract(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayPopupProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function hasStableDomResponse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const selector = value.selector?.css || value.selector || value.css || value.containerSelector;
    const identity = value.identity;
    const attributes = Array.isArray(identity?.attributes)
      ? identity.attributes.filter(item => typeof item === 'string' && item.trim())
      : [];
    const path = typeof identity?.path === 'string' ? identity.path.trim() : '';
    return !!String(selector || '').trim() && (attributes.length > 0 || !!path);
  }

  function mergeCalibrationResponse(previousResponse, profile) {
    const mode = String(profile?.capture?.mode || '').trim().toLowerCase();
    if (mode === 'hybrid' && hasStableDomResponse(profile.response)) return profile.response;
    // The popup also carries the legacy selector-only view used to render the
    // re-record action. Network-only mode never executes this value as a DOM
    // fallback, so preserving it here does not weaken the runtime contract.
    return previousResponse && typeof previousResponse === 'object' ? previousResponse : null;
  }

  return { hasStableDomResponse, mergeCalibrationResponse };
});
