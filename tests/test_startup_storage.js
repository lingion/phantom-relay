'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const StartupStorage = require('../extension/startup_storage.js');

function storageFixture(values, calls) {
  return {
    get(query, callback) {
      calls.push(query);
      const keys = Array.isArray(query) ? query : Object.keys(query || {});
      const result = Object.fromEntries(
        keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]),
      );
      queueMicrotask(() => callback(result));
    },
  };
}

test('critical startup storage excludes conversation and diagnostic history', async () => {
  const calls = [];
  const storage = storageFixture({
    phantomBackendUrl: 'http://127.0.0.1:8765',
    phantomProfiles: { version: 1, profiles: {} },
    phantomConversations: [{ user: 'large history' }],
    phantomDebugLogs: [{ message: 'large diagnostics' }],
  }, calls);

  const critical = await StartupStorage.loadCritical(storage);

  assert.equal(critical.phantomBackendUrl, 'http://127.0.0.1:8765');
  assert.deepEqual(critical.phantomProfiles, { version: 1, profiles: {} });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('phantomProfiles'));
  assert.ok(!calls[0].includes('phantomConversations'));
  assert.ok(!calls[0].includes('phantomDebugLogs'));
});

test('optional history is loaded through an independent storage operation', async () => {
  const calls = [];
  const storage = storageFixture({
    phantomConversations: [{ user: 'history' }],
    phantomDebugLogs: [{ message: 'diagnostic' }],
  }, calls);

  const optional = await StartupStorage.loadOptional(storage);

  assert.deepEqual(optional.phantomConversations, [{ user: 'history' }]);
  assert.deepEqual(optional.phantomDebugLogs, [{ message: 'diagnostic' }]);
  assert.deepEqual(calls, [['phantomConversations', 'phantomDebugLogs']]);
});

test('storage reads support promise-based Chromium APIs without callbacks', async () => {
  const storage = {
    get(query) {
      return Promise.resolve({ query, phantomProfiles: { version: 1, profiles: {} } });
    },
  };

  const result = await StartupStorage.loadCritical(storage);

  assert.deepEqual(result.phantomProfiles, { version: 1, profiles: {} });
});

test('a stalled storage read fails within the configured deadline', async () => {
  const storage = { get() { return undefined; } };

  await assert.rejects(
    StartupStorage.read(storage, ['phantomProfiles'], 10),
    error => error.code === 'startup_storage_timeout',
  );
});

console.log('STARTUP_STORAGE_TESTS_DEFINED');
