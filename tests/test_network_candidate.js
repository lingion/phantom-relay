#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
require('../extension/network_candidate.js');
const candidate = globalThis.PhantomRelayNetworkCandidate;

const boundaryAt = 1000;
assert.equal(candidate.isAfterBoundary({ requestAt: 999 }, boundaryAt), false);
assert.equal(candidate.isAfterBoundary({ requestAt: 1000 }, boundaryAt), true);

const selected = candidate.chooseCandidate([
  { requestId: 'old', requestAt: 999, finished: true, text: '旧流' },
  { requestId: 'current-early', requestAt: 1001, finished: false, text: '当前流片段' },
  { requestId: 'current-late', requestAt: 1002, finished: true, text: '当前流完整结果' },
], boundaryAt);
assert.equal(selected.requestId, 'current-late');
assert.equal(candidate.chooseCandidate([
  { requestId: 'a', requestAt: 1001, finished: true, text: '结果 A' },
  { requestId: 'b', requestAt: 1002, finished: true, text: '结果 B' },
], boundaryAt), null);

assert.equal(candidate.chooseCandidate([
  { requestAt: 900, finished: true, text: '旧结果' },
], boundaryAt), null);

// A response arriving after the boundary is not enough: if the request was
// already started before the boundary, it belongs to the old turn. Missing
// request timing is also fail-closed rather than guessed from responseAt.
assert.equal(candidate.isAfterBoundary({ requestAt: 900, responseAt: 1200 }, boundaryAt), false);
assert.equal(candidate.isAfterBoundary({ responseAt: 1200 }, boundaryAt), false);
assert.equal(candidate.chooseCandidate([
  { responseAt: 1200, finished: true, text: '旧流晚到' },
], boundaryAt), null);
console.log('NETWORK_CANDIDATE_PASS');
