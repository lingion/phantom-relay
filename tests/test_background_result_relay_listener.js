const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const background = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background.js'),
  'utf8',
);
const content = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content.js'),
  'utf8',
);

test('browser result relay uses a synchronous MV3 message listener', () => {
  assert.match(
    background,
    /function relayBrowserResult\(msg, sender, sendResponse\)/,
  );
  assert.match(
    background,
    /chrome\.runtime\.onMessage\.addListener\(\(msg, sender, sendResponse\) => \{\s*if \(msg\?\.type === 'browser_result_relay'\) \{\s*return relayBrowserResult\(msg, sender, sendResponse\);\s*\}/s,
  );
  assert.doesNotMatch(
    background,
    /chrome\.runtime\.onMessage\.addListener\(async\s*\(/,
  );
  assert.match(
    background,
    /if \(msg\?\.type === 'browser_result_relay'\) \{\s*return relayBrowserResult\(msg, sender, sendResponse\);\s*\}\s*\(async \(\) => \{/s,
  );
});

test('auto capture dispatch does not depend on a long-lived response channel', () => {
  const dispatchStart = background.indexOf("action: 'auto_capture'");
  assert.ok(dispatchStart >= 0, 'background must dispatch auto_capture');
  const dispatchWindow = background.slice(Math.max(0, dispatchStart - 700), dispatchStart + 1200);
  assert.doesNotMatch(
    dispatchWindow,
    /\},\s*\(value\)\s*=>\s*\{[\s\S]*browser_capture_callback_fired/,
    'background execution dispatch must not wait for a long-lived auto_capture acknowledgement'
  );
  assert.match(
    dispatchWindow,
    /chrome\.tabs\.sendMessage\([\s\S]*action:\s*'auto_capture'/,
    'background must still trigger the content runtime'
  );
  assert.match(
    dispatchWindow,
    /await chrome\.tabs\.sendMessage\([\s\S]*action:\s*'auto_capture'/,
    'background must confirm immediate message delivery so a missing content runtime fails the claimed job',
  );
  assert.doesNotMatch(
    dispatchWindow,
    /delivery\.catch\(/,
    'delivery rejection must reach the claimed-job failure path instead of becoming a log-only timeout',
  );

  const contentCaptureStart = content.indexOf("case 'auto_capture':");
  assert.ok(contentCaptureStart >= 0, 'content runtime must expose auto_capture');
  const contentCaptureEnd = content.indexOf("case 'find_response':", contentCaptureStart);
  assert.ok(contentCaptureEnd > contentCaptureStart, 'auto_capture branch must have a bounded switch case');
  const contentCaptureWindow = content.slice(contentCaptureStart, contentCaptureEnd);
  assert.doesNotMatch(
    contentCaptureWindow,
    /sendResponse\(/,
    'auto_capture must report through browser_result_relay instead of a long-lived message response'
  );
  assert.doesNotMatch(
    contentCaptureWindow,
    /return true;/,
    'auto_capture listener must not keep an acknowledgement channel open'
  );
});

test('terminal browser result relay waits for worker acknowledgement and retries transient failures', () => {
  const start = content.indexOf('async function postBrowserResultWithRetry(');
  const end = content.indexOf('\n  function relayCaptureSnapshot', start);
  const relay = start >= 0 && end > start ? content.slice(start, end) : '';

  assert.match(relay, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(
    relay,
    /await new Promise\(/,
    'terminal result delivery must wait for the short background POST acknowledgement',
  );
  assert.match(
    relay,
    /if \(ack\?\.ok\) \{[\s\S]{0,240}return true;/,
    'only an acknowledged backend result may finish the relay loop',
  );
});

test('background worker provides a bounded capture observation tick', () => {
  assert.match(background, /function scheduleCaptureObservationTick\(msg, sendResponse\)/);
  assert.match(background, /Math\.max\(50, Math\.min\(1000,/);
  const listenerStart = background.indexOf('chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {');
  const listenerEnd = background.indexOf('// ── Popup 消息', listenerStart);
  const listener = listenerStart >= 0 && listenerEnd > listenerStart
    ? background.slice(listenerStart, listenerEnd)
    : '';
  assert.match(
    listener,
    /msg\?\.type === 'capture_observation_tick'[\s\S]{0,180}scheduleCaptureObservationTick\(msg, sendResponse\)[\s\S]{0,80}return;/,
    'the content/runtime dispatcher must schedule the delayed tick without entering claim handling',
  );
  assert.match(listener, /\}\);\s*return true;\s*\}\);\s*$/, 'the MV3 listener must keep the delayed response channel open');
});

test('production execution dispatches the recorded DOM action without starting network capture', () => {
  assert.doesNotMatch(background, /const networkCapture = await startNetworkCapture\(tab\.id, data\.job\)/);
  assert.doesNotMatch(background, /network_capture_primary_path/);
  assert.match(background, /action:\s*'auto_capture'/);
  assert.match(background, /function startNetworkCapture\(tabId, job\)/, 'network capture remains available as historical calibration code');
});

test('authoritative selector application carries the active profile lifecycle revision', () => {
  assert.match(
    background,
    /function activeProfileRevisionForDomain\(domain\)/,
    'background must resolve lifecycle metadata separately from the pure profile'
  );
  assert.match(
    background,
    /action:\s*'set_selectors',[\s\S]{0,420}profile_revision:\s*[^,\n]+activeProfileRevisionForDomain\(/,
    'background selector application must carry the active revision to content'
  );
  assert.match(
    background,
    /get_server_selectors[\s\S]{0,500}profile_revision:\s*activeProfileRevisionForDomain\(/,
    'content startup selector loading must expose the active revision'
  );
});

test('production executable gate rejects network and hybrid profiles', () => {
  assert.match(background, /if \(mode === 'network' \|\| mode === 'hybrid'\) return false/);
});

test('network stream starts at responseReceived and is guarded against duplicate starts', () => {
  const responseHandlerStart = background.indexOf("if (method === 'Network.responseReceived') {");
  const laterEventHandlerStart = background.indexOf("if ((method === 'Network.dataReceived'", responseHandlerStart);
  assert.ok(responseHandlerStart >= 0, 'responseReceived handler must exist');
  assert.ok(laterEventHandlerStart > responseHandlerStart, 'later network event handler must exist');
  const responseHandler = background.slice(responseHandlerStart, laterEventHandlerStart);
  assert.match(
    responseHandler,
    /state\.requests\.set\(params\.requestId,[\s\S]*startNetworkStream\(source, state, params\.requestId\)\.catch\(\(\) => \{\}\);/,
    'matched responses must begin streaming before later network events'
  );
  assert.match(
    background,
    /async function startNetworkStream\(source, state, requestId\) \{[\s\S]{0,160}if \(!request \|\| request\.streamStarted\) return;[\s\S]{0,100}request\.streamStarted = true;/,
    'the request must be marked before the asynchronous CDP command'
  );
});

test('network capture has a send boundary and ignores response streams from before it', () => {
  assert.match(background, /const NETWORK_CAPTURE_RUNTIME_ENABLED\s*=\s*false/);
  assert.doesNotMatch(background, /importScripts\('network_candidate\.js'\)/);
  assert.match(background, /sendBoundaryAt: Date\.now\(\)/);
  assert.match(background, /method === 'Network\.requestWillBeSent'/);
  assert.match(background, /isAfterBoundary\(request, boundaryAt\)/);
  assert.match(background, /network_stream_response_before_boundary/);
  assert.match(background, /network_stream_candidate_ready/);
  assert.match(background, /scheduleNetworkCandidateSettlement/);
  assert.match(background, /network_candidate_ambiguous/);
  assert.match(content, /activeProfile\.capture\.mode === 'network' && !boundaryAck/);
  assert.match(background, /action: 'network_capture_response_observed'/);
  assert.match(content, /networkResponseObserved/);
  assert.match(content, /networkResponseObserved && \(networkOnlyProfile\(\) \|\| activeProfile\?\.capture\?\.mode === 'hybrid'\)/);
});

test('network stream consumption is serialized per request', () => {
  assert.match(background, /request\.consumeQueue = \(request\.consumeQueue \|\| Promise\.resolve\(\)\)/);
  assert.match(background, /consumeNetworkStreamChunkNow\(source, state, requestId, data, base64Encoded, finished\)/);
});

test('network result completion releases the local claim', () => {
  assert.match(background, /activeNetworkCaptures\.delete\(Number\(source\.tabId\)\)/);
  assert.match(background, /activeClaims\.delete\(state\.jobId\)/);
  assert.match(background, /await persistActiveClaims\(\)/);
});

test('network calibration loads the authoritative input/send recording after a worker restart', () => {
  assert.match(background, /importScripts\('profile_contract\.js'\)/);
  assert.match(background, /browser\/selectors\?domain=\$\{encodeURIComponent\(host\)\}/);
  assert.match(background, /network_calibration_requires_input_and_send/);
  assert.match(background, /const saved = await applyNetworkCalibrationProfile\(state\.domain, profile\)/);
  assert.doesNotMatch(background, /chrome\.runtime\.sendMessage\(\{ type: 'network_calibration_result'/);
});
