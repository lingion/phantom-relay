const assert = require('node:assert/strict');
const test = require('node:test');

const Recovery = require('../extension/selector_recovery.js');

test('derives an ID-prefix candidate from a recorded UUID ID', () => {
  assert.deepEqual(
    Recovery.deriveAlternatives('#chat-response-message-d5f5b354-ed74-4568-9dd6-cacd2dd3915a'),
    ['[id^="chat-response-message-"]']
  );
});

test('accepts selector descriptor shapes used by recorded profiles', () => {
  assert.deepEqual(
    Recovery.deriveAlternatives({ selector: { css: '#answer-00000000-0000-0000-0000-000000000000' } }),
    ['[id^="answer-"]']
  );
});

test('does not broaden stable selectors or malformed IDs', () => {
  assert.deepEqual(Recovery.deriveAlternatives('[data-message-id]'), []);
  assert.deepEqual(Recovery.deriveAlternatives('#answer-static'), []);
  assert.deepEqual(Recovery.deriveAlternatives('#x-00000000-0000-0000-0000-000000000000'), []);
});

console.log('SELECTOR_RECOVERY_TESTS_DEFINED');
