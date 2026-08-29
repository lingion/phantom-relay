import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));

test('browser registration preserves verified content readiness between claims', () => {
  assert.match(source, /const readyTabIds = new Set\(\)/);
  assert.match(source, /const ready = activeClaimMatchesDomain \|\| readyTabIds\.has\(Number\(tab\?\.id\)\)/);
  assert.match(source, /const currentRuntimeReady = runtime\?\.contentScriptVersion === CONTENT_SCRIPT_VERSION/);
  assert.match(source, /ready:\s*ready && currentRuntimeReady/);
  assert.match(
    source,
    /function isExecutionInventoryTab\(tab\)[\s\S]{0,320}readyTabIds\.has\(Number\(tab\?\.id\)\)[\s\S]{0,320}isRecordedExecutionTab\(tab\)/,
    'a content-validated tab must remain in registration inventory when only the local profile cache conflicts',
  );
  assert.match(
    source,
    /tabs\.filter\(isExecutionInventoryTab\)\.map\(tabRegistrationRecord\)/,
    'registration must use the content-ready inventory boundary',
  );
  assert.match(source, /async function publishReadyHeartbeat\(tab\)/);
  assert.match(source, /if \(ready\) await publishReadyHeartbeat\(tab\)/);
  assert.match(source, /markTabReady\(readyTabId, true\)/);
  assert.match(source, /if \(changeInfo\.status === 'loading' \|\| changeInfo\.url\) markTabReady\(tabId, false\)/);
  assert.match(source, /chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => markTabReady\(tabId, false\)\)/);
});

test('claimed tabs fail closed when navigation changes the execution domain', () => {
  const registrationStart = source.indexOf('function tabRegistrationRecord(tab)');
  const registrationEnd = source.indexOf('\nfunction isExecutionInventoryTab', registrationStart);
  const registration = source.slice(registrationStart, registrationEnd);
  assert.match(
    registration,
    /PhantomRelayClaimRecovery\.claimMatchesTab\(activeClaim, tab\?\.id, domain\)/,
    'an active claim may advertise readiness only on its exact recorded hostname',
  );

  const updateStart = source.indexOf('chrome.tabs.onUpdated.addListener');
  const updateEnd = source.indexOf('chrome.tabs.onRemoved.addListener', updateStart);
  const updateHandler = source.slice(updateStart, updateEnd);
  assert.match(
    updateHandler,
    /publishReadyHeartbeat\(tab, false\)/,
    'navigation must revoke server-side readiness immediately instead of waiting for the claim timeout',
  );
});

test('successful backend registration schedules profile reconciliation without blocking liveness', () => {
  assert.match(
    source,
    /async function retryPendingProfilesAfterBackendReady\(/,
    'backend recovery must have a bounded pending-profile retry path',
  );
  assert.match(
    source,
    /function scheduleBackendReconciliation\(/,
    'backend recovery must have a detached single-flight scheduler',
  );
  const registrationStart = source.indexOf('async function registerBrowserClient(');
  const registrationEnd = source.indexOf('\nfunction syncRoutesToBackend', registrationStart);
  const registration = source.slice(registrationStart, registrationEnd);
  assert.match(
    registration,
    /scheduleBackendReconciliation\(\)/,
    'the first successful browser registration must enqueue backend recovery',
  );
  assert.doesNotMatch(
    registration,
    /await retryPendingProfilesAfterBackendReady\(\)/,
    'liveness registration must return before profile replica recovery finishes',
  );
});

test('successful backend registration repairs active profiles missing from the backend', () => {
  assert.match(
    source,
    /async function reconcileActiveProfilesAfterBackendReady\(/,
    'backend recovery must reconcile locally active profiles, not only pending profiles',
  );
  const registrationStart = source.indexOf('async function registerBrowserClient(');
  const registrationEnd = source.indexOf('\nfunction syncRoutesToBackend', registrationStart);
  const registration = source.slice(registrationStart, registrationEnd);
  assert.match(
    registration,
    /scheduleBackendReconciliation\(\)/,
    'the first successful browser registration must enter the backend recovery path',
  );
  const retryStart = source.indexOf('async function retryPendingProfilesAfterBackendReady(');
  const retryEnd = source.indexOf('\nasync function bootstrapRecordedProfileLifecycle', retryStart);
  const retry = source.slice(retryStart, retryEnd);
  assert.match(
    retry,
    /await reconcileActiveProfilesAfterBackendReady\(\)/,
    'the backend recovery path must repair a backend that lost its profile registry',
  );
  assert.match(
    source,
    /browser\/profiles\/\$\{encodeURIComponent\(profileId\)\}/,
    'repair must probe the exact provider-neutral profile identity before publishing',
  );
  assert.match(
    source,
    /profile_backend_repair_missing/,
    'missing remote profiles must be diagnosable without exposing page content',
  );
});

test('background has one active execution scheduler and no two-second in-process poll loop', () => {
  assert.doesNotMatch(
    source,
    /function ensureBrowserBridgeInterval\(|browserBridgeInterval\s*=\s*setInterval/,
    'the worker must not keep an aggressive interval beside page-ready events and the MV3 alarm',
  );
  assert.match(
    source,
    /chrome\.alarms\.create\(BROWSER_POLL_ALARM, \{ periodInMinutes: 0\.5 \}\)/,
    'the platform alarm remains only as a low-frequency suspended-worker fallback',
  );
});

test('browser scheduler exposes bounded API-visible stall and failure diagnostics', () => {
  const tickStart = source.indexOf('async function browserBridgeTick()');
  const tickEnd = source.indexOf('\nlet bridgeWakeTimer', tickStart);
  const bridge = source.slice(tickStart, tickEnd);

  assert.match(
    bridge,
    /let tickStage = ['"]started['"]/,
    'the scheduler must retain the last completed startup boundary',
  );
  assert.match(
    bridge,
    /addDebugLog\(['"]browser_scheduler_stalled['"]/,
    'a blocked scheduler must cross the API diagnostic boundary',
  );
  assert.match(
    bridge,
    /addDebugLog\(['"]browser_scheduler_failed['"]/,
    'a thrown startup error must cross the API diagnostic boundary',
  );
  assert.match(
    bridge,
    /clearTimeout\(stallTimer\)/,
    'successful and failed ticks must cancel their one-shot watchdog',
  );
});

test('startup and tab events prepare only domains with an executable recorded profile', () => {
  assert.match(
    source,
    /function isRecordedExecutionTab\(tab\)/,
    'tab eligibility must have one provider-neutral recorded-profile gate',
  );
  const startupStart = source.indexOf('async function ensureContentScriptsInOpenTabs(');
  const startupEnd = source.indexOf('\nasync function probeRecordedExecutionContext', startupStart);
  const startup = source.slice(startupStart, startupEnd);
  assert.match(startup, /isRecordedExecutionTab\(tab\)/);
  const updateStart = source.indexOf('chrome.tabs.onUpdated.addListener');
  const updateEnd = source.indexOf('chrome.tabs.onRemoved.addListener', updateStart);
  const updateHandler = source.slice(updateStart, updateEnd);
  assert.match(updateHandler, /isRecordedExecutionTab\(tab\)/);
  const activationStart = source.indexOf('chrome.tabs.onActivated.addListener');
  const activationEnd = source.indexOf('\n\nfunction ensureBrowserBridgeAlarm', activationStart);
  const activationHandler = source.slice(activationStart, activationEnd);
  assert.match(activationHandler, /isRecordedExecutionTab\(tab\)/);
});

test('open tabs rehydrate backend-owned recorded profiles before the local execution gate', () => {
  assert.match(
    source,
    /async function rehydrateRecordedProfileForTab\(tab\)/,
    'a cleared extension profile must be able to recover an authoritative backend recording',
  );
  const rehydrateStart = source.indexOf('async function rehydrateRecordedProfileForTab(tab)');
  const rehydrateEnd = source.indexOf('\nasync function prepareRecordedExecutionTab', rehydrateStart);
  const rehydrate = rehydrateStart >= 0 && rehydrateEnd > rehydrateStart
    ? source.slice(rehydrateStart, rehydrateEnd)
    : '';
  assert.match(
    rehydrate,
    /browser\/selectors\?domain=\$\{encodeURIComponent\(hostname\)\}/,
    'recovery must use the current hostname and the provider-neutral selector endpoint',
  );
  assert.match(
    rehydrate,
    /browser\/profiles\/\$\{encodeURIComponent\(profileId\)\}/,
    'the profile registry must override a stale embedded selector profile before execution',
  );
  assert.match(
    rehydrate,
    /profile:\s*remoteProfile/,
    'the reconciled selector bundle must carry the authoritative remote profile',
  );
  assert.match(
    rehydrate,
    /await reconcileFetchedSelectors\(hostname, payload\)/,
    'server data must pass through the same profile reconciliation contract as normal execution',
  );
  assert.match(
    rehydrate,
    /return isRecordedExecutionTab\(tab\)/,
    'backend data alone is insufficient until the local executable-profile gate accepts it',
  );

  const prepareStart = source.indexOf('async function prepareRecordedExecutionTab(tab)');
  const prepareEnd = source.indexOf('\nasync function ensureContentScriptsInOpenTabs', prepareStart);
  const prepare = prepareStart >= 0 && prepareEnd > prepareStart
    ? source.slice(prepareStart, prepareEnd)
    : '';
  assert.match(prepare, /await rehydrateRecordedProfileForTab\(tab\)/);
  assert.match(prepare, /if \(!isRecordedExecutionTab\(tab\)\) return false;/);
  assert.match(prepare, /return ensureContentScript\(tab\)/);

  const startupStart = source.indexOf('async function ensureContentScriptsInOpenTabs(');
  const startupEnd = source.indexOf('\nasync function probeRecordedExecutionContext', startupStart);
  const startup = source.slice(startupStart, startupEnd);
  assert.match(startup, /await prepareRecordedExecutionTab\(tab\)/);

  const updateStart = source.indexOf('chrome.tabs.onUpdated.addListener');
  const updateEnd = source.indexOf('chrome.tabs.onRemoved.addListener', updateStart);
  const updateHandler = source.slice(updateStart, updateEnd);
  assert.match(updateHandler, /prepareRecordedExecutionTab\(tab\)/);
});

test('bridge ticks publish liveness before targeted profile recovery and refresh inventory afterward', () => {
  const tickStart = source.indexOf('async function browserBridgeTick()');
  const tickEnd = source.indexOf('\nlet bridgeWakeTimer', tickStart);
  const bridge = source.slice(tickStart, tickEnd);
  const firstRegistrationIndex = bridge.indexOf('await registerBrowserClient(');
  const pendingIndex = bridge.indexOf("fetch(`${LOCAL_API}/browser/pending-domains`)");
  const recoveryIndex = bridge.indexOf('await ensureContentScriptsInOpenTabs(preferredDomain)');
  const finalRegistrationIndex = bridge.indexOf('await registerBrowserClient(true)', recoveryIndex);
  const noOwnedIndex = bridge.indexOf("tickOutcome = 'no_owned_tabs'");

  assert.ok(firstRegistrationIndex >= 0, 'the worker must report liveness before any slow page probe');
  assert.ok(pendingIndex > firstRegistrationIndex, 'queued work may be loaded only after liveness registration');
  assert.ok(recoveryIndex > pendingIndex, 'clean-install recovery must target the selected queued domain');
  assert.ok(finalRegistrationIndex > recoveryIndex, 'recovered tabs must refresh the registration inventory');
  assert.ok(noOwnedIndex > finalRegistrationIndex, 'ownership may be evaluated only after final registration');
});

test('worker startup has one scheduler entry and no concurrent all-tab preparation', () => {
  const startupStart = source.indexOf('chrome.runtime.onInstalled.addListener');
  const startupEnd = source.indexOf('\nfunction relayBrowserResult', startupStart);
  const startup = source.slice(startupStart, startupEnd);

  assert.doesNotMatch(
    startup,
    /ensureContentScriptsInOpenTabs\(\)\.then/,
    'startup must not race a full-tab preparation pass against the scheduler',
  );
  assert.equal(
    [...startup.matchAll(/browserBridgeTick\(\)/g)].length,
    1,
    'startup must enter the scheduler exactly once',
  );
});

test('startup and registration share one pending-profile recovery owner', () => {
  assert.match(
    source,
    /function runPendingProfileRecoverySingleFlight\(/,
    'pending-profile recovery must have one single-flight owner',
  );
  const initializeStart = source.indexOf('async function initializeStorage()');
  const initializeEnd = source.indexOf('\nfunction startStorageInitialization', initializeStart);
  const initialize = source.slice(initializeStart, initializeEnd);
  assert.match(initialize, /runPendingProfileRecoverySingleFlight\(/);
  assert.doesNotMatch(initialize, /profileRecoveryPromise\s*=\s*recoverPendingProfiles\(/);
  assert.match(
    source,
    /if \(!storageCriticalAvailable\)[\s\S]{0,240}failed: \['startup_storage_unavailable'\][\s\S]{0,120}skipped: true/,
    'degraded storage must settle recovery without writing an empty profile store',
  );

  const retryStart = source.indexOf('async function retryPendingProfilesAfterBackendReady(');
  const retryEnd = source.indexOf('\nasync function bootstrapRecordedProfileLifecycle', retryStart);
  const retry = source.slice(retryStart, retryEnd);
  assert.match(retry, /await runPendingProfileRecoverySingleFlight\(/);
  assert.match(
    retry,
    /return \{ attempted: false, completed: false, reason: 'throttled' \}/,
    'throttling must remain an incomplete retry result',
  );
});

test('repeated page-ready leases reuse validated state instead of reloading selectors every time', () => {
  const start = source.indexOf("if (msg.type === 'page_ready')");
  const end = source.indexOf("if (msg.type === 'page_trace')", start);
  const handler = source.slice(start, end);
  assert.match(handler, /const validatedRuntime = pageRuntime\.get\(readyTabId\)/);
  assert.match(handler, /Date\.now\(\) - Number\(validatedRuntime\.lastValidatedAt \|\| 0\) < 30000/);
  assert.match(handler, /await publishReadyHeartbeat\(sender\.tab\)/);
});

test('active profile recovery skips selector republish when the backend is already identical', () => {
  const reconcileStart = source.indexOf('async function reconcileActiveProfilesAfterBackendReady(');
  const reconcileEnd = source.indexOf('\nfunction buildProfileHealthPayload', reconcileStart);
  const reconcile = reconcileStart >= 0 && reconcileEnd > reconcileStart
    ? source.slice(reconcileStart, reconcileEnd)
    : '';
  assert.match(
    reconcile,
    /browser\/selectors\?domain=/,
    'recovery must inspect the authoritative selector bundle before republishing it',
  );
  assert.match(
    reconcile,
    /selectorBundleFingerprint\(remoteSelectorPayload\?\.selectors\)/,
    'recovery must compare the remote selector bundle with the local recorded bundle',
  );
  assert.match(
    reconcile,
    /inspectSelectors:[\s\S]{0,1800}applySelectors:/,
    'background must delegate selector inspection and publication to the behavior-tested recovery orchestrator',
  );
});

test('active profile recovery repairs only an acknowledged local revision that is ahead', () => {
  const reconcileStart = source.indexOf('async function reconcileActiveProfilesAfterBackendReady(');
  const reconcileEnd = source.indexOf('\nfunction buildProfileHealthPayload', reconcileStart);
  const reconcile = reconcileStart >= 0 && reconcileEnd > reconcileStart
    ? source.slice(reconcileStart, reconcileEnd)
    : '';

  assert.match(
    reconcile,
    /PhantomRelayProfileRecovery\.recoverActiveProfileReplica\(\{/,
    'active recovery must use the provider-neutral revision/checksum decision table',
  );
  assert.match(
    reconcile,
    /result\.action === 'conflict'[\s\S]{0,700}profile_backend_repair_conflict/,
    'pending, same-revision divergent, and newer-remote profiles must remain explicit conflicts',
  );
  assert.doesNotMatch(reconcile, /chrome\.tabs\.(?:create|update)\(/);
});

test('authoritative active profile recovery applies only the local selector projection', () => {
  const reconcileStart = source.indexOf('async function reconcileActiveProfilesAfterBackendReady(');
  const reconcileEnd = source.indexOf('\nfunction buildProfileHealthPayload', reconcileStart);
  const reconcile = reconcileStart >= 0 && reconcileEnd > reconcileStart
    ? source.slice(reconcileStart, reconcileEnd)
    : '';
  assert.match(
    reconcile,
    /applySelectors:\s*envelope\s*=>\s*projectRecoveredProfileLocally\(\{\s*profileId,\s*envelope\s*\}\)/,
    'authoritative profile repair must not depend on the compatibility selector POST',
  );
});

test('compatibility selector publication is best effort after local projection', () => {
  const publishStart = source.indexOf('async function publishRecoveredSelectorProjection(');
  const publishEnd = source.indexOf('\nasync function applyRecoveredProfile', publishStart);
  const publish = publishStart >= 0 && publishEnd > publishStart
    ? source.slice(publishStart, publishEnd)
    : '';
  const applyStart = source.indexOf('async function applyRecoveredProfile(');
  const applyEnd = source.indexOf('\nasync function recoverPendingProfiles', applyStart);
  const apply = applyStart >= 0 && applyEnd > applyStart
    ? source.slice(applyStart, applyEnd)
    : '';
  assert.match(apply, /projectRecoveredProfileLocally\(\{\s*profileId,\s*envelope\s*\}\)/);
  assert.match(apply, /publishRecoveredSelectorProjection\(\{[\s\S]{0,700}selectorView[\s\S]{0,700}\}\)/);
  assert.match(
    publish,
    /catch \(error\) \{[\s\S]{0,500}profile_selector_republish_failed[\s\S]{0,300}return false;/,
    'a failed compatibility selector POST must be diagnosed without rejecting the authoritative recovery',
  );
  assert.doesNotMatch(publish, /throw error/);
});

test('browser submit maps transport failures to a structured backend-unreachable error', () => {
  assert.match(source, /code:\s*['"]backend_unreachable['"]/);
  assert.match(popupSource, /后端不可达/);
});

test('content-script preparation trusts a responsive runtime and delegates singleton takeover to content.js', () => {
  assert.match(
    source,
    /for\s*\(let attempt = 0; attempt < 4; attempt\+\+\)[\s\S]{0,900}pingContentRuntime\(\)/,
    'a transient static-script race must use a bounded handshake before injection'
  );
  const preparationStart = source.indexOf('async function ensureContentScriptOnce(');
  const preparationEnd = source.indexOf('\nasync function ensureContentScript(', preparationStart);
  const preparation = source.slice(preparationStart, preparationEnd);
  const liveHandshakeIndex = preparation.indexOf('if (acceptLiveContentScriptPing(ping, hostname))');
  const injectionIndex = preparation.indexOf("preparationStage = 'dynamic_injection'");
  assert.ok(liveHandshakeIndex >= 0, 'a responsive content runtime must be recognized before fallback injection');
  assert.ok(injectionIndex > liveHandshakeIndex, 'fallback injection may run only after the message handshake fails');
  assert.match(
    preparation,
    /if \(acceptLiveContentScriptPing\(ping, hostname\)\) \{[\s\S]{0,320}return ready;/,
    'a working message channel must finish preparation without injecting a second runtime'
  );
  assert.doesNotMatch(
    preparation,
    /marker_probe|data-phantom-relay-content-instance|data-phantom-relay-content-owner/,
    'background preparation must not block on or mutate the page singleton marker'
  );
  assert.match(
    contentSource,
    /heartbeatAfter\s*!==\s*heartbeatBefore[\s\S]{0,240}return[\s\S]{0,240}setAttribute\(INSTANCE_MARKER, CONTENT_SCRIPT_VERSION\)/,
    'content.js must keep the provider-neutral live-instance handshake and stale-marker takeover'
  );
});

test('content-script preparation is single-flight and never waits for document idle', () => {
  assert.match(
    source,
    /const contentScriptPreparationFlights = new Map\(\)/,
    'tab lifecycle events and the scheduler must share one preparation flight per tab',
  );
  assert.match(
    source,
    /contentScriptPreparationFlights\.get\(tabId\)[\s\S]{0,700}contentScriptPreparationFlights\.set\(tabId, flight\)/,
    'a concurrent preparation must reuse the existing tab flight',
  );
  const preparationStart = source.indexOf('async function ensureContentScriptOnce(');
  const preparationEnd = source.indexOf('\nasync function rehydrateRecordedProfileForTab', preparationStart);
  const preparation = source.slice(preparationStart, preparationEnd);
  assert.match(
    preparation,
    /addDebugLog\(['"]content_script_preparation_stalled['"]/,
    'a slow probe or injection must expose its exact stage',
  );
  assert.equal(
    [...preparation.matchAll(/injectImmediately:\s*true/g)].length,
    1,
    'only the bounded file injection may use executeScript in long-lived SPAs',
  );
  assert.match(
    preparation,
    /setTimeout\(\(\) => finish\(null\), 750\)/,
    'a detached content runtime must not hold a scheduler tick indefinitely',
  );
  assert.match(
    preparation,
    /chrome\.tabs\.sendMessage\(tab\.id, \{ action: 'ping' \}, \(response\) => \{/,
    'a missing receiver must settle through the callback API before dynamic injection',
  );
  assert.match(
    preparation,
    /const runtimeError = chrome\.runtime\.lastError;/,
    'a missing receiver must consume runtime.lastError without leaving a rejected promise',
  );
  assert.doesNotMatch(preparation, /content_script_stale_marker_cleared|marker_probe/);
});

test('Enter recording is persisted through the background selector contract', () => {
  assert.match(popupSource, /action:\s*'save_send_strategy'/);
  assert.match(source, /case\s*'save_send_strategy'/);
  assert.match(source, /selectors\[domain\]\s*=\s*\{[^\n]*send:\s*strategy\s*\}/);
  assert.match(source, /action:\s*'set_selectors'/);
});

test('legacy selector bundles cannot be treated as executable profiles', () => {
  assert.match(
    source,
    /PhantomRelayProfile\.normalizeProfile\(profile\)/,
    'background readiness must validate the full recorded profile contract'
  );
  assert.match(
    source,
    /PhantomRelayProfile\.hasRecordedIdentityVerification\(/,
    'background readiness must require recorded response identity evidence'
  );
  assert.doesNotMatch(
    source,
    /function hasExecutableRecordedProfile[\s\S]{0,700}return !!recorded\.response;/,
    'selector presence alone must not mark a profile executable'
  );
});

test('background exposes one claim-bound CDP keyboard-input execution path', () => {
  assert.match(source, /async function dispatchRecordedKeyboardViaDebugger\(/);
  assert.match(source, /Input\.dispatchKeyEvent/);
  assert.match(
    source,
    /msg\?\.type === 'dispatch_recorded_keyboard'[\s\S]{0,700}activeClaims\.get\([\s\S]{0,700}keyboard_claim_invalid/,
    'trusted key dispatch must fail closed unless the content request owns the active job claim',
  );
  assert.doesNotMatch(
    source,
    /for \([^\n]*Input\.dispatchKeyEvent/,
    'a recorded keyboard action must not be retried through a CDP loop',
  );
});

test('unverified network capture stays disabled while debugger permission is limited to recorded input', () => {
  assert.ok(manifest.permissions.includes('debugger'), 'trusted recorded keyboard replay requires debugger input permission');
  assert.match(source, /const NETWORK_CAPTURE_RUNTIME_ENABLED\s*=\s*false/);
  assert.doesNotMatch(source, /importScripts\('network_(?:capture|candidate|calibration)\.js'\)/);
  assert.match(
    source,
    /if \(NETWORK_CAPTURE_RUNTIME_ENABLED\) \{\s*chrome\.debugger\.onDetach\.addListener/,
    'debugger listeners must remain unreachable while the experimental runtime is disabled',
  );
  assert.match(source, /case 'start_network_calibration':[\s\S]{0,220}network_capture_disabled/);
});

test('background and content script share one handshake version', () => {
  const backgroundVersion = source.match(/const CONTENT_SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const contentVersion = contentSource.match(/const CONTENT_SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  assert.ok(backgroundVersion, 'background must declare the content-script handshake version');
  assert.ok(contentVersion, 'content script must declare the content-script handshake version');
  assert.equal(backgroundVersion, contentVersion, 'worker must not reject the content script it is meant to execute');
});

test('background owns extension reload requests from content-script version recovery', () => {
  const reloadStart = source.indexOf('function handleExtensionRuntimeReloadRequest(');
  const reloadEnd = source.indexOf('\n}\n\n// Keep all content/runtime messages', reloadStart);
  assert.ok(reloadStart >= 0 && reloadEnd > reloadStart, 'worker reload handler must be defined');
  assert.match(
    source.slice(reloadStart, reloadEnd),
    /chrome\.runtime\.reload\(\)/,
    'only the extension service worker can invoke chrome.runtime.reload',
  );
  assert.match(
    source,
    /msg\?\.type\s*!==\s*['"]reload_extension_runtime['"]|msg\?\.type === ['"]reload_extension_runtime['"]/
  );
  assert.match(
    source.slice(reloadStart, reloadEnd),
    /isValidExtensionRuntimeReloadRequest\(msg, sender\)/,
    'worker reloads only after validating the content-script request',
  );
  assert.match(
    source,
    /if \(msg\?\.type === ['"]reload_extension_runtime['"]\)[\s\S]{0,180}handleExtensionRuntimeReloadRequest\(msg, sender, sendResponse\)/,
    'the reload protocol must be handled before storage and claim initialization',
  );
});

test('live content-script handshake rejects version drift before execution', () => {
  assert.match(
    source,
    /function acceptLiveContentScriptPing\(ping, hostname = ''\)/,
    'background must centralize the live handshake acceptance policy'
  );
  assert.match(
    source,
    /content_script_version_drift[\s\S]{0,320}action:\s*['"]reject_stale_handshake['"]|action:\s*['"]reject_stale_handshake['"][\s\S]{0,320}content_script_version_drift/,
    'version drift must remain visible while failing closed'
  );
  assert.match(
    source,
    /if \(acceptLiveContentScriptPing\(ping, hostname\)\)\s*\{[\s\S]{0,260}const ready = await prime\(\)/,
    'only an accepted current ping may proceed to selector priming and readiness'
  );
  assert.match(
    source,
    /const injectedPing = await pingContentRuntime\(\)[\s\S]{0,220}acceptLiveContentScriptPing\(injectedPing, hostname\)/,
    'the dynamically injected runtime must also prove the current content build'
  );
  assert.doesNotMatch(
    source,
    /action:\s*['"]accept_live_handshake['"]/,
    'a stale page must never be accepted as a live handshake'
  );
});

test('ready heartbeats publish the page runtime content version, not the worker constant', () => {
  assert.match(
    source,
    /content_script_version:\s*runtime\?\.contentScriptVersion\s*\|\|\s*['"]['"]/,
    'the server heartbeat must carry the version observed from the actual page runtime',
  );
  assert.match(
    source,
    /contentScriptVersion:\s*pageContentScriptVersion/,
    'page_ready must persist the page-provided content version in pageRuntime',
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf('async function publishReadyHeartbeat('),
      source.indexOf('\nfunction tabRegistrationRecord', source.indexOf('async function publishReadyHeartbeat(')),
    ),
    /content_script_version:\s*CONTENT_SCRIPT_VERSION/,
    'the worker constant cannot impersonate the page runtime version',
  );
});

test('heartbeat readiness requires the business acknowledgement body and refreshes one stale runtime', () => {
  assert.match(
    source,
    /async function readBrowserHeartbeatAcknowledgement\(response\)/,
    'heartbeat handling must parse the API business body instead of trusting HTTP status alone',
  );
  assert.match(
    source,
    /payload\?\.ready !== false[\s\S]{0,180}payload\?\.ignored[\s\S]{0,180}payload\?\.claim_valid !== false/,
    'ready=false, ignored, and claim_valid=false must all fail closed',
  );
  assert.match(
    source,
    /async function postBrowserHeartbeat\(body\)[\s\S]{0,1200}registerBrowserClient\(true\)/,
    'an explicitly stale runtime gets one generic registration refresh before retry',
  );
  assert.match(
    source,
    /if \(ready\?\.ready && heartbeatResp\?\.accepted\)/,
    'the page-ready execution wake must require the accepted business acknowledgement',
  );
});

test('ready page heartbeat directly wakes the browser bridge before delayed fallbacks', () => {
  const readyBranchStart = source.indexOf('if (ready?.ready && heartbeatResp?.accepted) {');
  const readyBranchEnd = source.indexOf('\n        sendResponse({ ok: !!heartbeatResp?.accepted, ready, heartbeat: heartbeatResp?.payload || {} });', readyBranchStart);
  const readyBranch = readyBranchStart >= 0 && readyBranchEnd > readyBranchStart
    ? source.slice(readyBranchStart, readyBranchEnd)
    : '';
  assert.match(
    readyBranch,
    /if \(ready\?\.ready && heartbeatResp\?\.accepted\) \{[\s\S]{0,600}(?:browserBridgeTick\(\)|scheduleBrowserBridgeTick\(0\))/,
    'a ready page must wake the claim/execute path while the MV3 worker is still active'
  );
  assert.doesNotMatch(
    readyBranch,
    /\[[^\]]*1000[^\]]*3000[^\]]*7000[^\]]*\]\.forEach\(delay\s*=>\s*setTimeout\(/,
    'page-ready must not fan out three delayed bridge retries for one heartbeat'
  );
});

test('queued work never creates a provider page from the execution worker', () => {
  const start = source.indexOf('async function browserBridgeTick()');
  const end = source.indexOf('\nlet bridgeWakeTimer', start);
  const bridge = source.slice(start, end);
  assert.doesNotMatch(
    bridge,
    /chrome\.tabs\.create\s*\(/,
    'the request-path wake coordinator is the only automatic tab-activation owner'
  );
  assert.doesNotMatch(
    bridge,
    /browser\/(?:reserve-tab|commit-tab)/,
    'automatic execution must not retain the old tab reservation/creation path'
  );
  assert.match(
    bridge,
    /tickOutcome\s*=\s*['"]no_execution_tab['"]/,
    'a missing target page must fail closed and wait for the wake owner'
  );
});

test('queued work does not create a second same-domain tab when the existing page is not ready', () => {
  assert.match(
    source,
    /if \(!tab && preferredDomain\) \{[\s\S]{0,1800}sameDomainTabs[\s\S]{0,1200}same_domain_tab_not_ready[\s\S]{0,700}return;/,
    'an existing same-domain page must fail closed until its recorded profile is repaired',
  );
});

test('browser poll carries the selected job conversation without an undeclared identifier', () => {
  const start = source.indexOf('async function browserBridgeTick()');
  const end = source.indexOf('\nlet bridgeWakeTimer', start);
  const bridge = source.slice(start, end);
  assert.doesNotMatch(
    bridge,
    /preferredConversationId/,
    'an undeclared conversation variable must not abort the claim path before /browser/poll',
  );
  assert.match(
    bridge,
    /conversation_id:\s*String\(preferredJob\.conversation_id \|\| ''\)/,
    'the poll identity must come from the queued job selected by this tick',
  );
});

test('manifest worker and every imported startup dependency are present in the extension bundle', () => {
  const extensionRoot = path.join(root, 'extension');
  const workerPath = manifest?.background?.service_worker;
  assert.equal(typeof workerPath, 'string', 'Manifest V3 must declare a service worker path');
  assert.notEqual(workerPath.trim(), '', 'Manifest V3 service worker path must not be empty');
  assert.ok(
    fs.existsSync(path.join(extensionRoot, workerPath)),
    `declared service worker is missing: ${workerPath}`,
  );

  const importedFiles = [];
  for (const match of source.matchAll(/importScripts\(([^)]*)\)/g)) {
    const args = match[1]
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    for (const value of args) {
      const imported = value.match(/^['"]([^'"]+)['"]$/)?.[1];
      assert.ok(imported, `importScripts arguments must be string literals: ${value}`);
      importedFiles.push(imported);
      assert.ok(
        fs.existsSync(path.join(extensionRoot, imported)),
        `background dependency is missing from the extension bundle: ${imported}`,
      );
    }
  }
  assert.ok(importedFiles.length > 0, 'background must declare its runtime dependencies explicitly');
});

console.log('BACKGROUND_REGISTRATION_READINESS_TESTS_DEFINED');
