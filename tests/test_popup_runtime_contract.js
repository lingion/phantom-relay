'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const popupSource = fs.readFileSync(require.resolve('../extension/popup.js'), 'utf8');
const htmlSource = fs.readFileSync(require.resolve('../extension/popup.html'), 'utf8');
const backgroundSource = fs.readFileSync(require.resolve('../extension/background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(require.resolve('../extension/manifest.json'), 'utf8'));

test('popup validates the content script version before accepting an existing ping', () => {
  assert.match(popupSource, /content_script_version/);
  assert.match(popupSource, /get_extension_diagnostics/);
  assert.match(popupSource, /executeScript/);
});

test('popup rejects a live content handshake when the worker reports a different build', () => {
  assert.match(
    popupSource,
    /function acceptContentScriptPing\(ping\)/,
    'popup must centralize the live content handshake instead of duplicating a version gate'
  );
  assert.match(
    popupSource,
    /actualVersion !== expectedContentScriptVersion[\s\S]{0,220}return false/,
    'a page runtime that cannot persist through the current worker must be rejected'
  );
  assert.doesNotMatch(
    popupSource,
    /action:\s*'accept_live_handshake'/,
    'drift must not be accepted for recording merely because the page script answered'
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

test('popup does not mark a local selector as recorded before background acknowledgement', () => {
  assert.match(
    popupSource,
    /selector_capture_status/,
    'popup must read the content runtime capture acknowledgement state',
  );
  assert.match(
    popupSource,
    /captureStatus\?\.state === ['"]accepted['"]/,
    'a selector must be accepted by background before the popup advances',
  );
  assert.match(
    popupSource,
    /selector_capture_ack_timeout/,
    'a missing acknowledgement must become an explicit diagnostic failure',
  );
});

test('popup version comes from the loaded manifest', () => {
  assert.match(popupSource, /getManifest/);
  assert.doesNotMatch(htmlSource, /<div class="footer">v2\.0/);
});

test('popup runtime identity matches the packaged manifest version', () => {
  const popupVersion = popupSource.match(/extension_version:\s*['"]([^'"]+)['"]/)?.[1];
  assert.equal(popupVersion, manifest.version);
});

test('popup reloads an installed unpacked extension when its runtime identity is stale', () => {
  assert.match(
    popupSource,
    /function reloadIfRuntimeIdentityStale\(/,
    'popup must check the installed runtime before starting recording or capture',
  );
  assert.match(
    popupSource,
    /chrome\.runtime\.reload\(\)/,
    'an explicit runtime mismatch must reload the extension from its current source directory',
  );
  assert.match(
    popupSource,
    /background_version/,
    'the check must cover a cached service worker, not only the manifest version',
  );
});

test('popup rejects a content script that does not match the current worker contract', () => {
  assert.match(
    popupSource,
    /actualVersion !== expectedContentScriptVersion[\s\S]{0,220}return false/,
    'a stale page runtime must not enter recording while the worker is stale',
  );
  assert.doesNotMatch(
    popupSource,
    /action:\s*'accept_live_handshake'/,
    'version drift must not be treated as an accepted recording handshake',
  );
});

test('recording reset waits for the background transaction before clearing popup state', () => {
  const resetStart = popupSource.indexOf("btnReset.addEventListener('click'");
  const resetEnd = popupSource.indexOf("btnClear.addEventListener('click'", resetStart);
  const resetSource = popupSource.slice(resetStart, resetEnd);
  assert.ok(resetStart >= 0 && resetEnd > resetStart);
  assert.match(resetSource, /await new Promise\(/);
  assert.match(resetSource, /action:\s*'reset'/);
  assert.match(resetSource, /tab_id:\s*currentTabId/);
  assert.match(resetSource, /if \s*\(runtimeError \|\| !response\?\.ok\)/);
  assert.ok(
    resetSource.indexOf("action:'clear_selectors'") > resetSource.indexOf('!response?.ok'),
    'the page and popup must remain intact when the backend reset is rejected',
  );
});

test('background reset deletes the authoritative backend profile before local profile state', () => {
  const helperStart = backgroundSource.indexOf('async function resetRecordedDomain(');
  const helperEnd = backgroundSource.indexOf('\n}', helperStart) + 2;
  const helperSource = backgroundSource.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helperSource, /\/browser\/profiles\?domain=/);
  assert.match(helperSource, /method:\s*'DELETE'/);
  assert.match(helperSource, /removeProfilesForDomain\(/);
  assert.ok(
    helperSource.indexOf('if (!response.ok)') < helperSource.indexOf('removeProfilesForDomain('),
    'a failed remote reset must not leave the popup claiming local success',
  );
});

console.log('POPUP_RUNTIME_CONTRACT_TESTS_DEFINED');
