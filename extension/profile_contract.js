/*
 * Phantom Relay provider-neutral recorded profile contract.
 *
 * This module deliberately knows nothing about a named AI website. A profile
 * supplies recorded selectors and semantic hints; the generic DOM runtime uses
 * the normalized result to identify, clean, and reduce logical messages.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class ProfileContractError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'ProfileContractError';
      this.code = code;
      this.details = details;
    }
  }

  function fail(code, message, details) {
    throw new ProfileContractError(code, message, details);
  }

  function string(value, field, required = false) {
    if (value == null || value === '') {
      if (required) fail('profile_incomplete', `${field} is required`, { field });
      return '';
    }
    if (typeof value !== 'string') fail('profile_invalid', `${field} must be a string`, { field });
    return value.trim();
  }

  function selector(value, field, required = false) {
    if (value == null || value === '') {
      if (required) fail('profile_incomplete', `${field} selector is required`, { field });
      return null;
    }
    if (typeof value === 'string') return { css: string(value, `${field}.selector`, true), alternatives: [] };
    if (typeof value !== 'object' || Array.isArray(value)) {
      fail('profile_invalid', `${field} must be a selector string or object`, { field });
    }
    const css = string(value.css || value.selector, `${field}.selector`, required);
    const alternatives = Array.isArray(value.alternatives)
      ? value.alternatives.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
      : [];
    return css ? { ...value, css, alternatives } : null;
  }

  function normalizeAction(value, field, required = false) {
    if (value == null) {
      if (required) fail('profile_incomplete', `${field} action is required`, { field });
      return null;
    }
    if (typeof value === 'string') return { kind: 'button', selector: selector(value, field, true) };
    if (typeof value !== 'object' || Array.isArray(value)) {
      fail('profile_invalid', `${field} must be an action object`, { field });
    }
    const kind = string(value.kind, `${field}.kind`, true);
    if (!['button', 'enter', 'shortcut'].includes(kind)) {
      fail('profile_invalid', `${field}.kind is unsupported`, { field, kind });
    }
    const normalized = { ...value, kind };
    if (kind === 'button') normalized.selector = selector(value.selector || value, `${field}.selector`, true);
    if (kind === 'enter' || kind === 'shortcut') {
      normalized.key = string(value.key || 'Enter', `${field}.key`, true);
      normalized.modifiers = Array.isArray(value.modifiers)
        ? value.modifiers.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : [];
    }
    return normalized;
  }

  function normalizeIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('response_contract_missing', 'response.identity is required', { field: 'response.identity' });
    }
    const attributes = Array.isArray(value.attributes)
      ? value.attributes.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
      : [];
    const path = typeof value.path === 'string' ? value.path.trim() : '';
    if (!attributes.length && !path) {
      fail('response_contract_missing', 'response.identity must declare attributes or path', { field: 'response.identity' });
    }
    return { ...value, attributes, path };
  }

  // Identity attributes must identify a logical message, not a page state,
  // analytics event, or instrumentation projection. Keep this deliberately
  // provider-neutral: it describes attribute semantics, never a site name.
  const genericIdentityExcluded = /(?:^|[-_:])(role|status|state|streaming|loading|busy|typing|generating|thinking|processing|pending|complete|completed|finished|active|current|selected|disabled|expanded|pressed|checked|open|closed|visible|hidden|focus|hover|animation|transition|test|qa|click|show|hide|base|share|delete|session|query|content|text|html|style|log|rank|index|position|order|offset|page|count|sort|spm|track|trace|analytics|telemetry|event|anchor|source|panel|layout|container|viewport)(?:[-_:]|$)/i;

  function stableIdentityAttribute(attribute) {
    const name = String(attribute || '').trim().toLowerCase();
    if (!name || !/^(?:data-[a-z][a-z0-9_.:-]*|id)$/.test(name)) return false;
    return !genericIdentityExcluded.test(name);
  }

  function volatileSelectorLiteral(value) {
    const selectorText = String(value || '');
    if (!selectorText) return false;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(selectorText)) return true;
    return /(?:message|response|reply|result|item|row|node|turn)[-:.]?(?:\d{6,}|[0-9a-f]{16,}|[a-z0-9]{12,})/i.test(selectorText);
  }

  function selectorValues(value) {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (typeof value !== 'object' || Array.isArray(value)) return [];
    return [value.css || value.selector, ...(Array.isArray(value.alternatives) ? value.alternatives : [])]
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => item.trim());
  }

  function selectorBindsSpecificId(value) {
    return selectorValues(value).some(css => (
      /(?:^|[\s>+~,(])#[A-Za-z_][A-Za-z0-9_-]*/.test(css) ||
      /\[\s*id\s*(?:\^=|\$=|\*=|~=|\|=|=)\s*["'][^"']+["']\s*\]/i.test(css)
    ));
  }

  function semanticResponseBoundary(value) {
    return selectorValues(value).some(css => {
      if (volatileSelectorLiteral(css)) return false;
      return /(?:^|[-_.\s>#])(message|response|reply|assistant|answer|output|completion|result)(?:[-_.\s>#]|$)/i.test(css);
    });
  }

  function structuralResponseSelector(value) {
    return selectorValues(value).some(css => {
      if (volatileSelectorLiteral(css)) return false;
      const structural = /(?:^|[-_.\s>#])(app|root|conversation|chat|flow|history|list|container|wrapper|scroll|layout|panel|page|viewport|body|main|content)(?:[-_.\s>#]|$)/i.test(css);
      const semantic = /(?:^|[-_.\s>#])(message|response|reply|assistant|answer|output|completion|result)(?:[-_.\s>#]|$)/i.test(css);
      return structural && !semantic;
    });
  }

  function allowsDynamicMessageIdentity(identity, identityVerification, responseSelector, containerSelector) {
    const attributes = Array.isArray(identity?.attributes) ? identity.attributes : [];
    return attributes.some(attribute => String(attribute).trim().toLowerCase() === 'id') &&
      identityVerification?.method === 'dom-unique-at-recording' &&
      identityVerification?.identityKind === 'unique-per-message' &&
      semanticResponseBoundary(containerSelector || responseSelector);
  }

  function validateDomIdentityContract(identity, identityVerification, responseSelector, containerSelector) {
    const attributes = Array.isArray(identity?.attributes) ? identity.attributes : [];
    const verificationAttributes = Array.isArray(identityVerification?.attributes)
      ? identityVerification.attributes
      : [];
    if (attributes.some(attribute => !stableIdentityAttribute(attribute)) ||
        verificationAttributes.some(attribute => !stableIdentityAttribute(attribute))) {
      fail('response_identity_attribute_invalid', 'response identity contains a non-stable attribute', {
        field: 'response.identity.attributes'
      });
    }
    if (attributes.some(attribute => String(attribute).trim().toLowerCase() === 'id') &&
        structuralResponseSelector(responseSelector)) {
      fail('response_selector_structural', 'response selector points to a conversation or layout boundary', {
        field: 'response.selector'
      });
    }
    if (attributes.some(attribute => String(attribute).trim().toLowerCase() === 'id') &&
        !selectorBindsSpecificId(responseSelector) && !selectorBindsSpecificId(containerSelector) &&
        !allowsDynamicMessageIdentity(identity, identityVerification, responseSelector, containerSelector)) {
      fail('response_identity_ambiguous', 'plain id identity is not bound to a specific response boundary', {
        field: 'response.identity.attributes'
      });
    }
    const selectors = [...selectorValues(responseSelector), ...selectorValues(containerSelector)];
    if (selectors.some(volatileSelectorLiteral)) {
      fail('response_selector_volatile', 'response selector contains a generated message identity', {
        field: 'response.selector'
      });
    }
  }

  function normalizeIdentityVerification(value) {
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('profile_invalid', 'response.identityVerification must be an object', { field: 'response.identityVerification' });
    }
    const status = string(value.status, 'response.identityVerification.status', true).toLowerCase();
    if (status !== 'verified') {
      fail('profile_identity_evidence_invalid', 'response.identityVerification.status must be verified', {
        field: 'response.identityVerification.status', status
      });
    }
    const method = string(value.method, 'response.identityVerification.method', true);
    const attributes = Array.isArray(value.attributes)
      ? value.attributes.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
      : [];
    return { ...value, status, method, attributes };
  }

  function normalizeRoles(value) {
    const roles = value && typeof value === 'object' ? value : {};
    const normalize = (items) => Array.isArray(items)
      ? items.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().toLowerCase())
      : [];
    return { user: normalize(roles.user), assistant: normalize(roles.assistant) };
  }

  function normalizeIndicators(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) fail('profile_invalid', 'response.streamingIndicators must be an array', { field: 'response.streamingIndicators' });
    return value.map((item, index) => {
      if (typeof item === 'string' && item.trim()) return { selector: item.trim(), equals: true };
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail('profile_invalid', `response.streamingIndicators[${index}] is invalid`, { field: `response.streamingIndicators[${index}]` });
      }
      if (item.field != null && typeof item.field !== 'string') {
        fail('profile_invalid', `response.streamingIndicators[${index}].field must be a string`, { field: `response.streamingIndicators[${index}].field` });
      }
      if (item.selector != null && typeof item.selector !== 'string') {
        fail('profile_invalid', `response.streamingIndicators[${index}].selector must be a string`, { field: `response.streamingIndicators[${index}].selector` });
      }
      const field = typeof item.field === 'string' ? item.field.trim() : '';
      const selector = typeof item.selector === 'string' ? item.selector.trim() : '';
      if (!field && !selector) {
        fail('profile_incomplete', `response.streamingIndicators[${index}] requires field or selector`, { field: `response.streamingIndicators[${index}]` });
      }
      return {
        ...item,
        ...(field ? { field } : {}),
        ...(selector ? { selector } : {}),
        equals: item.equals === undefined ? true : item.equals
      };
    });
  }

  function normalizeTextRules(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) fail('profile_invalid', 'response.textNormalization must be an array', { field: 'response.textNormalization' });
    return value.map((item, index) => {
      if (typeof item === 'string') return { kind: item.trim() };
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail('profile_invalid', `response.textNormalization[${index}] is invalid`, { field: `response.textNormalization[${index}]` });
      }
      const kind = string(item.kind, `response.textNormalization[${index}].kind`, true);
      if (!['trim', 'collapse-whitespace', 'remove-text', 'remove-regex'].includes(kind)) {
        fail('profile_invalid', `response.textNormalization[${index}].kind is unsupported`, { field: `response.textNormalization[${index}]` });
      }
      if ((kind === 'remove-text' || kind === 'remove-regex') && typeof item.value !== 'string') {
        fail('profile_invalid', `response.textNormalization[${index}].value is required`, { field: `response.textNormalization[${index}]` });
      }
      return { ...item, kind };
    });
  }

  function normalizeCapture(value) {
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('capture_contract_invalid', 'capture must be an object', { field: 'capture' });
    }
    const mode = string(value.mode, 'capture.mode', true).toLowerCase();
    if (!['network', 'hybrid'].includes(mode)) {
      fail('capture_contract_invalid', 'capture.mode must be network or hybrid', { field: 'capture.mode', mode });
    }
    const response = value.response && typeof value.response === 'object' ? value.response : {};
    const url = response.url && typeof response.url === 'object' ? response.url : {};
    const origins = (Array.isArray(url.origins) ? url.origins : url.origin ? [url.origin] : [])
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => item.trim().replace(/\/$/, '').toLowerCase());
    const pathPatterns = (Array.isArray(url.pathPatterns) ? url.pathPatterns : url.pathPattern ? [url.pathPattern] : [])
      .filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
    const mimeTypes = (Array.isArray(response.mimeTypes) ? response.mimeTypes : response.mimeType ? [response.mimeType] : [])
      .filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().toLowerCase());
    if (!origins.length || !pathPatterns.length || !mimeTypes.length) {
      fail('capture_contract_incomplete', 'capture.response must declare origins, pathPatterns, and mimeTypes', { field: 'capture.response' });
    }
    const parser = value.parser && typeof value.parser === 'object' ? value.parser : {};
    const eventFormat = string(parser.eventFormat || 'sse', 'capture.parser.eventFormat', true).toLowerCase();
    if (eventFormat !== 'sse') fail('capture_contract_invalid', 'only SSE capture contracts are supported', { field: 'capture.parser.eventFormat' });
    const textRules = Array.isArray(parser.textRules) ? parser.textRules : [];
    if (!textRules.length) fail('capture_contract_incomplete', 'capture.parser.textRules is required', { field: 'capture.parser.textRules' });
    const finishRules = Array.isArray(parser.finishRules) ? parser.finishRules : [];
    if (!finishRules.length && parser.allowLoadingFinished !== true) {
      fail('capture_contract_incomplete', 'capture.parser.finishRules or allowLoadingFinished is required', { field: 'capture.parser' });
    }
    return {
      ...value,
      mode,
      response: {
        ...response,
        url: { ...url, origins, pathPatterns, queryPolicy: String(url.queryPolicy || 'ignore').toLowerCase() },
        mimeTypes
      },
      parser: { ...parser, eventFormat, textRules, finishRules, allowLoadingFinished: parser.allowLoadingFinished === true }
    };
  }

  function captureMode(profile) {
    return String(profile?.capture?.mode || 'dom').trim().toLowerCase();
  }

  function hasRecordedIdentityVerification(profile) {
    const normalized = profile?.__normalizedProfile ? profile : normalizeProfile(profile);
    if (captureMode(normalized) === 'network') return true;
    return normalized.response?.identityVerification?.status === 'verified';
  }

  function normalizeProfile(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('profile_incomplete', 'profile must be an object');
    }
    const profileId = string(input.profileId, 'profileId', true);
    const origin = string(input.origin, 'origin', true);
    const domain = string(input.domain, 'domain', true);
    const mode = String(input.capture?.mode || 'dom').trim().toLowerCase();
    const response = input.response && typeof input.response === 'object' && !Array.isArray(input.response)
      ? input.response : {};
    const networkOnly = mode === 'network';
    if (!networkOnly && (!input.response || typeof input.response !== 'object' || Array.isArray(input.response))) {
      fail('response_contract_missing', 'response contract is required', { field: 'response' });
    }
    const responseSelector = selector(response.selector || response.containerSelector, 'response', !networkOnly);
    const containerSelector = response.containerSelector && response.selector
      ? selector(response.containerSelector, 'response.containerSelector', false)
      : null;
    const identity = networkOnly && !response.identity ? null : normalizeIdentity(response.identity);
    const identityVerification = normalizeIdentityVerification(response.identityVerification);
    if (!networkOnly) validateDomIdentityContract(identity, identityVerification, responseSelector, containerSelector);
    const normalized = {
      ...input,
      profileId,
      origin,
      domain,
      input: {
        ...(input.input || {}),
        selector: selector(input.input?.selector || input.input, 'input', true),
        kind: string(input.input?.kind || 'textarea', 'input.kind', true)
      },
      send: normalizeAction(input.send, 'send', true),
      response: {
        ...response,
        selector: responseSelector,
        containerSelector,
        ...(identity ? { identity } : {}),
        ...(identityVerification ? { identityVerification } : {}),
        role: normalizeRoles(response.role),
        streamingIndicators: normalizeIndicators(response.streamingIndicators),
        excludedSelectors: Array.isArray(response.excludedSelectors)
          ? response.excludedSelectors.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
          : [],
        textNormalization: normalizeTextRules(response.textNormalization)
      },
      capabilities: { text: true, ...(input.capabilities || {}) },
      ...(input.capture ? { capture: normalizeCapture(input.capture) } : {})
    };
    if (networkOnly && !normalized.capture) fail('capture_contract_missing', 'network profile requires capture contract', { field: 'capture' });
    if (mode === 'hybrid' && !normalized.capture) fail('capture_contract_missing', 'hybrid profile requires capture contract', { field: 'capture' });
    normalized.__normalizedProfile = true;
    return normalized;
  }

  // A recorded send action is part of the executable profile contract. When a
  // user re-records the send control after response recording, update the
  // profile through the same normalizer instead of leaving selectors.send and
  // profile.send with different meanings.
  function withSendStrategy(profile, send) {
    const normalized = normalizeProfile(profile);
    return normalizeProfile({ ...normalized, send });
  }

  // A selector bundle may be refreshed independently from the executable
  // profile. Rebuild the profile through the same contract validator so the
  // response boundary can move without dropping its recorded identity proof.
  function withResponseSelector(profile, responseSelector) {
    const normalized = normalizeProfile(profile);
    const nextSelector = selector(responseSelector, 'response', true);
    return normalizeProfile({
      ...normalized,
      response: {
        ...normalized.response,
        selector: { css: nextSelector.css, alternatives: nextSelector.alternatives },
      },
    });
  }

  function getPath(value, path) {
    if (!path) return undefined;
    return path.split('.').reduce((current, part) => current == null ? undefined : current[part], value);
  }

  function messageIdentity(profile, record) {
    const normalized = profile.__normalizedProfile ? profile : normalizeProfile(profile);
    const identity = normalized.response.identity || {};
    const attrs = record && record.attributes && typeof record.attributes === 'object' ? record.attributes : {};
    for (const attribute of identity.attributes) {
      const value = attrs[attribute] ?? record?.[attribute];
      if (value != null && String(value).trim()) return `attribute:${attribute}=${String(value).trim()}`;
    }
    const pathValue = getPath(record, identity.path);
    if (pathValue != null && String(pathValue).trim()) return `path:${identity.path}=${String(pathValue).trim()}`;
    return '';
  }

  function messageRole(profile, record) {
    const normalized = profile.__normalizedProfile ? profile : normalizeProfile(profile);
    const raw = String(record?.role || record?.messageRole || '').trim().toLowerCase();
    if (normalized.response.role.user.includes(raw)) return 'user';
    if (normalized.response.role.assistant.includes(raw)) return 'assistant';
    if (raw === 'user') return 'user';
    if (raw === 'assistant' || raw === 'model' || raw === 'bot') return 'assistant';
    return raw || 'unknown';
  }

  function indicatorValue(record, indicator) {
    if (indicator.field) return getPath(record, indicator.field);
    if (indicator.selector) {
      const selectors = Array.isArray(record?.selectors) ? record.selectors : [];
      return selectors.includes(indicator.selector);
    }
    return undefined;
  }

  function indicatorObservation(record, indicator) {
    if (indicator.selector) {
      const states = Array.isArray(record?.indicatorStates) ? record.indicatorStates : [];
      const state = states.find(item => item?.selector === indicator.selector);
      if (state) {
        return {
          observed: state.observed === true,
          active: state.matched === indicator.equals,
        };
      }
      const selectors = Array.isArray(record?.selectors) ? record.selectors : [];
      const matched = selectors.includes(indicator.selector);
      return {
        observed: matched,
        active: matched === indicator.equals,
      };
    }
    const value = indicatorValue(record, indicator);
    return {
      observed: value !== undefined,
      active: value === indicator.equals,
    };
  }

  function streamingState(profile, record) {
    const normalized = profile.__normalizedProfile ? profile : normalizeProfile(profile);
    let active = false;
    let explicitlySettled = false;
    for (const indicator of normalized.response.streamingIndicators) {
      const observation = indicatorObservation(record, indicator);
      if (observation.active) active = true;
      else if (observation.observed) explicitlySettled = true;
    }
    return { active, explicitlySettled: !active && explicitlySettled };
  }

  function isStreaming(profile, record) {
    return streamingState(profile, record).active;
  }

  function normalizeText(profile, value) {
    const normalized = profile.__normalizedProfile ? profile : normalizeProfile(profile);
    let output = value == null ? '' : String(value);
    for (const rule of normalized.response.textNormalization) {
      if (rule.kind === 'trim') output = output.trim();
      else if (rule.kind === 'collapse-whitespace') output = output.replace(/\s+/g, ' ');
      else if (rule.kind === 'remove-text') output = output.split(rule.value).join('');
      else if (rule.kind === 'remove-regex') {
        try { output = output.replace(new RegExp(rule.value, rule.flags || 'g'), ''); } catch (_) { /* invalid optional cleanup is ignored */ }
      }
    }
    return output.trim();
  }

  function reduceMessages(profile, records) {
    const normalized = profile.__normalizedProfile ? profile : normalizeProfile(profile);
    const grouped = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      const key = messageIdentity(normalized, record);
      const text = normalizeText(normalized, record?.text);
      if (!key || !text) continue;
      const item = {
        key,
        role: messageRole(normalized, record),
        streaming: isStreaming(normalized, record),
        text
      };
      const old = grouped.get(key);
      if (!old || text.length >= old.text.length || record?.authoritative === true) grouped.set(key, item);
    }
    return Array.from(grouped.values());
  }

  function excludedSelectors(profile) {
    const normalized = profile.__normalizedProfile ? profile : normalizeProfile(profile);
    return normalized.response.excludedSelectors.slice();
  }

  return {
    ProfileContractError,
    normalizeCapture,
    captureMode,
    hasRecordedIdentityVerification,
    stableIdentityAttribute,
    volatileSelectorLiteral,
    normalizeProfile,
    withSendStrategy,
    withResponseSelector,
    messageIdentity,
    messageRole,
    streamingState,
    isStreaming,
    normalizeText,
    excludedSelectors,
    reduceMessages
  };
});
