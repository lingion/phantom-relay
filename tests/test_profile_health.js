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
    getClientRects: () => [{ left: 20, top: 20, right: 220, bottom: 60, width: 200, height: 40 }],
    getBoundingClientRect: () => ({ left: 20, top: 20, right: 220, bottom: 60, width: 200, height: 40 }),
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

function interactiveInputDocument(overrides = {}) {
  const attributes = { ...(overrides.attributes || {}) };
  const style = {
    visibility: 'visible',
    display: 'block',
    opacity: '1',
    pointerEvents: 'auto',
    ...(overrides.style || {})
  };
  const rect = overrides.rect || {
    left: 20,
    top: 20,
    right: 220,
    bottom: 60,
    width: 200,
    height: 40
  };
  const documentLike = {
    defaultView: {
      innerWidth: 1280,
      innerHeight: 720,
      getComputedStyle: () => style
    },
    querySelectorAll(selector) {
      if (selector === '#prompt') return [input];
      if (selector === '#send') return [visibleElement('#send')];
      if (selector === '[data-message-id]') return [];
      if (selector === '[data-streaming="true"]') return [];
      if (selector === '[aria-busy="true"]') return [];
      return [];
    },
    elementFromPoint() {
      return overrides.hitTarget === 'overlay' ? overlay :
        overrides.hitTarget === 'child' ? child : input;
    }
  };
  const child = { parentElement: null };
  const overlay = { parentElement: null };
  const input = {
    disabled: !!overrides.disabled,
    readOnly: !!overrides.readOnly,
    inert: !!overrides.inert,
    isConnected: overrides.isConnected !== false,
    ownerDocument: documentLike,
    parentElement: null,
    getClientRects: () => overrides.noRects ? [] : [rect],
    getBoundingClientRect: () => rect,
    matches: candidate => candidate === '#prompt' ||
      candidate === 'textarea,input,[contenteditable="true"],[role="textbox"]',
    getAttribute: name => attributes[name] ?? null,
    hasAttribute: name => Object.prototype.hasOwnProperty.call(attributes, name),
    closest: selector => selector === '[inert]' && overrides.inertAncestor ? {} : null,
    contains: node => node === child
  };
  child.parentElement = input;
  return { documentLike, input, child, overlay };
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

test('execution readiness rejects a recorded input covered by another page layer', () => {
  const { documentLike } = interactiveInputDocument({ hitTarget: 'overlay' });
  const report = Health.runProfileHealthCheck(validPageProfile(), {
    document: documentLike,
    allowMissingResponse: true
  });

  assert.equal(report.state, 'invalid');
  assert.equal(report.checks.input, 'fail');
  assert.ok(report.reason_codes.includes('recorded_input_not_interactable'));
});

test('execution readiness accepts hit testing on the recorded input or its descendant', () => {
  for (const hitTarget of ['input', 'child']) {
    const { documentLike } = interactiveInputDocument({ hitTarget });
    const report = Health.runProfileHealthCheck(validPageProfile(), {
      document: documentLike,
      allowMissingResponse: true
    });

    assert.equal(report.checks.input, 'pass', `expected ${hitTarget} hit target to remain usable`);
    assert.equal(report.state, 'verified');
  }
});

test('execution readiness rejects disconnected, hidden, disabled, readonly, inert, and zero-size inputs', () => {
  const cases = [
    ['disconnected', { isConnected: false }],
    ['hidden', { style: { visibility: 'hidden' } }],
    ['disabled', { disabled: true }],
    ['readonly', { readOnly: true }],
    ['aria-disabled', { attributes: { 'aria-disabled': 'true' } }],
    ['aria-readonly', { attributes: { 'aria-readonly': 'true' } }],
    ['inert', { inert: true }],
    ['inert ancestor', { inertAncestor: true }],
    ['zero size', { rect: { left: 20, top: 20, right: 20, bottom: 20, width: 0, height: 0 } }],
    ['no rects', { noRects: true }]
  ];

  for (const [name, overrides] of cases) {
    const { documentLike } = interactiveInputDocument(overrides);
    const report = Health.runProfileHealthCheck(validPageProfile(), {
      document: documentLike,
      allowMissingResponse: true
    });

    assert.equal(report.checks.input, 'fail', `expected ${name} input to fail closed`);
    assert.ok(report.reason_codes.includes('recorded_input_not_interactable'));
  }
});

test('execution readiness rejects visible response candidates without message identity', () => {
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

  assert.equal(report.state, 'invalid');
  assert.equal(report.checks.identity, 'fail');
  assert.ok(report.reason_codes.includes(Lifecycle.PROFILE_HEALTH_REASONS.IDENTITY_UNAVAILABLE));
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
