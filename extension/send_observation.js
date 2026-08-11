/* Provider-neutral evidence that one recorded send action affected the page. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhantomRelaySendObservation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function text(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function classify(observation = {}) {
    if (observation.userObserved) return { observed: true, reason: 'user_projection' };
    if (observation.assistantObserved) return { observed: true, reason: 'assistant_response' };
    if (observation.generationStarted) return { observed: true, reason: 'generation_started' };
    const inputBefore = text(observation.inputBefore);
    const inputAfter = text(observation.inputAfter);
    if (inputBefore && !inputAfter) return { observed: true, reason: 'input_consumed' };
    return { observed: false, reason: 'no_effect' };
  }

  return { classify };
});
