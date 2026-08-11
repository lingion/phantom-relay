/* Provider-neutral qualification for recorded response snapshots. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelayResponseObservation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_IDENTITY_OBSERVATIONS = 3;

  function identityQualificationMinimum(activity = {}) {
    return activity.explicitlySettled === true ? 1 : DEFAULT_IDENTITY_OBSERVATIONS;
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

  function isResponseStreaming(observation = {}) {
    return observation.recordedMarker === true;
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
    if (['assistant', 'model', 'bot'].includes(normalizedRole)) return false;
    if (['user', 'human'].includes(normalizedRole)) return true;

    const candidate = comparableEchoText(candidateText);
    const prompt = comparableEchoText(promptText);
    if (!candidate) return false;
    if (prompt && candidate === prompt) return true;

    for (const prior of Array.isArray(previousTexts) ? previousTexts : []) {
      if (candidate === comparableEchoText(prior)) return true;
    }

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
    identityQualificationMinimum,
    createIdentityState,
    observeIdentity,
    isResponseStreaming,
    isLikelyUserEcho,
  };
});
