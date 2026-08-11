'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Route = require('../extension/route_target.js');

test('model route resolves a sanitized recorded page URL', () => {
  const result = Route.resolveRecordingTarget({
    model: 'qwen-turbo',
    domain: 'wrong.example',
    currentUrl: 'https://wrong.example/',
    routes: {
      'qwen-turbo': {
        domain: 'chat.example',
        target_url: 'https://chat.example/qianwen/?conversation=secret#answer'
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetDomain, 'chat.example');
  assert.equal(result.targetUrl, 'https://chat.example/qianwen/');
  assert.equal(result.matchesCurrentPage, false);
});

test('same-domain route keeps the route path and reports a match', () => {
  const result = Route.resolveRecordingTarget({
    model: '',
    domain: 'chat.example',
    currentUrl: 'https://chat.example/other',
    routes: {
      saved: { domain: 'chat.example', target_url: 'https://chat.example/qianwen/' }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetUrl, 'https://chat.example/qianwen/');
  assert.equal(result.matchesCurrentPage, true);
});

test('route target cannot cross the declared route domain', () => {
  const result = Route.resolveRecordingTarget({
    model: 'saved',
    routes: {
      saved: { domain: 'chat.example', target_url: 'https://evil.example/' }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetUrl, 'https://chat.example/');
  assert.equal(result.targetDomain, 'chat.example');
});

test('current page is only a fallback when no saved route exists', () => {
  const result = Route.resolveRecordingTarget({
    model: '',
    domain: 'current.example',
    currentUrl: 'https://current.example/chat?draft=1#reply',
    routes: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'current_tab');
  assert.equal(result.targetUrl, 'https://current.example/chat');
});

test('saved profile origin resolves a recording page without a model binding', () => {
  const result = Route.resolveRecordingTarget({
    model: '',
    domain: 'chat.example',
    currentUrl: 'chrome://newtab/',
    profiles: {
      recordedProfile: {
        active: {
          profile: {
            profileId: 'recordedProfile',
            domain: 'chat.example',
            origin: 'https://chat.example/app/conversation'
          }
        }
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'profile_active');
  assert.equal(result.targetDomain, 'chat.example');
  assert.equal(result.targetUrl, 'https://chat.example/app/conversation');
});

test('non-web pages do not become recording targets', () => {
  const result = Route.resolveRecordingTarget({
    model: '',
    domain: '',
    currentUrl: 'chrome://extensions/',
    routes: {}
  });

  assert.deepEqual(result, { ok: false, error: 'recording_route_missing' });
});

console.log('RECORDING_ROUTE_TESTS_DEFINED');
