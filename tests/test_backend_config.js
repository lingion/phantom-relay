const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Config = require('../extension/backend_config.js');
const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));

test('backend URL defaults to localhost and strips trailing slashes', () => {
  assert.equal(Config.DEFAULT_BACKEND_URL, 'http://localhost:8765');
  assert.equal(Config.normalizeBackendUrl('http://localhost:8765///'), 'http://localhost:8765');
  assert.equal(Config.normalizeBackendUrl('https://relay.example/api/'), 'https://relay.example/api');
});

test('backend URL accepts HTTP(S) hosts and ports only', () => {
  assert.equal(Config.normalizeBackendUrl('http://192.168.1.20:8765'), 'http://192.168.1.20:8765');
  assert.equal(Config.normalizeBackendUrl('https://[::1]:8765/relay'), 'https://[::1]:8765/relay');
  for (const value of ['', 'javascript:alert(1)', 'file:///tmp/relay', 'http://', 'http://user:pass@relay.example']) {
    assert.throws(() => Config.normalizeBackendUrl(value), /backend_url_/);
  }
});

test('backend URL rejects query and fragment because it is a service root', () => {
  assert.throws(() => Config.normalizeBackendUrl('http://relay.example:8765/?token=secret'), /backend_url_query/);
  assert.throws(() => Config.normalizeBackendUrl('http://relay.example:8765/#fragment'), /backend_url_fragment/);
});

test('backend URL fallback is fail-closed to the built-in default', () => {
  assert.equal(Config.backendUrlOrDefault('not a URL'), Config.DEFAULT_BACKEND_URL);
  assert.equal(Config.backendUrlOrDefault('https://relay.example/'), 'https://relay.example');
});

test('all active backend traffic is worker-owned and content is injected only on demand', () => {
  assert.match(backgroundSource, /importScripts\('backend_config\.js'\)/);
  assert.match(backgroundSource, /let LOCAL_API = BACKEND_CONFIG\.DEFAULT_BACKEND_URL/);
  assert.doesNotMatch(contentSource, /https?:\/\/(?:localhost|127\.0\.0\.1):8765\/browser\//);
  assert.ok(
    !Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0,
    'arbitrary pages must not receive a static all-URL content script',
  );
  assert.match(
    backgroundSource,
    /files:\s*\['backend_config\.js',\s*'universal_bridge\.js'/,
    'recorded execution pages must receive the shared config through dynamic injection',
  );
});
