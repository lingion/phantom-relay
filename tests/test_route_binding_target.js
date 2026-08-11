const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const popupSource = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');

test('model binding forwards the recorded page URL as the route target', () => {
  assert.match(
    popupSource,
    /action:\s*'bind_model_route',[\s\S]{0,240}target_url:\s*appState\.pageUrl/,
    'popup must preserve the page URL observed during recording'
  );
});

test('background persists a route target without replacing it with a provider default', () => {
  assert.match(
    backgroundSource,
    /const recorded = normalizeSelectors\(selectors\[domain\]\)[\s\S]{0,260}profile_incomplete/,
    'background must reject route binding until a complete recorded profile exists'
  );
  assert.match(
    backgroundSource,
    /safeRouteTargetUrl\(msg\.target_url,\s*domain\)[\s\S]{0,160}modelRoutes\[model\]\s*=\s*\{\s*domain,\s*target_url:\s*targetUrl\s*\}/,
    'background must send the explicit target URL through the generic route binding'
  );
  assert.doesNotMatch(
    backgroundSource,
    /modelRoutes\[String\(modelName\)\.trim\(\)\.toLowerCase\(\)\]\s*=\s*domain/,
    'response recording must not discard a recorded non-root page path'
  );
  assert.match(
    backgroundSource,
    /const pageUrl = String\(sender\.tab\?\.url \|\| ''\)/,
    'response recording must derive the route target from the actual recording tab'
  );
});

test('route target sanitization drops URL credentials and transient state', () => {
  assert.match(backgroundSource, /parsed\.username\s*=\s*''/);
  assert.match(backgroundSource, /parsed\.password\s*=\s*''/);
  assert.match(backgroundSource, /parsed\.search\s*=\s*''/);
  assert.match(backgroundSource, /parsed\.hash\s*=\s*''/);
});

test('popup exposes a provider-neutral recording-page action', () => {
  assert.match(backgroundSource, /importScripts\('route_target\.js'\)/);
  assert.match(backgroundSource, /case 'get_recording_route'/);
  assert.match(backgroundSource, /case 'open_recording_page'/);
  assert.match(backgroundSource, /PhantomRelayRouteTarget\.resolveRecordingTarget/);
  assert.match(popupSource, /action:\s*'open_recording_page'/);
  assert.match(popupSource, /btnOpenRecordingPage/);
});

test('popup keeps an explicit model when the current domain has no reverse binding', () => {
  assert.match(
    popupSource,
    /const inferred = resp\?\.model \|\| r\.phantomModel \|\| ''/,
    'an unbound current page must not erase the user-selected model'
  );
});

test('background starts pending profile recovery and waits before reporting state', () => {
  assert.match(backgroundSource, /importScripts\('profile_recovery\.js'\)/);
  assert.match(backgroundSource, /profileRecoveryPromise = recoverPendingProfiles\(\)/);
  assert.match(backgroundSource, /await profileRecoveryPromise/);
  assert.match(backgroundSource, /profile_selector_republish_failed/);
});
