const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background.js'),
  'utf8',
);

test('same-domain execution selection probes recorded response context before tab-id fallback', () => {
  assert.match(
    source,
    /chrome\.tabs\.sendMessage\([A-Za-z_$][\w$]*\.id,\s*\{\s*action:\s*'get_profile_health'\s*\}\)/,
    'candidate tabs must be checked through the recorded profile health contract',
  );
  assert.match(
    source,
    /responseReady[\s\S]{0,700}checks\.response\s*===\s*['"]pass['"][\s\S]{0,700}checks\.identity\s*===\s*['"]pass['"]|checks\.response\s*===\s*['"]pass['"][\s\S]{0,700}checks\.identity\s*===\s*['"]pass['"][\s\S]{0,700}responseReady/,
    'response and identity health must be represented in the candidate context',
  );
  assert.match(
    source,
    /sortExecutionTabs\(domainTabs,\s*domainTabContexts\)/,
    'tab-id order must not be the primary same-domain selection rule',
  );
  assert.match(
    source,
    /if\s*\(context\.responseReady\)\s*score\s*\+=\s*1000/,
    'a verified response context must outrank same-domain landing-page fallbacks',
  );
  assert.doesNotMatch(
    source,
    /newestSameDomainTabId|older_same_domain_tab/,
    'same-domain readiness must not be revoked by numeric tab-id election',
  );
});

console.log('BACKGROUND_TAB_SELECTION_TESTS_DEFINED');
