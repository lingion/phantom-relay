const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, 'fixtures');

const fixtureNames = [
  'simple-chat.html',
  'virtualized-chat.html',
  'nested-message-chat.html',
  'contenteditable-chat.html',
  'streaming-chat.html'
];

test('generic HTML fixtures cover the required interaction shapes', () => {
  for (const name of fixtureNames) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(source, /data-chat-root/);
    assert.doesNotMatch(source, /doubao|deepseek|qwen|wenxin/i);
  }
  assert.match(fs.readFileSync(path.join(root, 'simple-chat.html'), 'utf8'), /<textarea/);
  assert.match(fs.readFileSync(path.join(root, 'contenteditable-chat.html'), 'utf8'), /contenteditable="true"/);
  assert.match(fs.readFileSync(path.join(root, 'virtualized-chat.html'), 'utf8'), /data-row-key/);
  assert.match(fs.readFileSync(path.join(root, 'nested-message-chat.html'), 'utf8'), /data-message-body/);
  assert.match(fs.readFileSync(path.join(root, 'streaming-chat.html'), 'utf8'), /data-streaming="true"/);
});
test('fixture identities are explicit and not derived from text', () => {
  const simple = fs.readFileSync(path.join(root, 'simple-chat.html'), 'utf8');
  const virtualized = fs.readFileSync(path.join(root, 'virtualized-chat.html'), 'utf8');
  assert.match(simple, /data-message-id="assistant-1"/);
  assert.match(virtualized, /data-row-key="row-assistant-1"/);
  assert.doesNotMatch(virtualized, /class="[^"]*provider[^"]*"/i);
});
