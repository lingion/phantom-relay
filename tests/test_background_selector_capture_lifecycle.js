'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

require('../extension/profile_contract.js');
const Lifecycle = require('../extension/profile_lifecycle.js');
const { validProfile } = require('./fixtures/profile_lifecycle.js');

const EXTENSION_DIR = path.resolve(__dirname, '../extension');

const clone = value => value == null ? value : structuredClone(value);

async function activeEnvelope(profile) {
  const recorded = await Lifecycle.createProfileEnvelope(profile);
  return Lifecycle.transitionProfileEnvelope(
    Lifecycle.transitionProfileEnvelope(recorded, 'sync_requested'),
    'sync_accepted',
  );
}

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return clone(body); },
  };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = check();
    if (value) return value;
    await flush();
  }
  throw new Error(message);
}

function eventTarget() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
  };
}

function createStorage(initial, options = {}) {
  const values = clone(initial);
  const writes = [];
  const set = (value, callback) => {
    const write = clone(value || {});
    writes.push(write);
    const gate = options.storageGate?.(write);
    const complete = () => {
      Object.assign(values, write);
      callback?.();
    };
    if (gate) {
      gate.then(complete, complete);
      return undefined;
    }
    queueMicrotask(complete);
    return undefined;
  };
  return {
    values,
    writes,
    get(query, callback) {
      const keys = Array.isArray(query)
        ? query
        : Object.keys(query || {});
      const result = {};
      for (const key of keys) {
        if (Object.hasOwn(values, key)) result[key] = clone(values[key]);
        else if (query && !Array.isArray(query) && query[key] !== undefined) result[key] = clone(query[key]);
      }
      queueMicrotask(() => callback?.(result));
      return undefined;
    },
    set,
  };
}

async function createHarness(options = {}) {
  const baseProfile = validProfile();
  const initialProfile = options.withActiveProfile === false ? null : baseProfile;
  const initialEnvelope = initialProfile ? await activeEnvelope(initialProfile) : null;
  const storage = createStorage({
    phantomBackendUrl: 'http://127.0.0.1:8765',
    phantomBrowserClientId: 'capture-test-client',
    phantomSelectors: initialProfile ? {
      'fixture.example': {
        input: initialProfile.input,
        send: initialProfile.send,
        response: initialProfile.response.selector,
        profile: initialProfile,
      },
    } : {},
    phantomDomainState: {},
    phantomModelRoutes: {},
    phantomProfiles: initialEnvelope ? {
      version: 1,
      profiles: {
        [initialProfile.profileId]: { active: initialEnvelope, pending: null, lastError: null },
      },
      diagnostics: [],
      legacyHints: [],
    } : { version: 1, profiles: {}, diagnostics: [], legacyHints: [] },
  }, options);

  const messageTarget = eventTarget();
  const fetches = [];
  const action = {
    setBadgeText(details) {
      if (action.failBadge) throw new Error('badge_write_failed');
      return details;
    },
    setBadgeBackgroundColor() {},
    failBadge: false,
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: messageTarget,
      onInstalled: eventTarget(),
      onStartup: eventTarget(),
      getManifest() { return { version: 'test' }; },
      sendMessage() { return Promise.resolve(); },
    },
    storage: { local: storage, session: createStorage({}) },
    action,
    tabs: {
      onUpdated: eventTarget(),
      onRemoved: eventTarget(),
      onCreated: eventTarget(),
      onActivated: eventTarget(),
      async query() { return []; },
      async get(tabId) { return { id: tabId, url: 'https://fixture.example/chat' }; },
      async sendMessage() { return { ok: true, ready: true, pong: true }; },
      async update(tabId) { return { id: tabId, url: 'https://fixture.example/chat' }; },
      async create() { return { id: 99, url: 'https://fixture.example/chat' }; },
    },
    scripting: { async executeScript() {} },
    debugger: {
      onDetach: eventTarget(),
      onEvent: eventTarget(),
      async attach() {},
      async detach() {},
      async sendCommand() { return {}; },
    },
    alarms: { onAlarm: eventTarget(), create() {} },
    downloads: { async download() {} },
  };

  const context = vm.createContext({
    AbortController,
    Date,
    JSON,
    Map,
    Promise,
    Set,
    TextEncoder,
    URL,
    Uint8Array,
    clearTimeout() {},
    chrome,
    console: { log() {}, warn() {}, error() {} },
    crypto: crypto.webcrypto,
    fetch: async (url, request = {}) => {
      const item = { url: String(url), request: clone(request) };
      fetches.push(item);
      if (typeof options.fetchResponder === 'function') {
        const custom = await options.fetchResponder(item, fetches);
        if (custom) return custom;
      }
      return response(200, {});
    },
    queueMicrotask,
    setTimeout() { return 0; },
    structuredClone,
  });
  context.globalThis = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  await waitFor(
    () => messageTarget.listeners.length >= 2,
    'background did not register both runtime listeners',
  );
  for (let attempt = 0; attempt < 20; attempt += 1) await flush();
  fetches.length = 0;

  function beginCapture(message) {
    const responses = [];
    const sender = { tab: { id: 7, url: 'https://fixture.example/chat' }, frameId: 0 };
    for (const listener of messageTarget.listeners) listener(message, sender, value => responses.push(clone(value)));
    return {
      responses,
      done: waitFor(() => responses[0], `capture did not receive an acknowledgement: ${message.capture_id || message.role}`),
    };
  }

  return { baseProfile, beginCapture, chrome, fetches, storage };
}

function profilePost(item) {
  return item.url.endsWith('/browser/profiles') && item.request.method === 'POST';
}

function selectorPost(item) {
  return item.url.endsWith('/browser/selectors') && item.request.method === 'POST';
}

function profileSyncSuccess(item) {
  const submitted = JSON.parse(item.request.body);
  return response(200, {
    ok: true,
    profile_id: submitted.profile.profileId,
    revision: submitted.revision,
    checksum: submitted.checksum,
    state: 'synced',
  });
}

test('profile synchronization failure rejects the capture and does not publish its selector candidate', async () => {
  const harness = await createHarness({
    async fetchResponder(item) {
      if (profilePost(item)) return response(503, { error: { code: 'backend_unavailable' } });
      return response(200, {});
    },
  });

  const capture = harness.beginCapture({
    type: 'selector_captured',
    role: 'response',
    selector: '[data-message-id]',
    profile: validProfile({ input: { selector: '#updated-prompt', kind: 'textarea' } }),
    domain: 'fixture.example',
    capture_id: 'capture-sync-failure',
  });
  const acknowledgement = await capture.done;

  assert.equal(capture.responses.length, 1);
  assert.equal(acknowledgement.ok, false);
  assert.equal(acknowledgement.error, 'profile_sync_failed');
  assert.equal(acknowledgement.capture_id, 'capture-sync-failure');
  assert.equal(harness.fetches.filter(selectorPost).length, 0);
});

test('selector projection persistence failure returns one structured rejection after a confirmed profile sync', async () => {
  const harness = await createHarness({
    async fetchResponder(item) {
      if (profilePost(item)) return profileSyncSuccess(item);
      if (selectorPost(item)) return response(503, { error: { code: 'selector_write_down' } });
      return response(200, {});
    },
  });

  const capture = harness.beginCapture({
    type: 'selector_captured',
    role: 'response',
    selector: '[data-message-id]',
    profile: validProfile({ input: { selector: '#projection-failure', kind: 'textarea' } }),
    domain: 'fixture.example',
    capture_id: 'capture-selector-failure',
  });
  const acknowledgement = await capture.done;

  assert.equal(capture.responses.length, 1);
  assert.deepEqual(acknowledgement, {
    ok: false,
    role: 'response',
    domain: 'fixture.example',
    capture_id: 'capture-selector-failure',
    error: 'selector_capture_persist_failed',
    detail: 'selector_capture_persist_failed:503',
  });
  assert.equal(harness.fetches.filter(profilePost).length, 1);
  assert.equal(harness.fetches.filter(selectorPost).length, 1);
});

test('an internal processing exception still returns a capture acknowledgement', async () => {
  const harness = await createHarness({
    async fetchResponder(item) {
      if (profilePost(item)) return profileSyncSuccess(item);
      return response(200, {});
    },
  });
  harness.chrome.action.failBadge = true;

  const capture = harness.beginCapture({
    type: 'selector_captured',
    role: 'response',
    selector: '[data-message-id]',
    profile: validProfile({ input: { selector: '#badge-failure', kind: 'textarea' } }),
    domain: 'fixture.example',
    capture_id: 'capture-badge-failure',
  });
  const acknowledgement = await capture.done;

  assert.equal(capture.responses.length, 1);
  assert.equal(acknowledgement.ok, false);
  assert.equal(acknowledgement.error, 'selector_capture_processing_failed');
  assert.equal(acknowledgement.role, 'response');
  assert.equal(acknowledgement.domain, 'fixture.example');
  assert.equal(acknowledgement.capture_id, 'capture-badge-failure');
});

test('a late acknowledgement for an older recording cannot overwrite or accept the newer transaction', async () => {
  let releaseFirst;
  const firstProfileRequest = new Promise(resolve => { releaseFirst = resolve; });
  let firstStartedResolve;
  const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
  const harness = await createHarness({
    async fetchResponder(item) {
      if (profilePost(item)) {
        const submitted = JSON.parse(item.request.body);
        if (submitted.profile.input.selector.css === '#prompt-a') {
          firstStartedResolve();
          await firstProfileRequest;
          return profileSyncSuccess(item);
        }
        return profileSyncSuccess(item);
      }
      return response(200, {});
    },
  });

  const first = harness.beginCapture({
    type: 'selector_captured', role: 'response', selector: '[data-message-id]',
    profile: validProfile({ input: { selector: '#prompt-a', kind: 'textarea' } }),
    domain: 'fixture.example', capture_id: 'capture-a',
  });
  await firstStarted;
  const second = harness.beginCapture({
    type: 'selector_captured', role: 'response', selector: '[data-message-id]',
    profile: validProfile({ input: { selector: '#prompt-b', kind: 'textarea' } }),
    domain: 'fixture.example', capture_id: 'capture-b',
  });
  const secondAcknowledgement = await second.done;
  releaseFirst();
  const firstAcknowledgement = await first.done;

  assert.equal(secondAcknowledgement.ok, true);
  assert.equal(secondAcknowledgement.capture_id, 'capture-b');
  assert.equal(secondAcknowledgement.profile_revision, 2);
  assert.match(secondAcknowledgement.profile_checksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal(firstAcknowledgement.ok, false);
  assert.equal(firstAcknowledgement.error, 'selector_capture_superseded');
  assert.equal(firstAcknowledgement.capture_id, 'capture-a');
  const postedSelectors = harness.fetches.filter(selectorPost).map(item => JSON.parse(item.request.body));
  assert.equal(postedSelectors.length, 1);
  assert.equal(postedSelectors[0].selectors.profile.input.selector.css, '#prompt-b');
});

test('the capture acknowledgement waits for its local selector persistence', async () => {
  let releaseStorage;
  const storageWriteGate = new Promise(resolve => { releaseStorage = resolve; });
  const harness = await createHarness({
    withActiveProfile: false,
    storageGate(write) {
      return Object.hasOwn(write, 'phantomSelectors') ? storageWriteGate : null;
    },
  });

  const capture = harness.beginCapture({
    type: 'selector_captured',
    role: 'send',
    selector: JSON.stringify({ kind: 'enter', key: 'Enter', modifiers: [] }),
    domain: 'fixture.example',
    capture_id: 'capture-storage-gate',
  });
  for (let attempt = 0; attempt < 10; attempt += 1) await flush();
  assert.equal(capture.responses.length, 0);
  assert.equal(harness.fetches.filter(selectorPost).length, 0);

  releaseStorage();
  const acknowledgement = await capture.done;
  assert.equal(acknowledgement.ok, true);
  assert.equal(acknowledgement.capture_id, 'capture-storage-gate');
  assert.equal(harness.fetches.filter(selectorPost).length, 1);
});

test('re-recording the input selector stages a new profile revision and preserves response identity', async () => {
  const harness = await createHarness({
    async fetchResponder(item) {
      if (profilePost(item)) return profileSyncSuccess(item);
      return response(200, {});
    },
  });

  const capture = harness.beginCapture({
    type: 'selector_captured',
    role: 'input',
    selector: '#fresh-prompt',
    alternatives: ['[data-prompt]'],
    domain: 'fixture.example',
    capture_id: 'capture-input-revision',
  });
  const acknowledgement = await capture.done;

  assert.equal(acknowledgement.ok, true);
  assert.equal(acknowledgement.profile_revision, 2);
  const profileRequest = harness.fetches.find(profilePost);
  const submittedProfile = JSON.parse(profileRequest.request.body).profile;
  assert.equal(submittedProfile.input.selector.css, '#fresh-prompt');
  assert.deepEqual(
    submittedProfile.response.identity.attributes,
    harness.baseProfile.response.identity.attributes,
  );
  const selectorRequest = harness.fetches.find(selectorPost);
  const selectorBundle = JSON.parse(selectorRequest.request.body).selectors;
  assert.equal(selectorBundle.profile.input.selector.css, '#fresh-prompt');
  assert.deepEqual(
    selectorBundle.profile.response.identity.attributes,
    harness.baseProfile.response.identity.attributes,
  );
});

test('re-recording the send action stages a new profile revision and projects one send strategy', async () => {
  const harness = await createHarness({
    async fetchResponder(item) {
      if (profilePost(item)) return profileSyncSuccess(item);
      return response(200, {});
    },
  });

  const capture = harness.beginCapture({
    type: 'selector_captured',
    role: 'send',
    selector: JSON.stringify({ kind: 'enter', key: 'Enter', modifiers: [] }),
    domain: 'fixture.example',
    capture_id: 'capture-send-revision',
  });
  const acknowledgement = await capture.done;

  assert.equal(acknowledgement.ok, true);
  assert.equal(acknowledgement.profile_revision, 2);
  const profileRequest = harness.fetches.find(profilePost);
  const submittedProfile = JSON.parse(profileRequest.request.body).profile;
  assert.deepEqual(submittedProfile.send, {
    kind: 'enter',
    key: 'Enter',
    modifiers: [],
  });
  const selectorRequest = harness.fetches.find(selectorPost);
  const selectorBundle = JSON.parse(selectorRequest.request.body).selectors;
  assert.deepEqual(selectorBundle.send, submittedProfile.send);
  assert.deepEqual(
    selectorBundle.profile.response.identity.attributes,
    harness.baseProfile.response.identity.attributes,
  );
});
