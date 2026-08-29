import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
const executableContentSource = contentSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

function loadNamedFunction(source, name, context = {}) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in content runtime`);
  let depth = 0;
  let bodyStarted = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') {
      bodyStarted = true;
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (bodyStarted && depth === 0) {
        return vm.runInNewContext(`(${source.slice(start, index + 1)})`, context);
      }
    }
  }
  assert.fail(`${name} function body was not complete`);
}

test('content capture does not call the removed response helper', () => {
  assert.doesNotMatch(
    executableContentSource,
    /\bfindBestVisibleAssistantResponse\b/,
    'content.js contains a call to an undefined response helper'
  );
});

test('recorded input owner survives selector state changes and only re-queries after detach', () => {
  const connectedInput = { isConnected: true };
  const replacementInput = { isConnected: true };
  const queries = [];
  const resolveRecordedInputOwner = loadNamedFunction(
    contentSource,
    'resolveRecordedInputOwner',
    {
      document: {
        querySelector(selector) {
          queries.push(selector);
          return replacementInput;
        },
      },
    },
  );

  assert.equal(
    resolveRecordedInputOwner('div.editor.empty', connectedInput),
    connectedInput,
    'a connected recorded input remains the request owner after its selector stops matching',
  );
  assert.deepEqual(queries, [], 'a connected owner must not be replaced by a fresh selector match');

  connectedInput.isConnected = false;
  assert.equal(
    resolveRecordedInputOwner('div.editor.empty', connectedInput),
    replacementInput,
    'the original recorded selector may be queried only after the captured owner detaches',
  );
  assert.deepEqual(queries, ['div.editor.empty']);
});

test('interactable input resolution replaces a stale connected SPA node', () => {
  const staleInput = {
    isConnected: true,
    interactable: false,
    matches: () => true,
  };
  const liveInput = {
    isConnected: true,
    interactable: true,
    matches: () => true,
  };
  const context = {
    document: {
      activeElement: null,
      querySelectorAll() {
        return [liveInput];
      },
    },
    ProfileHealth: {
      isInputInteractable(element) {
        return !!element?.interactable;
      },
    },
    selectorDescriptor(value) {
      return { css: String(value || ''), alternatives: [] };
    },
  };
  const inputCandidateInteractable = loadNamedFunction(
    contentSource,
    'inputCandidateInteractable',
    context,
  );
  const recordedInputCandidates = loadNamedFunction(
    contentSource,
    'recordedInputCandidates',
    { ...context, inputCandidateInteractable },
  );
  const resolveInteractableRecordedInput = loadNamedFunction(
    contentSource,
    'resolveInteractableRecordedInput',
    { ...context, recordedInputCandidates, inputCandidateInteractable },
  );

  assert.equal(
    resolveInteractableRecordedInput('textarea.message-input-textarea', staleInput),
    liveInput,
    'a connected but covered/disabled owner must not block selection of the live replacement',
  );
});

test('legacy stateful input selectors derive stable alternatives before readiness checks', () => {
  const queried = [];
  const context = {
    document: {
      querySelectorAll(selector) {
        queried.push(selector);
        return selector === 'div.tiptap.ProseMirror' ? [{}] : [];
      },
    },
  };
  const deriveStableSelectorAlternatives = loadNamedFunction(
    contentSource,
    'deriveStableSelectorAlternatives',
    context,
  );
  const normalizeRecordedSelector = loadNamedFunction(
    contentSource,
    'normalizeRecordedSelector',
    {
      ...context,
      deriveStableSelectorAlternatives,
    },
  );

  const normalized = normalizeRecordedSelector({
    css: 'div.tiptap.ProseMirror.ProseMirror-focused',
    alternatives: [],
  });
  assert.equal(normalized.css, 'div.tiptap.ProseMirror.ProseMirror-focused');
  assert.equal(normalized.alternatives.length, 1);
  assert.equal(normalized.alternatives[0], 'div.tiptap.ProseMirror');
  assert.equal(
    normalized.css,
    'div.tiptap.ProseMirror.ProseMirror-focused',
    'a historical focus-state selector must retain its recording value',
  );
  assert.ok(queried.includes('div.tiptap.ProseMirror'));
});

test('auto capture uses the recorded input owner through boundary, keyboard dispatch, and observation', () => {
  const captureStart = contentSource.indexOf('async function autoCapture(');
  const captureEnd = contentSource.indexOf('function requestAutoCaptureCancellation(', captureStart);
  const captureSource = contentSource.slice(captureStart, captureEnd);
  const observationStart = contentSource.indexOf('async function waitForSendObservation(');
  const observationEnd = contentSource.indexOf('async function autoCapture(', observationStart);
  const observationSource = contentSource.slice(observationStart, observationEnd);

  assert.match(captureSource, /const preSendInput\s*=\s*await waitForInteractableRecordedInput\(/);
  assert.match(
    captureSource,
    /dispatchRecordedKeyboardOnce\(inputEl,/,
    'Enter and shortcut dispatch must target the revalidated recorded input owner',
  );
  assert.match(
    captureSource,
    /waitForSendObservation\(\{[\s\S]{0,420}inputElement:\s*inputEl/,
    'send observation must receive the same recorded input owner',
  );
  assert.match(
    observationSource,
    /const input\s*=\s*resolveInteractableRecordedInput\(inputSelector,\s*inputElement\)/,
    'send observation must re-resolve the recorded input after a DOM replacement',
  );
});

test('readiness and auto capture require the recorded input to remain interactable', () => {
  const readinessStart = contentSource.indexOf("case 'wait_until_ready':");
  const readinessEnd = contentSource.indexOf("case 'get_profile_health':", readinessStart);
  const readinessSource = contentSource.slice(readinessStart, readinessEnd);
  const captureStart = contentSource.indexOf('async function autoCapture(');
  const captureEnd = contentSource.indexOf('function requestAutoCaptureCancellation(', captureStart);
  const captureSource = contentSource.slice(captureStart, captureEnd);

  assert.match(
    readinessSource,
    /waitForInteractableRecordedInput\(/,
    'a covered or disabled recorded input must never publish a ready lease',
  );
  assert.match(
    captureSource,
    /waitForInteractableRecordedInput\(/,
    'the recorded owner must be revalidated immediately before the single send action',
  );
  assert.match(captureSource, /recorded_input_not_interactable/);
});

test('readiness waits for dynamic page elements after static profile validation', () => {
  const readinessStart = contentSource.indexOf("case 'wait_until_ready':");
  const readinessEnd = contentSource.indexOf("case 'get_profile_health':", readinessStart);
  const readinessSource = contentSource.slice(readinessStart, readinessEnd);
  assert.match(
    readinessSource,
    /const profileHealth = activeProfile\s*\?\s*runProfileHealthCheck\(activeProfile,\s*\{[\s\S]{0,240}document:\s*null/,
    'initial readiness validation must not fail because the SPA composer has not rendered yet',
  );
  assert.match(
    readinessSource,
    /const finalHealth = liveHealth \|\| \(activeProfile\s*\?\s*runProfileHealthCheck\(activeProfile,\s*\{[\s\S]{0,180}\}\)\s*:\s*null\)/,
    'readiness timeout must return the live metadata-only health report',
  );
});

test('readiness revalidates live recorded response identity before publishing a ready lease', () => {
  const readinessStart = contentSource.indexOf("case 'wait_until_ready':");
  const readinessEnd = contentSource.indexOf("case 'get_profile_health':", readinessStart);
  const readinessSource = contentSource.slice(readinessStart, readinessEnd);
  const liveHealthStart = readinessSource.indexOf('liveHealth = activeProfile');
  const liveHealthInvalid = readinessSource.indexOf("liveHealth?.state === 'invalid'", liveHealthStart);
  const readyLease = readinessSource.indexOf('sendResponse({ ready: true', liveHealthInvalid);
  assert.ok(liveHealthStart >= 0, 'ready must run live profile health after the SPA input exists');
  assert.match(
    readinessSource.slice(liveHealthStart, liveHealthInvalid),
    /runProfileHealthCheck\(activeProfile,\s*\{[\s\S]*allowMissingResponse:\s*true[\s\S]*requireRecordedIdentity:\s*true/,
    'ready must use the same live recorded-identity requirement that capture relies on',
  );
  assert.ok(liveHealthInvalid > liveHealthStart, 'live identity failure must be checked after live health');
  assert.ok(readyLease > liveHealthInvalid, 'live identity failure must be rejected before publishing ready');
});

test('auto capture rejects a drifted recorded response identity before mutating the input', () => {
  const captureStart = contentSource.indexOf('async function autoCapture(');
  const captureEnd = contentSource.indexOf('function requestAutoCaptureCancellation(', captureStart);
  const captureSource = contentSource.slice(captureStart, captureEnd);
  const identityPreflight = captureSource.indexOf('const identityGapBeforeSend = recordedResponseIdentityGap()');
  const inputMutation = captureSource.indexOf('setInputValue(inputEl, userMessage)');

  assert.ok(identityPreflight >= 0, 'capture must inspect the recorded identity before sending');
  assert.ok(inputMutation > identityPreflight, 'identity drift must fail before the user prompt reaches the page');
  assert.match(
    captureSource.slice(identityPreflight, inputMutation),
    /profile_identity_unavailable/,
    'a stale analytics identity must produce an actionable profile error without dispatch',
  );
});

test('response identity recording rejects analytics exposure attributes', () => {
  const documentBody = {};
  const candidate = {
    attributes: [{ name: 'data-hy-exposured', value: 'true' }],
    parentElement: documentBody,
    getAttribute(name) {
      return name === 'data-hy-exposured' ? 'true' : null;
    },
    contains(node) {
      return node === this;
    },
  };
  const stableIdentityElement = loadNamedFunction(contentSource, 'stableIdentityElement', {
    CSS: { escape: value => String(value) },
    document: {
      body: documentBody,
      querySelectorAll(selector) {
        return selector === '[data-hy-exposured]' ? [candidate] : [];
      },
    },
  });

  assert.deepEqual(
    Array.from(stableIdentityElement(candidate).attributes),
    [],
    'viewport exposure and analytics state cannot become a reusable message identity',
  );
  assert.match(
    contentSource,
    /exposure\|exposed\|exposured\|impression\|intersection\|observer/,
    'the provider-neutral exclusion vocabulary must cover common exposure telemetry names',
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

test('content readiness and capture leases identify the actual page build', () => {
  assert.match(
    contentSource,
    /type:\s*['"]page_ready['"][\s\S]{0,160}content_script_version:\s*CONTENT_SCRIPT_VERSION/,
    'page_ready must identify the content script that emitted the lease',
  );
  assert.match(
    contentSource,
    /type:\s*['"]capture_heartbeat['"][\s\S]{0,420}content_script_version:\s*CONTENT_SCRIPT_VERSION/,
    'capture heartbeat must retain the same page build identity during streaming',
  );
  assert.match(
    contentSource,
    /sendResponse\(\{\s*ready:\s*true,[\s\S]{0,180}content_script_version:\s*CONTENT_SCRIPT_VERSION/,
    'wait_until_ready must return the actual content build with its readiness result',
  );
});

test('content runtime performs one bounded extension reload when an older worker rejects its build', () => {
  assert.match(
    contentSource,
    /async function recoverRuntimeVersionMismatch\(response\)/,
    'the page runtime must own recovery when it is newer than the in-memory worker',
  );
  assert.match(
    contentSource,
    /response\?\.error !== ['"]content_script_version_mismatch['"][\s\S]{0,160}return false/,
    'only an explicit version rejection may trigger extension reload',
  );
  assert.match(
    contentSource,
    /stopReadyLease\(\)[\s\S]{0,1000}root\?\.getAttribute\(RUNTIME_RELOAD_MARKER\)[\s\S]{0,1000}root\?\.setAttribute\(RUNTIME_RELOAD_MARKER[\s\S]{0,1200}reload_extension_runtime/,
    'recovery must stop heartbeat churn, persist a DOM throttle, and request reload from the worker',
  );
  assert.doesNotMatch(
    contentSource,
    /chrome\.storage\.session/,
    'storage.session is not exposed to content scripts by default and cannot own recovery',
  );
  assert.doesNotMatch(
    contentSource,
    /chrome\.runtime\.reload\(\)/,
    'content scripts cannot invoke chrome.runtime.reload; the service worker owns extension reload',
  );
  assert.match(
    contentSource,
    /RUNTIME_RELOAD_THROTTLE_MS\s*=\s*30000/,
    'reload recovery must have a fixed anti-loop window',
  );
  assert.match(
    contentSource,
    /recoverRuntimeVersionMismatch\(value\)\.finally\(finish\)/,
    'the page-ready callback must invoke recovery from the actual mismatch response',
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
    /waitForInteractableRecordedInput\(\s*selectorDescriptor\(selectors\.input\)/,
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
    /oldComparable\.includes\(nextComparable\)[\s\S]{0,120}nextComparable\.includes\(oldComparable\)/,
    'same-key growth that retains the old response body must be rejected as stale augmentation'
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
    /completionObservation\.complete[\s\S]{0,180}snapshot\.text\.length >= 1/,
    'a settled response is allowed to contain one valid character'
  );
  assert.match(
    contentSource,
    /isFreshRecordedResponse\(item\.key, item\.text, beforeKeys, item\.region\)/,
    'recorded response candidates must pass their DOM region into freshness checks'
  );
});

test('a fresh-looking identity cannot repeat exact pre-send text without stronger ownership proof', () => {
  const snapshotStart = contentSource.indexOf('function recordedResponseSnapshot(');
  const snapshotEnd = contentSource.indexOf('function recordedResponseIdentityGap(', snapshotStart);
  const snapshotSource = snapshotStart >= 0 && snapshotEnd > snapshotStart
    ? contentSource.slice(snapshotStart, snapshotEnd)
    : '';
  assert.match(
    snapshotSource,
    /isFreshRecordedResponse\(item\.key, item\.text, beforeKeys, item\.region\)/,
    'fresh identity must remain the authoritative response boundary'
  );
  assert.match(
    snapshotSource,
    /likelyUserEcho\(item\.text, userMessage, item\.role\)/,
    'all recorded candidates must pass request-epoch stale text rejection'
  );

  const waitStart = contentSource.indexOf('async function waitForFreshAssistantResponse');
  const waitEnd = contentSource.indexOf('async function waitForVisibleResponse', waitStart);
  const waitSource = waitStart >= 0 && waitEnd > waitStart ? contentSource.slice(waitStart, waitEnd) : '';
  assert.match(
    waitSource,
    /likelyUserEcho\(snapshot\.text, userMessage, snapshot\.role\)/,
    'the completion loop must fail closed on pre-send text projected as a new response'
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

test('recorded response candidate diagnostics expose rejection predicates without page text', () => {
  const snapshotStart = contentSource.indexOf('function recordedResponseSnapshot(');
  const snapshotEnd = contentSource.indexOf('function recordedResponseIdentityGap(', snapshotStart);
  const snapshotSource = snapshotStart >= 0 && snapshotEnd > snapshotStart
    ? contentSource.slice(snapshotStart, snapshotEnd)
    : '';

  assert.match(snapshotSource, /recorded_response_candidate_evaluated/);
  assert.match(snapshotSource, /freshIdentity/);
  assert.match(snapshotSource, /freshResponse/);
  assert.match(snapshotSource, /userEcho/);
  assert.match(snapshotSource, /afterFreshUser/);
  assert.match(snapshotSource, /promptPrefix/);
  const diagnosticStart = snapshotSource.indexOf("emitPageTrace('recorded_response_candidate_evaluated'");
  const diagnosticEnd = snapshotSource.indexOf('});', diagnosticStart);
  const diagnosticSource = diagnosticStart >= 0 && diagnosticEnd > diagnosticStart
    ? snapshotSource.slice(diagnosticStart, diagnosticEnd)
    : '';
  assert.doesNotMatch(
    diagnosticSource,
    /\btext\s*:/,
    'candidate diagnostics must stay metadata-only and never record page text',
  );
});

test('recorded response diagnostics expose aggregate projection selection metadata without page text', () => {
  const start = contentSource.indexOf("emitPageTrace('recorded_response_candidate_evaluated'");
  const end = contentSource.indexOf('const freshAssistant', start);
  const diagnosticSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';

  for (const field of [
    'projectionCount',
    'selectedIndex',
    'selectedSpecificity',
    'selectedDepth',
    'connected',
    'visible',
    'requestedLength',
    'domLength',
    'identityLength',
    'domContainsRequested',
    'identityContainsRequested',
  ]) {
    assert.match(diagnosticSource, new RegExp(`${field}:`), `${field} must be available in metadata-only diagnostics`);
  }
  assert.doesNotMatch(diagnosticSource, /text:\s*candidate\.item\.text/);
  assert.doesNotMatch(
    diagnosticSource,
    /projectionMembers/,
    'temporary per-projection member details must not inflate every response diagnostic sample',
  );
});

test('transient recorded-response gaps preserve identity continuity and reject prefix regressions', () => {
  const start = contentSource.indexOf('async function waitForFreshAssistantResponse(');
  const end = contentSource.indexOf('async function waitForVisibleResponse(', start);
  const waitSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  const noSnapshotStart = waitSource.indexOf('if (Date.now() - started < timeout)');
  const noSnapshotSource = noSnapshotStart >= 0 ? waitSource.slice(Math.max(0, noSnapshotStart - 360), noSnapshotStart) : '';

  assert.doesNotMatch(
    noSnapshotSource,
    /responseIdentityState\s*=\s*ResponseObservation[\s\S]{0,180}createIdentityState/,
    'a temporary projection gap must not erase the identity observations already earned by the same response',
  );
  assert.doesNotMatch(
    noSnapshotSource,
    /responseCompletionState\s*=\s*ResponseObservation\?\.createCompletionState/,
    'a temporary projection gap must not restart the response age and quiet clocks',
  );
  assert.match(waitSource, /completionObservation\.projectionRegressed/);
  assert.match(
    waitSource,
    /if \(completionObservation\.projectionRegressed\)[\s\S]{0,420}continue;/,
    'a shorter prefix projection must stay in observation instead of becoming caller-facing best text',
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

test('button replay shares the request deadline with provider-neutral send observation', () => {
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
  assert.match(
    autoCaptureSource,
    /const sendObservationTimeoutMs\s*=\s*Math\.max\(\s*2000,\s*Math\.min\(30000,\s*captureDeadlineAt\s*-\s*Date\.now\(\)\s*\)/,
    'send observation must allow a bounded cold-page acceptance window while remaining inside the request deadline'
  );
  assert.doesNotMatch(
    autoCaptureSource,
    /const sendObservationTimeoutMs\s*=\s*Math\.max\(1,\s*captureDeadlineAt\s*-\s*Date\.now\(\)/,
    'send observation must not consume the entire model response deadline'
  );
  assert.doesNotMatch(
    autoCaptureSource,
    /Date\.now\(\)\s*-\s*evidenceStarted[\s\S]{0,300}60000/,
    'button replay must not hold the request for a fixed 60-second projection wait'
  );
});

test('consumed input keeps the single dispatch alive for authoritative response observation', () => {
  const observationStart = contentSource.indexOf('async function waitForSendObservation(');
  const observationEnd = contentSource.indexOf('\n  // 这里不再依赖 copy 按钮', observationStart);
  const observationSource = observationStart >= 0 && observationEnd > observationStart
    ? contentSource.slice(observationStart, observationEnd)
    : '';
  const weakBranch = observationSource.indexOf('if (observation.weak) {');
  const weakReturn = observationSource.indexOf('return {', weakBranch);
  const nextWait = observationSource.indexOf('await observationWake.wait(250)', weakBranch);
  assert.ok(
    weakBranch >= 0 && weakReturn > weakBranch && nextWait > weakReturn,
    'consumed input must move immediately into response observation instead of wasting the send window',
  );
  const start = contentSource.indexOf('async function autoCapture(');
  const end = contentSource.indexOf('function normalizeRecordedSelector(', start);
  const autoCaptureSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    autoCaptureSource,
    /if \(!sendObservation\.observed && !sendObservation\.weak\)/,
    'a dispatched action with no page effect must fail, while consumed input remains pending',
  );
  assert.match(
    autoCaptureSource,
    /send_observation_pending/,
    'weak input-consumption evidence must remain visible in structured diagnostics',
  );
  const pending = autoCaptureSource.indexOf('send_observation_pending');
  const responseWait = autoCaptureSource.indexOf('await waitForFreshAssistantResponse(', pending);
  assert.ok(
    pending >= 0 && responseWait > pending,
    'weak evidence must proceed to the authoritative fresh-response boundary',
  );
  const betweenPendingAndResponse = autoCaptureSource.slice(pending, responseWait);
  assert.doesNotMatch(
    betweenPendingAndResponse,
    /safeClick\(|dispatchRecordedKeyboardOnce\(/,
    'pending send evidence must never authorize a second submission',
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

test('recorded Enter dispatch uses the trusted bridge and remains single-shot when outcome is unknown', () => {
  assert.match(
    contentSource,
    /function dispatchRecordedKeyboardOnce\(/,
    'Enter replay must have one explicit dispatch boundary'
  );
  assert.match(
    contentSource,
    /dispatchRecordedKeyboardOnce\(inputEl,\s*\{\s*key:\s*sendKey/,
    'auto capture must use the revalidated recorded input owner at the single-shot Enter boundary'
  );
  assert.match(contentSource, /type:\s*'dispatch_recorded_keyboard'/);
  assert.match(contentSource, /await dispatchRecordedKeyboardOnce\(/);
  assert.doesNotMatch(contentSource, /new KeyboardEvent\(/);
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

test('recorded streaming indicators are observed inside the response region', () => {
  const start = contentSource.indexOf('function elementRecord(');
  const end = contentSource.indexOf('\n  function pageNodeInfo(', start);
  const helper = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.ok(start >= 0 && end > start, 'elementRecord must remain inspectable');
  assert.match(
    helper,
    /querySelector\?\./,
    'indicator matching must inspect descendants when a page puts streaming state on a child node',
  );
  assert.match(
    helper,
    /matchesElementOrDescendant\(/,
    'response activity must use one provider-neutral descendant-aware matcher',
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
    /if \(identityObservation\.qualified && \(completionObservation\.changed \|\| identityObservation\.becameQualified\)\) \{\s*relayCaptureSnapshot\(/,
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
    /const freshTimeoutMs\s*=\s*Math\.max\(1,\s*captureDeadlineAt\s*-\s*Date\.now\(\)\)/,
    'response observation must consume only the remaining request deadline'
  );
  assert.match(
    autoCaptureSource,
    /captureTimeoutMs/,
    'the browser capture window must be supplied by the request contract'
  );
});

test('DOM completion uses page activity and body quiet settlement instead of snapshot counts', () => {
  const start = contentSource.indexOf('async function waitForFreshAssistantResponse');
  const end = contentSource.indexOf('async function waitForVisibleResponse', start);
  const waitSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(waitSource, /responseActivityState\(/, 'completion must inspect provider-neutral page activity');
  assert.match(waitSource, /observeCompletion\(/, 'completion must use the request-scoped body settlement state');
  assert.match(waitSource, /requestStreamingSeen/, 'static inactive indicators must not bypass request-scoped activity history');
  assert.match(waitSource, /recorded_response_completion_state/, 'completion diagnostics must expose metadata-only state transitions');
  assert.doesNotMatch(waitSource, /stable\s*>=\s*3/, 'three polling observations must not be terminal evidence');

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

test('only recorded response activity or a request-scoped generation control controls completion', () => {
  assert.match(contentSource, /const GENERATION_CONTROL_PATTERN/);
  assert.match(contentSource, /function activeGenerationControl\(\)/);
  assert.match(contentSource, /button, \[role="button"\], \[aria-label\], \[title\]/);
  const responseStart = contentSource.indexOf('function responseActivityState(');
  const responseEnd = contentSource.indexOf('function domToMarkdown(', responseStart);
  const responseSource = responseStart >= 0 && responseEnd > responseStart
    ? contentSource.slice(responseStart, responseEnd)
    : '';
  assert.match(responseSource, /activeGenerationControl\(\)/);
  assert.match(responseSource, /generationStateBefore\?\.control/);
  assert.match(responseSource, /isResponseStreaming\(\{ recordedMarker: marker, requestControl: control \}\)/);
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
  const end = contentSource.indexOf('function recordedResponseIdentityGap(', start);
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

test('recorded response candidates exclude incomplete requested-output prefixes from eligibility', () => {
  const start = contentSource.indexOf('function recordedResponseSnapshot(');
  const end = contentSource.indexOf('function recordedResponseIdentityGap(', start);
  const functionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    functionSource,
    /eligible:\s*freshResponse\s*&&\s*!userEcho\s*&&\s*!promptPrefix\s*&&\s*afterFreshUser/,
    'diagnostic eligibility must match the completion loop prefix rejection gate',
  );
});

test('recorded response regions prefer direct body matches over same-identity scope fallbacks', () => {
  const start = contentSource.indexOf('function responseRegionElements()');
  const end = contentSource.indexOf('function elementDepth(', start);
  const functionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(functionSource, /responseProjectionElements\(\)/);
  assert.match(functionSource, /mergeRecordedRegionElements\(/);
});

test('recorded response projections keep the recorded body instead of the longest identity container', () => {
  const start = contentSource.indexOf('function recordedResponseSnapshot(');
  const end = contentSource.indexOf('function recordedResponseIdentityGap(', start);
  const functionSource = start >= 0 && end > start ? contentSource.slice(start, end) : '';
  assert.match(
    functionSource,
    /selectRecordedProjection\(group\)/,
    'a message identity must select the most specific recorded body projection'
  );
  assert.doesNotMatch(
    functionSource,
    /selectLongestProjection\(group\)/,
    'outer container length must not decide the returned assistant body'
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
  const profileBuilderStart = contentSource.indexOf('function buildRecordedProfile(');
  const profileBuilderEnd = contentSource.indexOf('function selectorMatchCount(', profileBuilderStart);
  const profileBuilderSource = contentSource.slice(profileBuilderStart, profileBuilderEnd);
  const containerDefinition = profileBuilderSource.indexOf('const containerSelector = !structuralIdentity');
  const scopedGenerator = profileBuilderSource.indexOf(
    'generateStableContainerSelector(identity.element, identity.attributes)',
    containerDefinition,
  );
  assert.ok(containerDefinition >= 0 && scopedGenerator > containerDefinition,
    'every attribute identity must persist a reusable response scope, including when the clicked body is the identity node');
  assert.doesNotMatch(profileBuilderSource, /identity\.element\s*!==\s*responseElement/,
    'identity on the clicked response body still needs a reusable scope');
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
    /active\|current\|last\|first\|show\|hide\|loading\|streaming\|busy\|disabled\|selected\|focus\|focused\|hover\|open\|close\|transition\|animation\|enter\|leave\|visible\|hidden\|blank\|empty\|rank/,
    'provider-neutral selector generation must reject volatile state and ranking classes'
  );
});

test('response identity scopes use attribute presence without freezing the recorded value', () => {
  const generateStableContainerSelector = loadNamedFunction(
    contentSource,
    'generateStableContainerSelector',
    {
      CSS: { escape: value => String(value) },
      cssPath: () => 'div > div:nth-child(7)',
      selectorClassTokens: () => [],
    },
  );
  const result = generateStableContainerSelector({
    tagName: 'DIV',
    classList: [],
  }, ['data-message-id', 'data-row-key']);

  assert.equal(result.css, '[data-message-id]');
  assert.ok(result.alternatives.includes('[data-row-key]'));
  assert.doesNotMatch(JSON.stringify(result), /recorded-message-value/);
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
    /key:\s*chosen\.key[\s\S]{0,220}role:\s*chosen\.role[\s\S]{0,220}activityToken:\s*recordedResponseActivityToken\(chosen\)/,
    'recorded snapshots must preserve role through final qualification'
  );
  assert.match(
    contentSource,
    /activityToken:\s*snapshot\.activityToken/,
    'completion must receive metadata-only activity from the selected recorded response scope'
  );
});

test('selector recording exposes an explicit persistence acknowledgement state', () => {
  assert.match(
    contentSource,
    /const selectorCaptureStatus\s*=\s*\{\s*input:\s*null,\s*send:\s*null,\s*response:\s*null/s,
    'content runtime must track capture acknowledgement per role',
  );
  assert.match(
    contentSource,
    /selectorCaptureStatus\[targetRole\]\s*=\s*\{\s*state:\s*['"]pending['"]/,
    'a local candidate must remain pending until background confirms it',
  );
  assert.match(
    contentSource,
    /selectorCaptureStatus\[targetRole\]\s*=\s*\{\s*state:\s*['"]accepted['"]/,
    'the content runtime must record a successful background acknowledgement',
  );
  assert.match(
    contentSource,
    /sendResponse\(\{\s*selectors,\s*selector_capture_status:\s*selectorCaptureStatus\s*\}\)/,
    'popup polling must be able to distinguish local candidates from persisted selectors',
  );
});
