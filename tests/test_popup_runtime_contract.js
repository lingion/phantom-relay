'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const popupSource = fs.readFileSync(require.resolve('../extension/popup.js'), 'utf8');
const htmlSource = fs.readFileSync(require.resolve('../extension/popup.html'), 'utf8');
const backgroundSource = fs.readFileSync(require.resolve('../extension/background.js'), 'utf8');

test('popup validates the content script version before accepting an existing ping', () => {
  assert.match(popupSource, /content_script_version/);
  assert.match(popupSource, /get_extension_diagnostics/);
  assert.match(popupSource, /executeScript/);
});

test('popup accepts a live content handshake when a stale worker reports an older build', () => {
  assert.match(
    popupSource,
    /function acceptContentScriptPing\(ping\)/,
    'popup must centralize the live content handshake instead of duplicating a stale-version gate'
  );
  assert.match(
    popupSource,
    /expectedContentScriptVersion\s*=\s*actualVersion/,
    'the live page version must become authoritative after a valid ping'
  );
  assert.match(
    popupSource,
    /content_script_version_drift/,
    'version drift must be diagnostic rather than reported as script injection failure'
  );
});

test('enter selection persists a keyboard strategy without a button selector', () => {
  assert.match(popupSource, /kind === 'enter'/);
  assert.match(popupSource, /save_send_strategy/);
  assert.match(backgroundSource, /allowedKinds = new Set\(\['enter', 'shortcut'\]\)/);
  assert.doesNotMatch(backgroundSource, /if \(!remote\.ok\) throw new Error\('selector_sync_failed:/);
  assert.match(popupSource, /回车（无需录制按钮）/);
});

test('popup completion state uses the same recorded profile contract as the worker', () => {
  assert.match(htmlSource, /<script src="profile_contract\.js"><\/script>/);
  assert.match(popupSource, /PhantomRelayProfile\.normalizeProfile\(value\.profile\)/);
  assert.match(popupSource, /PhantomRelayProfile\.hasRecordedIdentityVerification\(/);
  assert.doesNotMatch(
    popupSource,
    /function hasCompleteRecordedProfile[\s\S]{0,700}return !!value\.response;/,
    'popup must not show all steps complete for selector-only legacy data'
  );
});

test('popup does not render a legacy response selector as a completed response step', () => {
  assert.match(
    popupSource,
    /const responseReady\s*=\s*hasCompleteRecordedProfile\(s\)/,
    'response step rendering must be gated by the executable profile contract'
  );
  assert.match(
    popupSource,
    /renderStep\('response',[\s\S]{0,280}responseReady\s*\?\s*s\.response\s*:\s*null/,
    'a selector-only legacy response must remain available for re-recording, not look complete'
  );
});

test('popup version comes from the loaded manifest', () => {
  assert.match(popupSource, /getManifest/);
  assert.doesNotMatch(htmlSource, /<div class="footer">v2\.0/);
});

console.log('POPUP_RUNTIME_CONTRACT_TESTS_DEFINED');
