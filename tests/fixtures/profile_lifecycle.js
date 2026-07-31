const BASE_PROFILE = {
  profileId: 'fixture-profile-v1',
  origin: 'https://fixture.example/chat',
  domain: 'fixture.example',
  input: { selector: '#prompt', kind: 'textarea' },
  send: { kind: 'button', selector: '#send' },
  response: {
    selector: '[data-message-id]',
    identity: { attributes: ['data-message-id'] },
    role: { assistant: ['assistant'] },
    streamingIndicators: [{ field: 'busy', equals: true }],
    excludedSelectors: [],
    textNormalization: [{ kind: 'trim' }]
  },
  capabilities: { text: true, streaming: 'dom-snapshot' }
};

function validProfile(overrides = {}) {
  return { ...BASE_PROFILE, ...overrides };
}

module.exports = { BASE_PROFILE, validProfile };
