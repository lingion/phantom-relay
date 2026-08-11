import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
const executableContentSource = contentSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

test('content capture does not call the removed response helper', () => {
  assert.doesNotMatch(
    executableContentSource,
    /\bfindBestVisibleAssistantResponse\b/,
    'content.js contains a call to an undefined response helper'
  );
});

test('generic content runtime does not contain provider-specific selectors or branches', () => {
  assert.doesNotMatch(contentSource, /qwen-chat-message|chat-response-message|chat-user-message/);
  assert.doesNotMatch(contentSource, /Doubao|DeepSeek|Qwen|Wenxin|qwenRoleKey/);
});

test('unrecorded pages stay dormant until the user records or a valid profile is loaded', () => {
  assert.match(
    contentSource,
    /function hasExecutablePageProfile\(\)/,
    'content runtime needs one provider-neutral activation gate',
  );
  const startupStart = contentSource.indexOf('// Load selectors before the first ready lease.');
  const startupEnd = contentSource.indexOf('// Content script only reports readiness', startupStart);
  const startup = contentSource.slice(startupStart, startupEnd);
  assert.match(startup, /if \(!hasExecutablePageProfile\(\)\) return;/);
  assert.doesNotMatch(
    startup,
    /startResponseMonitor\(\)/,
    'an arbitrary page must not install a document-wide mutation observer at startup',
  );
  assert.match(
    contentSource,
    /case 'record_response':[\s\S]{0,180}startResponseMonitor\(\)/,
    'response recording may explicitly activate the monitor',
  );
  assert.match(
    contentSource,
    /case 'auto_capture':[\s\S]{0,220}startResponseMonitor\(\)/,
    'an assigned job may explicitly activate the monitor',
  );
});

test('runtime profile health and replay preserve recorded selector alternatives', () => {
  assert.match(
    executableContentSource,
    /runtimeInputSelector|runtimeInput\s*=\s*normalizeRecordedSelector\(selectors\.input\)/,
    'profile refresh must merge the authoritative input selector bundle'
  );
  assert.match(
    executableContentSource,
    /waitForElement\(selectorDescriptor\(selectors\.input\)/,
    'readiness must probe the primary selector and its recorded alternatives'
  );
  assert.doesNotMatch(
    executableContentSource,
    /waitForElement\(\{\s*css:\s*selectorText\(selectors\.input\),\s*alternatives:\s*\[\]\s*\}/,
    'readiness must not discard recorded input alternatives'
  );
});

test('profile health carries the active lifecycle revision through the content runtime', () => {
  assert.match(
    contentSource,
    /let activeProfileRevision\s*=\s*0/,
    'content runtime must keep lifecycle revision outside the pure profile contract'
  );
  assert.match(
    contentSource,
    /revision:\s*activeProfileRevision/,
    'health reports must use the active lifecycle revision instead of defaulting to zero'
  );
  assert.match(
    contentSource,
    /profile_revision/,
    'content runtime must accept lifecycle revision metadata from the background worker'
  );
  assert.match(
    contentSource,
    /if \(incomingRevision\s*>\s*0\) activeProfileRevision\s*=\s*incomingRevision/,
    'unknown revision metadata must not overwrite an already active revision'
  );
  assert.match(
    contentSource,
    /case\s*'clear_selectors'[\s\S]{0,220}activeProfileRevision\s*=\s*0/,
    'clearing the active selector bundle must clear its lifecycle revision'
  );
});

test('capture cancellation is provider-neutral and releases the page lock through autoCapture finally', () => {
  assert.match(contentSource, /let captureCancelRequested = false/);
  assert.match(contentSource, /function requestAutoCaptureCancellation\(jobId, reason\)/);
  assert.match(contentSource, /case\s*'cancel_auto_capture'/, 'content runtime must expose a generic cancellation action');
  assert.match(contentSource, /capture_cancelled/);
  assert.match(contentSource, /throwIfCaptureCancelled\(\)/);
  assert.match(contentSource, /document\.documentElement\.removeAttribute\(captureLock\)/);
  assert.doesNotMatch(contentSource, /Doubao|DeepSeek|Qwen|Wenxin/);
});

test('recorded response freshness accepts a visible changed projection when a logical key is reused', () => {
  assert.match(
    contentSource,
    /function responseChangedSinceBefore\(key, currentText, element = null\)/,
    'freshness must receive the candidate DOM element for viewport-aware comparison'
  );
  assert.match(
    contentSource,
    /if \(nextText\.length >= oldText\.length\) return true/,
    'same-key responses must preserve the existing non-shortening freshness rule'
  );
  assert.match(
    contentSource,
    /const visibleInViewport = isVisibleInViewport\(element\)/,
    'shorter same-key responses must inspect the candidate DOM region'
  );
  assert.match(
    contentSource,
    /return visibleInViewport && !responseTextWasPresentBefore\(nextText\)/,
    'a shorter same-key response must be new text in a visible projection'
  );
  assert.match(
    contentSource,
    /stable >= 3[\s\S]{0,500}snapshot\.text\.length >= 1/,
    'a stable non-streaming response is allowed to contain one valid character'
  );
  assert.match(
    contentSource,
    /isFreshRecordedResponse\(item\.key, item\.text, beforeKeys, item\.region\)/,
    'recorded response candidates must pass their DOM region into freshness checks'
  );
});

test('a fresh logical response may repeat text from an earlier turn', () => {
  const snapshotStart = contentSource.indexOf('function recordedResponseSnapshot(');
  const snapshotEnd = contentSource.indexOf('function findDirectCandidate(', snapshotStart);
  const snapshotSource = snapshotStart >= 0 && snapshotEnd > snapshotStart
    ? contentSource.slice(snapshotStart, snapshotEnd)
    : '';
  assert.match(
    snapshotSource,
    /isFreshRecordedResponse\(item\.key, item\.text, beforeKeys, item\.region\)/,
    'fresh identity must remain the authoritative response boundary'
  );
  assert.doesNotMatch(
    snapshotSource,
    /isFreshRecordedResponse\(item\.key, item\.text, beforeKeys, item\.region\)[\s\S]{0,120}responseTextWasPresentBefore\(item\.text\)/,
    'a new message identity must not be rejected only because an earlier turn had the same answer text'
  );

  const waitStart = contentSource.indexOf('async function waitForFreshAssistantResponse');
  const waitEnd = contentSource.indexOf('async function waitForVisibleResponse', waitStart);
  const waitSource = waitStart >= 0 && waitEnd > waitStart ? contentSource.slice(waitStart, waitEnd) : '';
  assert.doesNotMatch(
    waitSource,
    /snapshot\.text[\s\S]{0,120}responseTextWasPresentBefore\(snapshot\.text\)/,
    'the completion loop must settle a fresh repeated answer instead of waiting for the API deadline'
  );
});

test('shorter same-key projections cannot turn a pre-send response substring into a fresh reply', () => {
  const start = contentSource.indexOf('function responseChangedSinceBefore(');
  const end = contentSource.indexOf('function isFreshRecordedResponse(', start);
  const functionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    functionSource,
    /const oldComparable\s*=\s*normalizeComparableText\(oldText\)/,
    'same-key freshness must compare normalized old and candidate projection text'
  );
  assert.match(
    functionSource,
    /nextComparable\.length\s*<\s*oldComparable\.length[\s\S]{0,240}oldComparable\.includes\(nextComparable\)/,
    'a shorter candidate contained in the pre-send projection must be rejected as stale'
  );
});

test('fresh user evidence accepts a changed projection when a logical key is reused', () => {
  assert.match(
    contentSource,
    /function isFreshUserProjection\(key, currentText, beforeKeys\)/,
    'send evidence needs a generic freshness predicate for reused message keys'
  );
  assert.match(
    contentSource,
    /isFreshUserProjection\(n\.key, n\.text, beforeKeys\)/,
    'logical user candidates must use the reused-key freshness predicate'
  );
  assert.match(
    contentSource,
    /isFreshUserProjection\(key, text, beforeKeys\)/,
    'generic keyed user candidates must use the reused-key freshness predicate'
  );
  assert.match(
    contentSource,
    /data-virtual-list-item-key/,
    'generic user evidence must observe virtualized message rows'
  );
  assert.match(
    contentSource,
    /function userComparableText\(value\)/,
    'user evidence must normalize a generic role display prefix'
  );
});

test('recorded shortcut dispatch is not retried when the page exposes only assistant DOM', () => {
  const dispatched = contentSource.indexOf('send_recorded_shortcut_dispatched');
  const observed = contentSource.indexOf('await waitForSendObservation(', dispatched);
  assert.ok(
    dispatched >= 0 && observed > dispatched,
    'a successfully dispatched recorded shortcut must proceed to bounded page-effect observation',
  );
  assert.doesNotMatch(
    contentSource,
    /send_recorded_shortcut_attempt[\s\S]{0,1600}send_enter_fallback_attempt/,
    'a missing keyed user projection must not trigger duplicate Enter submissions'
  );
});

test('button replay requires bounded provider-neutral send observation before the long response wait', () => {
  const start = contentSource.indexOf('async function autoCapture(');
  const end = contentSource.indexOf('function normalizeRecordedSelector(', start);
  const autoCaptureSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    autoCaptureSource,
    /await waitForSendObservation\(/,
    'a dispatched action must be observed before entering the model response window'
  );
  assert.match(
    autoCaptureSource,
    /send_not_observed/,
    'an action with no page effect must return a structured failure'
  );
  assert.doesNotMatch(
    autoCaptureSource,
    /Date\.now\(\)\s*-\s*evidenceStarted[\s\S]{0,300}60000/,
    'button replay must not hold the request for a fixed 60-second projection wait'
  );
});

test('recorded button replay dispatches one provider-neutral click action', () => {
  const captureStart = contentSource.indexOf('async function autoCapture(');
  const captureEnd = contentSource.indexOf('function normalizeRecordedSelector(', captureStart);
  const autoCaptureSource = captureStart >= 0 && captureEnd > captureStart
    ? contentSource.slice(captureStart, captureEnd)
    : '';
  const clickStart = contentSource.indexOf('function safeClick(');
  const clickEnd = contentSource.indexOf('\n  function getCopyButtons', clickStart);
  const safeClickSource = clickStart >= 0 && clickEnd > clickStart
    ? contentSource.slice(clickStart, clickEnd)
    : '';

  assert.doesNotMatch(
    autoCaptureSource,
    /invokeFrameworkClick/,
    'generic replay must not call React private handlers after dispatching a DOM click',
  );
  assert.doesNotMatch(
    contentSource,
    /function invokeFrameworkClick\(/,
    'framework-private click replay must not exist in the provider-neutral runtime',
  );
  assert.match(
    safeClickSource,
    /return dispatchRecordedPointerClick\(target\);/,
    'a non-native recorded control must emit one pointer/click sequence without a second HTMLElement.click()',
  );
});

test('send and response observation helpers are loaded before the content runtime', () => {
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const popupSource = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
  assert.match(
    backgroundSource,
    /files:\s*\[[^\]]*'send_observation\.js'[^\]]*'content\.js'/,
    'background content injection must load the provider-neutral observation helper first'
  );
  assert.match(
    popupSource,
    /files:\s*\[[^\]]*'send_observation\.js'[^\]]*'content\.js'/,
    'popup content injection must load the provider-neutral observation helper first'
  );
  assert.match(
    backgroundSource,
    /files:\s*\[[^\]]*'response_observation\.js'[^\]]*'content\.js'/,
    'background content injection must load response qualification before the runtime'
  );
  assert.match(
    popupSource,
    /files:\s*\[[^\]]*'response_observation\.js'[^\]]*'content\.js'/,
    'popup content injection must load response qualification before the runtime'
  );
  assert.match(contentSource, /PhantomRelaySendObservation/);
  assert.match(contentSource, /PhantomRelayResponseObservation/);
});

test('recorded Enter dispatch is provider-neutral and single-shot when outcome is unknown', () => {
  assert.match(
    contentSource,
    /function dispatchRecordedKeyboardOnce\(/,
    'Enter replay must have one explicit dispatch boundary'
  );
  assert.match(
    contentSource,
    /dispatchRecordedKeyboardOnce\(inputEl,\s*\{\s*key:\s*sendKey/,
    'auto capture must use the single-shot Enter dispatcher'
  );
  assert.doesNotMatch(contentSource, /cdp_dispatch_key|Input\.dispatchKeyEvent/);
  assert.doesNotMatch(
    contentSource,
    /for \(let attempt = 1; attempt <= 3 && !sendEvidence; attempt\+\+\)/,
    'an uncertain keyboard outcome must not trigger repeated Enter submissions'
  );
  assert.doesNotMatch(
    contentSource,
    /universal_button_fallback[\s\S]{0,1800}recorded_button_fallback_lookup/,
    'Enter replay must not silently submit through unrelated button fallbacks'
  );
});

test('recorded response region falls back to the stable container selector', () => {
  assert.match(
    contentSource,
    /function recordedResponseRegion\(\)[\s\S]{0,900}for \(const css of responseSelectorSet\(\)\)/,
    'response-region lookup must try the recorded selector and container selector'
  );
  assert.match(
    contentSource,
    /function recordedResponseScopeElements\(\)[\s\S]{0,900}querySelectorAll\(tag\)/,
    'response replay must recover the recorded element tag inside a stable container scope'
  );
  assert.match(
    contentSource,
    /function responseRegionElements\(\)[\s\S]{0,500}recordedResponseScopeElements\(\)/,
    'response snapshots must union direct selectors with scoped recovery candidates'
  );
});

test('visible response fallback cannot reuse a pre-send identity', () => {
  assert.match(
    contentSource,
    /visibleResponse\?\.key[\s\S]{0,120}!beforeKeys\.has\(visibleResponse\.key\)/,
    'a visible response with a pre-send key must wait for the fresh response contract'
  );
});

test('stream relay cannot bypass the recorded response identity boundary', () => {
  assert.match(
    contentSource,
    /function recordedResponseIdentityGap\(\)/,
    'capture must diagnose a non-empty response region that lacks recorded identity'
  );
  assert.match(
    contentSource,
    /recorded_response_identity_missing/,
    'identity gaps must fail explicitly instead of becoming assistant text'
  );
  const monitorStart = contentSource.indexOf('function emitResponseMonitorSnapshot');
  const monitorEnd = contentSource.indexOf('function startResponseMonitor', monitorStart);
  const monitorSource = monitorStart >= 0 && monitorEnd > monitorStart
    ? contentSource.slice(monitorStart, monitorEnd)
    : '';
  assert.match(
    monitorSource,
    /if \(!n\.key \|\| !n\.text\)/,
    'response monitor must ignore anonymous DOM projections'
  );
  assert.doesNotMatch(
    contentSource,
    /activeStreamDeltaTimer|startStreamDelta|stopStreamDelta/,
    'streaming must use the identity-checked capture loop, not an unchecked side channel'
  );
});

test('transient response identity gaps do not abort capture before DOM rehydration', () => {
  const start = contentSource.indexOf('async function waitForFreshAssistantResponse');
  const end = contentSource.indexOf('async function waitForVisibleResponse', start);
  const waitSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    waitSource,
    /recorded_response_identity_pending/,
    'a transient DOM rebuild must be observable without becoming a terminal capture error'
  );
  assert.doesNotMatch(
    waitSource,
    /const identityGap = recordedResponseIdentityGap\(\);[\s\S]{0,500}throw new Error\('recorded_response_identity_missing'\)/,
    'the first identity gap after send must not cancel a request before the page rehydrates'
  );
});

test('recorded response selectors stay inside the declared response container', () => {
  assert.match(
    contentSource,
    /function isWithinRecordedResponseScope\(/,
    'a structural response selector must be constrained by its recorded container'
  );
  const start = contentSource.indexOf('function responseRegionElements()');
  const end = contentSource.indexOf('function declaredIdentityElement', start);
  const regionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    regionSource,
    /filter\(isWithinRecordedResponseScope\)/,
    'input-area and layout matches must not enter the response identity boundary'
  );
});

test('recorded response replay derives provider-neutral volatile-id alternatives', () => {
  assert.match(contentSource, /PhantomRelaySelectorRecovery/);
  assert.match(contentSource, /deriveAlternatives/);
  assert.match(contentSource, /response\.selector, response\.containerSelector/);
  assert.doesNotMatch(contentSource, /chat\.qwen|doubao|deepseek|wenxin/i);
});

test('button replay can advance on fresh recorded response evidence', () => {
  assert.match(contentSource, /function freshResponseEvidence\(userMessage, beforeKeys\)/);
  assert.match(contentSource, /const responseEvidence = freshResponseEvidence\(userMessage, beforeKeys\)/);
  assert.match(contentSource, /send_response_evidence/);
});

test('send response evidence uses the canonical recorded snapshot boundary', () => {
  const start = contentSource.indexOf('function freshResponseEvidence(userMessage, beforeKeys)');
  const end = contentSource.indexOf('\n  function createRecordedResponseWake()', start);
  const helper = contentSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'fresh response evidence helper must remain inspectable');
  assert.match(
    helper,
    /recordedResponseSnapshot\(userMessage, beforeKeys\)/,
    'send acceptance must use the same normalized recorded boundary as final response capture',
  );
  assert.doesNotMatch(
    helper,
    /innerText|textContent/,
    'excluded controls or status labels must not make an old response look fresh',
  );
});

test('fresh response changes relay snapshots from the authoritative completion loop', () => {
  const start = contentSource.indexOf('async function waitForFreshAssistantResponse');
  const end = contentSource.indexOf('async function waitForVisibleResponse', start);
  const functionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    functionSource,
    /relayCaptureSnapshot\(/,
    'each authoritative fresh response snapshot must be available to caller-facing streaming'
  );
  assert.doesNotMatch(
    functionSource,
    /filteredCandidates|freshUserIndex/,
    'legacy candidate fallback must not bypass recorded identity qualification'
  );
  assert.match(
    functionSource,
    /if \(identityObservation\.qualified && \(snapshotChanged \|\| identityObservation\.becameQualified\)\) \{\s*relayCaptureSnapshot\(/,
    'caller-facing streaming must remain inside the qualified recorded-identity branch'
  );
});

test('response capture timeout is not reduced to 15 seconds for short prompts', () => {
  const start = contentSource.indexOf('async function autoCapture(');
  const end = contentSource.indexOf('function normalizeRecordedSelector(', start);
  const autoCaptureSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.doesNotMatch(
    autoCaptureSource,
    /const longContextPrompt\s*=\s*userMessage\.length\s*>\s*1200/,
    'capture duration must not be selected from prompt length'
  );
  assert.match(
    autoCaptureSource,
    /const freshTimeoutMs\s*=\s*Math\.max\(\s*120000/,
    'capture must retain a progress-aware long-running window'
  );
  assert.match(
    autoCaptureSource,
    /captureTimeoutMs/,
    'the browser capture window must be supplied by the request contract'
  );
});

test('DOM completion uses page activity and repeated snapshots instead of fixed silence', () => {
  const start = contentSource.indexOf('async function waitForFreshAssistantResponse');
  const end = contentSource.indexOf('async function waitForVisibleResponse', start);
  const waitSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(waitSource, /responseActivityState\(/, 'completion must inspect provider-neutral page activity');
  assert.match(waitSource, /generationSignalSeen/, 'completion must remember whether the page exposed an active generation signal');
  assert.match(waitSource, /stable >= 3[\s\S]{0,180}!snapshot\.streaming/, 'completion must require repeated identity-checked snapshots after activity stops');
  assert.doesNotMatch(waitSource, /NO_INDICATOR_SETTLE_WINDOW_MS|completionSettleWindowMs|lastChangeAt/, 'completion must not use a fixed silent interval');

  const autoStart = contentSource.indexOf('async function autoCapture(');
  const autoEnd = contentSource.indexOf('function normalizeRecordedSelector(', autoStart);
  const autoSource = autoStart >= 0 && autoEnd > autoStart ? contentSource.slice(autoStart, autoEnd) : '';
  assert.doesNotMatch(autoSource, /response_candidate_too_short_waiting|shortStarted|< 8/, 'short valid answers must not trigger a hidden extra wait');
});

test('recorded response observation is event-driven in hidden provider tabs', () => {
  const wakeStart = contentSource.indexOf('function createRecordedResponseWake(');
  const waitStart = contentSource.indexOf('async function waitForFreshAssistantResponse');
  const waitEnd = contentSource.indexOf('async function waitForVisibleResponse', waitStart);
  const waitSource = waitStart >= 0 && waitEnd > waitStart
    ? contentSource.slice(waitStart, waitEnd)
    : '';

  assert.ok(wakeStart >= 0, 'capture must install a response-scoped mutation wake source');
  assert.match(waitSource, /responseWake\.wait\(/, 'the completion loop must wait on DOM or worker events');
  assert.match(waitSource, /explicitlySettled/, 'an observed inactive marker must be usable as terminal evidence');
  assert.doesNotMatch(
    waitSource,
    /await sleep\(200\)/,
    'hidden-tab timer throttling must not control response qualification or completion',
  );
  assert.match(contentSource, /capture_observation_tick/, 'the extension worker must supply the fallback stability tick');
});

test('only recorded response activity controls completion', () => {
  assert.match(contentSource, /const GENERATION_CONTROL_PATTERN/);
  assert.match(contentSource, /function activeGenerationControl\(\)/);
  assert.match(contentSource, /button, \[role="button"\], \[aria-label\], \[title\]/);
  const responseStart = contentSource.indexOf('function responseActivityState(');
  const responseEnd = contentSource.indexOf('function domToMarkdown(', responseStart);
  const responseSource = responseStart >= 0 && responseEnd > responseStart
    ? contentSource.slice(responseStart, responseEnd)
    : '';
  assert.match(responseSource, /isResponseStreaming\(\{ recordedMarker: marker \}\)/);
  assert.doesNotMatch(responseSource, /activeGenerationControl/);
  assert.match(contentSource, /function sendActivityState\([\s\S]{0,300}activeGenerationControl/);
  assert.doesNotMatch(contentSource, /Doubao|DeepSeek|Qwen|Wenxin/);
});

test('intermediate recorded snapshots are relayed as streaming evidence', () => {
  const start = contentSource.indexOf('function relayCaptureSnapshot');
  const end = contentSource.indexOf('// ── 高亮', start);
  const relaySource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(relaySource, /streaming:\s*true/, 'DOM snapshots sent before final result must remain non-terminal');
});

test('button replay accepts changed text when a virtualized response key is reused', () => {
  const evidenceStart = contentSource.indexOf('function freshResponseEvidence(userMessage, beforeKeys)');
  const evidenceEnd = contentSource.indexOf('function createRecordedResponseWake()', evidenceStart);
  const evidenceSource = evidenceStart >= 0 && evidenceEnd > evidenceStart
    ? contentSource.slice(evidenceStart, evidenceEnd)
    : '';
  const snapshotStart = contentSource.indexOf('function recordedResponseSnapshot(');
  const snapshotEnd = contentSource.indexOf('function recordedResponseIdentityGap()', snapshotStart);
  const snapshotSource = snapshotStart >= 0 && snapshotEnd > snapshotStart
    ? contentSource.slice(snapshotStart, snapshotEnd)
    : '';
  assert.match(
    evidenceSource,
    /recordedResponseSnapshot\(userMessage, beforeKeys\)/,
    'button send evidence must use the canonical recorded response snapshot'
  );
  assert.match(
    snapshotSource,
    /isFreshRecordedResponse\(item\.key, item\.text, beforeKeys, item\.region\)/,
    'button send evidence must accept a changed projection under a reused logical response key'
  );
});

test('recorded response snapshot unions primary and derived selector matches', () => {
  assert.match(
    contentSource,
    /const regions = responseRegionElements\(\)\.filter\(/,
    'response capture must inspect all provider-neutral selector candidates'
  );
  assert.doesNotMatch(
    contentSource,
    /if \(regions\.length\) break/,
    'a still-present stale primary selector must not hide a fresh derived match'
  );
});

test('recorded response snapshots clean generic status lines before freshness decisions', () => {
  const start = contentSource.indexOf('function recordedResponseSnapshot(');
  const end = contentSource.indexOf('function findDirectCandidate(', start);
  const functionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    functionSource,
    /const rawText\s*=\s*ProfileContract\.normalizeText\(activeProfile, extractMessageText\(region\)\)/,
    'recorded snapshots must retain the normalized DOM text as an intermediate value'
  );
  assert.match(
    functionSource,
    /text:\s*Universal\?\.responseText\s*\?\s*Universal\.responseText\(rawText\)\s*:\s*rawText/,
    'recorded snapshots must remove provider-neutral progress/status lines before freshness checks'
  );
});

test('recorded response projections keep the longest text for each declared identity', () => {
  const start = contentSource.indexOf('function recordedResponseSnapshot(');
  const end = contentSource.indexOf('function findDirectCandidate(', start);
  const functionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    functionSource,
    /selectLongestProjection\(group\)/,
    'a message identity must select the longest live text projection'
  );
  assert.doesNotMatch(
    functionSource,
    /const leaves = group\.filter\(/,
    'an inner short projection must not hide the complete outer message text'
  );
});

test('response identity walks from recorded inner node to its declared stable ancestor', () => {
  assert.match(
    contentSource,
    /function declaredIdentityElement\(element\)[\s\S]{0,1200}getAttribute\(attribute\)/,
    'DOM capture must resolve stable identity on an ancestor of the recorded text node'
  );
  assert.match(
    contentSource,
    /const declared = declaredIdentityElement\(el\);/,
    'element records must prefer the declared identity ancestor over a generic container selector'
  );
  assert.match(contentSource, /identityElement = declared;/);
});

test('capture revalidates a response boundary after the page creates a response region', () => {
  assert.match(
    contentSource,
    /runProfileHealthCheck\(activeProfile,\s*\{\s*allowMissingResponse:\s*false/
  );
  assert.match(contentSource, /profile_response_scope_too_broad/);
  assert.match(contentSource, /recorded_response_boundary_rejected/);
});

test('recording mode gives the user visible candidate boxes and a hovered target label', () => {
  assert.match(contentSource, /function startRecordingOverlay\(targetRole\)/);
  assert.match(contentSource, /recording-overlay/);
  assert.match(contentSource, /pointermove/);
  assert.match(contentSource, /candidate/);
  assert.match(contentSource, /移动鼠标/);
});

test('response recording persists the boxed candidate instead of a clicked inner descendant', () => {
  assert.match(
    contentSource,
    /let recordingOverlayCandidates\s*=\s*\[\]/,
    'the overlay must retain the exact page elements represented by candidate boxes'
  );
  assert.match(
    contentSource,
    /function recordingCandidateForTarget\(target, role\)[\s\S]{0,900}recordingOverlayCandidates[\s\S]{0,500}candidate\.contains\?\.\(element\)/,
    'hover and click resolution must map descendants back to the same boxed response candidate'
  );
  assert.match(
    contentSource,
    /if \(targetRole === 'response'\)[\s\S]{0,420}recordingCandidateForTarget\(e\.target, 'response'\)/,
    'the persisted response selector must be generated from the boxed candidate'
  );
});

test('response candidate labels disclose an ancestor identity anchor when the clicked projection lacks one', () => {
  assert.match(
    contentSource,
    /function recordingOverlayLabelFor\(element, role\)[\s\S]{0,700}recordingResponseIdentityAnchor\(element\)/,
    'response labels must explain which stable ancestor identity will delimit the replayed message'
  );
  assert.match(
    contentSource,
    /身份锚点/,
    'response labels must expose the identity anchor in human-readable form'
  );
});

test('recording overlay ignores its own mutations and limits refresh observation to page changes', () => {
  assert.match(
    contentSource,
    /function recordingOverlayMutationIsPageChange\(records\)/,
    'overlay refresh must have an explicit page-vs-overlay mutation boundary'
  );
  assert.match(
    contentSource,
    /const changedNodes\s*=\s*\[[\s\S]{0,220}addedNodes[\s\S]{0,220}removedNodes/,
    'observer filtering must ignore nodes created inside the recording overlay'
  );
  assert.match(
    contentSource,
    /changedNodes\.every\(isRecordingOverlayNode\)/,
    'observer filtering must classify overlay nodes through one shared predicate'
  );
  assert.match(
    contentSource,
    /attributeFilter:\s*\[[\s\S]{0,260}(?:class|style|hidden|aria-hidden)/,
    'observer must avoid subscribing to every page attribute mutation'
  );
});

test('response recording overlay filters structural page chrome and deduplicates message projections', () => {
  assert.match(
    contentSource,
    /const recordingResponseSemanticPattern\s*=\s*\//,
    'response candidates must use provider-neutral message/content semantics'
  );
  assert.match(
    contentSource,
    /const recordingResponseStructuralPattern\s*=\s*\//,
    'response candidates must exclude generic page chrome and layout containers'
  );
  assert.match(
    contentSource,
    /const recordingResponseControlPattern\s*=\s*\//,
    'response candidates must exclude generic response action controls'
  );
  assert.match(
    contentSource,
    /function recordingResponseCandidateAllowed\(element, textLength\)/,
    'response candidate selection must have an explicit structural filter'
  );
  assert.match(
    contentSource,
    /function recordingResponseIdentityAnchor\(element\)/,
    'response candidate selection must group projections by a stable identity scope'
  );
  assert.match(
    contentSource,
    /function recordingResponseIdentityAnchor\(element\)[\s\S]{0,1000}getAttribute\(['"]id['"]\)[\s\S]{0,500}recordingResponseSemanticPattern/,
    'response candidates must use a semantic id ancestor as their identity scope'
  );
  assert.match(
    contentSource,
    /const responseGroups\s*=\s*new Map\(\)/,
    'response candidates must be deduplicated before drawing boxes'
  );
  assert.match(
    contentSource,
    /return selected\.slice\(0, role === 'response' \? 24/,
    'response overlay must keep the visual choice set bounded'
  );
});

test('response recording rejects profiles without stable message identity', () => {
  assert.match(
    contentSource,
    /const recordedProfile = targetRole === 'response'[\s\S]{0,240}buildRecordedProfile\(actualTarget, selector\)/,
    'response recording must build the profile before accepting the selector'
  );
  assert.match(
    contentSource,
    /if \(targetRole === 'response' && !recordedProfile\)/,
    'response recording must fail closed when the profile contract is incomplete'
  );
  assert.match(
    contentSource,
    /error: 'profile_identity_unavailable'/,
    'recording failure must expose a bounded generic reason code'
  );
  assert.match(
    contentSource,
    /type: 'selector_capture_rejected'/,
    'popup must receive a recording rejection event'
  );
  assert.match(
    contentSource,
    /if \(targetRole === 'response' && !recordedProfile\)[\s\S]{0,1200}selectors\[targetRole\] = \{/,
    'response selector persistence must occur only after the profile check'
  );
});

test('response recording emits metadata-only evidence when the real click reaches the listener', () => {
  assert.match(
    contentSource,
    /clickCapture\s*=\s*function \(e\) \{[\s\S]{0,700}emitPageTrace\(['"]recording_click_seen['"]/
  );
  assert.match(
    contentSource,
    /recording_click_seen[\s\S]{0,500}trusted:\s*!!e\?\.isTrusted/
  );
  assert.doesNotMatch(
    contentSource,
    /recording_click_seen[\s\S]{0,300}textContent/
  );
});

test('diagnostic traces are metadata-only at call sites, not just filtered after page content is collected', () => {
  assert.match(contentSource, /function sanitizeTraceValue\(/);
  assert.match(contentSource, /input_value_preview/);
  assert.match(contentSource, /value_preview/);
  assert.doesNotMatch(contentSource, /inputValuePreview|valuePreview|bodyTail|userMessagePreview/);
  assert.doesNotMatch(contentSource, /emitPageTrace\(['"]response_probe['"][\s\S]{0,700}userMessage\s*:/);
  assert.doesNotMatch(contentSource, /emitPageTrace\(['"]response_probe['"][\s\S]{0,900}bodyTail/);
  assert.doesNotMatch(contentSource, /function debugNode\([\s\S]{0,220}text:\s*n\.text/);
  assert.doesNotMatch(contentSource, /function emitResponseMonitorSnapshot\([\s\S]{0,500}text:\s*text/);
});

test('recording observes the provider-neutral pointer-to-click event boundary without page text', () => {
  assert.match(contentSource, /recording_input_event_seen/);
  assert.match(contentSource, /\['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'\]/);
  assert.match(contentSource, /eventType:\s*String\(e\?\.type/);
  assert.doesNotMatch(contentSource, /recording_input_event_seen[\s\S]{0,500}textContent/);
});

test('content singleton rejects duplicate isolated-world injections through a DOM heartbeat', () => {
  assert.match(contentSource, /INSTANCE_HEARTBEAT_MARKER/);
  assert.match(contentSource, /INSTANCE_EVENT_NAME/);
  assert.match(contentSource, /heartbeatBefore/);
  assert.match(contentSource, /document\.dispatchEvent\(new Event\(INSTANCE_EVENT_NAME\)\)/);
  assert.match(contentSource, /heartbeatAfter\s*!==\s*heartbeatBefore[\s\S]{0,240}return/);
  assert.match(contentSource, /document\.addEventListener\(INSTANCE_EVENT_NAME/);
  assert.match(contentSource, /const touchInstanceHeartbeat\s*=\s*\(\)\s*=>/);
  assert.match(contentSource, /requestReadyLease\(\)\s*\{[\s\S]{0,120}touchInstanceHeartbeat\(\)/);
});

test('response recording discovers provider-neutral identity without freezing dynamic message ids', () => {
  assert.match(
    contentSource,
    /const stableIdentityAttributes\s*=\s*\[/,
    'recording must keep an explicit priority list for known stable identity attributes'
  );
  assert.match(
    contentSource,
    /stableIdentityAttributes\s*=\s*\[[^;]*data-lid/,
    'recording must prioritize generic message data identities such as data-lid'
  );
  assert.doesNotMatch(
    contentSource,
    /stableIdentityAttributes\s*=\s*\[[^;]*['"]id['"]\s*\]/,
    'plain DOM ids must remain a last-resort identity rather than a message priority'
  );
  assert.match(
    contentSource,
    /const generic = Array\.from\(candidate\?\.attributes \|\| \[\]\)[\s\S]{0,700}if \(generic\.length\) return generic[\s\S]{0,300}return \['id'\]/,
    'identity discovery must prefer generic data attributes before falling back to id'
  );
  assert.match(
    contentSource,
    /const minimumIdentityDepth\s*=\s*16/,
    'recording must search beyond shallow message markup when finding an identity ancestor'
  );
  assert.match(
    contentSource,
    /name\.startsWith\(['"]data-['"]\)/,
    'recording must inspect actual provider-neutral data attributes instead of naming providers'
  );
  assert.match(
    contentSource,
    /containerSelector\s*=\s*!structuralIdentity\s*&&\s*identity\.element\s*!==\s*responseElement[\s\S]{0,700}generateStableContainerSelector\(identity\.element\)/,
    'recording must keep the response container structural and reserve identity values for freshness checks'
  );
  assert.doesNotMatch(
    contentSource,
    /identityAttributeSelector\(identity\.element, identity\.attributes\)/,
    'recording must not persist a volatile identity value inside the response container selector'
  );
  assert.match(
    contentSource,
    /const genericIdentityExcluded\s*=\s*\//,
    'recording must exclude generic state, test, session, and content attributes from identity discovery'
  );
  assert.match(contentSource, /role\|status\|state\|streaming\|loading\|busy[\s\S]{0,240}test\|qa/);
  assert.match(contentSource, /content\|text\|html\|style\|log/);
  assert.match(contentSource, /rank\|index\|position\|order/);
  assert.match(
    contentSource,
    /spm\|track\|trace\|analytics\|telemetry\|event\|anchor\|source/,
    'identity discovery must reject analytics and telemetry attributes'
  );
  assert.match(
    contentSource,
    /panel\|layout[\s\S]{0,240}container[\s\S]{0,240}viewport/,
    'identity discovery must reject generic layout and container attributes'
  );
  assert.match(
    contentSource,
    /conversation\|chat[\s\S]{0,240}content\|text[\s\S]{0,240}container\|wrapper\|scroll\|flow/,
    'plain layout ids must not become response identity fallbacks'
  );
  assert.match(
    contentSource,
    /const volatilePlainId\s*=\s*\(value\)\s*=>[\s\S]{0,1200}return \/\(\?:\^\|\[-_:\]\)\(message\|response\|reply\|result\|item\|row\|node\|turn\)/,
    'identity discovery must classify message-shaped ids as volatile unless separately proven reusable'
  );
  assert.match(
    contentSource,
    /String\(attribute\)\.toLowerCase\(\)\s*===\s*['"]id['"]\s*&&\s*volatilePlainId\(value\)[\s\S]{0,260}!\(allowDynamicMessageId\s*&&\s*dynamicMessageId\(value\)\)/,
    'plain ids must be rejected unless dynamic message identity is explicitly enabled by the caller'
  );
  assert.ok(
    contentSource.includes('return /(?:^|[-_:])(message|response|reply|result|item|row|node|turn)(?:[-_:]|$)/i.test(normalized)'),
    'plain container ids with message semantics must not become response identity'
  );
  assert.match(
    contentSource,
    /candidate\.contains(?:\?\.)?\(item\)/,
    'recording may accept a repeated identity value only when all projections stay inside one candidate scope'
  );
  assert.match(
    contentSource,
    /function selectorClassTokens\(el\)/,
    'structural selectors must derive a reusable class subset instead of freezing volatile state classes'
  );
  assert.match(
    contentSource,
    /selectorClassTokens\(el\)/,
    'selector generation must use the reusable class subset'
  );
  assert.match(
    contentSource,
    /active\|current\|last\|first\|show\|hide\|loading\|streaming\|busy\|disabled\|selected\|focus\|hover\|open\|close\|transition\|animation\|enter\|leave\|visible\|hidden\|rank/,
    'provider-neutral selector generation must reject volatile state and ranking classes'
  );
});

test('response recording separates transient state from message identity', () => {
  assert.match(
    contentSource,
    /typing\|generating\|thinking\|processing\|pending\|complete\|completed\|finished/,
    'generation and completion state attributes must never become message identity'
  );
  assert.match(
    contentSource,
    /function recordedStreamingIndicators\(element\)/,
    'recording must convert boolean generation state into a streaming contract'
  );
  assert.match(
    contentSource,
    /recordedStreamingIndicators\(responseElement\)/,
    'the recorded profile must persist discovered state indicators'
  );
});

test('response recording falls back to selector-position identity without site branches', () => {
  assert.match(contentSource, /recordedResponseIndex/);
  assert.match(contentSource, /path:\s*['"]recordedResponseIndex['"]/);
  assert.match(contentSource, /method:\s*['"]selector-index-at-recording['"]/);
  assert.match(contentSource, /identityKind:\s*['"]selector-position['"]/);
});

test('caller-facing response qualification rejects unknown-role user echoes', () => {
  assert.match(
    contentSource,
    /ResponseObservation\.isLikelyUserEcho\(/,
    'the runtime must use the shared prompt-echo classifier'
  );
  assert.match(
    contentSource,
    /return \{ key: chosen\.key, text: chosen\.text, streaming: chosen\.streaming, role: chosen\.role, region: chosen\.region \};/,
    'recorded snapshots must preserve role through final qualification'
  );
});
