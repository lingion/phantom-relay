const assert = require('node:assert/strict');
const test = require('node:test');

const Lifecycle = require('../extension/profile_lifecycle.js');
const Health = require('../extension/profile_health.js');
const { validProfile } = require('./fixtures/profile_lifecycle.js');
const {
  validPageProfile,
  profileWithMissingIdentity,
  profileWithMissingInput,
  profileWithMissingResponse
} = require('./fixtures/profile_health.js');

test('health check is verified for a complete provider-neutral profile', () => {
  const report = Health.runProfileHealthCheck(validPageProfile());
  assert.equal(report.state, 'verified');
  assert.deepEqual(report.checks, {
    input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass'
  });
  assert.deepEqual(report.reason_codes, []);
});

function visibleElement(selector, attributes = {}) {
  return {
    disabled: false,
    isConnected: true,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) } },
    getClientRects: () => [{}],
    matches: (candidate) => candidate === selector || candidate === 'textarea,input,[contenteditable="true"],[role="textbox"]',
    getAttribute: (name) => attributes[name] ?? null
  };
}

function blankConversationDocument() {
  const input = visibleElement('#prompt');
  const send = visibleElement('#send');
  return {
    querySelectorAll(selector) {
      if (selector === '#prompt') return [input];
      if (selector === '#send') return [send];
      if (selector === '[data-message-id]') return [];
      if (selector === '[data-streaming="true"]') return [];
      if (selector === '[aria-busy="true"]') return [];
      return [];
    }
  };
}

test('empty new conversation accepts a valid response contract for execution readiness', () => {
  const documentLike = blankConversationDocument();
  const strict = Health.runProfileHealthCheck(validPageProfile(), { document: documentLike });
  assert.equal(strict.state, 'invalid');
  assert.ok(strict.reason_codes.includes(Lifecycle.PROFILE_HEALTH_REASONS.RESPONSE_UNAVAILABLE));

  const ready = Health.runProfileHealthCheck(validPageProfile(), {
    document: documentLike,
    allowMissingResponse: true
  });
  assert.equal(ready.state, 'verified');
  assert.deepEqual(ready.checks, {
    input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass'
  });
  assert.deepEqual(ready.reason_codes, []);
});

test('execution readiness ignores visible response candidates without message identity when response is absent', () => {
  const documentLike = blankConversationDocument();
  const genericCandidates = [
    visibleElement('.layout-node'),
    visibleElement('.layout-node')
  ];
  const originalQuerySelectorAll = documentLike.querySelectorAll;
  documentLike.querySelectorAll = (selector) => {
    if (selector === '.layout-node') return genericCandidates;
    if (selector === '[data-message-id]') return [];
    return originalQuerySelectorAll(selector);
  };
  const profile = validProfile({
    response: {
      selector: '.layout-node',
      identity: { attributes: ['data-message-id'] },
      identityVerification: { status: 'verified', method: 'fixture-dom-unique', attributes: ['data-message-id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });

  const strict = Health.runProfileHealthCheck(profile, { document: documentLike });
  assert.equal(strict.state, 'invalid');
  assert.equal(strict.checks.identity, 'fail');

  const report = Health.runProfileHealthCheck(profile, {
    document: documentLike,
    allowMissingResponse: true,
    requireRecordedIdentity: true
  });

  assert.equal(report.state, 'verified');
  assert.equal(report.checks.identity, 'pass');
  assert.deepEqual(report.reason_codes, []);
});

test('empty new conversation rejects a legacy profile without recorded identity evidence', () => {
  const legacy = validPageProfile();
  delete legacy.response.identityVerification;
  const report = Health.runProfileHealthCheck(legacy, {
    document: blankConversationDocument(),
    allowMissingResponse: true,
    requireRecordedIdentity: true
  });
  assert.equal(report.state, 'invalid');
  assert.equal(report.checks.input, 'pass');
  assert.equal(report.checks.response, 'pass');
  assert.equal(report.checks.identity, 'fail');
  assert.ok(report.reason_codes.includes(Lifecycle.PROFILE_HEALTH_REASONS.IDENTITY_EVIDENCE_MISSING));
});

test('idle disabled send button does not invalidate execution readiness', () => {
  const documentLike = blankConversationDocument();
  documentLike.querySelectorAll('#send')[0].disabled = true;
  const report = Health.runProfileHealthCheck(validPageProfile(), {
    document: documentLike,
    allowMissingResponse: true
  });
  assert.equal(report.state, 'verified');
  assert.equal(report.checks.send, 'pass');
});

test('missing input returns a bounded input reason', () => {
  const report = Health.runProfileHealthCheck(profileWithMissingInput());
  assert.equal(report.state, 'invalid');
  assert.ok(report.reason_codes.includes(Lifecycle.PROFILE_HEALTH_REASONS.INPUT_UNAVAILABLE));
});

test('missing response returns a bounded response reason', () => {
  const report = Health.runProfileHealthCheck(profileWithMissingResponse());
  assert.equal(report.state, 'invalid');
  assert.ok(report.reason_codes.includes(Lifecycle.PROFILE_HEALTH_REASONS.RESPONSE_UNAVAILABLE));
});

test('missing response identity fails closed', () => {
  const report = Health.runProfileHealthCheck(profileWithMissingIdentity());
  assert.equal(report.state, 'invalid');
  assert.ok(report.reason_codes.includes(Lifecycle.PROFILE_HEALTH_REASONS.IDENTITY_UNAVAILABLE));
});

test('identity health checks the declared stable response container', () => {
  const child = visibleElement('.answer-text');
  const container = visibleElement('[data-message-id]', { 'data-message-id': 'message-1' });
  child.closest = (selector) => selector === '[data-message-id]' ? container : null;
  const documentLike = {
    querySelectorAll(selector) {
      if (selector === '#prompt') return [visibleElement('#prompt')];
      if (selector === '#send') return [visibleElement('#send')];
      if (selector === '.answer-text') return [child];
      if (selector === '[data-message-id]') return [container];
      if (selector === '[data-streaming="true"]') return [];
      return [];
    }
  };
  const profile = validProfile({
    response: {
      selector: '.answer-text',
      containerSelector: '[data-message-id]',
      identity: { attributes: ['data-message-id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });
  const report = Health.runProfileHealthCheck(profile, { document: documentLike });
  assert.equal(report.checks.identity, 'pass');
});

test('identity health resolves stable identity from ancestors of a broad response selector', () => {
  const firstContainer = visibleElement('[data-message-id]', { 'data-message-id': 'message-1' });
  const secondContainer = visibleElement('[data-message-id]', { 'data-message-id': 'message-2' });
  const firstProjection = visibleElement('div > div');
  const secondProjection = visibleElement('div > div');
  firstProjection.parentElement = firstContainer;
  secondProjection.parentElement = secondContainer;
  const documentLike = {
    querySelectorAll(selector) {
      if (selector === '#prompt') return [visibleElement('#prompt')];
      if (selector === '#send') return [visibleElement('#send')];
      if (selector === 'div > div') return [firstProjection, secondProjection];
      if (selector === '[data-streaming="true"]') return [];
      if (selector === '[aria-busy="true"]') return [];
      return [];
    }
  };
  const profile = validProfile({
    response: {
      selector: 'div > div',
      identity: { attributes: ['data-message-id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });

  const report = Health.runProfileHealthCheck(profile, { document: documentLike });
  assert.equal(report.checks.identity, 'pass');
});

test('health rejects a response selector whose identity node contains multiple identity descendants', () => {
  const root = visibleElement('#conversation-root', { id: 'conversation-root' });
  const firstMessage = visibleElement('[id]', { id: 'message-1' });
  const secondMessage = visibleElement('[id]', { id: 'message-2' });
  root.querySelectorAll = (selector) => selector === '[id]' ? [firstMessage, secondMessage] : [];
  const documentLike = {
    querySelectorAll(selector) {
      if (selector === '#prompt') return [visibleElement('#prompt')];
      if (selector === '#send') return [visibleElement('#send')];
      if (selector === '#conversation-root') return [root];
      if (selector === '[data-streaming="true"]') return [];
      if (selector === '[aria-busy="true"]') return [];
      return [];
    }
  };
  const profile = validProfile({
    response: {
      selector: '#conversation-root',
      identity: { attributes: ['id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });

  const report = Health.runProfileHealthCheck(profile, { document: documentLike });
  assert.equal(report.checks.response, 'fail');
  assert.ok(report.reason_codes.includes('profile_response_scope_too_broad'));
});

test('identity health fails closed when visible response containers reuse one identity value', () => {
  const first = visibleElement('.answer', { id: '1' });
  const second = visibleElement('.answer', { id: '1' });
  const documentLike = {
    querySelectorAll(selector) {
      if (selector === '#prompt') return [visibleElement('#prompt')];
      if (selector === '#send') return [visibleElement('#send')];
      if (selector === '.answer') return [first, second];
      if (selector === '[data-streaming=\"true\"]') return [];
      if (selector === '[aria-busy=\"true\"]') return [];
      return [];
    }
  };
  const profile = validProfile({
    response: {
      selector: '.answer',
      containerSelector: '.answer',
      identity: { attributes: ['id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });
  const report = Health.runProfileHealthCheck(profile, { document: documentLike });
  assert.equal(report.state, 'invalid');
  assert.equal(report.checks.identity, 'fail');
  assert.ok(report.reason_codes.includes(Lifecycle.PROFILE_HEALTH_REASONS.IDENTITY_UNAVAILABLE));
});

test('selector-position identity must be complete and unique across every visible response', () => {
  const first = visibleElement('.answer');
  const second = visibleElement('.answer');
  const documentLike = {
    querySelectorAll(selector) {
      if (selector === '#prompt') return [visibleElement('#prompt')];
      if (selector === '#send') return [visibleElement('#send')];
      if (selector === '.answer') return [first, second];
      if (selector === '[data-is-typing="true"]') return [];
      return [];
    }
  };
  const profile = validProfile({
    response: {
      selector: '.answer',
      identity: { path: 'recordedResponseIndex' },
      identityVerification: {
        status: 'verified',
        method: 'selector-index-at-recording',
        identityKind: 'selector-position',
        attributes: []
      },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ selector: '[data-is-typing="true"]', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });

  const missing = Health.runProfileHealthCheck(profile, {
    document: documentLike,
    identityProbe: element => element === first ? '' : 'path:recordedResponseIndex=1'
  });
  assert.equal(missing.checks.identity, 'fail');

  const duplicate = Health.runProfileHealthCheck(profile, {
    document: documentLike,
    identityProbe: () => 'path:recordedResponseIndex=0'
  });
  assert.equal(duplicate.checks.identity, 'fail');

  const unique = Health.runProfileHealthCheck(profile, {
    document: documentLike,
    identityProbe: element => element === first
      ? 'path:recordedResponseIndex=0'
      : 'path:recordedResponseIndex=1'
  });
  assert.equal(unique.checks.identity, 'pass');
});

test('network-only health treats network capture as the response and identity boundary', () => {
  const report = Health.runProfileHealthCheck({
    profileId: 'network-profile',
    input: { selector: '#prompt' },
    send: { kind: 'enter', key: 'Enter' },
    capture: { mode: 'network' }
  });
  assert.equal(report.state, 'verified');
  assert.deepEqual(report.checks, {
    input: 'pass', send: 'pass', response: 'pass', identity: 'pass', streaming: 'pass'
  });
  assert.deepEqual(report.reason_codes, []);
});

test('health reports and errors contain no page or conversation content', () => {
  const error = Health.profileHealthError(Health.runProfileHealthCheck(profileWithMissingResponse()));
  const serialized = JSON.stringify(error);
  for (const forbidden of ['pageText', 'prompt', 'assistant_text', 'cookie', 'localStorage', 'sessionStorage', 'authorization']) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
  }
});
