const { validProfile } = require('./profile_lifecycle.js');

function validPageProfile() {
  return validProfile({
    response: {
      selector: '[data-message-id]',
      identity: { attributes: ['data-message-id'] },
      role: { assistant: ['assistant'] },
      streamingIndicators: [{ field: 'busy', equals: true }],
      excludedSelectors: [],
      textNormalization: [{ kind: 'trim' }]
    }
  });
}

function profileWithMissingIdentity() {
  return validProfile({ response: { selector: '[data-message-id]' } });
}

function profileWithMissingInput() {
  return validProfile({ input: null });
}

function profileWithMissingResponse() {
  return validProfile({ response: {} });
}

module.exports = {
  validPageProfile,
  profileWithMissingIdentity,
  profileWithMissingInput,
  profileWithMissingResponse
};
