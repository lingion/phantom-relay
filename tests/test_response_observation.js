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

test('one recorded identity qualifies after three consecutive snapshots', () => {
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
  assert.equal(ResponseObservation.identityQualificationMinimum({
    explicitlySettled: true,
    streamingSeen: false,
  }), 3);

  const observation = ResponseObservation.observeIdentity(
    ResponseObservation.createIdentityState(),
    'path:recordedResponseIndex=2',
    ResponseObservation.identityQualificationMinimum({ explicitlySettled: true }),
  );

  assert.equal(observation.qualified, true);
  assert.equal(observation.becameQualified, true);
});

test('only recorded markers or request-scoped generation controls own completion activity', () => {
  assert.equal(ResponseObservation.isResponseStreaming({ recordedMarker: true }), true);
  assert.equal(ResponseObservation.isResponseStreaming({ recordedMarker: false }), false);
  assert.equal(ResponseObservation.isResponseStreaming({
    recordedMarker: false,
    requestControl: true,
  }), true);
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

test('a fresh assistant identity cannot reuse exact pre-send text as response proof', () => {
  assert.equal(ResponseObservation.isLikelyUserEcho({
    candidateText: 'Repeat this exact text',
    promptText: 'Repeat this exact text',
    previousTexts: ['Repeat this exact text'],
    role: 'assistant',
  }), true);
});

test('short requested answer is allowed when it was not present before send', () => {
  assert.equal(ResponseObservation.isLikelyUserEcho({
    candidateText: 'OK',
    promptText: 'Reply with exactly OK and nothing else.',
    previousTexts: [],
    role: 'unknown',
  }), false);
});

test('three unchanged snapshots inside 750ms do not complete an unknown-activity response', () => {
  let state = ResponseObservation.createCompletionState();
  const key = 'attribute:data-message-id=assistant-1';

  for (const now of [0, 250, 500, 750]) {
    const observation = ResponseObservation.observeCompletion(state, {
      key,
      text: 'ACK',
      identityQualified: true,
      streaming: false,
      explicitlySettled: false,
    }, now);
    state = observation.state;
    assert.equal(observation.complete, false);
  }
});

test('unknown activity survives a long model pause and settles only after conservative age and quiet gates', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'assistant-1',
      text: 'ACK_WARM_20260812T152820_WENXIN_BAIDU_CO',
      identityQualified: true,
      streaming: false,
      explicitlySettled: false,
    },
    100,
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260812T152820_WENXIN_BAIDU_CO',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 100 + ResponseObservation.DEFAULT_RESPONSE_QUIET_MS);
  assert.equal(observation.complete, false, 'a short quiet gap is not completion evidence');

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260812T152820_WENXIN_BAIDU_COM_001',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 4_500);
  assert.equal(observation.complete, false, 'later growth must remain eligible after the pause');

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260812T152820_WENXIN_BAIDU_COM_001',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 8_099);
  assert.equal(observation.complete, false, 'candidate age must also reach the conservative floor');

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260812T152820_WENXIN_BAIDU_COM_001',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 8_100);
  assert.equal(observation.complete, true);
  assert.equal(observation.reason, 'conservative_unknown_activity_settlement');
});

test('recorded response scope activity prevents completion while the selected body projection is unchanged', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'assistant-1',
      text: 'ACK_WARM_20260813T120816_WENXIN_BAIDU_CO',
      activityToken: 'scope-revision-1',
      identityQualified: true,
      streaming: false,
      explicitlySettled: false,
    },
    100,
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260813T120816_WENXIN_BAIDU_CO',
    activityToken: 'scope-revision-2',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 7_600);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260813T120816_WENXIN_BAIDU_CO',
    activityToken: 'scope-revision-2',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 8_100);
  assert.equal(
    observation.complete,
    false,
    'response-scope growth must reset the quiet settlement boundary even when the selected text lags',
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260813T120816_WENXIN_BAIDU_COM_001',
    activityToken: 'scope-revision-3',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 9_000);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260813T120816_WENXIN_BAIDU_COM_001',
    activityToken: 'scope-revision-3',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 12_000);
  assert.equal(observation.complete, false, 'a recovered projection must earn a fresh conservative age');

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_WARM_20260813T120816_WENXIN_BAIDU_COM_001',
    activityToken: 'scope-revision-3',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 17_000);
  assert.equal(observation.complete, true);
  assert.equal(observation.reason, 'conservative_unknown_activity_settlement');
});

test('response text growth resets the quiet settlement window', () => {
  let state = ResponseObservation.createCompletionState();

  state = ResponseObservation.observeCompletion(state, {
    key: 'assistant-1',
    text: 'ACK',
    identityQualified: true,
  }, 0).state;
  state = ResponseObservation.observeCompletion(state, {
    key: 'assistant-1',
    text: 'ACK_ALIAS_ROUTE',
    identityQualified: true,
  }, ResponseObservation.DEFAULT_RESPONSE_QUIET_MS - 1).state;

  let observation = ResponseObservation.observeCompletion(state, {
    key: 'assistant-1',
    text: 'ACK_ALIAS_ROUTE',
    identityQualified: true,
  }, ResponseObservation.DEFAULT_RESPONSE_QUIET_MS);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_ALIAS_ROUTE',
    identityQualified: true,
  }, ResponseObservation.DEFAULT_UNKNOWN_ACTIVITY_MIN_AGE_MS - 1);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'ACK_ALIAS_ROUTE',
    identityQualified: true,
  }, ResponseObservation.DEFAULT_UNKNOWN_ACTIVITY_MIN_AGE_MS);
  assert.equal(observation.complete, true);
  assert.equal(observation.reason, 'conservative_unknown_activity_settlement');
});

test('a late growth after a long pause cannot be committed from the earlier partial snapshot', () => {
  let state = ResponseObservation.createCompletionState();
  const observations = [
    [1_000, 4],
    [2_100, 31],
    [2_530, 44],
    [4_440, 50],
    [7_180, 53],
  ];

  for (const [now, length] of observations) {
    const result = ResponseObservation.observeCompletion(state, {
      key: 'assistant-1',
      text: 'x'.repeat(length),
      identityQualified: true,
      streaming: false,
      explicitlySettled: false,
      activityToken: JSON.stringify({ selectedTextLength: length, scopeTextLength: length }),
    }, now);
    state = result.state;
    assert.equal(result.complete, false, `partial snapshot of ${length} chars must not complete`);
  }

  const afterQuietWindow = ResponseObservation.observeCompletion(state, {
    key: 'assistant-1',
    text: 'x'.repeat(53),
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
    activityToken: JSON.stringify({ selectedTextLength: 53, scopeTextLength: 53 }),
  }, 10_181);
  assert.equal(afterQuietWindow.complete, true);
  assert.equal(afterQuietWindow.reason, 'conservative_unknown_activity_settlement');
});

test('unrelated observation ticks do not reset or accelerate body settlement', () => {
  let state = ResponseObservation.createCompletionState();
  state = ResponseObservation.observeCompletion(state, {
    key: 'assistant-1',
    text: 'complete body',
    identityQualified: true,
  }, 100).state;

  const early = ResponseObservation.observeCompletion(state, {
    key: 'assistant-1',
    text: 'complete body',
    identityQualified: true,
  }, 100 + ResponseObservation.DEFAULT_RESPONSE_QUIET_MS - 1);
  assert.equal(early.complete, false);

  const continuous = ResponseObservation.observeCompletion(early.state, {
    key: 'assistant-1',
    text: 'complete body',
    identityQualified: true,
  }, 5_000);
  assert.equal(continuous.complete, false);

  const settled = ResponseObservation.observeCompletion(continuous.state, {
    key: 'assistant-1',
    text: 'complete body',
    identityQualified: true,
  }, 100 + ResponseObservation.DEFAULT_UNKNOWN_ACTIVITY_MIN_AGE_MS);
  assert.equal(settled.complete, true);
});

test('recorded explicit settled evidence completes without a generic quiet wait', () => {
  const observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'assistant-1',
      text: 'OK',
      identityQualified: true,
      explicitlySettled: true,
    },
    10,
  );

  assert.equal(observation.complete, true);
  assert.equal(observation.reason, 'recorded_activity_settled');
});

test('a static inactive marker cannot complete a response before streaming was observed', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'assistant-1',
      text: 'partial',
      identityQualified: true,
      streaming: false,
      explicitlySettled: true,
      streamingSeen: false,
    },
    100,
  );
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'partial',
    identityQualified: true,
    streaming: true,
    explicitlySettled: false,
    streamingSeen: true,
  }, 200);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'complete',
    identityQualified: true,
    streaming: false,
    explicitlySettled: true,
    streamingSeen: false,
  }, 300);
  assert.equal(observation.complete, true);
  assert.equal(observation.reason, 'recorded_activity_settled');
});

test('a seen generation signal must stop before quiet settlement can complete', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'assistant-1',
      text: 'working',
      identityQualified: true,
      streaming: true,
    },
    0,
  );
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'working',
    identityQualified: true,
    streaming: false,
  }, ResponseObservation.DEFAULT_RESPONSE_QUIET_MS * 2);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'working',
    identityQualified: true,
    streaming: false,
  }, ResponseObservation.DEFAULT_RESPONSE_QUIET_MS * 3);
  assert.equal(observation.complete, true);
  assert.equal(observation.reason, 'page_activity_stopped');
});

test('recorded body specificity wins over a longer identity container projection', () => {
  const chosen = ResponseObservation.selectRecordedProjection([
    {
      text: 'Question ACK_CURRENT Search results Recommended questions',
      specificity: 0,
      depth: 4,
      index: 2,
    },
    {
      text: 'ACK_CURRENT',
      specificity: 2,
      depth: 8,
      index: 1,
    },
  ]);

  assert.equal(chosen.text, 'ACK_CURRENT');
});

test('direct recorded body projections suppress same-identity fallback descendants', () => {
  const directBody = { id: 'direct-body', identity: 'assistant-1', text: 'ACK_COMPLETE' };
  const fallbackFragments = [
    { id: 'fallback-status', identity: 'assistant-1', text: 'OK' },
    { id: 'fallback-prefix', identity: 'assistant-1', text: 'ACK_COMPL' },
  ];

  const regions = ResponseObservation.mergeRecordedRegionElements(
    [directBody],
    fallbackFragments,
    item => item.identity,
  );

  assert.deepEqual(regions, [directBody]);
});

test('recorded region fallback remains available for identities without a direct body projection', () => {
  const directBody = { id: 'direct-old', identity: 'assistant-old', text: 'OLD' };
  const fallbackNew = { id: 'fallback-new', identity: 'assistant-new', text: 'NEW' };

  const regions = ResponseObservation.mergeRecordedRegionElements(
    [directBody],
    [
      { id: 'fallback-old', identity: 'assistant-old', text: 'OLD CHILD' },
      fallbackNew,
    ],
    item => item.identity,
  );

  assert.deepEqual(regions, [directBody, fallbackNew]);
});

test('equally recorded body projections prefer the more specific descendant, not longest text', () => {
  const chosen = ResponseObservation.selectRecordedProjection([
    { text: 'outer status plus ACK_CURRENT', specificity: 2, depth: 5, index: 1 },
    { text: 'ACK_CURRENT', specificity: 2, depth: 7, index: 2 },
  ]);

  assert.equal(chosen.text, 'ACK_CURRENT');
});

test('same-identity prefix regression cannot settle as a truncated response', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'attribute:data-message-id=assistant-1',
      text: 'DIAGYIY',
      identityQualified: true,
      streaming: false,
      explicitlySettled: false,
    },
    1_000,
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'attribute:data-message-id=assistant-1',
    text: 'DI',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 20_000);

  assert.equal(observation.projectionRegressed, true);
  assert.equal(observation.complete, false);
  assert.equal(observation.state.text, 'DIAGYIY');

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'attribute:data-message-id=assistant-1',
    text: 'DI',
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 30_000);

  assert.equal(observation.projectionRegressed, true);
  assert.equal(observation.complete, false);
  assert.equal(observation.state.text, 'DIAGYIY');
});

test('same-identity body may recover from a prefix regression and settle after new growth', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'attribute:data-message-id=assistant-1',
      text: 'DIAGYIY',
      identityQualified: true,
    },
    1_000,
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'attribute:data-message-id=assistant-1',
    text: 'DI',
    identityQualified: true,
  }, 10_000);
  assert.equal(observation.projectionRegressed, true);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'attribute:data-message-id=assistant-1',
    text: 'DIAGYIYAN202608141517',
    identityQualified: true,
  }, 11_000);
  assert.equal(observation.projectionRegressed, false);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'attribute:data-message-id=assistant-1',
    text: 'DIAGYIYAN202608141517',
    identityQualified: true,
  }, 14_000);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'attribute:data-message-id=assistant-1',
    text: 'DIAGYIYAN202608141517',
    identityQualified: true,
  }, 15_000);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'attribute:data-message-id=assistant-1',
    text: 'DIAGYIYAN202608141517',
    identityQualified: true,
  }, 19_000);
  assert.equal(observation.complete, true);
});

test('a shorter body after a long same-identity gap is a regression even when text is unrelated', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'assistant-1',
      text: 'WAIT',
      identityQualified: true,
    },
    1_000,
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'PRO',
    identityQualified: true,
  }, 10_000);

  assert.equal(observation.projectionRegressed, true);
  assert.equal(observation.complete, false);
  assert.equal(observation.state.text, 'WAIT');
  assert.equal(observation.state.discontinuous, true);
});

test('an unknown-activity response cannot settle after a long projection gap until it exceeds the prior maximum', () => {
  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key: 'assistant-1',
      text: 'ABCD',
      identityQualified: true,
    },
    1_000,
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'WXYZ',
    identityQualified: true,
  }, 10_000);
  assert.equal(observation.projectionRegressed, false);
  assert.equal(observation.state.discontinuous, true);

  for (const now of [11_000, 14_000, 20_000]) {
    observation = ResponseObservation.observeCompletion(observation.state, {
      key: 'assistant-1',
      text: 'WXYZ',
      identityQualified: true,
    }, now);
    assert.equal(observation.complete, false);
    assert.equal(observation.state.discontinuous, true);
  }

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'WXYZ1',
    identityQualified: true,
  }, 21_000);
  assert.equal(observation.state.discontinuous, false);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'WXYZ1',
    identityQualified: true,
  }, 25_000);
  assert.equal(observation.complete, false);

  observation = ResponseObservation.observeCompletion(observation.state, {
    key: 'assistant-1',
    text: 'WXYZ1',
    identityQualified: true,
  }, 29_000);
  assert.equal(observation.complete, true);
});

test('a stable full response is not marked discontinuous by an observation gap alone', () => {
  const key = 'attribute:data-message-id=assistant-full-1';
  const text = 'ACK_FULL_RESPONSE_AFTER_BROWSER_GAP';

  let observation = ResponseObservation.observeCompletion(
    ResponseObservation.createCompletionState(),
    {
      key,
      text,
      identityQualified: true,
      streaming: false,
      explicitlySettled: false,
    },
    1_000,
  );

  observation = ResponseObservation.observeCompletion(observation.state, {
    key,
    text,
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 1_000 + ResponseObservation.DEFAULT_OBSERVATION_GAP_MS + 1);

  assert.equal(observation.state.discontinuous, false);
  assert.equal(observation.complete, false, 'the conservative age and quiet gates still apply');

  observation = ResponseObservation.observeCompletion(observation.state, {
    key,
    text,
    identityQualified: true,
    streaming: false,
    explicitlySettled: false,
  }, 1_000 + ResponseObservation.DEFAULT_UNKNOWN_ACTIVITY_MIN_AGE_MS);

  assert.equal(observation.complete, true);
  assert.equal(observation.reason, 'conservative_unknown_activity_settlement');
});
