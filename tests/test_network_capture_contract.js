#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
require('../extension/network_capture.js');
const capture = globalThis.PhantomRelayNetworkCapture;

const contract = {
  mode: 'network',
  response: {
    url: { origins: ['https://example.test'], pathPatterns: ['/stream/*'], queryPolicy: 'ignore' },
    mimeTypes: ['text/event-stream'],
  },
  parser: {
    eventFormat: 'sse',
    textRules: [
      { source: 'fragments', path: '/v/response/fragments', itemPath: '/content', select: 'last', mode: 'set' },
      { eventPath: '/p', eventPattern: 'response/fragments/*/content', valuePath: '/v', mode: 'append' },
      { eventPath: '/p', eventEquals: 'response/content', valuePath: '/v', mode: 'set' },
      { eventPath: '/p', eventPathAbsent: true, valuePath: '/v', mode: 'append' },
    ],
    finishRules: [
      { eventPath: '/p', eventEquals: 'response/status', valuePath: '/v', valueEquals: 'FINISHED' },
    ],
  },
};

assert.equal(capture.matchNetworkResponse({ url: 'https://example.test/stream/reply?trace=1', mimeType: 'text/event-stream' }, contract), true);
assert.equal(capture.matchNetworkResponse({ url: 'https://other.test/stream/reply', mimeType: 'text/event-stream' }, contract), false);
assert.equal(capture.matchNetworkResponse({ url: 'https://example.test/other', mimeType: 'text/event-stream' }, contract), false);

const body = [
  'data: {"request":"new"}',
  '',
  'data: {"v":{"response":{"fragments":[{"content":"网络"}]}}}',
  '',
  'data: {"p":"response/fragments/0/content","o":"APPEND","v":"流"}',
  '',
  'data: {"p":"response/content","o":"SET","v":"网络流"}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
].join('\n');
assert.deepEqual(capture.parseSseBody(body, contract), { text: '网络流', finished: true });
assert.deepEqual(capture.parseSseBody('data: {"v":"不完整', contract), { text: '', finished: false });
assert.equal(capture.parseSseBody('data: [DONE]\n\n', contract).finished, true);

const transportBody = [
  'event:basedata\n',
  'data: {"p":"response/content","v":"网络流"}\n\n',
  'data: {"p":"response/status","v":"FINISHED"}\n\n',
].join('');
const transportBytes = Buffer.from(transportBody);
const encodedBlocks = [
  transportBytes.slice(0, 17),
  transportBytes.slice(17, 41),
  transportBytes.slice(41),
].map(block => block.toString('base64')).join('');
const decodedTransport = capture.decodeTransportChunk(encodedBlocks, false);
assert.equal(decodedTransport, transportBody);
assert.deepEqual(capture.parseSseBody(decodedTransport, contract), { text: '网络流', finished: true });

const incremental = { text: '', finished: false, processedRecords: 0 };
const incrementalContract = {
  ...contract,
  parser: {
    ...contract.parser,
    textRules: [{ eventPath: '/p', eventEquals: 'response/content', valuePath: '/v', mode: 'append' }],
    finishRules: []
  }
};
assert.deepEqual(capture.parseSseBody('data: {"p":"response/content","v":"网络"}\n\n', incrementalContract, incremental), { text: '网络', finished: false });
assert.deepEqual(capture.parseSseBody('data: {"p":"response/content","v":"网络"}\n\ndata: {"p":"response/content","v":"流"}\n\n', incrementalContract, incremental), { text: '网络流', finished: false });
assert.equal(incremental.processedRecords, 2);
console.log('NETWORK_CAPTURE_CONTRACT_PASS');
