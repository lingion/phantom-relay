/* Provider-neutral qualification for recorded response snapshots. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayResponseObservation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_IDENTITY_OBSERVATIONS = 3;
  const DEFAULT_RESPONSE_QUIET_MS = 3000;
  const DEFAULT_OBSERVATION_GAP_MS = 5000;
  // When a recording offers no affirmative end-of-generation signal, a short
  // DOM pause is not enough to prove that the provider has finished. This is
  // deliberately a contract-wide bound, not a provider-specific delay.
  const DEFAULT_UNKNOWN_ACTIVITY_MIN_AGE_MS = 8000;

  function identityQualificationMinimum(activity = {}) {
    const requestScopedSettlement = activity.explicitlySettled === true && activity.streamingSeen !== false;
    return requestScopedSettlement ? 1 : DEFAULT_IDENTITY_OBSERVATIONS;
  }

  function createIdentityState() {
    return { key: '', observations: 0, qualified: false };
  }

  function observeIdentity(previous, value, minimum = DEFAULT_IDENTITY_OBSERVATIONS) {
    const key = String(value || '').trim();
    if (!key) {
      const state = createIdentityState();
      return { state, qualified: false, becameQualified: false };
    }

    const prior = previous && typeof previous === 'object'
      ? previous
      : createIdentityState();
    const sameIdentity = prior.key === key;
    const observations = sameIdentity ? Number(prior.observations || 0) + 1 : 1;
    const threshold = Math.max(1, Number(minimum) || DEFAULT_IDENTITY_OBSERVATIONS);
    const qualified = observations >= threshold;
    const becameQualified = qualified && !(sameIdentity && prior.qualified);
    const state = { key, observations, qualified };
    return { state, qualified, becameQualified };
  }

  function createCompletionState() {
    return {
      key: '',
      text: '',
      activityToken: '',
      firstObservedAt: 0,
      lastTextChangeAt: 0,
      lastActivityChangeAt: 0,
      streamingSeen: false,
      streamingActive: false,
      lastStreamingStopAt: 0,
      lastObservedAt: null,
      maxTextLength: 0,
      discontinuous: false,
    };
  }

  function comparableProjectionText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function observeCompletion(previous, observation = {}, now = Date.now(), quietMs = DEFAULT_RESPONSE_QUIET_MS) {
    const at = Math.max(0, Number(now) || 0);
    const key = String(observation.key || '').trim();
    const body = String(observation.text || '');
    const prior = previous && typeof previous === 'object'
      ? previous
      : createCompletionState();
    const sameIdentity = !!key && prior.key === key;
    const priorBody = sameIdentity ? String(prior.text || '') : '';
    const priorComparable = comparableProjectionText(priorBody);
    const bodyComparable = comparableProjectionText(body);
    const priorLastObservedAt = prior.lastObservedAt === null || prior.lastObservedAt === undefined
      ? null
      : Number(prior.lastObservedAt);
    const resumedAfterGap = sameIdentity && Number.isFinite(priorLastObservedAt) &&
      at - priorLastObservedAt > DEFAULT_OBSERVATION_GAP_MS;
    const priorMaxTextLength = sameIdentity
      ? Math.max(Number(prior.maxTextLength || 0), priorComparable.length)
      : 0;
    const grewBeyondMaximum = sameIdentity && bodyComparable.length > priorMaxTextLength;
    const recoveredFromDiscontinuity = sameIdentity &&
      prior.discontinuous === true && grewBeyondMaximum;
    const activityToken = String(observation.activityToken || '');
    const activityChanged = sameIdentity && !!prior.activityToken &&
      !!activityToken && prior.activityToken !== activityToken;
    // A delayed observer tick is not itself a discontinuity. Only mark the
    // projection as discontinuous when the same identity reappears after a
    // gap with different text or recorded-scope activity; otherwise a stable
    // full response can be blocked forever by scheduler/DOM observation
    // latency.
    const changedAfterGap = sameIdentity && resumedAfterGap &&
      (bodyComparable !== priorComparable || activityChanged);
    const projectionRegressed = sameIdentity && !!bodyComparable &&
      priorComparable.length > bodyComparable.length &&
      (resumedAfterGap || priorComparable.startsWith(bodyComparable) || priorComparable.includes(bodyComparable));
    const effectiveBody = projectionRegressed ? priorBody : body;
    const changed = !sameIdentity || (!projectionRegressed && prior.text !== body);
    const streamingActive = observation.streaming === true;
    const streamingSeen = !!prior.streamingSeen || streamingActive;
    const streamingStopped = sameIdentity && !!prior.streamingActive && !streamingActive;
    const state = {
      key,
      text: effectiveBody,
      firstObservedAt: sameIdentity && !recoveredFromDiscontinuity && Number.isFinite(Number(prior.firstObservedAt))
        ? Number(prior.firstObservedAt)
        : at,
      lastTextChangeAt: changed
        ? at
        : (Number.isFinite(Number(prior.lastTextChangeAt)) ? Number(prior.lastTextChangeAt) : at),
      activityToken,
      lastActivityChangeAt: activityChanged
        ? at
        : (sameIdentity && Number.isFinite(Number(prior.lastActivityChangeAt))
          ? Number(prior.lastActivityChangeAt)
          : at),
      streamingSeen,
      streamingActive,
      lastStreamingStopAt: streamingStopped
        ? at
        : (sameIdentity && Number.isFinite(Number(prior.lastStreamingStopAt))
          ? Number(prior.lastStreamingStopAt)
          : 0),
      lastObservedAt: at,
      maxTextLength: projectionRegressed
        ? priorMaxTextLength
        : Math.max(priorMaxTextLength, bodyComparable.length),
      discontinuous: grewBeyondMaximum
        ? false
        : (sameIdentity && (prior.discontinuous === true || changedAfterGap)),
    };

    if (projectionRegressed) {
      return { state, complete: false, changed: false, projectionRegressed: true, reason: '' };
    }
    if (!key || !body || observation.identityQualified !== true || streamingActive) {
      return { state, complete: false, changed, projectionRegressed: false, reason: '' };
    }
    // A static inactive marker may be present before generation starts. It is
    // completion evidence only after this request observed the response active
    // at least once; otherwise keep the conservative identity and quiet gates.
    const explicitlySettled = observation.explicitlySettled === true &&
      (observation.streamingSeen !== false || prior.streamingSeen || observation.streamingSeen === true);
    if (explicitlySettled) {
      return { state, complete: true, changed, projectionRegressed: false, reason: 'recorded_activity_settled' };
    }
    if (!streamingSeen && state.discontinuous) {
      return { state, complete: false, changed, projectionRegressed: false, reason: '' };
    }

    const quietWindow = Math.max(250, Number(quietMs) || DEFAULT_RESPONSE_QUIET_MS);
    const quietStartedAt = Math.max(
      state.lastTextChangeAt,
      state.lastActivityChangeAt,
      state.lastStreamingStopAt,
    );
    if (at - quietStartedAt < quietWindow) {
      return { state, complete: false, changed, projectionRegressed: false, reason: '' };
    }
    if (!streamingSeen) {
      const minimumAge = Math.max(
        quietWindow,
        Number(observation.unknownActivityMinimumAgeMs) || DEFAULT_UNKNOWN_ACTIVITY_MIN_AGE_MS,
      );
      if (at - state.firstObservedAt < minimumAge) {
        return { state, complete: false, changed, projectionRegressed: false, reason: '' };
      }
    }
    return {
      state,
      complete: true,
      changed,
      projectionRegressed: false,
      reason: streamingSeen ? 'page_activity_stopped' : 'conservative_unknown_activity_settlement',
    };
  }

  function mergeRecordedRegionElements(directElements = [], fallbackElements = [], identityOf = item => item?.key) {
    const direct = Array.from(new Set(Array.isArray(directElements) ? directElements : []));
    const directIdentities = new Set();
    for (const element of direct) {
      const identity = String(identityOf(element) || '').trim();
      if (identity) directIdentities.add(identity);
    }
    const merged = direct.slice();
    const seen = new Set(direct);
    for (const element of Array.isArray(fallbackElements) ? fallbackElements : []) {
      if (!element || seen.has(element)) continue;
      const identity = String(identityOf(element) || '').trim();
      if (identity && directIdentities.has(identity)) continue;
      seen.add(element);
      merged.push(element);
    }
    return merged;
  }

  function selectRecordedProjection(group = []) {
    return (Array.isArray(group) ? group : []).reduce((best, item) => {
      if (!best) return item;
      const specificity = Number(item?.specificity || 0);
      const bestSpecificity = Number(best?.specificity || 0);
      if (specificity !== bestSpecificity) return specificity > bestSpecificity ? item : best;
      const depth = Number(item?.depth || 0);
      const bestDepth = Number(best?.depth || 0);
      if (depth !== bestDepth) return depth > bestDepth ? item : best;
      return Number(item?.index || 0) > Number(best?.index || 0) ? item : best;
    }, null);
  }

  function isResponseStreaming(observation = {}) {
    return observation.recordedMarker === true || observation.requestControl === true;
  }

  function comparableEchoText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
      .replace(/^[\s]*(?:user|human|用户)\s*[:：]\s*/i, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function ngramSimilarity(left, right, size = 3) {
    if (left === right) return 1;
    if (!left || !right) return 0;
    if (left.length < size || right.length < size) return 0;
    const counts = new Map();
    for (let index = 0; index <= left.length - size; index += 1) {
      const gram = left.slice(index, index + size);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    let matches = 0;
    for (let index = 0; index <= right.length - size; index += 1) {
      const gram = right.slice(index, index + size);
      const count = counts.get(gram) || 0;
      if (!count) continue;
      matches += 1;
      counts.set(gram, count - 1);
    }
    const leftCount = left.length - size + 1;
    const rightCount = right.length - size + 1;
    return (2 * matches) / (leftCount + rightCount);
  }

  function isLikelyUserEcho({ candidateText = '', promptText = '', previousTexts = [], role = 'unknown' } = {}) {
    const normalizedRole = String(role || 'unknown').trim().toLowerCase();
    const candidate = comparableEchoText(candidateText);
    const prompt = comparableEchoText(promptText);
    if (!candidate) return false;

    for (const prior of Array.isArray(previousTexts) ? previousTexts : []) {
      if (candidate === comparableEchoText(prior)) return true;
    }

    // A role label does not establish request ownership. A fresh-looking
    // assistant node that repeats exact pre-send text can be a rehydrated or
    // virtualized stale response, so reject it before considering page roles.
    if (['assistant', 'model', 'bot'].includes(normalizedRole)) return false;
    if (['user', 'human'].includes(normalizedRole)) return true;
    if (prompt && candidate === prompt) return true;

    // Rendered Markdown, URL labels, and punctuation can make a user bubble
    // differ slightly from the submitted prompt. Apply fuzzy matching only to
    // long, similarly sized unknown-role text so short requested answers such
    // as "OK" remain eligible.
    if (prompt.length >= 80 && candidate.length >= 80) {
      const lengthRatio = Math.min(candidate.length, prompt.length) / Math.max(candidate.length, prompt.length);
      if (lengthRatio >= 0.82 && ngramSimilarity(candidate, prompt) >= 0.9) return true;
    }
    return false;
  }

  return {
    DEFAULT_IDENTITY_OBSERVATIONS,
    DEFAULT_RESPONSE_QUIET_MS,
    DEFAULT_OBSERVATION_GAP_MS,
    DEFAULT_UNKNOWN_ACTIVITY_MIN_AGE_MS,
    identityQualificationMinimum,
    createIdentityState,
    observeIdentity,
    createCompletionState,
    observeCompletion,
    mergeRecordedRegionElements,
    selectRecordedProjection,
    isResponseStreaming,
    isLikelyUserEcho,
  };
});
