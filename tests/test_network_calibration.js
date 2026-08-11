'use strict';

const assert = require('node:assert/strict');
require('../extension/network_calibration.js');
require('../extension/network_capture.js');
const calibration = globalThis.PhantomRelayNetworkCalibration;
const capture = globalThis.PhantomRelayNetworkCapture;

const body = [
  'data: {"v":{"stream":[{"content":"网络"}]}}', '',
  'data: {"p":"stream/0/content","o":"APPEND","v":"校准"}', '',
  'data: {"p":"status","v":"FINISHED"}', '',
].join('\n');

const profile = calibration.inferProfile({
  domain: 'recorded.example', origin: 'https://recorded.example/chat',
  input: { selector: '#prompt', kind: 'textarea' },
  send: { kind: 'enter', key: 'Enter', modifiers: [] },
  response: { url: 'https://stream.example/events/1', mimeType: 'text/event-stream' },
  body,
});

assert.equal(profile.capture.mode, 'network');
assert.deepEqual(profile.capture.response.url.origins, ['https://stream.example']);
assert.deepEqual(profile.capture.response.url.pathPatterns, ['/events/1']);
assert.equal(profile.response.selector, undefined);
assert.equal(profile.capture.parser.finishRules[0].valueEquals, 'FINISHED');
assert.ok(profile.capture.parser.textRules.length > 0);
assert.doesNotMatch(JSON.stringify(profile), /网络|校准/);
assert.doesNotMatch(JSON.stringify(profile), /cookie|authorization|password|token/i);

const nestedBody = [
  'event:basedata',
  'data: {"status":0,"data":{"message":{"content":{"generator":{"data":{"value":"网"}}}}}}',
  '',
  'event:basedata',
  'data: {"status":0,"data":{"message":{"content":{"generator":{"data":{"value":"网络"}}}}}}',
  '',
  'event:basedata',
  'data: {"status":0,"data":{"message":{"content":{"generator":{"data":{"value":"网络流"}}}}}}',
  '',
  'event:basedata',
  'data: {"status":0,"data":{"message":{"content":{"generator":{"data":{"value":"网络流"},"status":"FINISHED"}}}}}',
  '',
].join('\n');

const nestedProfile = calibration.inferProfile({
  domain: 'nested.fixture.example', origin: 'https://nested.fixture.example/chat',
  input: { selector: '#prompt', kind: 'textarea' },
  send: { kind: 'enter', key: 'Enter', modifiers: [] },
  response: { url: 'https://stream.fixture.example/events/1', mimeType: 'text/event-stream' },
  body: nestedBody,
});
const nestedRule = nestedProfile.capture.parser.textRules.find(rule => rule.valuePath === '/data/message/content/generator/data/value');
assert.ok(nestedRule, 'nested scalar stream value should be inferred');
assert.equal(nestedRule.mode, 'set', 'cumulative nested values should use set mode');
assert.equal(capture.parseSseBody(nestedBody, nestedProfile.capture).text, '网络流');
assert.doesNotMatch(JSON.stringify(nestedProfile), /网络流/);

const terminalBody = [
  'event:basedata',
  'data: {"data":{"message":{"content":{"generator":{"data":{"value":"a"}}}}}}',
  '',
  'event:basedata',
  'data: {"data":{"message":{"content":{"generator":{"data":{"value":"ab"}}}}}}',
  '',
  'event:basedata',
  'data: {"data":{"message":{"content":{"generator":{"data":{"value":"abc"}}}}}}',
  '',
  'event:basedata',
  'data: {"data":{"message":{"metaData":{"state":"generate-complete"}}}}',
  '',
].join('\n');
const terminalProfile = calibration.inferProfile({
  domain: 'terminal.fixture.example', origin: 'https://terminal.fixture.example/chat',
  input: { selector: '#prompt', kind: 'textarea' },
  send: { kind: 'enter', key: 'Enter', modifiers: [] },
  response: { url: 'https://terminal.fixture.example/events/1', mimeType: 'text/event-stream' },
  body: terminalBody,
});
assert.deepEqual(terminalProfile.capture.parser.finishRules, [{
  valuePath: '/data/message/metaData/state',
  valueEquals: 'generate-complete',
}], 'nested completion states should be inferred as terminal parser evidence');
console.log('NETWORK_CALIBRATION_PASS');
