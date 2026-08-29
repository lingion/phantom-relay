const assert = require('node:assert/strict');
const test = require('node:test');

const SendObservation = require('../extension/send_observation.js');

test('fresh user projection proves that the page accepted the send action', () => {
  assert.deepEqual(SendObservation.classify({ userObserved: true }), {
    observed: true,
    reason: 'user_projection',
  });
});

test('a fresh assistant boundary proves send on assistant-only pages', () => {
  assert.deepEqual(SendObservation.classify({ assistantObserved: true }), {
    observed: true,
    reason: 'assistant_response',
  });
});

test('a new generation signal proves that the page started processing', () => {
  assert.deepEqual(SendObservation.classify({ generationStarted: true }), {
    observed: true,
    reason: 'generation_started',
  });
});

test('consuming a non-empty recorded input is weak evidence, not accepted submission proof', () => {
  assert.deepEqual(SendObservation.classify({ inputBefore: 'hello', inputAfter: '' }), {
    observed: false,
    weak: true,
    reason: 'input_consumed_only',
  });
});

test('a late fresh assistant boundary upgrades earlier weak input evidence', () => {
  const early = SendObservation.classify({ inputBefore: 'hello', inputAfter: '' });
  assert.equal(early.observed, false);
  assert.equal(early.weak, true);

  const later = SendObservation.classify({
    assistantObserved: true,
    inputBefore: 'hello',
    inputAfter: '',
  });
  assert.deepEqual(later, { observed: true, reason: 'assistant_response' });
});

test('dispatch without a page effect is not send evidence', () => {
  assert.deepEqual(SendObservation.classify({
    inputBefore: 'hello',
    inputAfter: 'hello',
    actionDispatched: true,
  }), {
    observed: false,
    reason: 'no_effect',
  });
});
