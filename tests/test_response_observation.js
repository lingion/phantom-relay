const assert = require('node:assert/strict');
const test = require('node:test');

const ResponseObservation = require('../extension/response_observation.js');

test('a transient recorded identity is not qualified for caller-facing streaming', () => {
  let state = ResponseObservation.createIdentityState();

  let observation = ResponseObservation.observeIdentity(state, 'attribute:data-message-id=transient');
  state = observation.state;
  assert.equal(observation.qualified, false);
  assert.equal(observation.becameQualified, false);

  observation = ResponseObservation.observeIdentity(state, '');
  assert.deepEqual(observation.state, ResponseObservation.createIdentityState());
  assert.equal(observation.qualified, false);
});

test('one recorded identity qualifies after three consecutive snapshots even while text grows', () => {
  let state = ResponseObservation.createIdentityState();
  const key = 'attribute:data-message-id=assistant-1';

  let observation = ResponseObservation.observeIdentity(state, key);
  state = observation.state;
  assert.equal(observation.qualified, false);

  observation = ResponseObservation.observeIdentity(state, key);
  state = observation.state;
  assert.equal(observation.qualified, false);

  observation = ResponseObservation.observeIdentity(state, key);
  assert.equal(observation.qualified, true);
  assert.equal(observation.becameQualified, true);
});

test('switching recorded identities restarts qualification', () => {
  let state = ResponseObservation.createIdentityState();
  state = ResponseObservation.observeIdentity(state, 'attribute:data-message-id=first').state;
  state = ResponseObservation.observeIdentity(state, 'attribute:data-message-id=first').state;

  const observation = ResponseObservation.observeIdentity(
    state,
    'attribute:data-message-id=second',
  );

  assert.equal(observation.state.observations, 1);
  assert.equal(observation.qualified, false);
  assert.equal(observation.becameQualified, false);
});

test('an explicitly settled recorded response qualifies without timer-driven repeats', () => {
  assert.equal(ResponseObservation.identityQualificationMinimum({ explicitlySettled: true }), 1);
  assert.equal(ResponseObservation.identityQualificationMinimum({ explicitlySettled: false }), 3);

  const observation = ResponseObservation.observeIdentity(
    ResponseObservation.createIdentityState(),
    'path:recordedResponseIndex=2',
    ResponseObservation.identityQualificationMinimum({ explicitlySettled: true }),
  );

  assert.equal(observation.qualified, true);
  assert.equal(observation.becameQualified, true);
});

test('only the recorded response marker owns completion activity', () => {
  assert.equal(ResponseObservation.isResponseStreaming({ recordedMarker: true }), true);
  assert.equal(ResponseObservation.isResponseStreaming({ recordedMarker: false }), false);
  assert.equal(ResponseObservation.isResponseStreaming({
    recordedMarker: false,
    unrecordedPageControl: true,
  }), false);
});

test('unknown-role full prompt echo is rejected', () => {
  assert.equal(ResponseObservation.isLikelyUserEcho({
    candidateText: 'User: Explain the boundary contract in one paragraph.',
    promptText: 'Explain the boundary contract in one paragraph.',
    previousTexts: [],
    role: 'unknown',
  }), true);
});

test('unknown-role near-identical rendered prompt is rejected', () => {
  const prompt = '# Task\n\nUse **recorded DOM identity** and inspect [the contract](https://example.test/contract). '
    + 'Return a detailed answer that preserves every requirement and does not add a provider-specific selector.';
  const rendered = 'Task Use recorded DOM identity and inspect the contract. '
    + 'Return a detailed answer that preserves every requirement and does not add a provider specific selector.';

  assert.equal(ResponseObservation.isLikelyUserEcho({
    candidateText: rendered,
    promptText: prompt,
    previousTexts: [],
    role: 'unknown',
  }), true);
});

test('unknown-role text already present before send is rejected under a fresh identity', () => {
  assert.equal(ResponseObservation.isLikelyUserEcho({
    candidateText: 'An earlier user message projected again',
    promptText: 'Write a new answer',
    previousTexts: ['An earlier user message projected again'],
    role: 'unknown',
  }), true);
});

test('explicit assistant role may legitimately repeat prior text', () => {
  assert.equal(ResponseObservation.isLikelyUserEcho({
    candidateText: 'Repeat this exact text',
    promptText: 'Repeat this exact text',
    previousTexts: ['Repeat this exact text'],
    role: 'assistant',
  }), false);
});

test('short requested answer is allowed when it was not present before send', () => {
  assert.equal(ResponseObservation.isLikelyUserEcho({
    candidateText: 'OK',
    promptText: 'Reply with exactly OK and nothing else.',
    previousTexts: [],
    role: 'unknown',
  }), false);
});
