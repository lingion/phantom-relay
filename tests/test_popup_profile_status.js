const assert = require('node:assert/strict');
const test = require('node:test');

const Status = require('../extension/popup_profile_status.js');

test('popup renders profile lifecycle metadata and reason code only', () => {
  const html = Status.renderProfileStatus({
    profileId: 'p', revision: 3, state: 'degraded', lastVerifiedAt: '2026-07-31T12:00:00.000Z',
    reasonCodes: ['profile_response_unavailable']
  });
  assert.match(html, /p/);
  assert.match(html, /3/);
  assert.match(html, /degraded/);
  assert.match(html, /profile_response_unavailable/);
  assert.doesNotMatch(html, /assistant text|prompt text|pageText/);
});

test('popup distinguishes all lifecycle states', () => {
  for (const state of ['recorded', 'sync_pending', 'synced', 'verified', 'degraded', 'invalid', 'archived']) {
    assert.match(Status.renderProfileStatus({ profileId: 'p', revision: 1, state }), new RegExp(`data-profile-state="${state}"`));
    assert.notEqual(Status.profileStatusLabel(state), state);
  }
});

test('popup escapes metadata before injecting status markup', () => {
  const html = Status.renderProfileStatus({ profileId: '<page-text>', revision: 1, state: 'invalid' });
  assert.doesNotMatch(html, /<page-text>/);
  assert.match(html, /&lt;page-text&gt;/);
});

test('popup does not present an empty profile as recorded', () => {
  const html = Status.renderProfileStatus({ state: 'unavailable', profileId: '', revision: 0 });
  assert.match(html, /data-profile-state="unavailable"/);
  assert.match(html, /未录制|未建立/);
  assert.doesNotMatch(html, /已录制/);
});
