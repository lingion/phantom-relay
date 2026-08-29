/*
 * Provider-neutral reconciliation for selector bundles crossing the
 * background/server boundary.
 *
 * A legacy selector store may contain a concrete top-level send control while
 * the embedded profile still declares the older Enter action. That is not a
 * usable profile contract: the page must receive one send meaning everywhere.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelaySelectorReconciliation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function normalizeSelector(value) {
    if (typeof value === 'string' && value.trim()) {
      return { selector: value.trim(), alternatives: [] };
    }
    if (!value || typeof value !== 'object') return null;
    const nested = value.selector && typeof value.selector === 'object' ? value.selector : null;
    if (nested?.css) {
      return {
        selector: String(nested.css),
        alternatives: [...(value.alternatives || []), ...(nested.alternatives || [])].map(String),
      };
    }
    const selector = typeof value.selector === 'string' ? value.selector : value.css;
    if (!selector || typeof selector !== 'string' || !selector.trim()) return null;
    return {
      selector: selector.trim(),
      alternatives: Array.isArray(value.alternatives) ? value.alternatives.map(String) : [],
    };
  }

  function normalizeSendStrategy(value) {
    if (!value) return null;
    const kind = String(value.kind || '').trim().toLowerCase();
    if (kind === 'enter' || kind === 'shortcut') {
      return {
        kind,
        key: String(value.key || 'Enter'),
        modifiers: Array.isArray(value.modifiers) ? value.modifiers.map(String).filter(Boolean) : [],
      };
    }
    const selector = normalizeSelector(kind === 'button' ? value.selector : value);
    if (!selector?.selector) return null;
    return {
      kind: 'button',
      selector: { css: selector.selector, alternatives: selector.alternatives.slice() },
    };
  }

  function fingerprint(value) {
    const strategy = normalizeSendStrategy(value);
    if (!strategy) return '';
    if (strategy.kind === 'button') {
      return JSON.stringify({
        kind: 'button',
        css: strategy.selector?.css || '',
        alternatives: strategy.selector?.alternatives || [],
      });
    }
    return JSON.stringify({
      kind: strategy.kind,
      key: strategy.key || 'Enter',
      modifiers: strategy.modifiers || [],
    });
  }

  function selectorFingerprint(value) {
    const selector = normalizeSelector(value);
    if (!selector) return '';
    return JSON.stringify({
      selector: selector.selector,
      alternatives: selector.alternatives || [],
    });
  }

  function reconcileProfileSelectors(profile, send, response, profileContract = root?.PhantomRelayProfile) {
    if (!profile || !profileContract?.normalizeProfile || !profileContract?.withSendStrategy || !profileContract?.withResponseSelector) {
      throw new Error('profile_reconciliation_contract_unavailable');
    }
    let normalizedProfile = profileContract.normalizeProfile(profile);
    const normalizedSend = normalizeSendStrategy(send);
    if (!normalizedSend) throw new Error('send_strategy_invalid');
    const normalizedResponse = response == null ? null : normalizeSelector(response);
    if (response != null && !normalizedResponse) throw new Error('response_selector_invalid');
    let changedSend = fingerprint(normalizedProfile.send) !== fingerprint(normalizedSend);
    let changedResponse = normalizedResponse != null &&
      selectorFingerprint(normalizedProfile.response?.selector) !== selectorFingerprint(normalizedResponse);
    if (changedSend) normalizedProfile = profileContract.withSendStrategy(normalizedProfile, normalizedSend);
    if (changedResponse) normalizedProfile = profileContract.withResponseSelector(normalizedProfile, normalizedResponse);
    return {
      changed: changedSend || changedResponse,
      changedSend,
      changedResponse,
      send: normalizedSend,
      response: normalizedResponse,
      profile: normalizedProfile,
    };
  }

  function reconcileProfileSendStrategy(profile, send, profileContract = root?.PhantomRelayProfile) {
    const result = reconcileProfileSelectors(profile, send, null, profileContract);
    return {
      changed: result.changedSend,
      send: result.send,
      profile: result.profile,
    };
  }

  function reconcileProfileInputSelector(profile, input, profileContract = root?.PhantomRelayProfile) {
    if (!profile || !profileContract?.normalizeProfile || !profileContract?.withInputSelector) {
      throw new Error('profile_reconciliation_contract_unavailable');
    }
    const normalizedProfile = profileContract.normalizeProfile(profile);
    const normalizedInput = normalizeSelector(input);
    if (!normalizedInput) throw new Error('input_selector_invalid');
    const changed = selectorFingerprint(normalizedProfile.input?.selector) !== selectorFingerprint(normalizedInput);
    return {
      changed,
      input: normalizedInput,
      profile: changed ? profileContract.withInputSelector(normalizedProfile, normalizedInput) : normalizedProfile,
    };
  }

  function mergeReconciledSelectorBundle(incoming, result, profile) {
    const bundle = {
      ...(incoming || {}),
      send: result?.send || incoming?.send || null,
      profile: profile || result?.profile || incoming?.profile || null,
    };
    if (result?.response != null) bundle.response = result.response;
    return bundle;
  }

  function projectProfileSelectorBundle(incoming, profileContract = root?.PhantomRelayProfile) {
    const profile = incoming?.profile;
    if (!profile || typeof profileContract?.normalizeProfile !== 'function') {
      throw new Error('profile_projection_contract_unavailable');
    }
    const normalizedProfile = profileContract.normalizeProfile(profile);
    const response = normalizedProfile.response || {};
    return {
      ...(incoming || {}),
      input: normalizedProfile.input,
      send: normalizedProfile.send,
      response: response.selector || response.containerSelector || null,
      profile: normalizedProfile,
    };
  }

  return {
    normalizeSelector,
    normalizeSendStrategy,
    fingerprint,
    selectorFingerprint,
    reconcileProfileSelectors,
    reconcileProfileSendStrategy,
    reconcileProfileInputSelector,
    mergeReconciledSelectorBundle,
    projectProfileSelectorBundle,
  };
});
