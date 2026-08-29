const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');

test('recorded keyboard actions use the trusted browser input bridge', () => {
  assert.ok(manifest.permissions.includes('debugger'), 'the extension must be allowed to use the Chromium debugger input channel');
  assert.match(background, /async function dispatchRecordedKeyboardViaDebugger\(/);
  assert.match(background, /Input\.dispatchKeyEvent/);
  assert.match(background, /activeNetworkCaptures\.has\((?:Number\(tabId\)|numericTabId)\)/);
  assert.match(background, /msg\?\.type === 'dispatch_recorded_keyboard'/);
  assert.match(content, /await dispatchRecordedKeyboardOnce\(/);
  assert.match(content, /type: 'dispatch_recorded_keyboard'/);
  assert.doesNotMatch(content, /new KeyboardEvent\(/, 'recorded sends must not rely on untrusted page-created keyboard events');
});

test('trusted keyboard replay uses a complete Chromium key sequence', () => {
  const start = background.indexOf('async function dispatchRecordedKeyboardViaDebugger(');
  const end = background.indexOf('\nasync function startNetworkCapture(', start);
  assert.ok(start >= 0 && end > start, 'trusted keyboard dispatcher must be present');
  const dispatcher = background.slice(start, end);

  const keyDown = dispatcher.indexOf("type: keyText ? 'keyDown' : 'rawKeyDown'");
  const keyUp = dispatcher.indexOf("type: 'keyUp'");
  assert.ok(keyDown >= 0, 'replay must emit a keyDown event with text semantics when available');
  assert.ok(keyUp > keyDown, 'replay must release the key after keyDown');
  assert.match(dispatcher, /text:\s*keyText/);
  assert.match(dispatcher, /unmodifiedText:\s*keyText/);
});

test('content replay fails closed unless the recorded input owns focus', () => {
  assert.match(content, /function recordedInputOwnsFocus\(/);
  assert.match(content, /if \(!recordedInputOwnsFocus\(inputEl\)\)/);
  assert.match(content, /error:\s*'keyboard_focus_not_acquired'/);
  assert.match(content, /kind:\s*'keyboard_focus_not_acquired'/);
});
