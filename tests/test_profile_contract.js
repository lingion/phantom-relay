const assert = require('node:assert/strict');
const test = require('node:test');

const Profile = require('../extension/profile_contract.js');

function profile(overrides = {}) {
  return {
    profileId: 'fixture-a-v1',
    origin: 'https://fixture-a.test',
    domain: 'fixture-a.test',
    input: { selector: '#prompt', kind: 'textarea' },
    send: { kind: 'button', selector: '#send' },
    response: {
      selector: '[data-message-id]',
      identity: { attributes: ['data-message-id'] },
      identityVerification: { status: 'verified', method: 'fixture-dom-unique', attributes: ['data-message-id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: ['[data-action="copy"]'],
      textNormalization: [
        { kind: 'trim' },
        { kind: 'collapse-whitespace' },
        { kind: 'remove-text', value: '[copy]' }
      ]
    },
    capabilities: { text: true, streaming: 'dom-snapshot' },
    ...overrides
  };
}

test('normalizes a provider-neutral recorded profile', () => {
  const normalized = Profile.normalizeProfile(profile());

  assert.equal(normalized.profileId, 'fixture-a-v1');
  assert.deepEqual(normalized.response.identity.attributes, ['data-message-id']);
  assert.deepEqual(normalized.response.identityVerification, {
    status: 'verified',
    method: 'fixture-dom-unique',
    attributes: ['data-message-id']
  });
  assert.deepEqual(normalized.response.streamingIndicators, [{ field: 'busy', equals: true }]);
  assert.deepEqual(normalized.response.excludedSelectors, ['[data-action="copy"]']);
  assert.deepEqual(normalized.response.textNormalization, [
    { kind: 'trim' },
    { kind: 'collapse-whitespace' },
    { kind: 'remove-text', value: '[copy]' }
  ]);
});

test('can replace a recorded response selector without changing identity evidence', () => {
  const original = Profile.normalizeProfile(profile());
  const updated = Profile.withResponseSelector(original, {
    selector: '.answer-region',
    alternatives: ['[data-answer]'],
  });

  assert.deepEqual(updated.response.selector, {
    css: '.answer-region',
    alternatives: ['[data-answer]'],
  });
  assert.deepEqual(updated.response.identity, original.response.identity);
  assert.deepEqual(updated.response.identityVerification, original.response.identityVerification);
  assert.equal(updated.profileId, original.profileId);
});

test('accepts selector-based streaming indicators emitted by the recorder', () => {
  const normalized = Profile.normalizeProfile(profile({
    response: {
      selector: '[data-message-id]',
      identity: { attributes: ['data-message-id'] },
      streamingIndicators: [
        { selector: '[data-streaming="true"]', equals: true },
        { selector: '[aria-busy="true"]', equals: true }
      ]
    }
  }));

  assert.deepEqual(normalized.response.streamingIndicators, [
    { selector: '[data-streaming="true"]', equals: true },
    { selector: '[aria-busy="true"]', equals: true }
  ]);
});

test('selector streaming state distinguishes explicit completion from an absent marker', () => {
  const normalized = Profile.normalizeProfile(profile({
    response: {
      selector: '.recorded-response',
      identity: { attributes: ['data-message-id'] },
      streamingIndicators: [
        { selector: '[data-is-typing="true"]', equals: true }
      ]
    }
  }));

  assert.deepEqual(Profile.streamingState(normalized, {
    indicatorStates: [{
      selector: '[data-is-typing="true"]',
      observed: true,
      matched: true,
    }]
  }), { active: true, explicitlySettled: false });

  assert.deepEqual(Profile.streamingState(normalized, {
    indicatorStates: [{
      selector: '[data-is-typing="true"]',
      observed: true,
      matched: false,
    }]
  }), { active: false, explicitlySettled: true });

  assert.deepEqual(Profile.streamingState(normalized, { indicatorStates: [] }), {
    active: false,
    explicitlySettled: false,
  });
});

test('fails closed when response ownership is not declared', () => {
  assert.throws(
    () => Profile.normalizeProfile(profile({ response: { selector: '[data-message]' } })),
    (error) => error && error.code === 'response_contract_missing'
  );
});

test('rejects analytics and telemetry attributes as response identity', () => {
  assert.throws(
    () => Profile.normalizeProfile(profile({
      response: {
        selector: '[data-spm-anchor-id]',
        identity: { attributes: ['data-spm-anchor-id'] },
        identityVerification: {
          status: 'verified',
          method: 'fixture-dom-unique',
          attributes: ['data-spm-anchor-id']
        }
      }
    })),
    error => error && error.code === 'response_identity_attribute_invalid'
  );
});

test('rejects layout and panel attributes as response identity', () => {
  for (const attribute of ['data-panel-id', 'data-layout-key', 'data-container-id', 'data-viewport-id']) {
    assert.throws(
      () => Profile.normalizeProfile(profile({
        response: {
          selector: '.markdown-text',
          identity: { attributes: [attribute] },
          identityVerification: {
            status: 'verified',
            method: 'fixture-dom-unique',
            attributes: [attribute]
          }
        }
      })),
      error => error && error.code === 'response_identity_attribute_invalid',
      attribute
    );
  }
});

test('rejects transient generation state attributes as response identity', () => {
  for (const attribute of [
    'data-is-typing',
    'data-generating',
    'data-thinking',
    'data-processing',
    'data-pending',
    'data-completed',
    'data-active',
    'data-selected',
  ]) {
    assert.equal(Profile.stableIdentityAttribute(attribute), false, attribute);
    assert.throws(
      () => Profile.normalizeProfile(profile({
        response: {
          selector: '.markdown-response',
          identity: { attributes: [attribute] },
          identityVerification: {
            status: 'verified',
            method: 'dom-unique-at-recording',
            attributes: [attribute]
          }
        }
      })),
      error => error && error.code === 'response_identity_attribute_invalid',
      attribute
    );
  }
});

test('accepts selector-position identity when no stable message attribute exists', () => {
  const normalized = Profile.normalizeProfile(profile({
    response: {
      selector: '.markdown-response',
      identity: { path: 'recordedResponseIndex' },
      identityVerification: {
        status: 'verified',
        method: 'selector-index-at-recording',
        identityKind: 'selector-position',
        attributes: []
      },
      streamingIndicators: [{ selector: '[data-is-typing="true"]', equals: true }]
    }
  }));

  assert.equal(normalized.response.identity.path, 'recordedResponseIndex');
  assert.equal(normalized.response.identityVerification.method, 'selector-index-at-recording');
  assert.equal(
    Profile.messageIdentity(normalized, { recordedResponseIndex: 2 }),
    'path:recordedResponseIndex=2'
  );
});

test('rejects response selectors that freeze generated message ids but keeps stable ids', () => {
  assert.throws(
    () => Profile.normalizeProfile(profile({
      response: {
        selector: '#chat-response-message-bcd2d3ef-4119-4a7c-a33e-064b3aa476e7',
        identity: { attributes: ['id'] },
        identityVerification: {
          status: 'verified',
          method: 'fixture-dom-unique',
          attributes: ['id']
        }
      }
    })),
    error => error && error.code === 'response_selector_volatile'
  );

  const normalized = Profile.normalizeProfile(profile({
    response: {
      selector: '#assistant-2',
      identity: { attributes: ['id'] },
      identityVerification: {
        status: 'verified',
        method: 'fixture-dom-unique',
        attributes: ['id']
      }
    }
  }));
  assert.equal(normalized.response.selector.css, '#assistant-2');
});

test('rejects a structural conversation boundary even when its id is unique', () => {
  assert.throws(
    () => Profile.normalizeProfile(profile({
      response: {
        selector: '#conversation-flow-container',
        identity: { attributes: ['id'] },
        identityVerification: {
          status: 'verified',
          method: 'dom-unique-at-recording',
          attributes: ['id']
        }
      }
    })),
    error => error && error.code === 'response_selector_structural'
  );
});

test('rejects plain id identity when the response boundary does not bind a specific id', () => {
  assert.throws(
    () => Profile.normalizeProfile(profile({
      response: {
        selector: 'span.markdown-text',
        containerSelector: 'div.message-list',
        identity: { attributes: ['id'] },
        identityVerification: {
          status: 'verified',
          method: 'fixture-dom-unique',
          attributes: ['id']
        }
      }
    })),
    error => error && error.code === 'response_identity_ambiguous'
  );
});

test('accepts a dynamic per-message id when it is scoped by a semantic response boundary', () => {
  const normalized = Profile.normalizeProfile(profile({
    response: {
      selector: 'span.markdown-text',
      containerSelector: 'div.chat-response-message',
      identity: { attributes: ['id'] },
      identityVerification: {
        status: 'verified',
        method: 'dom-unique-at-recording',
        identityKind: 'unique-per-message',
        attributes: ['id']
      }
    }
  }));

  assert.equal(normalized.response.identity.attributes[0], 'id');
  assert.equal(normalized.response.identityVerification.identityKind, 'unique-per-message');
});

test('network-only profile can omit the DOM response region but requires a capture contract', () => {
  const normalized = Profile.normalizeProfile(profile({
    response: {},
    capture: {
      mode: 'network',
      response: {
        url: { origins: ['https://capture.fixture.test'], pathPatterns: ['/stream/*'] },
        mimeTypes: ['text/event-stream']
      },
      parser: {
        eventFormat: 'sse',
        textRules: [{ eventPath: '/type', eventEquals: 'delta', valuePath: '/text', mode: 'append' }],
        finishRules: [{ eventPath: '/type', eventEquals: 'done' }]
      }
    }
  }));

  assert.equal(normalized.capture.mode, 'network');
  assert.equal(normalized.response.selector, null);
  assert.equal(normalized.response.identity, undefined);
});

test('network-only profile fails closed without terminal parsing semantics', () => {
  assert.throws(
    () => Profile.normalizeProfile(profile({
      response: {},
      capture: {
        mode: 'network',
        response: {
          url: { origins: ['https://capture.fixture.test'], pathPatterns: ['/stream/*'] },
          mimeTypes: ['text/event-stream']
        },
        parser: {
          eventFormat: 'sse',
          textRules: [{ valuePath: '/text', mode: 'append' }]
        }
      }
    })),
    error => error && error.code === 'capture_contract_incomplete'
  );
});

test('hybrid profile retains a recorded DOM boundary alongside network capture', () => {
  const normalized = Profile.normalizeProfile(profile({
    response: {
      selector: '[data-message-id]',
      identity: { attributes: ['data-message-id'] }
    },
    capture: {
      mode: 'hybrid',
      response: {
        url: { origins: ['https://capture.fixture.test'], pathPatterns: ['/stream/*'] },
        mimeTypes: ['text/event-stream']
      },
      parser: {
        eventFormat: 'sse',
        textRules: [{ eventPath: '/type', eventEquals: 'delta', valuePath: '/text', mode: 'append' }],
        finishRules: [{ eventPath: '/type', eventEquals: 'done' }]
      }
    }
  }));

  assert.equal(normalized.capture.mode, 'hybrid');
  assert.equal(normalized.response.selector.css, '[data-message-id]');
  assert.deepEqual(normalized.response.identity.attributes, ['data-message-id']);
});

test('hybrid profile fails closed when its DOM fallback has no identity', () => {
  assert.throws(
    () => Profile.normalizeProfile(profile({
      response: { selector: '[data-message]' },
      capture: {
        mode: 'hybrid',
        response: {
          url: { origins: ['https://capture.fixture.test'], pathPatterns: ['/stream/*'] },
          mimeTypes: ['text/event-stream']
        },
        parser: {
          eventFormat: 'sse',
          textRules: [{ valuePath: '/text', mode: 'append' }],
          finishRules: [{ eventPath: '/type', eventEquals: 'done' }]
        }
      }
    })),
    error => error && error.code === 'response_contract_missing'
  );
});

test('different profiles drive the same reducer without provider branches', () => {
  const profileA = Profile.normalizeProfile(profile());
  const profileB = Profile.normalizeProfile(profile({
    profileId: 'fixture-b-v1',
    origin: 'https://fixture-b.test',
    domain: 'fixture-b.test',
    input: { selector: '[contenteditable="true"]', kind: 'contenteditable' },
    send: { kind: 'enter', key: 'Enter', modifiers: [] },
    response: {
      selector: '[data-row-key]',
      identity: { attributes: ['data-row-key'] },
      role: { assistant: ['model'] },
      streamingIndicators: [{ field: 'loading', equals: true }],
      excludedSelectors: ['[data-toolbar]'],
      textNormalization: [{ kind: 'trim' }, { kind: 'collapse-whitespace' }]
    }
  }));

  const nodesA = [
    { attributes: { 'data-message-id': 'old' }, role: 'assistant', busy: false, text: 'old' },
    { attributes: { 'data-message-id': 'answer-1' }, role: 'assistant', busy: false, text: '  Hello   world [copy]  ' }
  ];
  const nodesB = [
    { attributes: { 'data-row-key': 'old' }, role: 'model', loading: false, text: 'old' },
    { attributes: { 'data-row-key': 'answer-1' }, role: 'model', loading: false, text: '  Hello   world  ' }
  ];

  assert.deepEqual(Profile.reduceMessages(profileA, nodesA), [
    { key: 'attribute:data-message-id=old', role: 'assistant', streaming: false, text: 'old' },
    { key: 'attribute:data-message-id=answer-1', role: 'assistant', streaming: false, text: 'Hello world' }
  ]);
  assert.deepEqual(Profile.reduceMessages(profileB, nodesB), [
    { key: 'attribute:data-row-key=old', role: 'assistant', streaming: false, text: 'old' },
    { key: 'attribute:data-row-key=answer-1', role: 'assistant', streaming: false, text: 'Hello world' }
  ]);
});

test('same logical identity preserves text growth and streaming state', () => {
  const normalized = Profile.normalizeProfile(profile());
  const first = Profile.reduceMessages(normalized, [
    { attributes: { 'data-message-id': 'answer-1' }, role: 'assistant', busy: true, text: 'Hel' }
  ]);
  const second = Profile.reduceMessages(normalized, [
    { attributes: { 'data-message-id': 'answer-1' }, role: 'assistant', busy: false, text: 'Hello' }
  ]);

  assert.deepEqual(first[0], {
    key: 'attribute:data-message-id=answer-1', role: 'assistant', streaming: true, text: 'Hel'
  });
  assert.deepEqual(second[0], {
    key: 'attribute:data-message-id=answer-1', role: 'assistant', streaming: false, text: 'Hello'
  });
});
