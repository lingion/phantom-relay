const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background.js'),
  'utf8',
);

function bridgeSource() {
  const start = source.indexOf('async function browserBridgeTick()');
  const end = source.indexOf('\nlet bridgeWakeTimer', start);
  assert.ok(start >= 0 && end > start, 'browser bridge function must be discoverable');
  return source.slice(start, end);
}

test('automatic execution has one tab-activation owner', () => {
  const bridge = bridgeSource();

  assert.doesNotMatch(
    bridge,
    /chrome\.tabs\.create\s*\(/,
    'the execution worker must not create a provider tab after the backend wake path already owns activation',
  );
  assert.doesNotMatch(
    bridge,
    /browser\/(?:reserve-tab|commit-tab)/,
    'tab reservation/commit must not remain an active automatic execution path',
  );
  assert.match(
    bridge,
    /tickOutcome\s*=\s*['"]no_execution_tab['"]/,
    'a missing execution tab must fail closed and wait for the wake owner',
  );
});

test('user-driven recording navigation remains separate from automatic execution', () => {
  const popupHandler = source.slice(source.indexOf("case 'open_recording_page':"));
  assert.match(
    popupHandler,
    /chrome\.tabs\.(?:update|create)\s*\(/,
    'the explicit recording-page action may still navigate or create a page for the user',
  );
});

test('extension registration advertises that automatic execution cannot create provider tabs', () => {
  const registration = source.slice(source.indexOf('function tabRegistrationRecord('), source.indexOf('async function registerBrowserClient('));
  assert.match(
    registration,
    /can_create_tab:\s*false/,
    'the worker only reuses pages; its advertised capability must match that ownership contract',
  );
  assert.doesNotMatch(
    registration,
    /can_create_tab:\s*true/,
    'stale capability=true would invite the backend or old consumers to create a second page',
  );
});

test('page-ready and claim heartbeats never advertise a second automatic activation owner', () => {
  const pageReady = source.slice(source.indexOf("if (msg.type === 'page_ready')"), source.indexOf("if (msg.type === 'page_trace')"));
  const claimHeartbeat = source.slice(source.indexOf('const leaseHeartbeat = {'), source.indexOf('fetch(`${LOCAL_API}/browser/heartbeat`', source.indexOf('const leaseHeartbeat = {')));
  assert.doesNotMatch(pageReady, /can_create_tab:\s*true/);
  assert.doesNotMatch(claimHeartbeat, /can_create_tab:\s*true/);
});

console.log('BACKGROUND_ACTIVATION_OWNERSHIP_TESTS_DEFINED');
