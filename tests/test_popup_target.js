'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PopupTarget = require('../extension/popup_target.js');

const extensionRoot = path.join(__dirname, '..', 'extension');
const popupSource = fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(extensionRoot, 'popup.html'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');

test('explicit target id is parsed from a tab-hosted recorder URL', () => {
  assert.equal(PopupTarget.explicitTabIdFromSearch('?tab_id=73&workspace=1'), 73);
  assert.equal(PopupTarget.explicitTabIdFromSearch('?tab_id=0'), null);
  assert.equal(PopupTarget.explicitTabIdFromSearch('?tab_id=not-a-number'), null);
});

test('only normal HTTP(S) pages can become recording targets', () => {
  assert.equal(PopupTarget.isUsableRecordingTab({ id: 7, url: 'https://chat.example/thread' }), true);
  assert.equal(PopupTarget.isUsableRecordingTab({ id: 8, url: 'http://localhost:3000/test' }), true);
  assert.equal(PopupTarget.isUsableRecordingTab({ id: 9, url: 'chrome-extension://abc/popup.html' }), false);
  assert.equal(PopupTarget.isUsableRecordingTab({ id: 10, url: 'chrome://extensions/' }), false);
  assert.equal(PopupTarget.isUsableRecordingTab({ id: 11, url: 'about:blank' }), false);
});

test('explicit target remains authoritative when the active tab is the recorder itself', () => {
  const result = PopupTarget.selectRecordingTab({
    explicitTabId: 73,
    explicitTab: { id: 73, url: 'https://chat.example/thread' },
    activeTab: { id: 99, url: 'chrome-extension://abc/popup.html?tab_id=73' },
    rememberedTab: { id: 44, url: 'https://other.example/' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'explicit');
  assert.equal(result.tab.id, 73);
});

test('an unavailable explicit target fails closed instead of guessing another page', () => {
  const result = PopupTarget.selectRecordingTab({
    explicitTabId: 73,
    explicitTab: null,
    activeTab: { id: 44, url: 'https://other.example/' },
    rememberedTab: { id: 45, url: 'https://remembered.example/' },
  });

  assert.deepEqual(result, { ok: false, error: 'recording_target_tab_unavailable' });
});

test('action popup prefers its active web page and only falls back to remembered explicit state', () => {
  const active = PopupTarget.selectRecordingTab({
    activeTab: { id: 44, url: 'https://active.example/thread' },
    rememberedTab: { id: 45, url: 'https://remembered.example/' },
  });
  assert.equal(active.ok, true);
  assert.equal(active.source, 'active');
  assert.equal(active.tab.id, 44);

  const remembered = PopupTarget.selectRecordingTab({
    activeTab: { id: 99, url: 'chrome://extensions/' },
    rememberedTab: { id: 45, url: 'https://remembered.example/' },
  });
  assert.equal(remembered.ok, true);
  assert.equal(remembered.source, 'remembered');
  assert.equal(remembered.tab.id, 45);
});

test('popup loads target resolver before runtime and initializes through the locked target', () => {
  assert.match(popupHtml, /<script src="popup_target\.js"><\/script>[\s\S]*<script src="popup\.js"><\/script>/);
  assert.match(popupSource, /PhantomRelayPopupTarget\.explicitTabIdFromSearch\(window\.location\.search\)/);
  assert.match(popupSource, /chrome\.tabs\.get\(explicitTabId\)/);
  assert.match(popupSource, /PhantomRelayPopupTarget\.selectRecordingTab/);
  assert.match(popupSource, /phantomRecordingTarget/);
});

test('user can open a persistent recording workspace bound to the exact provider tab', () => {
  assert.match(popupHtml, /id="btnOpenRecordingWorkspace"/);
  assert.match(popupSource, /action:\s*'open_recording_workspace'/);
  const handler = backgroundSource.slice(backgroundSource.indexOf("case 'open_recording_workspace':"));
  assert.match(handler, /chrome\.runtime\.getURL\(['"]popup\.html['"]\)/);
  assert.match(handler, /searchParams\.set\(['"]tab_id['"],\s*String\(targetTab\.id\)\)/);
  assert.match(handler, /chrome\.tabs\.create\(\{\s*url:\s*workspaceUrl\.toString\(\),\s*active:\s*true\s*\}\)/);
});

