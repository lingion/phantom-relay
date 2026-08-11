const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const Lock = require('../extension/capture_lock.js');

test('older content generations do not retain the capture lock', () => {
  assert.equal(Lock.lockNeedsClear('4', 5), true);
  assert.equal(Lock.lockNeedsClear('old-generation', 5), true);
});

test('current content generation keeps its in-flight lock', () => {
  assert.equal(Lock.lockNeedsClear('5', 5), false);
  assert.equal(Lock.lockNeedsClear('', 5), false);
  assert.equal(Lock.CAPTURE_LOCK_ATTRIBUTE, 'data-phantom-relay-capture-lock');
});

test('content runtime invokes generation-scoped lock recovery', () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'extension', 'content.js'), 'utf8');
  assert.match(source, /lockNeedsClear/);
  assert.match(source, /CAPTURE_LOCK_ATTRIBUTE/);
});
