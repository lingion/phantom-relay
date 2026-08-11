/*
 * Phantom Relay — provider-neutral page profile health checks.
 *
 * This module only validates the selectors and actions declared by a recorded
 * profile. It never reads node text, page storage, cookies, credentials, or
 * network data. A DOM adapter is supplied by content.js in the browser; the
 * same function can therefore be tested without a browser using the profile's
 * structural contract alone.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayProfileHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const HEALTH_FIELDS = Object.freeze(['input', 'send', 'response', 'identity', 'streaming']);
  const FALLBACK_REASONS = Object.freeze({
    INPUT_UNAVAILABLE: 'profile_input_unavailable',
    SEND_UNAVAILABLE: 'profile_send_unavailable',
    RESPONSE_UNAVAILABLE: 'profile_response_unavailable',
    RESPONSE_SCOPE_TOO_BROAD: 'profile_response_scope_too_broad',
    IDENTITY_UNAVAILABLE: 'profile_identity_unavailable',
    IDENTITY_EVIDENCE_MISSING: 'profile_identity_evidence_missing',
    STREAMING_UNAVAILABLE: 'profile_streaming_unavailable'
  });

  function reasons() {
    return root?.PhantomRelayProfileLifecycle?.PROFILE_HEALTH_REASONS || FALLBACK_REASONS;
  }

  function selectorValues(value) {
    if (typeof value === 'string') return [value].filter(Boolean);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return [value.css, value.selector, ...(Array.isArray(value.alternatives) ? value.alternatives : [])]
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => item.trim());
  }

  function hasSelector(value) {
    return selectorValues(value).length > 0;
  }

  function selectorIsValid(value, documentLike) {
    const values = selectorValues(value);
    if (!values.length) return false;
    for (const css of values) {
      try {
        if (!documentLike || typeof documentLike.querySelectorAll !== 'function') continue;
        documentLike.querySelectorAll(css);
        return true;
      } catch (_) {
        // A malformed primary selector may have valid recorded alternatives.
      }
    }
    return !documentLike;
  }

  function isVisible(element) {
    if (!element) return false;
    if (element.isConnected === false) return false;
    try {
      const rects = typeof element.getClientRects === 'function' ? element.getClientRects() : null;
      if (rects && !rects.length) return false;
      const view = element.ownerDocument?.defaultView || root;
      const style = view?.getComputedStyle?.(element);
      if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
    } catch (_) {
      return false;
    }
    return true;
  }

  function firstVisible(documentLike, selector, role) {
    if (!documentLike || typeof documentLike.querySelectorAll !== 'function') return null;
    for (const css of selectorValues(selector)) {
      let matches;
      try {
        matches = Array.from(documentLike.querySelectorAll(css));
      } catch (_) {
        continue;
      }
      const visible = matches.filter(isVisible);
      if (role === 'input') {
        const editable = visible.find(element => element.matches?.(
          'textarea,input,[contenteditable="true"],[role="textbox"]'
        ));
        if (editable) return editable;
      } else if (visible.length) {
        return visible[visible.length - 1];
      }
    }
    return null;
  }

  function visibleMatches(documentLike, selector) {
    if (!documentLike || typeof documentLike.querySelectorAll !== 'function') return [];
    const matches = [];
    for (const css of selectorValues(selector)) {
      try {
        for (const element of Array.from(documentLike.querySelectorAll(css))) {
          if (isVisible(element) && !matches.includes(element)) matches.push(element);
        }
      } catch (_) {
        // A malformed primary selector may have valid recorded alternatives.
      }
    }
    return matches;
  }

  function identityValue(element, attribute) {
    const value = element?.getAttribute?.(attribute);
    return value == null ? '' : String(value).trim();
  }

  function declaredIdentityElement(element, attributes) {
    let current = element;
    while (current) {
      if (attributes.some(attribute => identityValue(current, attribute))) return current;
      current = current.parentElement || null;
    }
    return null;
  }

  function identityValuesAreUnique(elements, attributes) {
    const usable = Array.isArray(elements) ? elements : [];
    const declared = Array.isArray(attributes) ? attributes : [];
    if (!usable.length || !declared.length) return false;
    // Match messageIdentity: each element uses its first non-empty declared
    // attribute. The resulting logical keys, rather than every optional
    // attribute independently, must be complete and unique.
    const keys = usable.map(element => {
      for (const attribute of declared) {
        const value = identityValue(element, attribute);
        if (value) return attribute + ':' + value;
      }
      return '';
    });
    return keys.every(Boolean) && new Set(keys).size === keys.length;
  }

  function identityDescendants(element, attributes) {
    if (!element || !Array.isArray(attributes) || !attributes.length ||
        typeof element.querySelectorAll !== 'function') return [];
    const descendants = [];
    for (const attribute of attributes) {
      let matches;
      try {
        matches = Array.from(element.querySelectorAll(`[${attribute}]`));
      } catch (_) {
        continue;
      }
      for (const descendant of matches) {
        if (!isVisible(descendant) || descendants.includes(descendant)) continue;
        if (attributes.some(candidate => identityValue(descendant, candidate))) {
          descendants.push(descendant);
        }
      }
    }
    return descendants;
  }

  function responseScopeTooBroad(profile, documentLike) {
    if (String(profile?.capture?.mode || '').toLowerCase() === 'network') return false;
    const attributes = Array.isArray(profile?.response?.identity?.attributes)
      ? profile.response.identity.attributes.filter(item => typeof item === 'string' && item.trim())
      : [];
    if (!attributes.length) return false;
    return visibleMatches(documentLike, profile?.response?.selector).some(element => {
      const ownsIdentity = attributes.some(attribute => identityValue(element, attribute));
      if (!ownsIdentity) return false;
      return identityDescendants(element, attributes).length > 1;
    });
  }

  function checkInput(profile, documentLike) {
    const selector = profile?.input?.selector || profile?.input;
    if (!hasSelector(selector) || !selectorIsValid(selector, documentLike)) return false;
    if (!documentLike) return true;
    return !!firstVisible(documentLike, selector, 'input');
  }

  function checkSend(profile, documentLike) {
    const send = profile?.send;
    if (!send || typeof send !== 'object') return false;
    const kind = String(send.kind || '').trim();
    if (kind === 'enter' || kind === 'shortcut') {
      return typeof send.key === 'string' && send.key.trim().length > 0 &&
        (!send.modifiers || Array.isArray(send.modifiers));
    }
    if (kind !== 'button') return false;
    const selector = send.selector;
    if (!hasSelector(selector) || !selectorIsValid(selector, documentLike)) return false;
    if (!documentLike) return true;
    // Chat UIs commonly disable the send button while the input is empty.
    // Startup readiness validates the recorded action contract; replay still
    // resolves and validates the live button after filling input.
    return true;
  }

  function checkResponse(profile, documentLike, options = {}) {
    if (String(profile?.capture?.mode || '').toLowerCase() === 'network') return true;
    const selector = profile?.response?.selector;
    if (!hasSelector(selector) || !selectorIsValid(selector, documentLike)) return false;
    if (!documentLike) return true;
    if (options.responseScopeTooBroad) return false;
    return options.allowMissingResponse ? true : !!firstVisible(documentLike, selector, 'response');
  }

  function checkIdentity(profile, documentLike, identityProbe, options = {}) {
    if (String(profile?.capture?.mode || '').toLowerCase() === 'network') return true;
    if (options.requireRecordedIdentity && profile?.response?.identityVerification?.status !== 'verified') return false;
    const identity = profile?.response?.identity;
    const attributes = Array.isArray(identity?.attributes)
      ? identity.attributes.filter(item => typeof item === 'string' && item.trim())
      : [];
    const path = typeof identity?.path === 'string' ? identity.path.trim() : '';
    if (!attributes.length && !path) return false;
    if (!documentLike) return true;
    // Identity commonly lives on the stable message container while the
    // recorded response selector points at its text/markdown descendant.
    // Probe the container first when the profile declares one.
    const identitySelector = attributes.length
      ? profile?.response?.containerSelector || profile?.response?.selector
      : profile?.response?.selector;
    const responseElements = visibleMatches(documentLike, identitySelector);
    if (!responseElements.length && options.allowMissingResponse) return true;
    if (!responseElements.length) return false;
    const identityElements = attributes.length
      ? responseElements
        .map(element => declaredIdentityElement(element, attributes))
        .filter((element, index, values) => element && values.indexOf(element) === index)
      : responseElements;
    // A broad recorded response selector can match visible layout or loading
    // nodes before the first logical message exists. With an explicitly
    // allowed missing response, those nodes are not evidence of a malformed
    // message identity; the capture path still requires a fresh identity
    // before it can return a response.
    if (!identityElements.length && options.allowMissingResponse) return true;
    if (!identityElements.length) return false;
    if (attributes.length && !identityValuesAreUnique(identityElements, attributes)) return false;
    const keys = identityElements.map(element => {
      if (typeof identityProbe === 'function') {
        const probed = identityProbe(element);
        return typeof probed === 'string' ? probed.trim() : '';
      }
      for (const attribute of attributes) {
        const value = String(element.getAttribute?.(attribute) || '').trim();
        if (value) return `attribute:${attribute}=${value}`;
      }
      // A path is a declared identity contract. For DOM-only fallback paths,
      // read properties/attributes, never text content.
      let current = element;
      for (const part of path.split('.').filter(Boolean)) {
        if (current == null) break;
        if (part === 'dataset') current = current.dataset;
        else if (typeof current.getAttribute === 'function' && part.startsWith('data-')) current = current.getAttribute(part);
        else current = current[part];
      }
      return current == null || !String(current).trim()
        ? ''
        : `path:${path}=${String(current).trim()}`;
    });
    return keys.every(Boolean) && new Set(keys).size === keys.length;
  }

  function checkStreaming(profile, documentLike) {
    if (String(profile?.capture?.mode || '').toLowerCase() === 'network') return true;
    const indicators = profile?.response?.streamingIndicators;
    if (!Array.isArray(indicators) || !indicators.length) return false;
    return indicators.every(indicator => {
      if (!indicator || typeof indicator !== 'object') return false;
      if (typeof indicator.field === 'string' && indicator.field.trim()) return true;
      if (typeof indicator.selector !== 'string' || !indicator.selector.trim()) return false;
      return selectorIsValid(indicator.selector, documentLike);
    });
  }

  function runProfileHealthCheck(profile, options = {}) {
    const documentLike = options.document || (typeof document !== 'undefined' ? document : null);
    const reason = reasons();
    const scopeTooBroad = responseScopeTooBroad(profile, documentLike);
    const checks = {
      input: checkInput(profile, documentLike) ? 'pass' : 'fail',
      send: checkSend(profile, documentLike) ? 'pass' : 'fail',
      response: checkResponse(profile, documentLike, { ...options, responseScopeTooBroad: scopeTooBroad }) ? 'pass' : 'fail',
      identity: checkIdentity(profile, documentLike, options.identityProbe, options) ? 'pass' : 'fail',
      streaming: checkStreaming(profile, documentLike) ? 'pass' : 'fail'
    };
    const reasonCodes = [];
    if (checks.input !== 'pass') reasonCodes.push(reason.INPUT_UNAVAILABLE);
    if (checks.send !== 'pass') reasonCodes.push(reason.SEND_UNAVAILABLE);
    if (checks.response !== 'pass') {
      reasonCodes.push(scopeTooBroad ? reason.RESPONSE_SCOPE_TOO_BROAD : reason.RESPONSE_UNAVAILABLE);
    }
    if (checks.identity !== 'pass') {
      if (options.requireRecordedIdentity && String(profile?.capture?.mode || '').toLowerCase() !== 'network' &&
          profile?.response?.identityVerification?.status !== 'verified') {
        reasonCodes.push(reason.IDENTITY_EVIDENCE_MISSING);
      } else {
        reasonCodes.push(reason.IDENTITY_UNAVAILABLE);
      }
    }
    if (checks.streaming !== 'pass') reasonCodes.push(reason.STREAMING_UNAVAILABLE);
    const coreFields = ['input', 'send', 'response', 'identity'];
    const state = coreFields.some(field => checks[field] !== 'pass') ? 'invalid' :
      checks.streaming === 'pass' ? 'verified' : 'degraded';
    return {
      profile_id: String(profile?.profileId || ''),
      revision: Number(options.revision || profile?.revision || 0),
      state,
      checks,
      reason_codes: [...new Set(reasonCodes)]
    };
  }

  function profileHealthError(report) {
    const reasonCodes = Array.isArray(report?.reason_codes) ? report.reason_codes.slice() : [];
    const error = reasonCodes[0] || 'profile_invalid';
    return {
      error,
      detail: `录制 profile 健康检查失败: ${reasonCodes.join(', ') || 'profile_invalid'}`,
      reason_codes: reasonCodes,
      profile_health: report || null,
      recoverable: true
    };
  }

  return { HEALTH_FIELDS, runProfileHealthCheck, profileHealthError };
});
