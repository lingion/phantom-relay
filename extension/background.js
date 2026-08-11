// ============================================================
// Phantom Relay — Background Service Worker v3
// 多站点: 按域名独立存储选择器模板
// ============================================================

importScripts('backend_config.js');
importScripts('route_target.js');
importScripts('profile_contract.js');
importScripts('profile_selector_reconciliation.js');
importScripts('profile_lifecycle.js');
importScripts('profile_store.js');
importScripts('profile_sync.js');
importScripts('profile_recovery.js');
importScripts('claim_recovery.js');

const CONTENT_SCRIPT_VERSION = '2026-08-11.06';
globalThis.__phantomRelayBackgroundVersion = '2026-08-11.10-content-ready-inventory';
const BACKEND_CONFIG = globalThis.PhantomRelayBackendConfig;
let LOCAL_API = BACKEND_CONFIG.DEFAULT_BACKEND_URL;
const BROWSER_POLL_ALARM = 'phantom-relay-browser-poll';
const NETWORK_CAPTURE_RUNTIME_ENABLED = false;

const State = {
  IDLE: 'idle', RECORDING_INPUT: 'recording_input', INPUT_DONE: 'input_done',
  RECORDING_SEND: 'recording_send', SEND_DONE: 'send_done',
  RECORDING_RESPONSE: 'recording_response', ALL_DONE: 'all_done',
};

const STATE_LABELS = { '': '', recording_input: 'IN', input_done: '✓1', recording_send: 'SD', send_done: '✓2', recording_response: 'RP', all_done: '✓' };
const STATE_COLORS = { '': '#607D8B', recording_input: '#FF6D00', input_done: '#FF8A65', recording_send: '#1976D2', send_done: '#64B5F6', recording_response: '#7B1FA2', all_done: '#00C853' };

// ── 数据结构 ──────────────────────────────────────────────
// selectors: { "domain": { input, send, response } }
// domainState: { "domain": { current: 'all_done' } }
let selectors = {};       // 所有站点的选择器
let domainState = {};     // 每个站点的录制状态
let currentDomain = null; // 当前活跃站点
const pageRuntime = new Map(); // tabId -> current document identity
let conversations = [];
let debugLogs = [];
let modelRoutes = {};      // 用户录制后绑定：模型名 -> 官网 hostname
let storageReadyResolve;
const storageReady = new Promise(resolve => { storageReadyResolve = resolve; });
let profileStore = { version: 1, profiles: {}, diagnostics: [], legacyHints: [] };
let profileRecoveryPromise = Promise.resolve();
let browserClientId = '';
const browserRuntimeSessionId = (() => {
  const randomPart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `runtime-${randomPart}`;
})();
const ownedTabIds = new Set();
const readyTabIds = new Set();
  let registrationInFlight = null;
  let lastRegistrationAt = 0;
  const CLIENT_REGISTRATION_INTERVAL_MS = 30000;
  let backendReconciliationCompleted = false;
  let profileRecoveryRetryInFlight = null;
  let lastProfileRecoveryRetryAt = 0;
  const PROFILE_RECOVERY_RETRY_INTERVAL_MS = 5000;
  const contentScriptPreparationFlights = new Map();
const bridgeWaitStates = new Map();

function bridgeWaitKey(jobId, domain) {
  return `${String(jobId || '')}:${String(domain || '').trim().toLowerCase()}`;
}

function clearBridgeWaitForDomain(domain = '') {
  const wanted = String(domain || '').trim().toLowerCase();
  for (const key of bridgeWaitStates.keys()) {
    if (!wanted || key.endsWith(`:${wanted}`)) bridgeWaitStates.delete(key);
  }
}

function bridgeWaitBackoff(jobId, domain) {
  const key = bridgeWaitKey(jobId, domain);
  const previous = bridgeWaitStates.get(key) || { attempts: 0 };
  const attempts = Math.min(Number(previous.attempts || 0) + 1, 5);
  const delayMs = Math.min(30000, 2000 * (2 ** (attempts - 1)));
  bridgeWaitStates.set(key, { attempts, nextAt: Date.now() + delayMs });
  return { attempts, delayMs };
}

function bridgeWaitBlocked(jobId, domain) {
  const state = bridgeWaitStates.get(bridgeWaitKey(jobId, domain));
  return state && Number(state.nextAt || 0) > Date.now() ? state : null;
}

function emptySelectors() {
  return { input: null, send: null, response: null, profile: null };
}

function responseRoleValue(value) {
  return value?.response ?? value?.copy ?? null;
}

function normalizeRoleSelector(value) {
  if (!value) return null;
  if (typeof value === 'string') return { selector: value, alternatives: [] };
  const nested = value.selector && typeof value.selector === 'object' ? value.selector : null;
  if (nested?.css) return { ...value, selector: nested.css, alternatives: [...(value.alternatives || []), ...(nested.alternatives || [])] };
  if (typeof value.selector === 'string') return { ...value, selector: value.selector, alternatives: value.alternatives || [] };
  if (typeof value.css === 'string') return { ...value, selector: value.css, alternatives: value.alternatives || [] };
  return null;
}

function normalizeSelectors(value) {
  const out = emptySelectors();
  for (const role of ['input', 'send', 'response']) {
    const raw = role === 'response' ? responseRoleValue(value) : value?.[role];
    // Strategy objects like {kind:'enter', key:'Enter', modifiers:[]} pass through
    if (raw && typeof raw === 'object' && raw.kind) {
      out[role] = raw;
    } else {
      out[role] = normalizeRoleSelector(raw);
    }
  }
  out.profile = value?.profile || null;
  return out;
}

function normalizeRecordedSendStrategy(value) {
  return globalThis.PhantomRelaySelectorReconciliation.normalizeSendStrategy(value);
}

function sendStrategyFingerprint(value) {
  return globalThis.PhantomRelaySelectorReconciliation.fingerprint(value);
}

function selectorBundleFingerprint(value) {
  const normalized = normalizeSelectors(value);
  const selectorFingerprint = globalThis.PhantomRelaySelectorReconciliation.selectorFingerprint;
  return JSON.stringify({
    input: selectorFingerprint(normalized.input),
    send: sendStrategyFingerprint(normalized.send),
    response: selectorFingerprint(normalized.response),
  });
}

function hasExecutableRecordedProfile(recorded) {
  const profile = recorded?.profile;
  const mode = String(profile?.capture?.mode || 'dom').trim().toLowerCase();
  if (!recorded?.input || !recorded?.send || !profile) return false;
  if (mode === 'network' || mode === 'hybrid') return false;
  try {
    const normalized = PhantomRelayProfile.normalizeProfile(profile);
    return !!recorded.response && PhantomRelayProfile.hasRecordedIdentityVerification(normalized);
  } catch (_) {
    return false;
  }
}

function profileStageMetadata(profile) {
  const response = profile?.response && typeof profile.response === 'object' ? profile.response : {};
  const identity = response.identity && typeof response.identity === 'object' ? response.identity : {};
  const verification = response.identityVerification && typeof response.identityVerification === 'object'
    ? response.identityVerification
    : {};
  const selector = response.selector && typeof response.selector === 'object' ? response.selector : {};
  const container = response.containerSelector && typeof response.containerSelector === 'object'
    ? response.containerSelector
    : {};
  return {
    profileId: String(profile?.profileId || ''),
    domain: String(profile?.domain || ''),
    captureMode: String(profile?.capture?.mode || 'dom'),
    hasInputSelector: !!profile?.input?.selector,
    hasSend: !!profile?.send,
    responseSelector: String(selector.css || selector.selector || ''),
    containerSelector: String(container.css || container.selector || ''),
    identityAttributes: Array.isArray(identity.attributes) ? identity.attributes.slice(0, 8) : [],
    identityPath: String(identity.path || ''),
    identityMethod: String(verification.method || ''),
    identityKind: String(verification.identityKind || ''),
    identityStatus: String(verification.status || ''),
    verificationAttributes: Array.isArray(verification.attributes) ? verification.attributes.slice(0, 8) : [],
  };
}

async function diagnoseProfileStageFailure(profile, store, originalError) {
  const metadata = profileStageMetadata(profile);
  const report = (phase, error) => addDebugLog(`profile_stage_${phase}_failed`, {
    ...metadata,
    code: error?.code || 'unknown',
    error: error?.message || String(error),
    originalCode: originalError?.code || '',
    originalError: originalError?.message || String(originalError || ''),
  }, metadata.domain || currentDomain);

  let normalized;
  try {
    normalized = PhantomRelayProfile.normalizeProfile(profile);
  } catch (error) {
    report('normalize', error);
    return;
  }

  let recorded;
  try {
    const profileId = normalized.profileId;
    const previous = store?.profiles?.[profileId]?.active || undefined;
    recorded = await PhantomRelayProfileLifecycle.createProfileEnvelope(normalized, previous);
  } catch (error) {
    report('envelope', error);
    return;
  }

  try {
    PhantomRelayProfileLifecycle.transitionProfileEnvelope(recorded, 'sync_requested');
  } catch (error) {
    report('transition', error);
  }
}


function domainCandidates(hostname) {
  const parts = String(hostname || '').split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return [...new Set([hostname, ...out])];
}

function selectorsForDomain(hostname) {
  // 人工录制模板是唯一真理：只允许当前 hostname 的精确记录，
  // 禁止父域名回退、自动发现或替换成其它站点模板。
  const raw = selectors[hostname];
  // Strategy-type send objects pass through without normalizeRoleSelector
  const out = emptySelectors();
  if (raw) {
    for (const role of Object.keys(out)) {
      const v = role === 'response' ? responseRoleValue(raw) : raw[role];
      if (role === 'send' && v && typeof v === 'object' && v.kind) {
        out[role] = v;
      } else {
        out[role] = normalizeRoleSelector(v);
      }
    }
  }
  out.profile = raw?.profile || null;
  return { key: hostname, value: out };
}


function addDebugLog(message, details = null, domain = currentDomain) {
  const entry = {
    time: new Date().toISOString(),
    domain: domain || 'unknown',
    message,
    details: details || null
  };
  debugLogs.push(entry);
  if (debugLogs.length > 500) debugLogs = debugLogs.slice(-500);
  chrome.storage.local.set({ phantomDebugLogs: debugLogs });
  // The bridge emits several lifecycle markers per polling tick. Keep those
  // markers in the local diagnostic ring buffer, but do not turn an idle
  // extension into a continuous write stream against the API. User-visible
  // and failure diagnostics still cross the boundary.
  if (!String(message || '').startsWith('browser_bridge_')) {
    fetch(`${LOCAL_API}/browser/debug`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry)
    }).catch(() => {});
  }
  console.log('[Phantom Relay]', entry);
}

function acceptLiveContentScriptPing(ping, hostname = '') {
  const actualVersion = String(ping?.content_script_version || '').trim();
  if (ping?.pong !== true || !actualVersion) return false;

  // A live page can outlive an MV3 worker restart or extension reload. The
  // pong proves that the page runtime is present and speaking the protocol;
  // a diagnostic version drift must not strand a queued job before readiness.
  if (actualVersion !== CONTENT_SCRIPT_VERSION) {
    addDebugLog('content_script_version_drift', {
      expected: CONTENT_SCRIPT_VERSION,
      actual: actualVersion,
      action: 'accept_live_handshake'
    }, hostname);
  }
  return true;
}

// ── 持久化 ────────────────────────────────────────────────
chrome.storage.local.get(['phantomBackendUrl', 'phantomBrowserClientId', 'phantomSelectors', 'phantomDomainState', 'phantomConversations', 'phantomDebugLogs', 'phantomModelRoutes'], async (data) => {
  LOCAL_API = BACKEND_CONFIG.backendUrlOrDefault(data.phantomBackendUrl);
  browserClientId = String(data.phantomBrowserClientId || '').trim();
  if (!browserClientId) {
    const randomPart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    browserClientId = `client-${randomPart}`;
    chrome.storage.local.set({ phantomBrowserClientId: browserClientId });
  }
  if (data.phantomSelectors) {
    selectors = Object.fromEntries(Object.entries(data.phantomSelectors).map(([domain, value]) => {
      const normalized = normalizeSelectors(value);
      return [domain, { ...value, ...normalized }];
    }));
  }
  if (data.phantomDomainState) domainState = data.phantomDomainState;
  if (data.phantomConversations) conversations = data.phantomConversations;
  if (data.phantomDebugLogs) debugLogs = data.phantomDebugLogs;
  if (data.phantomModelRoutes) modelRoutes = data.phantomModelRoutes;
  try {
    profileStore = await PhantomRelayProfileStore.loadProfileStore(chrome.storage.local);
    const migration = PhantomRelayProfileStore.migrateLegacySelectors(data.phantomSelectors || {});
    profileStore.legacyHints = migration.hints;
  } catch (error) {
    profileStore.diagnostics.push({ slot: 'store', code: error?.code || 'profile_store_load_failed', message: error?.message || String(error) });
  }
  storageReadyResolve();
  await reconcileRestoredSendStrategies().catch(error => {
    addDebugLog('send_strategy_profile_startup_reconcile_failed', {
      code: error?.code || 'profile_reconcile_failed',
      error: error?.message || String(error),
    });
  });
  await reconcileRestoredProfiles().catch(error => {
    addDebugLog('profile_lifecycle_bootstrap_failed', {
      code: error?.code || 'profile_bootstrap_failed',
      error: error?.message || String(error),
    });
  });
  for (const [domain, value] of Object.entries(selectors || {})) {
    const restored = normalizeSelectors(value);
    if (!restored.input && !restored.send && !restored.response) continue;
    fetch(`${LOCAL_API}/browser/selectors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, selectors: restored })
    }).catch(() => {});
  }
  profileRecoveryPromise = recoverPendingProfiles().catch(error => {
    addDebugLog('profile_startup_recovery_failed', { error: error?.message || String(error) });
    return { recovered: [], failed: [], error: error?.message || String(error) };
  });
});

function markTabReady(tabId, ready = true) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId) || numericTabId < 0) return;
  if (ready) readyTabIds.add(numericTabId);
  else readyTabIds.delete(numericTabId);
}

async function publishReadyHeartbeat(tab) {
  if (!isUsableExecutionTab(tab)) return false;
  let domain = '';
  try { domain = new URL(tab.url || '').hostname; } catch (_) {}
  if (!domain || !browserClientId) return false;
  const readyOverride = arguments.length > 1 ? arguments[1] : true;
  const ready = readyOverride === true;
  const runtime = pageRuntime.get(Number(tab.id));
  try {
    const response = await fetch(`${LOCAL_API}/browser/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: browserClientId,
        runtime_session_id: browserRuntimeSessionId,
        domain,
        tab_id: Number(tab.id),
        url: String(tab.url || ''),
        source: 'content-ready',
        transport: 'chrome-extension',
        page_session_id: runtime?.pageSessionId || '',
        conversation_id: '',
        ready,
        input_ready: ready,
        send_ready: ready,
        capabilities: { can_observe: ready, can_execute: ready, can_stream: true, can_create_tab: false, can_close_tab: false, can_snapshot: ready },
        background_version: globalThis.__phantomRelayBackgroundVersion || ''
      })
    });
    if (!response.ok) return false;
    markTabReady(tab.id, ready);
    return true;
  } catch (_) {
    return false;
  }
}

function tabRegistrationRecord(tab) {
  let domain = '';
  try { domain = new URL(tab?.url || '').hostname; } catch (_) {}
  const activeClaim = [...activeClaims.values()].find(claim => Number(claim?.tab_id) === Number(tab?.id));
  const ready = !!activeClaim || readyTabIds.has(Number(tab?.id));
  return {
    tab_id: Number(tab?.id),
    url: String(tab?.url || ''),
    domain,
    ready,
    input_ready: ready,
    send_ready: ready,
    conversation_id: String(activeClaim?.conversation_id || ''),
    capabilities: {
      can_execute: ready,
      can_observe: ready,
      can_stream: true,
      can_create_tab: false,
      can_close_tab: false,
      can_snapshot: ready,
    },
  };
}

function isExecutionInventoryTab(tab) {
  if (!isUsableExecutionTab(tab)) return false;
  return readyTabIds.has(Number(tab?.id))
    || [...activeClaims.values()].some(claim => Number(claim?.tab_id) === Number(tab?.id))
    || isRecordedExecutionTab(tab);
}

async function registerBrowserClient(force = false) {
  await storageReady;
  const now = Date.now();
  if (!force && now - lastRegistrationAt < CLIENT_REGISTRATION_INTERVAL_MS) return null;
  if (registrationInFlight) return registrationInFlight;
  registrationInFlight = (async () => {
    const tabs = await chrome.tabs.query({ windowType: 'normal' }).catch(() => []);
    const requestPayload = {
      client_id: browserClientId,
      runtime_session_id: browserRuntimeSessionId,
      extension_version: chrome.runtime.getManifest?.().version || CONTENT_SCRIPT_VERSION,
      browser: { name: 'Chromium', version: '' },
      profile_id: browserClientId,
      tabs: tabs.filter(isExecutionInventoryTab).map(tabRegistrationRecord),
    };
    const response = await fetch(`${LOCAL_API}/browser/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    if (!response.ok) throw new Error(`browser_registration_failed:${response.status}`);
    lastRegistrationAt = Date.now();
    const payload = await response.json().catch(() => ({}));
    if (!backendReconciliationCompleted) {
      try {
        await retryPendingProfilesAfterBackendReady();
        backendReconciliationCompleted = true;
      } catch (error) {
        addDebugLog('profile_backend_reconciliation_deferred', {
          error: error?.message || String(error),
        });
      }
    }
    const registeredTabs = Array.isArray(payload?.client?.tabs) ? payload.client.tabs : null;
    if (registeredTabs) {
      ownedTabIds.clear();
      for (const tab of registeredTabs) {
        const tabId = Number(tab?.tab_id);
        if (Number.isFinite(tabId) && tabId >= 0) ownedTabIds.add(tabId);
      }
    }
    return payload;
  })().catch(error => {
    addDebugLog('browser_registration_failed', { error: error?.message || String(error) });
    return null;
  }).finally(() => {
    registrationInFlight = null;
  });
  return registrationInFlight;
}

function syncRoutesToBackend() {
  try {
    fetch(`${LOCAL_API}/browser/sync-routes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routes: modelRoutes })
    }).catch(() => {});
  } catch (_) {}
}

function loadRoutes() {
  chrome.storage.local.get({ phantomModelRoutes: {} }, (r) => {
    if (r.phantomModelRoutes && Object.keys(r.phantomModelRoutes).length) {
      modelRoutes = { ...modelRoutes, ...r.phantomModelRoutes };
    }
    fetch(`${LOCAL_API}/model-routes`).then(resp => resp.json()).then(data => {
      if (data?.routes) { modelRoutes = { ...modelRoutes, ...data.routes }; persist(); }
    }).catch(() => {});
  });
}

function persist() {
  chrome.storage.local.set({
    phantomSelectors: selectors,
    phantomDomainState: domainState,
    phantomConversations: conversations,
    phantomModelRoutes: modelRoutes,
  });
  PhantomRelayProfileStore.saveProfileStore(chrome.storage.local, profileStore).catch(error => {
    addDebugLog('profile_store_persist_failed', { error: error?.message || String(error) });
  });
  syncRoutesToBackend();
}

async function syncPendingProfile(profileId) {
  await storageReady;
  try {
    const result = await PhantomRelayProfileSync.syncPendingProfile(profileId, {
      store: profileStore,
      clientId: browserClientId,
      baseUrl: LOCAL_API,
      fetchImpl: fetch,
      setStore(next) { profileStore = next; }
    });
    profileStore = result.store;
    await PhantomRelayProfileStore.saveProfileStore(chrome.storage.local, profileStore);
    return result;
  } catch (error) {
    if (error?.store) profileStore = error.store;
    await PhantomRelayProfileStore.saveProfileStore(chrome.storage.local, profileStore).catch(() => {});
    throw error;
  }
}

async function retryPendingProfilesAfterBackendReady() {
  await storageReady;
  const now = Date.now();
  if (profileRecoveryRetryInFlight) return profileRecoveryRetryInFlight;
  if (now - lastProfileRecoveryRetryAt < PROFILE_RECOVERY_RETRY_INTERVAL_MS) return null;
  lastProfileRecoveryRetryAt = now;
  profileRecoveryRetryInFlight = (async () => {
    await profileRecoveryPromise.catch(() => {});
    const pending = await recoverPendingProfiles();
    const active = await reconcileActiveProfilesAfterBackendReady();
    const failed = [
      ...(Array.isArray(pending?.failed) ? pending.failed : []),
      ...(Array.isArray(active?.failed) ? active.failed : []),
    ];
    if (failed.length) {
      const error = new Error(`profile_backend_recovery_incomplete:${failed.length}`);
      error.code = 'profile_backend_recovery_incomplete';
      error.failed = [...new Set(failed)];
      throw error;
    }
    if (pending?.recovered?.length) persist();
    return { pending, active, failed: [] };
  })().catch(error => {
    addDebugLog('profile_backend_recovery_failed', {
      error: error?.message || String(error),
    });
    throw error;
  }).finally(() => {
    profileRecoveryRetryInFlight = null;
  });
  return profileRecoveryRetryInFlight;
}

async function bootstrapRecordedProfileLifecycle(domain, recorded, fallbackRevision = 0) {
  await storageReady;
  const normalized = PhantomRelayProfile.normalizeProfile(recorded?.profile);
  if (!PhantomRelayProfile.hasRecordedIdentityVerification(normalized)) {
    throw Object.assign(new Error('profile_identity_evidence_missing'), { code: 'profile_identity_evidence_missing' });
  }
  const profileId = normalized.profileId;
  const entry = profileStore.profiles?.[profileId] || {};
  let remote = null;

  // A fresh browser may have a complete legacy profile but no local envelope.
  // Adopt the backend's exact revision when the checksum agrees; never merge
  // or overwrite an unknown remote profile implicitly.
  if (!entry.active && !entry.pending) {
    try {
      const response = await fetch(`${LOCAL_API}/browser/profiles/${encodeURIComponent(profileId)}`);
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        remote = payload;
        const localChecksum = await PhantomRelayProfileLifecycle.computeProfileChecksum(normalized);
        if (String(remote.checksum || '') !== localChecksum) {
          throw Object.assign(new Error('profile_remote_checksum_mismatch'), { code: 'profile_remote_checksum_mismatch' });
        }
        const adopted = await PhantomRelayProfileStore.adoptSyncedProfile(profileStore, normalized, remote);
        profileStore = adopted.store;
        await PhantomRelayProfileStore.saveProfileStore(chrome.storage.local, profileStore);
        addDebugLog('profile_lifecycle_adopted', {
          profileId,
          revision: adopted.revision,
          source: 'backend',
        }, domain);
        return adopted.profile;
      }
      if (response.status !== 404) {
        addDebugLog('profile_lifecycle_remote_lookup_failed', {
          profileId,
          status: response.status,
        }, domain);
      }
    } catch (error) {
      if (error?.code === 'profile_remote_checksum_mismatch') throw error;
      addDebugLog('profile_lifecycle_remote_lookup_unavailable', {
        profileId,
        code: error?.code || 'profile_remote_lookup_failed',
        error: error?.message || String(error),
      }, domain);
    }
  }

  const remoteRevision = Math.max(
    Number(remote?.revision || 0),
    Number(fallbackRevision || 0),
  );
  const bootstrapped = await PhantomRelayProfileStore.bootstrapProfile(
    profileStore,
    normalized,
    { remoteRevision },
  );
  profileStore = bootstrapped.store;
  if (bootstrapped.state === 'already_active') return bootstrapped.profile;
  await PhantomRelayProfileStore.saveProfileStore(chrome.storage.local, profileStore);

  if (bootstrapped.state === 'staged' || bootstrapped.state === 'pending') {
    const synced = await syncPendingProfile(profileId);
    if (synced.state !== 'synced') {
      throw Object.assign(new Error(synced.error?.code || 'profile_sync_conflict'), {
        code: synced.error?.code || 'profile_sync_conflict',
      });
    }
    profileStore = synced.store || profileStore;
  }
  const active = profileStore.profiles?.[profileId]?.active?.profile;
  if (active) {
    addDebugLog('profile_lifecycle_bootstrapped', {
      profileId,
      revision: Number(profileStore.profiles?.[profileId]?.active?.lifecycle?.revision || 0),
      state: String(profileStore.profiles?.[profileId]?.active?.lifecycle?.state || ''),
    }, domain);
    return active;
  }
  return normalized;
}

async function reconcileRestoredProfiles() {
  await storageReady;
  for (const [domain, raw] of Object.entries(selectors || {})) {
    const value = normalizeSelectors(raw);
    if (!value.profile) continue;
    try {
      const profile = await bootstrapRecordedProfileLifecycle(
        domain,
        value,
        activeProfileRevisionForDomain(domain),
      );
      selectors[domain] = { ...value, profile };
    } catch (error) {
      addDebugLog('profile_lifecycle_bootstrap_failed', {
        profileId: String(value.profile?.profileId || ''),
        code: error?.code || 'profile_bootstrap_failed',
        error: error?.message || String(error),
      }, domain);
    }
  }
  persist();
}

async function reconcileRestoredSendStrategies() {
  await storageReady;
  for (const [domain, raw] of Object.entries(selectors || {})) {
    const value = normalizeSelectors(raw);
    const profile = value.profile;
    if (!profile) continue;
    try {
      const projected = PhantomRelaySelectorReconciliation.projectProfileSelectorBundle(
        value,
        PhantomRelayProfile,
      );
      const changed = selectorBundleFingerprint(value) !== selectorBundleFingerprint(projected);
      selectors[domain] = projected;
      if (changed) {
        addDebugLog('selector_view_projected_from_profile', {
          profileId: String(projected.profile?.profileId || ''),
          kind: String(projected.send?.kind || ''),
          source: 'startup',
        }, domain);
      }
    } catch (error) {
      addDebugLog('send_strategy_profile_startup_reconcile_failed', {
        domain,
        code: error?.code || 'profile_invalid',
        error: error?.message || String(error),
      }, domain);
      selectors[domain] = { ...value, profile: null };
    }
  }
}

async function reconcileFetchedSelectors(domain, payload) {
  await storageReady;
  const host = String(domain || '').trim().toLowerCase();
  const incoming = normalizeSelectors(payload?.selectors || payload || {});
  const fallbackRevision = Number(payload?.profile_revision || activeProfileRevisionForDomain(host) || 0);
  if (!host || !incoming.profile) {
    return { selectors: incoming, profile_revision: fallbackRevision };
  }

  try {
    const projected = PhantomRelaySelectorReconciliation.projectProfileSelectorBundle(
      incoming,
      PhantomRelayProfile,
    );
    const existingSelectors = normalizeSelectors(selectors[host]);
    const active = profileStore.profiles?.[projected.profile.profileId]?.active;
    const incomingChecksum = await PhantomRelayProfileLifecycle.computeProfileChecksum(projected.profile);
    const activeChecksum = String(active?.lifecycle?.checksum || '');
    if (active && activeChecksum !== incomingChecksum) {
      throw Object.assign(new Error('profile_remote_checksum_mismatch'), {
        code: 'profile_remote_checksum_mismatch',
      });
    }
    if (active && activeChecksum === incomingChecksum
      && selectorBundleFingerprint(existingSelectors) === selectorBundleFingerprint(projected)) {
      return {
        selectors: existingSelectors,
        profile_revision: Number(active.lifecycle.revision || fallbackRevision),
      };
    }
    const profile = await bootstrapRecordedProfileLifecycle(
      host,
      projected,
      fallbackRevision,
    );
    const selectorsValue = PhantomRelaySelectorReconciliation.projectProfileSelectorBundle(
      { ...projected, profile },
      PhantomRelayProfile,
    );
    selectors[host] = { ...existingSelectors, ...selectorsValue };
    persist();
    const revision = activeProfileRevisionForDomain(host) || fallbackRevision;
    addDebugLog('selector_view_projected_from_profile', {
      profileId: profile.profileId,
      revision,
      kind: String(profile.send?.kind || ''),
      source: 'backend',
    }, host);
    return { selectors: selectorsValue, profile_revision: revision };
  } catch (error) {
    // A remote mixed contract must never reach the page. Keep the selector
    // visible for a later retry, but remove the executable profile locally so
    // readiness and replay fail closed until both halves can be synchronized.
    const failed = { ...incoming, profile: null };
    selectors[host] = { ...normalizeSelectors(selectors[host]), ...failed };
    addDebugLog('send_strategy_profile_server_reconcile_failed', {
      profileId: String(incoming.profile?.profileId || ''),
      code: error?.code || 'profile_server_reconcile_failed',
      error: error?.message || String(error),
    }, host);
    return { selectors: failed, profile_revision: 0 };
  }
}

async function applyRecoveredProfile({ profileId, envelope }) {
  const profile = envelope?.profile;
  const domain = String(profile?.domain || '').trim().toLowerCase();
  if (!profile || !domain) throw new Error(`profile_domain_missing:${profileId}`);
  const existing = normalizeSelectors(selectors[domain]);
  selectors[domain] = {
    ...existing,
    input: profile.input || existing.input,
    send: profile.send || existing.send,
    response: profile.response || existing.response,
    profile,
  };
  domainState[domain] = { current: State.ALL_DONE };
  try {
    const response = await fetch(`${LOCAL_API}/browser/selectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, selectors: selectors[domain] })
    });
    if (!response.ok) throw new Error(`selector_republish_failed:${response.status}`);
  } catch (error) {
    addDebugLog('profile_selector_republish_failed', {
      profileId, domain, error: error?.message || String(error)
    }, domain);
    throw error;
  }
  addDebugLog('profile_startup_recovered', { profileId, domain }, domain);
}

async function recoverPendingProfiles() {
  await storageReady;
  const result = await PhantomRelayProfileRecovery.recoverPendingProfiles(
    profileStore,
    profileId => syncPendingProfile(profileId),
    applyRecoveredProfile
  );
  profileStore = result.store;
  await PhantomRelayProfileStore.saveProfileStore(chrome.storage.local, profileStore);
  if (result.recovered.length) persist();
  for (const profileId of result.failed) {
    addDebugLog('profile_startup_recovery_pending', { profileId });
  }
  return result;
}

async function reconcileActiveProfilesAfterBackendReady() {
  await storageReady;
  const repaired = [];
  const failed = [];
  const entries = Object.entries(profileStore.profiles || {});

  for (const [profileId, entry] of entries) {
    const active = entry?.active;
    if (!active?.profile || !active?.lifecycle) continue;

    const domain = String(active.profile.domain || '').trim().toLowerCase();
    let remoteResponse;
    let needsSelectorRepair = false;
    try {
      remoteResponse = await fetch(`${LOCAL_API}/browser/profiles/${encodeURIComponent(profileId)}`);
    } catch (error) {
      failed.push(profileId);
      addDebugLog('profile_backend_repair_failed', {
        profileId,
        code: 'backend_unreachable',
        error: error?.message || String(error),
      }, active.profile.domain || currentDomain);
      continue;
    }

    if (remoteResponse.status === 404) {
      // The local active envelope is last-known-good. Re-publish that exact
      // revision instead of creating an unnecessary revision just because the
      // backend was reset or its registry was lost.
      addDebugLog('profile_backend_repair_missing', {
        profileId,
        revision: Number(active.lifecycle.revision || 0),
      }, active.profile.domain || currentDomain);
      try {
        const response = await fetch(`${LOCAL_API}/browser/profiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(PhantomRelayProfileSync.buildProfileUpsertPayload(browserClientId, active)),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error?.message || `profile_backend_repair_failed:${response.status}`);
        }
      } catch (error) {
        failed.push(profileId);
        addDebugLog('profile_backend_repair_failed', {
          profileId,
          code: error?.code || 'profile_backend_repair_failed',
            error: error?.message || String(error),
        }, domain || currentDomain);
        continue;
      }
      needsSelectorRepair = true;
    } else if (!remoteResponse.ok) {
      failed.push(profileId);
      addDebugLog('profile_backend_repair_failed', {
        profileId,
        code: `profile_lookup_failed:${remoteResponse.status}`,
      }, domain || currentDomain);
      continue;
    } else {
      const remote = await remoteResponse.json().catch(() => ({}));
      const remoteChecksum = String(remote?.checksum || remote?.profile?.lifecycle?.checksum || '');
      const localChecksum = String(active.lifecycle.checksum || '');
      if (remoteChecksum && localChecksum && remoteChecksum !== localChecksum) {
        failed.push(profileId);
        addDebugLog('profile_backend_repair_conflict', {
          profileId,
          revision: Number(active.lifecycle.revision || 0),
        }, domain || currentDomain);
        continue;
      }

      // A profile can survive a backend restart while its legacy selector
      // bundle is missing or stale. Probe the bundle separately and only
      // republish when the provider-neutral recorded contract differs.
      try {
        const selectorResponse = await fetch(
          `${LOCAL_API}/browser/selectors?domain=${encodeURIComponent(domain)}`,
        );
        if (!selectorResponse.ok) {
          needsSelectorRepair = true;
        } else {
          const remoteSelectorPayload = await selectorResponse.json().catch(() => ({}));
          const remoteSelectorProfileId = String(
            remoteSelectorPayload?.selectors?.profile?.profileId
              || remoteSelectorPayload?.selectors?.profile?.profile_id
              || '',
          );
          needsSelectorRepair = remoteSelectorProfileId !== profileId
            || selectorBundleFingerprint(remoteSelectorPayload?.selectors)
              !== selectorBundleFingerprint(active.profile);
        }
      } catch (error) {
        needsSelectorRepair = true;
        addDebugLog('profile_selector_bundle_probe_failed', {
          profileId,
          code: 'backend_unreachable',
          error: error?.message || String(error),
        }, domain || currentDomain);
      }
    }

    if (!needsSelectorRepair) continue;

    try {
      await applyRecoveredProfile({ profileId, envelope: active });
      repaired.push(profileId);
    } catch (error) {
      failed.push(profileId);
      addDebugLog('profile_backend_repair_failed', {
        profileId,
        code: error?.code || 'profile_selector_republish_failed',
        error: error?.message || String(error),
      }, domain || currentDomain);
    }
  }

  if (repaired.length) persist();
  return { repaired, failed };
}

function buildProfileHealthPayload(profileId, revision, report) {
  return PhantomRelayProfileSync.buildProfileHealthPayload(profileId, revision, report);
}

function profileEnvelopeSummary(envelope) {
  if (!envelope?.profile || !envelope?.lifecycle) return null;
  const health = envelope.health && typeof envelope.health === 'object' ? envelope.health : {};
  return {
    profileId: String(envelope.profile.profileId || ''),
    revision: Number(envelope.lifecycle.revision || 0),
    state: String(envelope.lifecycle.state || 'recorded'),
    lastVerifiedAt: envelope.lifecycle.lastVerifiedAt || null,
    reasonCodes: Array.isArray(health.reason_codes) ? health.reason_codes.slice() : [],
  };
}

function profileStatusForDomain(domain) {
  const host = String(domain || '').trim();
  const selectedId = String(selectors[host]?.profile?.profileId || '');
  let profileId = selectedId;
  let entry = profileId ? profileStore.profiles?.[profileId] : null;
  if (!entry) {
    for (const [candidateId, candidate] of Object.entries(profileStore.profiles || {})) {
      const activeDomain = candidate?.active?.profile?.domain;
      const pendingDomain = candidate?.pending?.profile?.domain;
      if (activeDomain === host || pendingDomain === host) {
        profileId = candidateId;
        entry = candidate;
        break;
      }
    }
  }
  const active = profileEnvelopeSummary(entry?.active);
  const pending = profileEnvelopeSummary(entry?.pending);
  const errorCode = String(entry?.lastError?.code || '');
  const current = pending || active;
  const legacyRecorded = !!(
    selectors[host]?.input && selectors[host]?.send && selectors[host]?.response && !current
  );
  const reasonCodes = [...new Set([
    ...(pending?.reasonCodes || active?.reasonCodes || []),
    ...(errorCode ? [errorCode] : []),
    ...(legacyRecorded ? ['profile_lifecycle_missing'] : [])
  ])];
  return {
    profileId: current?.profileId || profileId,
    revision: current?.revision || 0,
    // Never label selector-only legacy data as a structured lifecycle state.
    // An empty id plus "recorded" made the popup claim a profile existed when
    // only the pre-profile selector cache was present.
    state: current?.state || (legacyRecorded ? 'legacy_recorded' : 'unavailable'),
    lastVerifiedAt: active?.lastVerifiedAt || null,
    reasonCodes,
    activeState: active?.state || null,
    pendingState: pending?.state || null,
    active,
    pending,
  };
}

function profileRoutesForRecording() {
  const routes = {};
  for (const [profileId, entry] of Object.entries(profileStore.profiles || {})) {
    const envelope = entry?.active || entry?.pending;
    const profile = envelope?.profile;
    if (profile?.domain || profile?.origin) routes[profileId] = entry;
  }
  // A legacy selector cache may still contain the recorded profile even when
  // its lifecycle envelope was not migrated. Keep it usable for navigation;
  // execution still requires the structured profile contract elsewhere.
  for (const [domain, value] of Object.entries(selectors || {})) {
    if (value?.profile && !routes[value.profile.profileId || domain]) {
      routes[value.profile.profileId || domain] = { profile: value.profile };
    }
  }
  return routes;
}

function activeProfileRevisionForDomain(domain) {
  const status = profileStatusForDomain(domain);
  return Number(status.active?.revision || 0);
}

function setBadge(domain) {
  const st = domainState[domain]?.current || State.IDLE;
  chrome.action.setBadgeText({ text: STATE_LABELS[st] || '' });
  chrome.action.setBadgeBackgroundColor({ color: STATE_COLORS[st] || '#607D8B' });
}

function modelTargetDomain(model, fallback = '') {
  const name = String(model || '').trim().toLowerCase();
  // Route metadata only identifies the page domain. It never supplies selectors.
  const value = modelRoutes[name];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return routeDomain(value, fallback);
  return String(fallback || '').trim();
}

function routeDomain(value, fallback = '') {
  if (value && typeof value === 'object') {
    const declared = String(value.domain || '').trim();
    if (declared) return declared.toLowerCase();
    value = value.target_url || value.url || '';
  }
  const raw = String(value || '').trim();
  if (!raw) return String(fallback || '').trim().toLowerCase();
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase(); }
  catch (_) { return String(fallback || '').trim().toLowerCase(); }
}

function safeRouteTargetUrl(value, domain) {
  const expectedDomain = String(domain || '').trim().toLowerCase();
  try {
    const parsed = new URL(String(value || '').trim() || `https://${expectedDomain}/`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== expectedDomain) {
      return `https://${expectedDomain}/`;
    }
    // A recorded route may keep a non-root application path, but never carries
    // URL credentials or transient query/hash state into persistent bindings.
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return `https://${expectedDomain}/`;
  }
}

function modelNameForDomain(domain) {
  // 反向查找：哪个模型绑定到了这个域名
  const host = (domain || '').trim().toLowerCase();
  for (const [model, d] of Object.entries(modelRoutes)) {
    if (routeDomain(d) === host) return model;
  }
  // 无绑定 → 用域名本身当模型名（去掉 www.）
  return host.replace(/^www\./, '');
}

function isUsableExecutionTab(tab) {
  return !!(tab?.id && tab.url && !/^(chrome|edge|about|devtools):/.test(tab.url));
}

function isRecordedExecutionTab(tab) {
  if (!isUsableExecutionTab(tab)) return false;
  let hostname = '';
  try { hostname = new URL(tab.url).hostname.trim().toLowerCase(); } catch (_) {}
  if (!hostname) return false;
  const recorded = normalizeSelectors(selectors[hostname]);
  return hasExecutableRecordedProfile(recorded);
}

async function getExecutionTab(preferredDomain = '') {
  const allTabs = await chrome.tabs.query({ windowType: 'normal' });
  const usable = allTabs.filter(t => t?.id && t.url && !/^(chrome|edge|about|devtools):/i.test(t.url));
  const rank = (tab) => (
    (readyTabIds.has(Number(tab?.id)) ? 1000 : 0)
    + (tab?.active ? 100 : 0)
  );
  if (preferredDomain) {
    const exact = usable.filter(t => {
      try { return new URL(t.url).hostname === preferredDomain; } catch (_) { return false; }
    }).sort((a, b) => rank(b) - rank(a));
    if (exact.length) return exact[0];
  }
  if (usable.length) return usable.sort((a, b) => rank(b) - rank(a))[0];
  return null;
}

async function ensureContentScriptOnce(tab) {
  if (!isUsableExecutionTab(tab)) return false;
  const hostname = (() => { try { return new URL(tab.url).hostname; } catch (_) { return ''; } })();
  let preparationStage = 'start';
  const preparationStartedAt = Date.now();
  const preparationWatchdog = setTimeout(() => {
    addDebugLog('content_script_preparation_stalled', {
      tabId: Number(tab.id),
      stage: preparationStage,
      elapsedMs: Date.now() - preparationStartedAt,
      url: String(tab.url || ''),
    }, hostname);
  }, 10000);

  try {

    const pingContentRuntime = async () => {
      let timeoutId = null;
      try {
        return await Promise.race([
          chrome.tabs.sendMessage(tab.id, { action: 'ping' }),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('content_ping_timeout')), 750);
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    const prime = async () => {
      // Always apply the authoritative recorded template before readiness.
      // This covers pages whose initial content-script handshake races the API.
      try {
        preparationStage = 'selector_fetch';
        const response = await fetch(`${LOCAL_API}/browser/selectors?domain=${encodeURIComponent(hostname)}`);
        const payload = response.ok ? await response.json() : null;
        if (!payload?.selectors?.input) throw new Error('recorded_input_template_missing');
        let applied = false;
        for (let attempt = 0; attempt < 3 && !applied; attempt++) {
          try {
            preparationStage = 'selector_apply';
            const result = await chrome.tabs.sendMessage(tab.id, {
              action: 'set_selectors',
              selectors: payload.selectors,
              profile_revision: Number(payload.profile_revision || activeProfileRevisionForDomain(hostname)),
            });
            applied = !!result?.ok;
          } catch (_) {}
          if (!applied) await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!applied) throw new Error('recorded_selectors_apply_failed');
      } catch (_) {}
      preparationStage = 'readiness_wait';
      const ready = await chrome.tabs.sendMessage(tab.id, { action: 'wait_until_ready', timeout: 12000 });
      const ok = !!ready?.ready && !!ready?.input_ready && !!ready?.send_ready;
      return ok;
  };
  let ping = null;
  preparationStage = 'content_ping';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      ping = await pingContentRuntime();
      if (acceptLiveContentScriptPing(ping, hostname)) {
        const ready = await prime();
        if (ready) await publishReadyHeartbeat(tab);
        else await publishReadyHeartbeat(tab, false);
        return ready;
      }
    } catch (_) {}
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250));
  }
  const pingVersion = String(ping?.content_script_version || '');
  if (pingVersion && pingVersion !== CONTENT_SCRIPT_VERSION) addDebugLog('content_script_version_drift', { tabId: tab.id, expected: CONTENT_SCRIPT_VERSION, actual: pingVersion, action: 'awaiting_valid_handshake' }, hostname);
  try {
    preparationStage = 'marker_probe';
    const markerProbe = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
      func: (expectedVersion) => {
        const root = document.documentElement;
        const marker = root?.getAttribute('data-phantom-relay-content-instance') || '';
        const heartbeat = root?.getAttribute('data-phantom-relay-content-heartbeat') || '';
        const parts = heartbeat.split(':');
        const heartbeatAt = Number(parts[1] || 0);
        const active = marker === expectedVersion
          && parts[0] === expectedVersion
          && Number.isFinite(heartbeatAt)
          && Date.now() - heartbeatAt < 10000;
        const staleMarkerCleared = !!(marker || heartbeat);
        if (staleMarkerCleared) {
          root?.removeAttribute('data-phantom-relay-content-instance');
          root?.removeAttribute('data-phantom-relay-content-heartbeat');
          root?.removeAttribute('data-phantom-relay-content-owner');
        }
        return {
          marker,
          heartbeatAt,
          active,
          staleMarkerCleared,
        };
      },
      args: [CONTENT_SCRIPT_VERSION]
    });
    const state = markerProbe?.[0]?.result || null;
    if (state?.staleMarkerCleared) {
      addDebugLog('content_script_stale_marker_cleared', {
        tabId: tab.id,
        marker: state.marker || '',
        heartbeatAt: state.heartbeatAt || 0,
        wasActive: !!state.active,
      }, hostname);
    }
  } catch (_) {}
  try {
    preparationStage = 'dynamic_injection';
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, injectImmediately: true, files: ['backend_config.js', 'universal_bridge.js', 'profile_contract.js', 'profile_lifecycle.js', 'profile_health.js', 'selector_recovery.js', 'capture_lock.js', 'send_observation.js', 'response_observation.js', 'content.js'] });
    await new Promise(resolve => setTimeout(resolve, 250));
    preparationStage = 'post_injection_ping';
    const injectedPing = await pingContentRuntime();
    if (!acceptLiveContentScriptPing(injectedPing, hostname)) throw new Error(`content_script_handshake_invalid:${String(injectedPing?.content_script_version || 'missing')}`);
    const ready = await prime();
    if (ready) await publishReadyHeartbeat(tab);
    else await publishReadyHeartbeat(tab, false);
    addDebugLog(ready ? 'content_script_prepared' : 'content_script_not_ready', { tabId: tab.id, url: tab.url, version: injectedPing.content_script_version }, hostname);
    return ready;
  } catch (e) {
    addDebugLog('content_script_inject_failed', { tabId: tab.id, url: tab.url, error: e?.message || String(e) }, hostname || tab.url || 'unknown');
    return false;
  }
  } finally {
    clearTimeout(preparationWatchdog);
  }
}

async function ensureContentScript(tab) {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  const existing = contentScriptPreparationFlights.get(tabId);
  if (existing) return existing;
  const flight = ensureContentScriptOnce(tab).finally(() => {
    if (contentScriptPreparationFlights.get(tabId) === flight) {
      contentScriptPreparationFlights.delete(tabId);
    }
  });
  contentScriptPreparationFlights.set(tabId, flight);
  return flight;
}

async function rehydrateRecordedProfileForTab(tab) {
  await storageReady;
  if (!isUsableExecutionTab(tab)) return false;
  let hostname = '';
  try { hostname = new URL(tab.url).hostname.trim().toLowerCase(); } catch (_) {}
  if (!hostname) return false;
  if (isRecordedExecutionTab(tab)) return true;

  try {
    const response = await fetch(`${LOCAL_API}/browser/selectors?domain=${encodeURIComponent(hostname)}`);
    if (!response.ok) return false;
    let payload = await response.json().catch(() => null);
    if (!payload?.selectors?.profile) return false;
    const profileId = String(payload.selectors.profile.profileId || '').trim();
    if (profileId) {
      const profileResponse = await fetch(
        `${LOCAL_API}/browser/profiles/${encodeURIComponent(profileId)}`,
      );
      if (profileResponse.ok) {
        const profilePayload = await profileResponse.json().catch(() => null);
        const remoteProfile = profilePayload?.profile;
        if (remoteProfile) {
          const remoteDomain = String(remoteProfile.domain || '').trim().toLowerCase();
          if (remoteDomain !== hostname) throw new Error('profile_remote_domain_mismatch');
          payload = {
            ...payload,
            profile_revision: Number(profilePayload.revision || payload.profile_revision || 0),
            selectors: {
              ...payload.selectors,
              input: remoteProfile.input,
              send: remoteProfile.send,
              response: remoteProfile.response?.selector
                || remoteProfile.response?.containerSelector
                || payload.selectors.response,
              profile: remoteProfile,
            },
          };
        }
      }
    }
    const reconciled = await reconcileFetchedSelectors(hostname, payload);
    const recovered = isRecordedExecutionTab(tab);
    if (recovered) {
      addDebugLog('recorded_profile_backend_rehydrated', {
        profileId: String(reconciled?.selectors?.profile?.profileId || ''),
        revision: Number(reconciled?.profile_revision || 0),
        tabId: Number(tab.id),
      }, hostname);
    }
    return isRecordedExecutionTab(tab);
  } catch (error) {
    addDebugLog('recorded_profile_backend_rehydrate_failed', {
      error: error?.message || String(error),
      tabId: Number(tab.id),
    }, hostname);
    return false;
  }
}

async function prepareRecordedExecutionTab(tab) {
  if (!isUsableExecutionTab(tab) || tab.status !== 'complete') return false;
  if (!isRecordedExecutionTab(tab)) await rehydrateRecordedProfileForTab(tab);
  if (!isRecordedExecutionTab(tab)) return false;
  return ensureContentScript(tab);
}

async function ensureContentScriptsInOpenTabs(preferredDomain = '') {
  let preparedCount = 0;
  try {
    await storageReady;
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    for (const tab of tabs) {
      if (tab.status !== 'complete') continue;
      if (preferredDomain) {
        let hostname = '';
        try { hostname = new URL(tab.url || '').hostname; } catch (_) {}
        if (hostname !== preferredDomain) continue;
      }
      const prepared = isRecordedExecutionTab(tab)
        ? await ensureContentScript(tab)
        : await prepareRecordedExecutionTab(tab);
      if (prepared) preparedCount += 1;
    }
  } catch (_) {}
  return preparedCount;
}

async function probeRecordedExecutionContext(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'get_profile_health' });
    const checks = response?.profile_health?.checks || {};
    return {
      responseReady: checks.response === 'pass' && checks.identity === 'pass',
    };
  } catch (_) {
    return { responseReady: false };
  }
}

function executionTabScore(tab, context = {}) {
  let score = 0;
  // A verified response/identity proves that this page owns a usable
  // conversation context. It must outrank an empty same-domain landing page.
  if (context.responseReady) score += 1000;
  if (tab?.active) score += 100;
  try {
    const parsed = new URL(tab?.url || '');
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) score += 10;
  } catch (_) {}
  return score;
}

function sortExecutionTabs(tabs, contexts) {
  return tabs.sort((left, right) => {
    const scoreDelta = executionTabScore(right, contexts.get(Number(right.id)))
      - executionTabScore(left, contexts.get(Number(left.id)));
    if (scoreDelta) return scoreDelta;
    return Number(right.id || 0) - Number(left.id || 0);
  });
}

let browserPollInFlight = false;
// an MV3 content-script message loses optional fields during reload.
const activeClaims = new Map();
const activeNetworkCaptures = new Map();
const activeNetworkCalibrations = new Map();
const CLAIM_STORAGE_KEY = 'phantomActiveClaims';
let activeClaimsPersistInFlight = Promise.resolve();

function claimSessionStorage() {
  return chrome.storage?.session || null;
}

function claimStorageCall(storage, method, args) {
  if (!storage || typeof storage[method] !== 'function') return Promise.resolve(null);
  const fn = storage[method];
  if (fn.length >= args.length + 1) {
    return new Promise((resolve, reject) => {
      try {
        fn.call(storage, ...args, value => {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) reject(new Error(runtimeError.message));
          else resolve(value);
        });
      } catch (error) { reject(error); }
    });
  }
  try { return Promise.resolve(fn.call(storage, ...args)); }
  catch (error) { return Promise.reject(error); }
}

async function restoreActiveClaims() {
  const storage = claimSessionStorage();
  if (!storage || !globalThis.PhantomRelayClaimRecovery) return;
  try {
    const data = await claimStorageCall(storage, 'get', [[CLAIM_STORAGE_KEY]]);
    const restored = globalThis.PhantomRelayClaimRecovery.deserializeClaims(data?.[CLAIM_STORAGE_KEY]);
    for (const [jobId, claim] of restored.entries()) activeClaims.set(jobId, claim);
    if (restored.size) addDebugLog('active_claims_restored', { count: restored.size });
  } catch (error) {
    addDebugLog('active_claims_restore_failed', { error: error?.message || String(error) });
  }
}

function persistActiveClaims() {
  const storage = claimSessionStorage();
  if (!storage || !globalThis.PhantomRelayClaimRecovery) return Promise.resolve();
  const serialized = globalThis.PhantomRelayClaimRecovery.serializeClaims(activeClaims);
  activeClaimsPersistInFlight = activeClaimsPersistInFlight
    .catch(() => {})
    .then(() => claimStorageCall(storage, 'set', [{ [CLAIM_STORAGE_KEY]: serialized }]))
    .catch(error => addDebugLog('active_claims_persist_failed', { error: error?.message || String(error) }));
  return activeClaimsPersistInFlight;
}

async function cancelClaimedPageCapture(claim, reason) {
  const tabId = Number(claim?.tab_id);
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'cancel_auto_capture',
      job_id: String(claim?.job_id || ''),
      reason: String(reason || 'claim_invalidated')
    });
    addDebugLog('active_claim_capture_cancelled', {
      jobId: String(claim?.job_id || ''),
      tabId,
      cancelled: !!response?.cancelled,
      ignored: !!response?.ignored,
      reason: String(reason || 'claim_invalidated')
    }, claim?.domain || currentDomain);
    return !!response?.cancelled;
  } catch (error) {
    // The page may have navigated or the content runtime may already be gone.
    // The backend claim is still invalid; leave polling/recovery to the next tick.
    addDebugLog('active_claim_capture_cancel_failed', {
      jobId: String(claim?.job_id || ''),
      tabId,
      reason: String(reason || 'claim_invalidated'),
      error: error?.message || String(error)
    }, claim?.domain || currentDomain);
    return false;
  }
}

async function reconcileActiveClaims() {
  if (!activeClaims.size) return;
  const claimsBeforeReconcile = new Map(activeClaims);
  const result = await globalThis.PhantomRelayClaimRecovery.reconcileClaims(activeClaims, async (jobId, claim) => {
      return globalThis.PhantomRelayClaimRecovery.lookupClaimToken(
        { ...claim, job_id: jobId },
        { baseUrl: LOCAL_API, clientId: browserClientId, fetchImpl: fetch }
      );
    });
  const removedClaims = Array.isArray(result.removedClaims) && result.removedClaims.length
    ? result.removedClaims
    : [...claimsBeforeReconcile.entries()]
      .filter(([jobId]) => !result.claims.has(jobId))
      .map(([jobId, claim]) => ({ job_id: jobId, claim }));
  for (const removed of removedClaims) {
    await cancelClaimedPageCapture(removed.claim, 'backend_claim_invalidated');
  }
  if (!result.changed) return;
  activeClaims.clear();
  for (const [jobId, claim] of result.claims.entries()) activeClaims.set(jobId, claim);
  await persistActiveClaims();
  addDebugLog('active_claims_reconciled', { remaining: activeClaims.size, removed: removedClaims.length });
}

const activeClaimsReady = restoreActiveClaims();

function parseNetworkSseBody(body, contract) {
  return globalThis.PhantomRelayNetworkCapture.parseSseBody(body, contract);
}

function networkCaptureAttached(tabId) {
  return activeNetworkCaptures.has(Number(tabId));
}

async function stopNetworkCaptureForJob(jobId, tabId, reason = 'job_finished') {
  const numericTabId = Number(tabId);
  const state = activeNetworkCaptures.get(numericTabId);
  if (!state || String(state.jobId) !== String(jobId)) return false;
  activeNetworkCaptures.delete(numericTabId);
  if (state.settleTimer) clearTimeout(state.settleTimer);
  addDebugLog('network_capture_stopped', {
    tabId: numericTabId,
    jobId: String(jobId || ''),
    reason: String(reason || 'job_finished')
  }, state.domain);
  await chrome.debugger.detach(state.target).catch(() => {});
  return true;
}

async function attachNetworkDebugger(target, tabId, job) {
  try {
    await chrome.debugger.attach(target, '1.3');
    return true;
  } catch (firstError) {
    const message = String(firstError?.message || firstError);
    if (!/already attached/i.test(message)) throw firstError;
    // A timed-out stream may leave Chrome's debugger attachment alive after
    // MV3 state was discarded. Detach the stale owner, then attach once.
    addDebugLog('network_capture_stale_debugger', { tabId, jobId: job?.id, error: message }, job?.domain);
    try { await chrome.debugger.detach(target); } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
    await chrome.debugger.attach(target, '1.3');
    return true;
  }
}

async function startNetworkCapture(tabId, job) {
  const modelKey = String(job?.model || '').toLowerCase();
  const route = modelRoutes[modelKey] || Object.values(modelRoutes).find(value => value && typeof value === 'object' && String(value.domain || '').toLowerCase() === String(job?.domain || '').toLowerCase());
  const domain = String(job?.domain || '').toLowerCase();
  let recorded = selectorsForDomain(domain).value;
  // The backend owns the recorded profile. Always refresh it before attaching
  // the debugger: an MV3 worker can restart with a stale local snapshot, and
  // the page/content worker may already have accepted a newer calibration.
  // This keeps capture and execution on the same provider-neutral contract.
  try {
    const response = await fetch(`${LOCAL_API}/browser/selectors?domain=${encodeURIComponent(domain)}`);
    const payload = response.ok ? await response.json() : null;
    if (payload?.selectors) {
      selectors[domain] = { ...(selectors[domain] || emptySelectors()), ...payload.selectors };
      recorded = selectorsForDomain(domain).value;
    }
  } catch (_) {}
  const contract = recorded?.profile?.capture;
  if (!contract || !['network', 'hybrid'].includes(String(contract.mode || '').toLowerCase())) {
    addDebugLog('network_capture_skipped', { tabId, jobId: job?.id, model: modelKey, domain: job?.domain, routeFound: !!route, reason: 'profile_capture_contract_missing' }, job?.domain);
    return false;
  }
  const target = { tabId };
  // Drain a stale capture from a previous job on the same tab. The previous
  // // consumeNetworkStreamChunk() detaches the debugger optimistically via
  // // .catch(() => {}), which can leave the old capture state in the Map and
  // // the CDP buffer full of the previous SSE stream. Re-attaching reuses that
  // // buffer, causing the new job to return the old assistant response.
  // Drain and disable before re-enabling to get a clean Network domain.
  const stale = activeNetworkCaptures.get(Number(tabId));
  if (stale) {
    addDebugLog('network_capture_drain_stale', { tabId, oldJobId: stale.jobId }, job?.domain);
    try { await chrome.debugger.detach(target); } catch (_) {}
    activeNetworkCaptures.delete(Number(tabId));
  }
  try {
    await attachNetworkDebugger(target, tabId, job);
    await chrome.debugger.sendCommand(target, 'Network.disable').catch(() => {});
    await chrome.debugger.sendCommand(target, 'Network.enable', { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 });
    activeNetworkCaptures.set(Number(tabId), {
      target,
      jobId: job.id,
      claimToken: job.claim_token,
      conversationId: job.conversation_id,
      domain: job.domain,
      contract,
      startedAt: Date.now(),
      sendBoundaryAt: Date.now(),
      requestMetadata: new Map(),
      requests: new Map(),
      candidates: new Map(),
      settleTimer: null,
      responseEvidenceSent: false,
      resultSubmitted: false,
    });
    addDebugLog('network_capture_started', { tabId, jobId: job.id }, job.domain);
    return { started: true, mode: String(contract.mode || '').toLowerCase() };
  } catch (error) {
    addDebugLog('network_capture_start_failed', { tabId, jobId: job?.id, error: error?.message || String(error) }, job?.domain);
    return false;
  }
}

if (NETWORK_CAPTURE_RUNTIME_ENABLED) {
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = Number(source?.tabId);
    if (activeNetworkCaptures.delete(tabId)) {
      addDebugLog('network_capture_detached', { tabId }, '');
    }
  });
}

async function startNetworkStream(source, state, requestId) {
  const request = state.requests.get(requestId);
  if (!request || request.streamStarted) return;
  request.streamStarted = true;
  try {
    const result = await chrome.debugger.sendCommand(source, 'Network.streamResourceContent', { requestId });
    const initial = result?.bufferedData || '';
    if (initial) await consumeNetworkStreamChunk(source, state, requestId, initial, !!result?.base64Encoded);
  } catch (error) {
    request.streamStarted = false;
    addDebugLog('network_stream_start_retry', { tabId: source.tabId, jobId: state.jobId, requestId, error: error?.message || String(error) }, state.domain);
  }
}

function scheduleNetworkCandidateSettlement(source, state) {
  if (!state || state.resultSubmitted || state.settleTimer) return;
  // Give sibling response streams a short quiet period. A page can open more
  // than one matching stream for one send; the first terminal stream is not
  // necessarily the assistant stream belonging to this job.
  state.settleTimer = setTimeout(() => {
    state.settleTimer = null;
    const candidates = [...state.candidates.values()];
    const selected = globalThis.PhantomRelayNetworkCandidate?.chooseCandidate(
      candidates,
      state.sendBoundaryAt || state.startedAt
    );
    if (!selected || state.resultSubmitted) {
      const finishedCandidates = candidates.filter(candidate => candidate.finished && candidate.text);
      if (finishedCandidates.length > 1 && new Set(finishedCandidates.map(candidate => candidate.text)).size > 1) {
        addDebugLog('network_stream_candidate_ambiguous', {
          tabId: source.tabId,
          jobId: state.jobId,
          candidateCount: finishedCandidates.length
        }, state.domain);
        activeNetworkCaptures.delete(Number(source.tabId));
        chrome.debugger.detach(source).catch(() => {});
        if (String(state.contract?.mode || '').toLowerCase() === 'network') {
          fetch(String(LOCAL_API) + '/browser/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: browserClientId,
              job_id: state.jobId,
              claim_token: state.claimToken,
              success: false,
              error: 'network_candidate_ambiguous',
              conversation_id: state.conversationId,
              tab_id: source.tabId,
              domain: state.domain
            })
          }).catch(() => {});
        }
      }
      return;
    }
    state.resultSubmitted = true;
    fetch(`${LOCAL_API}/browser/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: browserClientId,
        job_id: state.jobId,
        claim_token: state.claimToken,
        success: true,
        user: '',
        assistant: selected.text,
        conversation_id: state.conversationId,
        tab_id: source.tabId,
        domain: state.domain,
        response_region: 'network-sse',
        completion_reason: selected.finished ? 'explicit_done' : 'loading_finished'
      })
    }).then(async response => {
      if (!response.ok) throw new Error(`network_result_http_${response.status}`);
      addDebugLog('network_stream_candidate_selected', {
        tabId: source.tabId,
        jobId: state.jobId,
        requestId: selected.requestId,
        requestAt: selected.requestAt,
        textLength: selected.text.length,
        candidateCount: candidates.length
      }, state.domain);
      activeNetworkCaptures.delete(Number(source.tabId));
      if (String(state.contract?.mode || '').toLowerCase() === 'hybrid') {
        await cancelClaimedPageCapture({
          job_id: state.jobId,
          claim_token: state.claimToken,
          conversation_id: state.conversationId,
          tab_id: source.tabId,
          domain: state.domain
        }, 'network_result_selected');
      }
      activeClaims.delete(state.jobId);
      await persistActiveClaims();
      chrome.debugger.detach(source).catch(() => {});
    }).catch(error => {
      state.resultSubmitted = false;
      addDebugLog('network_stream_result_retry', {
        tabId: source.tabId,
        jobId: state.jobId,
        error: error?.message || String(error)
      }, state.domain);
    });
  }, 1500);
}

function decodeNetworkChunk(data, base64Encoded) {
  return globalThis.PhantomRelayNetworkCapture.decodeTransportChunk(data, !!base64Encoded);
}

async function consumeNetworkStreamChunk(source, state, requestId, data, base64Encoded = false, finished = false) {
  const request = state.requests.get(requestId);
  if (!request) return;
  // CDP can deliver dataReceived, loadingFinished, and the initial stream
  // buffer concurrently. Serialize them per request so a terminal body read
  // cannot race a partial parser update and hide the completed candidate.
  request.consumeQueue = (request.consumeQueue || Promise.resolve()).then(
    () => consumeNetworkStreamChunkNow(source, state, requestId, data, base64Encoded, finished),
  );
  return request.consumeQueue;
}

async function consumeNetworkStreamChunkNow(source, state, requestId, data, base64Encoded = false, finished = false) {
  const request = state.requests.get(requestId);
  if (!request) return;
  request.buffer = (request.buffer || '') + decodeNetworkChunk(data, base64Encoded);
  request.parserState = request.parserState || { text: '', finished: false, processedRecords: 0 };
  let parsed = parseNetworkSseBody(request.buffer, state.contract, request.parserState, finished);
  // Some browsers expose a compressed stream through streamResourceContent
  // without usable incremental text. At the terminal boundary, ask CDP for
  // the decoded response body and parse it once. This keeps network-only
  // capture reliable without treating a non-empty opaque chunk as assistant
  // text or adding a site-specific decompressor.
  if (finished && !parsed.text) {
    try {
      const finalBody = await chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId });
      const body = decodeNetworkChunk(finalBody?.body || '', !!finalBody?.base64Encoded);
      if (body) {
        request.buffer = body;
        request.parserState = { text: '', finished: false, processedRecords: 0 };
        parsed = parseNetworkSseBody(request.buffer, state.contract, request.parserState, true);
        addDebugLog('network_stream_final_body_fallback', { tabId: source.tabId, jobId: state.jobId, requestId, bodyLength: body.length, textLength: parsed.text.length }, state.domain);
      }
    } catch (error) {
      addDebugLog('network_stream_final_body_fallback_failed', { tabId: source.tabId, jobId: state.jobId, requestId, error: error?.message || String(error) }, state.domain);
    }
  }
  addDebugLog('network_stream_progress', { tabId: source.tabId, jobId: state.jobId, requestId, textLength: parsed.text.length, finished: parsed.finished, closed: finished }, state.domain);
  // Do not settle on a role-only or partial body. Wait for FINISHED, [DONE], or
  // loadingFinished. The stream is read incrementally, so long answers need not
  // wait for the response body to close before they become visible to the parser.
  if (!finished && !parsed.finished) return;
  if (!parsed.text || request.completed) return;
  request.completed = true;
  state.completedRequests = state.completedRequests || new Set();
  state.completedRequests.add(requestId);
  state.candidates.set(requestId, {
    requestId,
    requestAt: request.requestAt,
    responseAt: request.responseAt,
    method: request.method,
    text: parsed.text,
    finished: !!parsed.finished || !!finished,
  });
  addDebugLog('network_stream_candidate_ready', {
    tabId: source.tabId,
    jobId: state.jobId,
    requestId,
    requestAt: request.requestAt,
    textLength: parsed.text.length,
    finished: !!parsed.finished || !!finished
  }, state.domain);
  scheduleNetworkCandidateSettlement(source, state);
}

function scheduleNetworkBodyRead(source, state, requestId) {
  if (!state || state.completedRequests?.has(requestId)) return;
  const request = state.requests.get(requestId);
  if (!request) return;
  if (!request.streamStarted) startNetworkStream(source, state, requestId).catch(() => {});
}

function sendCalibrationProgress(tabId, message, details = {}) {
  chrome.runtime.sendMessage({ type: 'network_calibration_progress', tab_id: Number(tabId), message, details }).catch(() => {});
}

async function startNetworkCalibration(tabId, domain) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) throw new Error('network_calibration_tab_required');
  const tab = await chrome.tabs.get(numericTabId);
  if (!tab?.url || /^(?:chrome|about|edge|devtools):/i.test(tab.url)) throw new Error('network_calibration_page_invalid');
  await storageReady;
  const host = String(domain || new URL(tab.url).hostname).trim().toLowerCase();
  const local = normalizeSelectors(selectors[host]);
  if (!local.input || !local.send) {
    // Calibration is initiated from the popup, but the worker can restart
    // between popup state reads and the response event. Rehydrate the
    // authoritative input/send recording before accepting a network profile.
    try {
      const response = await fetch(`${LOCAL_API}/browser/selectors?domain=${encodeURIComponent(host)}`);
      const payload = response.ok ? await response.json() : null;
      if (payload?.selectors) {
        selectors[host] = { ...(selectors[host] || emptySelectors()), ...payload.selectors };
      }
    } catch (_) {}
  }
  if (!normalizeSelectors(selectors[host]).input || !normalizeSelectors(selectors[host]).send) {
    throw new Error('network_calibration_requires_input_and_send');
  }
  const existing = activeNetworkCalibrations.get(numericTabId);
  if (existing) return { ok: true, state: 'listening', tab_id: numericTabId };
  if (activeNetworkCaptures.has(numericTabId)) throw new Error('network_capture_in_flight');
  const target = { tabId: numericTabId };
  await attachNetworkDebugger(target, numericTabId, { id: 'calibration', domain });
  await chrome.debugger.sendCommand(target, 'Network.disable').catch(() => {});
  await chrome.debugger.sendCommand(target, 'Network.enable', { maxTotalBufferSize: 25 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 });
  activeNetworkCalibrations.set(numericTabId, {
    target,
    tabId: numericTabId,
    domain: host,
    origin: new URL(tab.url).origin,
    requests: new Map(),
    startedAt: Date.now(),
  });
  sendCalibrationProgress(numericTabId, '网络校准已开始，请在页面手动发送一次短消息');
  return { ok: true, state: 'listening', tab_id: numericTabId };
}

async function stopNetworkCalibration(tabId, reason = 'cancelled') {
  const numericTabId = Number(tabId);
  const state = activeNetworkCalibrations.get(numericTabId);
  if (!state) return { ok: true, state: 'idle', tab_id: numericTabId };
  activeNetworkCalibrations.delete(numericTabId);
  await chrome.debugger.detach(state.target).catch(() => {});
  sendCalibrationProgress(numericTabId, reason === 'cancelled' ? '网络校准已取消' : reason);
  return { ok: true, state: 'idle', tab_id: numericTabId };
}

async function consumeNetworkCalibrationResponse(source, state, requestId) {
  const request = state.requests.get(requestId);
  if (!request || request.attempted) return;
  request.attempted = true;
  let body = request.buffer || '';
  try {
    const result = await chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId });
    const finalBody = decodeNetworkChunk(result?.body || '', !!result?.base64Encoded);
    if (finalBody) body = finalBody;
  } catch (error) {
    addDebugLog('network_calibration_body_read_failed', { tabId: source.tabId, requestId, error: error?.message || String(error) }, state.domain);
    sendCalibrationProgress(source.tabId, '读取流式响应失败，等待其他候选响应', { error: error?.message || String(error) });
  }
  addDebugLog('network_calibration_candidate', { tabId: source.tabId, requestId, bodyLength: body.length }, state.domain);
  if (!body || body.length > 8 * 1024 * 1024) return;
  let profile;
  try {
    profile = globalThis.PhantomRelayNetworkCalibration.inferProfile({
      domain: state.domain,
      origin: state.origin,
      input: normalizeSelectors(selectors[state.domain]).input,
      send: normalizeSelectors(selectors[state.domain]).send,
      response: request.response,
      body,
    });
    addDebugLog('network_calibration_inferred', { tabId: source.tabId, requestId, profileId: profile.profileId, textRuleCount: profile.capture?.parser?.textRules?.length || 0, finishRuleCount: profile.capture?.parser?.finishRules?.length || 0 }, state.domain);
  } catch (error) {
    addDebugLog('network_calibration_infer_failed', { tabId: source.tabId, requestId, code: error?.code || 'unknown', error: error?.message || String(error) }, state.domain);
    sendCalibrationProgress(source.tabId, '候选流未包含可识别的文本事件，继续观察', { error: error?.code || error?.message || String(error) });
    request.buffer = '';
    return;
  }
  try {
    activeNetworkCalibrations.delete(Number(source.tabId));
    await chrome.debugger.detach(source).catch(() => {});
    sendCalibrationProgress(source.tabId, '已从真实流式响应推导网络合同');
    // This code already runs in the service worker. Sending the profile back
    // through runtime messaging is not a reliable self-dispatch path in MV3;
    // persist and sync it directly, then notify any open popup separately.
    const saved = await applyNetworkCalibrationProfile(state.domain, profile);
    addDebugLog('network_calibration_saved', { tabId: source.tabId, profileId: saved.profile?.profileId || profile.profileId, mode: profile.capture?.mode }, state.domain);
    chrome.runtime.sendMessage({ type: 'network_calibration_saved', tab_id: Number(source.tabId), domain: state.domain, profile: saved.profile }).catch(() => {});
  } catch (error) {
    addDebugLog('network_calibration_save_failed', { tabId: source.tabId, requestId, code: error?.code || 'unknown', error: error?.message || String(error) }, state.domain);
    sendCalibrationProgress(source.tabId, '网络校准保存失败', { error: error?.code || error?.message || String(error) });
  } finally {
    // The raw response body is deliberately released after inference.
    request.buffer = '';
  }
}

async function applyNetworkCalibrationProfile(domain, profile) {
  await storageReady;
  const host = String(domain || profile?.domain || '').trim().toLowerCase();
  if (!host || !profile) throw new Error('network_calibration_profile_missing');
  const recorded = normalizeSelectors(selectors[host]);
  if (!recorded.input || !recorded.send) throw new Error('network_calibration_requires_input_and_send');
  // Network calibration must not destroy a previously recorded DOM response
  // contract.  If that contract has a selector and a stable identity, keep it
  // beside the network contract and promote the profile to hybrid.  The
  // decision is made entirely from recorded profile data; no provider/domain
  // branch is involved.  If the old response lacks identity, keep network-only
  // and fail closed rather than inventing a DOM boundary.
  const recordedResponseProfile = recorded.profile?.response;
  const hasDomFallback = !!(
    recordedResponseProfile &&
    (recordedResponseProfile.selector || recordedResponseProfile.containerSelector) &&
    (Array.isArray(recordedResponseProfile.identity?.attributes) && recordedResponseProfile.identity.attributes.length ||
      String(recordedResponseProfile.identity?.path || '').trim())
  );
  const calibratedCapture = {
    ...(profile.capture || {}),
    mode: hasDomFallback ? 'hybrid' : String(profile.capture?.mode || 'network').toLowerCase(),
  };
  const candidate = {
    ...profile,
    domain: host,
    input: { ...(profile.input || {}), selector: recorded.input.selector || recorded.input },
    send: recorded.send,
    response: hasDomFallback ? recordedResponseProfile : profile.response,
    capture: calibratedCapture,
  };
  profileStore = await PhantomRelayProfileStore.stageProfile(profileStore, candidate);
  const profileId = candidate.profileId;
  const synced = await syncPendingProfile(profileId);
  profileStore = synced.store;
  const active = profileStore.profiles?.[profileId]?.active?.profile || candidate;
  selectors[host] = {
    ...selectors[host],
    input: recorded.input,
    send: recorded.send,
    response: hasDomFallback ? (recorded.response || recordedResponseProfile.selector || null) : (recorded.response || null),
    profile: active
  };
  domainState[host] = { current: State.ALL_DONE };
  currentDomain = host;
  persist();
  fetch(`${LOCAL_API}/browser/selectors`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: host, selectors: { ...selectors[host], profile: active } })
  }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'network_calibration_saved', domain: host, profile: active }).catch(() => {});
  return { ok: true, domain: host, profile: active };
}

if (NETWORK_CAPTURE_RUNTIME_ENABLED) {
chrome.debugger.onEvent.addListener((source, method, params) => {
  const state = activeNetworkCaptures.get(Number(source.tabId));
  const calibration = activeNetworkCalibrations.get(Number(source.tabId));
  if (!state && !calibration) return;
  if (!state && calibration) {
    if (method === 'Network.responseReceived') {
      const response = params?.response || {};
      const mimeType = String(response.mimeType || '').toLowerCase();
      if (mimeType.includes('text/event-stream')) {
        calibration.requests.set(params.requestId, { response: { url: String(response.url || ''), mimeType: response.mimeType || '' }, buffer: '' });
        sendCalibrationProgress(source.tabId, '已发现 SSE 流，等待响应结束以完成结构校准');
      }
    } else if (calibration.requests.has(params?.requestId)) {
      const request = calibration.requests.get(params.requestId);
      if (method === 'Network.dataReceived' && params?.data) request.buffer += decodeNetworkChunk(params.data, !!params.base64Encoded);
      if (method === 'Network.loadingFinished') consumeNetworkCalibrationResponse(source, calibration, params.requestId).catch(error => sendCalibrationProgress(source.tabId, '网络校准失败', { error: error?.message || String(error) }));
    }
    return;
  }
  if (method === 'Network.requestWillBeSent') {
    state.requestMetadata.set(params.requestId, {
      requestAt: Date.now(),
      method: String(params?.request?.method || '').toUpperCase(),
      url: String(params?.request?.url || '')
    });
    return;
  }
  if (method === 'Network.responseReceived') {
    const response = params?.response || {};
    if (globalThis.PhantomRelayNetworkCapture.matchNetworkResponse(response, state.contract)) {
      const metadata = state.requestMetadata.get(params.requestId) || {};
      const request = {
        url: String(response.url || ''),
        responseAt: Date.now(),
        requestAt: Number(metadata.requestAt || 0),
        method: metadata.method || '',
      };
      const boundaryAt = state.sendBoundaryAt || state.startedAt;
      if (!globalThis.PhantomRelayNetworkCandidate?.isAfterBoundary(request, boundaryAt)) {
        addDebugLog('network_stream_response_before_boundary', {
          tabId: source.tabId,
          jobId: state.jobId,
          requestId,
          requestAt: request.requestAt,
          boundaryAt
        }, state.domain);
        return;
      }
      state.requests.set(params.requestId, request);
      addDebugLog('network_stream_response', { tabId: source.tabId, jobId: state.jobId, status: response.status, mime: response.mimeType }, state.domain);
      if (!state.responseEvidenceSent) {
        state.responseEvidenceSent = true;
        chrome.tabs.sendMessage(source.tabId, {
          action: 'network_capture_response_observed',
          job_id: state.jobId,
          request_id: params.requestId,
        }, () => { void chrome.runtime.lastError; });
      }
      // Short SSE responses can finish before dataReceived/loadingFinished is
      // delivered. Start streaming at responseReceived while the request ID
      // is still valid; later events remain responsible for incremental data
      // and terminal fallback.
      startNetworkStream(source, state, params.requestId).catch(() => {});
    }
  }
  if ((method === 'Network.dataReceived' || method === 'Network.loadingFinished') && state.requests.has(params?.requestId)) {
    if (method === 'Network.dataReceived' && params?.data) {
      consumeNetworkStreamChunk(source, state, params.requestId, params.data, !!params.base64Encoded).catch(() => {});
    } else if (method === 'Network.loadingFinished') {
      consumeNetworkStreamChunk(source, state, params.requestId, '', false, true).catch(() => {});
    }
    scheduleNetworkBodyRead(source, state, params.requestId);
  }
});
}

async function browserBridgeTick() {
  if (browserPollInFlight) return;
  browserPollInFlight = true;
  const tickId = `tick-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const tickStartedAt = Date.now();
  let tickOutcome = 'in_progress';
  let tickStage = 'started';
  const tickTrace = (message, details = {}) => addDebugLog(`browser_bridge_${message}`, {
    tickId,
    elapsedMs: Date.now() - tickStartedAt,
    ...details,
  });
  const stallTimer = setTimeout(() => {
    addDebugLog('browser_scheduler_stalled', {
      tickId,
      stage: tickStage,
      elapsedMs: Date.now() - tickStartedAt,
      ownedTabCount: ownedTabIds.size,
      readyTabCount: readyTabIds.size,
    });
  }, 15000);
  let claimedJobId = null;
  let claimedDomain = '';
  let claimedClaimToken = '';
  let claimedConversationId = '';
  let claimedTabId = null;
  tickTrace('start', { ownedTabCount: ownedTabIds.size, readyTabCount: readyTabIds.size });
  try {
    tickStage = 'storage_wait';
    await storageReady;
    tickTrace('storage_ready');
    tickStage = 'claim_restore_wait';
    await activeClaimsReady;
    tickTrace('claims_ready', { activeClaimCount: activeClaims.size });
    tickStage = 'claim_reconciliation';
    await reconcileActiveClaims();
    tickTrace('claims_reconciled', { activeClaimCount: activeClaims.size });
    tickStage = 'client_liveness_registration';
    await registerBrowserClient();
    tickTrace('client_registered', { ownedTabCount: ownedTabIds.size, readyTabCount: readyTabIds.size });
    tickStage = 'pending_job_load';
    const pendingResp = await fetch(`${LOCAL_API}/browser/pending-domains`).catch(() => null);
    const pendingData = pendingResp ? await pendingResp.json().catch(() => ({})) : {};
    const pendingJobs = Array.isArray(pendingData?.jobs) ? pendingData.jobs : [];
    tickTrace('pending_loaded', { httpOk: !!pendingResp?.ok, queuedJobCount: pendingJobs.filter(job => job?.status === 'queued').length, claimedJobCount: pendingJobs.filter(job => job?.status === 'claimed').length });
    // A queued job is not permission to create a tab. The wake helper owns
    // process activation; this worker only consumes an existing ready tab.
    // That boundary prevents a failed ready handshake from creating a tab storm.
    const preferredJob = pendingJobs.find(job => job && job.status === 'queued') || null;
    if (!preferredJob) {
      bridgeWaitStates.clear();
      tickOutcome = 'no_queued_job';
      tickTrace('return', { reason: tickOutcome });
      return;
    }
    const preferredDomain = preferredJob?.domain || pendingData?.domains?.[0] || '';
    if (!preferredDomain) {
      tickOutcome = 'queued_job_domain_missing';
      tickTrace('return', { reason: tickOutcome, jobId: preferredJob.id || '' });
      return;
    }
    const waitState = bridgeWaitBlocked(preferredJob.id, preferredDomain);
    if (waitState) {
      tickOutcome = 'same_domain_tab_backoff';
      tickTrace('return', {
        reason: tickOutcome,
        domain: preferredDomain,
        retryInMs: Math.max(0, Number(waitState.nextAt) - Date.now()),
        attempts: waitState.attempts,
      });
      return;
    }
    tickTrace('job_selected', { jobId: preferredJob.id || '', domain: preferredDomain, conversationIdPresent: !!preferredJob.conversation_id });

    // Registration is the cheap liveness boundary. Page probing can wait on a
    // dynamic UI, so perform it only for the queued job's exact domain and
    // refresh the inventory afterward. A slow unrelated page must never make
    // the whole extension appear disconnected.
    tickStage = 'execution_tab_reconciliation';
    const recoveredTabCount = await ensureContentScriptsInOpenTabs(preferredDomain);
    tickTrace('execution_tabs_reconciled', { recoveredTabCount, domain: preferredDomain });
    tickStage = 'client_inventory_registration';
    await registerBrowserClient(true);
    tickTrace('client_inventory_refreshed', { ownedTabCount: ownedTabIds.size, readyTabCount: readyTabIds.size });
    // A tab returned by chrome.tabs.query() is not necessarily owned by this
    // extension profile. The registration response is the authoritative
    // ownership boundary when multiple Phantom Relay clients share a domain.
    if (!ownedTabIds.size) {
      tickOutcome = 'no_owned_tabs';
      tickTrace('return', { reason: tickOutcome });
      return;
    }

    const activeClaimedTabIds = new Set([
      ...(Array.isArray(pendingData?.claimed_tab_ids) ? pendingData.claimed_tab_ids : []),
      ...pendingJobs.filter(job => job?.status === 'claimed' && job.tab_id != null).map(job => Number(job.tab_id)),
      ...[...activeClaims.values()].filter(claim => claim?.tab_id != null).map(claim => Number(claim.tab_id))
    ].map(Number));
    const activeClaimedDomains = new Set([...activeClaims.values()].map(claim => String(claim?.domain || '').toLowerCase()).filter(Boolean));
    // Resolve the execution tab BEFORE polling/claiming. Never let the currently
    // active wrong-model tab claim a job for another domain.
    // Always prefer an explicitly reserved tab for this job. Falling back to
    // the first same-domain tab can reuse a tab that already has an in-flight
    // capture or stale page state, which silently leaves the new job at the
    // user-message stage.
    tickStage = 'execution_tab_selection';
    const allTabs = await chrome.tabs.query({ windowType: 'normal' });
    tickTrace('tabs_loaded', { tabCount: allTabs.length, usableOwnedTabCount: allTabs.filter(candidate => {
      try { return ownedTabIds.has(Number(candidate.id)) && isUsableExecutionTab(candidate) && new URL(candidate.url).hostname === preferredDomain; }
      catch (_) { return false; }
    }).length });
    let tab = null;
    if (preferredJob?.reservation_tab_id) {
      tab = ownedTabIds.has(Number(preferredJob.reservation_tab_id))
        ? allTabs.find(t => t.id === Number(preferredJob.reservation_tab_id)) || null
        : null;
      if (tab && !isUsableExecutionTab(tab)) tab = null;
    }
    if (!tab && preferredDomain) {
      const domainTabs = [];
      const domainTabContexts = new Map();
      for (const candidate of allTabs.filter(t => {
        try { return ownedTabIds.has(Number(t.id)) && isUsableExecutionTab(t) && !activeClaimedTabIds.has(Number(t.id)) && new URL(t.url).hostname === preferredDomain; }
        catch (_) { return false; }
      })) {
        if (activeClaimedDomains.has(preferredDomain) || activeClaimedTabIds.has(Number(candidate.id))) continue;
        tickTrace('ensure_content_start', { tabId: candidate.id, domain: preferredDomain });
        if (await ensureContentScript(candidate)) {
          domainTabContexts.set(Number(candidate.id), await probeRecordedExecutionContext(candidate));
          domainTabs.push(candidate);
        }
        tickTrace('ensure_content_done', { tabId: candidate.id, domain: preferredDomain, ready: domainTabs.some(item => Number(item.id) === Number(candidate.id)) });
      }
      // Reuse a same-domain page with a verified response context first. An
      // empty landing page can still serve a first request, but it must not
      // steal work from an existing recorded conversation page.
      // A plain new tab is not a real new conversation, and opening another
      // page unnecessarily can land on a stale runtime. Only create a new tab
      // when there is no healthy same-domain execution tab at all.
      sortExecutionTabs(domainTabs, domainTabContexts);
      tab = domainTabs[0] || null;
      if (tab) {
        tickTrace('execution_tab_selected', {
          tabId: tab.id,
          active: !!tab.active,
          responseReady: !!domainTabContexts.get(Number(tab.id))?.responseReady,
        });
      }
    }
    // A same-domain page that is present but not executable is a recorded
    // profile/configuration problem, not permission to create another tab.
    // Creating one on every bridge tick produces a tab storm and can race the
    // backend wake path into visible about:blank/domain switching.  Keep the
    // existing page and fail closed until the user re-records it.
    if (!tab && preferredDomain) {
      const sameDomainTabs = allTabs.filter(candidate => {
        try {
          return ownedTabIds.has(Number(candidate.id))
            && isUsableExecutionTab(candidate)
            && new URL(candidate.url).hostname === preferredDomain;
        } catch (_) {
          return false;
        }
      });
      if (sameDomainTabs.length) {
        tickOutcome = 'same_domain_tab_not_ready';
        addDebugLog('browser_bridge_waiting_for_existing_domain_tab', {
          jobId: preferredJob.id || '',
          domain: preferredDomain,
          tabIds: sameDomainTabs.map(candidate => Number(candidate.id)),
        }, preferredDomain);
        const backoff = bridgeWaitBackoff(preferredJob.id, preferredDomain);
        tickTrace('backoff', { domain: preferredDomain, ...backoff });
        tickTrace('return', { reason: tickOutcome, domain: preferredDomain });
        return;
      }
    }
    // Automatic execution has one activation owner: the request-path wake
    // coordinator. The worker may reuse a page that already exists, but it
    // must never create or navigate a provider tab here. Otherwise a cold
    // request can race the backend's `open -g target_url` and expose an
    // about:blank intermediate tab or duplicate the provider page. If the
    // wake owner has not produced a usable page yet, wait for the next
    // registration/ready event and fail closed.
    if (!tab) {
      tickOutcome = 'no_execution_tab';
      tickTrace('return', { reason: tickOutcome, domain: preferredDomain });
      return;
    }
    // A tab URL alone is not readiness. Re-inject/ping the content bridge
    // before claiming so reloads and old heartbeat records self-heal.
    tickTrace('ensure_selected_content_start', { tabId: tab.id, domain: preferredDomain });
    tickStage = 'selected_tab_readiness';
    const selectedTabReady = await ensureContentScript(tab);
    tickTrace('ensure_selected_content_done', { tabId: tab.id, domain: preferredDomain, ready: selectedTabReady });
    if (!selectedTabReady) {
      const backoff = bridgeWaitBackoff(preferredJob.id, preferredDomain);
      tickOutcome = 'selected_content_not_ready';
      addDebugLog('browser_self_heal_waiting_for_content', { tabId: tab.id, url: tab.url }, preferredDomain);
      tickTrace('backoff', { domain: preferredDomain, ...backoff });
      tickTrace('return', { reason: tickOutcome, tabId: tab.id, domain: preferredDomain });
      return;
    }
    bridgeWaitStates.delete(bridgeWaitKey(preferredJob.id, preferredDomain));
    const url = tab.url || '';
    const domain = /^(about|chrome|edge|devtools):/i.test(url) ? '' : (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    claimedDomain = domain || 'unknown';
    // At this point tab is already the exact target-domain tab. Claim only with
    // that tab identity; a wrong active page can never consume this job.
    // The content script owns the authoritative ready heartbeat. Do not send a
    // background-poll heartbeat here: it can overwrite a real content-ready
    // record and make a healthy tab look unavailable.
    tickStage = 'job_claim';
    const response = await fetch(`${LOCAL_API}/browser/poll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: browserClientId, runtime_session_id: browserRuntimeSessionId, domain, tab_id: tab.id, conversation_id: String(preferredJob.conversation_id || '') })
    });
    const data = await response.json();
    tickTrace('poll_finished', { httpOk: response.ok, hasJob: !!data.job, tabId: tab.id, domain });
    if (!data.job) {
      tickOutcome = 'poll_no_job';
      tickTrace('return', { reason: tickOutcome, tabId: tab.id, domain });
      return;
    }
    claimedJobId = data.job.id;
    claimedClaimToken = data.job.claim_token || '';
    claimedConversationId = data.job.conversation_id || '';
    claimedTabId = tab.id;
    activeClaims.set(claimedJobId, {
      job_id: claimedJobId,
      claim_token: claimedClaimToken,
      conversation_id: claimedConversationId,
      tab_id: claimedTabId,
      domain: claimedDomain,
      claimed_at: Date.now(),
    });
    tickStage = 'claim_persistence';
    await persistActiveClaims();
    const requestedModel = data.job.model || '';
    // 优先使用后端已解析并验证过的 domain；扩展自身的 modelRoutes 只是加速缓存。
    const targetDomain = data.job.domain || modelTargetDomain(requestedModel, '') || '';
    if (!targetDomain) throw new Error(`model_route_missing:${requestedModel || '(empty)'}`);
    let executionTab = tab;
    if (data.job.target_url && data.job.new_tab) {
      const expectedUrl = data.job.target_url;
      const currentUrl = tab.url || '';
      let sameTarget = false;
      try { sameTarget = new URL(currentUrl).hostname === targetDomain; } catch (_) {}
      if (!sameTarget) {
        addDebugLog('browser_backend_target_mismatch', { currentUrl, targetUrl: expectedUrl }, domain);
        return;
      }
    }
    // A worker never navigates or creates a target tab. The wake/activation
    // layer and user-loaded extension must provide the exact execution page.
    if (!data.job.target_url && domain !== targetDomain) {
      addDebugLog('browser_model_route_unavailable', { model: requestedModel, from: domain, to: targetDomain }, domain);
      return;
    }
    if (!executionTab?.id || !executionTab.url || /^about:blank$/i.test(executionTab.url)) {
      throw new Error('execution_tab_invalid');
    }
    const executionDomain = new URL(executionTab.url).hostname;
    claimedDomain = executionDomain;
    // The content script loads the authoritative selector template during page
    // initialization. Do not overwrite it here with stale worker storage.
    const selectorsForPage = null;
    addDebugLog('browser_selector_template', {
      requestedDomain: domain,
      executionDomain,
      source: 'content-script-server-template'
    }, domain);
    const requestedTools = Array.isArray(data.job.request_meta?.tools) ? data.job.request_meta.tools : [];
    const toolsEnabled = requestedTools.length > 0;
    // Content script executes the user's recorded selector contract and posts
    // the signed result. CDP is inspection-only and never an execution path.
    addDebugLog('browser_capture_message_attempt', { tabId: executionTab.id, jobId: data.job.id }, domain);
    try {
      tickStage = 'capture_dispatch';
      await chrome.tabs.sendMessage(executionTab.id, {
        action: 'auto_capture',
        message: data.job.message,
        job_id: data.job.id,
        claim_token: data.job.claim_token,
        conversation_id: data.job.conversation_id,
        tab_id: executionTab.id,
        client_id: browserClientId,
        allow_tool_calls: toolsEnabled,
        capture_timeout_ms: Number(data.job.request_meta?.capture_timeout_ms) || 240000
      });
      // The content listener returns immediately after accepting auto_capture.
      // Awaiting this promise confirms delivery only; the long-running DOM
      // capture still settles independently through browser_result_relay.
    } catch (error) {
      addDebugLog('browser_capture_message_dispatch_failed', { tabId: executionTab.id, jobId: data.job.id, error: error?.message || String(error) }, domain);
      throw error;
    }
    addDebugLog('browser_capture_message_dispatched', { tabId: executionTab.id, jobId: data.job.id }, domain);
    tickOutcome = 'capture_dispatched';
    return;
  } catch (error) {
  tickOutcome = claimedJobId ? 'claimed_error' : 'tick_error';
  addDebugLog('browser_scheduler_failed', {
    tickId,
    stage: tickStage,
    elapsedMs: Date.now() - tickStartedAt,
    error: error?.message || String(error),
  }, claimedDomain || currentDomain);
  if (claimedJobId) {
    const errMsg = error?.message || String(error);
    // 录制数据本身损坏时自动清除旧选择器，下次 re-record 生效。
    if (/recorded_send_selector_invalid|recorded_input_selector_invalid/.test(errMsg)) {
      const domainKey = domainCandidates(claimedDomain).find(key => selectors[key]?.send || selectors[key]?.input);
      if (domainKey) {
        addDebugLog('browser_bridge_auto_purge', { domain: domainKey, reason: errMsg }, claimedDomain);
        delete selectors[domainKey];
        persist();
      }
    }
    fetch(`${LOCAL_API}/browser/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: browserClientId, job_id: claimedJobId, claim_token: claimedClaimToken, success: false, error: error.message, conversation_id: claimedConversationId, tab_id: claimedTabId, domain: claimedDomain })
    }).finally(() => {
      activeClaims.delete(claimedJobId);
      persistActiveClaims();
    }).catch(() => {});
  }
    // 服务未启动、页面不可注入时下一次 alarm 重试；不吞掉任务状态。
    console.debug('[Phantom Relay] browser bridge tick:', error.message);
  } finally {
    clearTimeout(stallTimer);
    tickTrace('finished', { outcome: tickOutcome, claimedJobId: claimedJobId || '', claimedTabId: claimedTabId || null, ownedTabCount: ownedTabIds.size });
    browserPollInFlight = false;
  }
}

let bridgeWakeTimer = null;
function scheduleBrowserBridgeTick(delay = 250) {
  if (bridgeWakeTimer) return;
  bridgeWakeTimer = setTimeout(() => {
    bridgeWakeTimer = null;
    browserBridgeTick();
  }, delay);
}

// ── MV3 SW wake-up: alarm fires → process immediately, no setTimeout ──
// setTimeout with delay 0 is unsafe after suspension — the SW can be evicted
// before the macrotask runs. Direct call ensures the tick completes.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BROWSER_POLL_ALARM) browserBridgeTick();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) markTabReady(tabId, false);
  if (changeInfo.status === 'complete' && isRecordedExecutionTab(tab)) {
    ensureContentScript(tab).then(() => scheduleBrowserBridgeTick(0));
  } else if (changeInfo.status === 'complete' && isUsableExecutionTab(tab)) {
    prepareRecordedExecutionTab(tab).then(prepared => {
      if (prepared) scheduleBrowserBridgeTick(0);
    });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => markTabReady(tabId, false));
chrome.tabs.onCreated.addListener((tab) => {
  if (isRecordedExecutionTab(tab)) scheduleBrowserBridgeTick(250);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => {
    if (isRecordedExecutionTab(tab)) scheduleBrowserBridgeTick(250);
    else if (tab.status === 'complete' && isUsableExecutionTab(tab)) {
      prepareRecordedExecutionTab(tab).then(prepared => {
        if (prepared) scheduleBrowserBridgeTick(0);
      });
    }
  }).catch(() => {});
});

function ensureBrowserBridgeAlarm() {
  chrome.alarms.create(BROWSER_POLL_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(ensureBrowserBridgeAlarm);
chrome.runtime.onStartup.addListener(ensureBrowserBridgeAlarm);
loadRoutes();
// Unpacked extension reload: ensure alarm exists.
ensureBrowserBridgeAlarm();
// Enter the scheduler once. It reports extension liveness before probing only
// the queued job's domain, so startup cannot race two full-tab injection runs.
browserBridgeTick().catch(() => {});
function relayBrowserResult(msg, sender, sendResponse) {
  (async () => {
    await activeClaimsReady;
    const jobId = String(msg.payload?.job_id || '');
    const claim = activeClaims.get(jobId);
    const canRecoverClaim = !!(msg.payload?.job_id && msg.payload?.tab_id != null && msg.payload?.domain);
    if ((!claim || sender.tab?.id == null || Number(sender.tab.id) !== Number(claim.tab_id)) && !canRecoverClaim) {
      // Service-worker restart can evict activeClaims while the server lease is
      // still valid. Preserve the signed payload instead of dropping the result.
      const fallback = msg.payload || {};
      if (!fallback.claim_token || sender.tab?.id == null || Number(sender.tab.id) !== Number(fallback.tab_id)) {
        sendResponse({ ok: false, error: 'active_claim_not_found' });
        return;
      }
    }
    let sourceClaim = claim || msg.payload;
    if (!sourceClaim?.claim_token && msg.payload?.job_id && msg.payload?.tab_id != null && msg.payload?.domain) {
      let tokenResult;
      try {
        tokenResult = await globalThis.PhantomRelayClaimRecovery.lookupClaimToken(
          { ...(sourceClaim || {}), job_id: msg.payload.job_id },
          { baseUrl: LOCAL_API, clientId: browserClientId, fetchImpl: fetch }
        );
      } catch (error) {
        sendResponse({ ok: false, error: 'claim_token_lookup_failed', detail: error?.message || String(error) });
        return;
      }
      if (!tokenResult?.ok || !tokenResult.claim_token) {
        if (globalThis.PhantomRelayClaimRecovery.shouldRemoveAfterTokenLookup(tokenResult?.status)) {
          activeClaims.delete(jobId);
          await persistActiveClaims();
        }
        sendResponse({ ok: false, status: tokenResult?.status || 503, error: 'claim_token_unavailable' });
        return;
      }
      sourceClaim = { ...(sourceClaim || {}), claim_token: tokenResult.claim_token };
    }
    const payload = { ...(msg.payload || {}), job_id: jobId,
      client_id: browserClientId,
      claim_token: sourceClaim.claim_token, conversation_id: sourceClaim.conversation_id,
      tab_id: sourceClaim.tab_id, domain: sourceClaim.domain };
    const response = await fetch(`${LOCAL_API}/browser/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text().catch(() => '');
    const backendRejectedClaim = !response.ok &&
      globalThis.PhantomRelayClaimRecovery.shouldRemoveAfterBackendResponse(response.status);
    if (response.ok || backendRejectedClaim) {
      await stopNetworkCaptureForJob(jobId, sourceClaim.tab_id, response.ok ? 'dom_result_submitted' : 'backend_claim_rejected');
      activeClaims.delete(jobId);
      await persistActiveClaims();
    }
    sendResponse({ ok: response.ok, status: response.status, body: text.slice(0, 500) });
  })().catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
}

function scheduleCaptureObservationTick(msg, sendResponse) {
  const delayMs = Math.max(50, Math.min(1000, Number(msg?.delay_ms) || 250));
  setTimeout(() => sendResponse({ ok: true, delay_ms: delayMs }), delayMs);
}

// Keep all content/runtime messages behind one synchronous MV3 listener. A
// second listener for browser_result_relay can close the shared response
// channel even when the relay listener itself returns true.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'browser_result_relay') {
    return relayBrowserResult(msg, sender, sendResponse);
  }
  (async () => {
    const tabId = sender.tab?.id;

    if (msg?.type === 'capture_observation_tick') {
      scheduleCaptureObservationTick(msg, sendResponse);
      return;
    }

    await activeClaimsReady;

    if (msg?.type === 'network_calibration_result') {
      sendResponse({ ok: false, error: 'network_capture_disabled' });
      return;
    }

  if (msg.type === 'get_server_selectors') {
    const domain = String(msg.domain || '').trim().toLowerCase();
    (async () => {
      await storageReady;
      const response = await fetch(`${LOCAL_API}/browser/selectors?domain=${encodeURIComponent(domain)}`);
      const value = response.ok ? await response.json() : null;
      if (!value) {
        sendResponse({ selectors: null, profile_revision: activeProfileRevisionForDomain(domain) });
        return;
      }
      const reconciled = await reconcileFetchedSelectors(domain, value);
      sendResponse({
        ...reconciled,
        profile_revision: Math.max(
          Number(reconciled.profile_revision || 0),
          activeProfileRevisionForDomain(domain),
        ),
      });
    })().catch(() => sendResponse({ selectors: null, profile_revision: 0 }));
    return true;
  }


  if (msg.type === 'capture_heartbeat') {
    // Immediate lease renewal during autoCapture — no wait_until_ready,
    // no activeClaims dependency. Keeps the client alive even when the SW
    // restarts and loses the in-memory claim map.
    const domain = msg.domain || (sender.tab?.url ? new URL(sender.tab.url).hostname : '');
    const tabId = msg.tab_id || sender.tab?.id;
    const conversationId = msg.conversation_id || '';
    if (tabId && domain) {
      (async () => {
        try {
          const response = await fetch(`${LOCAL_API}/browser/heartbeat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: browserClientId,
              runtime_session_id: browserRuntimeSessionId,
              domain,
              tab_id: tabId,
              conversation_id: conversationId,
              job_id: msg.job_id || '',
              claim_token: msg.claim_token || '',
              ready: true,
              input_ready: true,
              send_ready: true,
              source: 'content-ready',
              capabilities: { can_execute: true, can_observe: true }
            })
          });
          const payload = await response.json().catch(() => ({}));
          if (payload?.claim_valid === false) {
            addDebugLog('capture_heartbeat_claim_invalid', {
              tabId,
              jobId: msg.job_id || '',
              status: response.status,
            }, domain);
          }
          sendResponse({ ok: response.ok, claim_valid: payload?.claim_valid });
        } catch (error) {
          sendResponse({ ok: false, claim_valid: null, error: error?.message || String(error) });
        }
      })();
    } else {
      sendResponse({ ok: false, claim_valid: null, error: 'capture_heartbeat_identity_missing' });
    }
    return true;
  }

  if (msg.type === 'network_capture_boundary') {
    const boundaryTabId = Number(msg.tab_id || sender.tab?.id);
    const state = activeNetworkCaptures.get(boundaryTabId);
    if (state && (!msg.job_id || String(msg.job_id) === String(state.jobId))) {
      state.sendBoundaryAt = Date.now();
      state.requests.clear();
      state.candidates.clear();
      if (state.settleTimer) {
        clearTimeout(state.settleTimer);
        state.settleTimer = null;
      }
      addDebugLog('network_capture_boundary', {
        tabId: boundaryTabId,
        jobId: state.jobId,
        boundaryAt: state.sendBoundaryAt
      }, state.domain);
      sendResponse({ ok: true, boundary_at: state.sendBoundaryAt });
      return true;
    }
    sendResponse({ ok: false, error: 'network_capture_not_found' });
    return true;
  }

  if (msg.type === 'page_ready') {
  const pageDomain = sender.tab?.url ? new URL(sender.tab.url).hostname : '';
  const readyTabId = sender.tab?.id;
  const pageSessionId = String(msg.page_session_id || '');
  clearBridgeWaitForDomain(pageDomain);
  const existingClaim = [...activeClaims.values()].find(claim => Number(claim.tab_id) === Number(readyTabId));
  if (existingClaim) {
    // Keep the content-ready lease alive while a long-running capture owns the
    // tab. Previously this branch returned without refreshing BROWSER_CLIENTS;
    // after CLIENT_TTL the server re-queued the live job and rejected the final
    // result as job_not_claimed. A claimed tab remains executable, so renew the
    // same signed conversation lease instead of skipping the heartbeat.
    const leaseHeartbeat = {
      client_id: browserClientId,
      runtime_session_id: browserRuntimeSessionId,
      domain: pageDomain,
      tab_id: readyTabId,
      url: sender.tab?.url || '',
      source: 'content-ready',
      transport: 'chrome-extension',
      page_session_id: pageSessionId,
      conversation_id: existingClaim.conversation_id || '',
      ready: true,
      input_ready: true,
      send_ready: true,
      capabilities: { can_observe: true, can_execute: true, can_stream: true, can_create_tab: false, can_close_tab: false, can_snapshot: true },
      background_version: globalThis.__phantomRelayBackgroundVersion || ''
    };
    fetch(`${LOCAL_API}/browser/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(leaseHeartbeat)
    }).catch(() => {});
    markTabReady(readyTabId, true);
    sendResponse({ ok: true, ready: { ready: true, input_ready: true, send_ready: true }, renewed: 'active_claim' });
    return true;
  }
    const validatedRuntime = pageRuntime.get(readyTabId);
    const validatedRecently = !!validatedRuntime
      && validatedRuntime.pageSessionId === pageSessionId
      && Date.now() - Number(validatedRuntime.lastValidatedAt || 0) < 30000;
    if (validatedRecently) {
      (async () => {
        const heartbeatOk = await publishReadyHeartbeat(sender.tab);
        if (heartbeatOk) browserBridgeTick().catch(() => {});
        sendResponse({
          ok: heartbeatOk,
          ready: { ready: heartbeatOk, input_ready: heartbeatOk, send_ready: heartbeatOk },
          reused: 'validated_runtime',
        });
      })();
      return true;
    }
    if (readyTabId != null && pageSessionId) {
      pageRuntime.set(readyTabId, {
        pageSessionId,
        frameId: sender.frameId ?? 0,
        domain: pageDomain,
        lastSeq: 0,
        lastValidatedAt: 0,
      });
    }
    (async () => {
      try {
        await storageReady;
        // Fetch the authoritative template in the worker and apply it before
        // readiness probing. This avoids page-context localhost/CORS failures.
        try {
          const selectorResponse = await fetch(`${LOCAL_API}/browser/selectors?domain=${encodeURIComponent(pageDomain)}`);
          const selectorPayload = selectorResponse.ok
            ? await reconcileFetchedSelectors(pageDomain, await selectorResponse.json())
            : null;
          if (!selectorPayload?.selectors?.input) throw new Error('recorded_input_template_missing');
          let applied = false;
          for (let attempt = 0; attempt < 3 && !applied; attempt++) {
            try {
              const result = await chrome.tabs.sendMessage(readyTabId, {
                action: 'set_selectors',
                selectors: selectorPayload.selectors,
                profile_revision: Number(selectorPayload.profile_revision || activeProfileRevisionForDomain(pageDomain)),
              });
              applied = !!result?.ok;
            } catch (_) {}
            if (!applied) await new Promise(resolve => setTimeout(resolve, 250));
          }
          if (!applied) throw new Error('recorded_selectors_apply_failed');
        } catch (_) {}
        const ready = await chrome.tabs.sendMessage(readyTabId, { action: 'wait_until_ready', timeout: 30000 });
        const heartbeatResp = await fetch(`${LOCAL_API}/browser/heartbeat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: browserClientId, runtime_session_id: browserRuntimeSessionId, domain: pageDomain, tab_id: readyTabId, url: sender.tab?.url || '', source: 'content-ready', transport: 'chrome-extension', page_session_id: pageSessionId, conversation_id: ready?.conversation_id || '', ready: !!ready?.ready, input_ready: !!ready?.input_ready, send_ready: !!ready?.send_ready, capabilities: { can_observe: !!ready?.ready, can_execute: !!ready?.input_ready && !!ready?.send_ready, can_stream: true, can_create_tab: false, can_close_tab: false, can_snapshot: !!ready?.ready }, background_version: globalThis.__phantomRelayBackgroundVersion || '' })
        }).catch(() => null);
        addDebugLog('page_ready_heartbeat_result', {
          tabId: readyTabId,
          ready: !!ready?.ready,
          inputReady: !!ready?.input_ready,
          sendReady: !!ready?.send_ready,
          responseOk: !!heartbeatResp?.ok,
          responseStatus: Number(heartbeatResp?.status || 0),
        }, pageDomain);
        if (ready?.ready && heartbeatResp?.ok) {
          markTabReady(readyTabId, true);
          const runtime = pageRuntime.get(readyTabId);
          if (runtime?.pageSessionId === pageSessionId) runtime.lastValidatedAt = Date.now();
          // Claim immediately while this MV3 worker is still alive. The normal
          // alarm/interval and tab lifecycle events provide bounded recovery;
          // do not fan one page-ready heartbeat into three extra timers.
          browserBridgeTick().catch(() => {});
        }
        sendResponse({ ok: true, ready });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'page_trace') {
    const runtime = pageRuntime.get(tabId);
    const pageSessionId = String(msg.page_session_id || msg.entry?.page_session_id || '');
    const seq = Number(msg.entry?.seq || 0);
    if (runtime && pageSessionId && runtime.pageSessionId !== pageSessionId) return;
    if (runtime && seq && seq <= runtime.lastSeq) return;
    if (runtime && seq) runtime.lastSeq = seq;
    fetch(`${LOCAL_API}/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'phantom-relay',
        domain: sender.tab?.url ? new URL(sender.tab.url).hostname : currentDomain,
        tabId,
        frameId: sender.frameId ?? 0,
        pageSessionId,
        seq,
        entry: msg.entry
      })
    }).catch((e) => addDebugLog('trace_write_failed', { error: e.message }));
    chrome.runtime.sendMessage({ type: 'page_trace', page_session_id: pageSessionId, entry: msg.entry }).catch(() => {});
    return;
  }

  if (msg.type === 'capture_progress') {
    const runtime = pageRuntime.get(tabId);
    if (runtime && msg.page_session_id && runtime.pageSessionId !== msg.page_session_id) return;
    addDebugLog(msg.message, { debug: msg.debug || [] }, sender.tab?.url ? new URL(sender.tab.url).hostname : currentDomain);
    chrome.runtime.sendMessage({
      type: 'capture_progress',
      page_session_id: msg.page_session_id || '',
      message: msg.message,
      debug: msg.debug || []
    }).catch(() => {});
    return;
  }

  if (msg.type === 'selector_capture_rejected') {
    const pageDomain = sender.tab?.url ? (() => {
      try { return new URL(sender.tab.url).hostname; } catch (_) { return currentDomain; }
    })() : currentDomain;
    const error = String(msg.error || 'profile_recording_rejected');
    addDebugLog('selector_capture_rejected', {
      role: String(msg.role || ''),
      error
    }, pageDomain);
    chrome.runtime.sendMessage({
      type: 'selector_capture_rejected',
      role: String(msg.role || ''),
      error,
      detail: String(msg.detail || ''),
      domain: pageDomain
    }).catch(() => {});
    return;
  }

  if (msg.type === 'capture_delta') {
    const runtime = pageRuntime.get(tabId);
    if (runtime && msg.page_session_id && runtime.pageSessionId !== msg.page_session_id) return;
    const pageUrl = sender.tab?.url || '';
    const pageDomain = (() => { try { return new URL(pageUrl).hostname; } catch (_) { return ''; } })();
    fetch(`${LOCAL_API}/browser/delta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: browserClientId, job_id: msg.job_id, claim_token: msg.claim_token || '', conversation_id: msg.conversation_id || '', tab_id: msg.tab_id || tabId || null, domain: pageDomain, page_session_id: msg.page_session_id || '', key: msg.key, text: msg.text, streaming: !!msg.streaming, completion_reason: msg.completion_reason || '' })
    }).catch((e) => addDebugLog('capture_delta_write_failed', { error: e?.message || String(e) }, currentDomain));
    return;
  }

  if (msg.type === 'selector_captured') {
    (async () => {
      await storageReady;
      const domain = msg.domain || currentDomain || 'unknown';
      const role = msg.role === 'copy' ? 'response' : msg.role;
      if (!selectors[domain]) selectors[domain] = emptySelectors();
      if (!domainState[domain]) domainState[domain] = { current: State.IDLE };
      // Detect send-strategy JSON vs legacy CSS selector.
      let captured;
      if (role === 'send' && typeof msg.selector === 'string' && /^\s*\{/.test(msg.selector)) {
        try { captured = JSON.parse(msg.selector); } catch (_) { captured = normalizeRoleSelector({ selector: msg.selector, alternatives: msg.alternatives || [] }); }
      } else {
        captured = normalizeRoleSelector({ selector: msg.selector, alternatives: msg.alternatives || [] });
      }
      selectors[domain][role] = typeof captured === 'object' && captured.kind
        ? captured
        : { ...captured, confidence: msg.confidence, elementTag: msg.elementTag, capturedAt: Date.now() };

      let stagedEnvelope = null;
      if (role === 'send' && selectors[domain].profile) {
        try {
          const updatedProfile = PhantomRelayProfile.withSendStrategy(
            selectors[domain].profile,
            selectors[domain].send,
          );
          profileStore = await PhantomRelayProfileStore.stageProfile(profileStore, updatedProfile);
          stagedEnvelope = profileStore.profiles[updatedProfile.profileId]?.pending || null;
          if (stagedEnvelope?.profile) selectors[domain].profile = stagedEnvelope.profile;
          if (stagedEnvelope) {
            try {
              const synced = await syncPendingProfile(updatedProfile.profileId);
              profileStore = synced.store || profileStore;
            } catch (error) {
              addDebugLog('profile_sync_failed', {
                ...profileStageMetadata(updatedProfile),
                code: error?.code || 'profile_sync_failed',
                error: error?.message || String(error),
              }, domain);
            }
          }
          addDebugLog('send_strategy_profile_reconciled', {
            profileId: updatedProfile.profileId,
            revision: Number(stagedEnvelope?.lifecycle?.revision || 0),
            kind: String(updatedProfile.send?.kind || ''),
          }, domain);
        } catch (error) {
          // Keep the selector visible for re-recording, but remove the stale
          // executable profile so replay fails closed instead of mixing the new
          // send action with an old profile contract.
          selectors[domain].profile = null;
          addDebugLog('send_strategy_profile_reconcile_failed', {
            domain,
            code: error?.code || 'profile_reconcile_failed',
            error: error?.message || String(error),
          }, domain);
        }
      }
      if (role === 'response' && msg.profile && typeof msg.profile === 'object') {
        try {
          profileStore = await PhantomRelayProfileStore.stageProfile(profileStore, msg.profile);
          stagedEnvelope = profileStore.profiles[msg.profile.profileId]?.pending || null;
          selectors[domain].profile = stagedEnvelope?.profile || null;
        } catch (error) {
          selectors[domain].profile = null;
          profileStore = await PhantomRelayProfileStore.recordProfileError(
            profileStore,
            String(msg.profile.profileId || domain),
            { code: error?.code || 'profile_stage_failed', message: error?.message || String(error), recoverable: true }
          );
          await diagnoseProfileStageFailure(msg.profile, profileStore, error);
          addDebugLog('profile_stage_failed', { domain, error: error?.message || String(error) }, domain);
        }

        if (stagedEnvelope) {
          try {
            await syncPendingProfile(msg.profile.profileId);
          } catch (error) {
            addDebugLog('profile_sync_failed', {
              ...profileStageMetadata(msg.profile),
              code: error?.code || 'profile_sync_failed',
              error: error?.message || String(error),
            }, domain);
          }
        }
      }

      if (role === 'input') domainState[domain].current = State.INPUT_DONE;
      else if (role === 'send') domainState[domain].current = State.SEND_DONE;
      else if (role === 'response') {
        domainState[domain].current = State.ALL_DONE;
        const modelName = msg.model || domain;
        const modelKey = String(modelName).trim().toLowerCase();
        const pageUrl = String(sender.tab?.url || '').trim();
        const previousRoute = modelRoutes[modelKey];
        const previousTarget = previousRoute && typeof previousRoute === 'object'
          ? previousRoute.target_url || previousRoute.url || ''
          : '';
        const targetUrl = safeRouteTargetUrl(pageUrl || previousTarget, domain);
        modelRoutes[modelKey] = { domain, target_url: targetUrl };
      }

      currentDomain = domain;
      setBadge(domain);
      persist();
      const selectorPayload = { ...selectors[domain], response: selectors[domain].response || selectors[domain].copy || null };
      if (stagedEnvelope) selectorPayload.profile = stagedEnvelope.profile;
      fetch(`${LOCAL_API}/browser/selectors`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, selectors: selectorPayload })
      }).catch(() => {});
    })().catch(error => addDebugLog('selector_capture_processing_failed', { error: error?.message || String(error) }));
    return;
  }

  // 旧版复制事件兼容：自动抓取现在由 popup 直接保存完整回复。
  if (msg.type === 'text_copied') return;

  })().catch(error => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

// ── Popup 消息 ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.from !== 'popup') return;

  switch (msg.action) {
    case 'get_backend_config':
      sendResponse({ ok: true, backend_url: LOCAL_API, default_backend_url: BACKEND_CONFIG.DEFAULT_BACKEND_URL });
      break;

    case 'set_backend_config': {
      try {
        const backendUrl = BACKEND_CONFIG.normalizeBackendUrl(msg.backend_url);
        LOCAL_API = backendUrl;
        chrome.storage.local.set({ phantomBackendUrl: backendUrl });
        lastRegistrationAt = 0;
        registerBrowserClient(true).catch(() => {});
        sendResponse({ ok: true, backend_url: backendUrl });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      break;
    }

    case 'browser_submit': {
      const domain = msg.domain || currentDomain;
      (async () => {
        try {
          const response = await fetch(`${LOCAL_API}/browser/submit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg.message, domain, tab_id: msg.tab_id, model: msg.model || '' })
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            sendResponse({
              ...payload,
              error: payload?.error?.message || `backend_request_failed:${response.status}`,
              code: payload?.error?.code || 'backend_request_failed',
              status: response.status,
            });
            return;
          }
          sendResponse(payload);
        } catch (error) {
          sendResponse({
            error: '后端不可达',
            code: 'backend_unreachable',
            detail: error?.message || String(error),
          });
        }
      })();
      return true;
    }

    case 'get_recording_route': {
      (async () => {
        await storageReady;
        await profileRecoveryPromise;
        const result = PhantomRelayRouteTarget.resolveRecordingTarget({
          model: msg.model,
          domain: msg.domain || currentDomain,
          currentUrl: msg.current_url || '',
          routes: modelRoutes,
          profiles: profileRoutesForRecording(),
        });
        sendResponse(result);
      })().catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    case 'open_recording_page': {
      (async () => {
        await storageReady;
        const requestedTabId = Number(msg.tab_id);
        const currentTab = Number.isFinite(requestedTabId) && requestedTabId > 0
          ? await chrome.tabs.get(requestedTabId).catch(() => null)
          : null;
        const result = PhantomRelayRouteTarget.resolveRecordingTarget({
          model: msg.model,
          domain: msg.domain || currentDomain,
          currentUrl: currentTab?.url || msg.current_url || '',
          routes: modelRoutes,
          profiles: profileRoutesForRecording(),
        });
        if (!result.ok) {
          sendResponse({ ok: false, error: result.error });
          return;
        }
        if (currentTab?.id) {
          await chrome.tabs.update(currentTab.id, { url: result.targetUrl, active: true });
          addDebugLog('recording_page_opened', {
            tabId: currentTab.id,
            model: String(msg.model || '').trim().toLowerCase(),
            targetUrl: result.targetUrl,
            source: result.source
          }, result.targetDomain);
          sendResponse({ ...result, action: 'updated', tab_id: currentTab.id });
          return;
        }
        const created = await chrome.tabs.create({ url: result.targetUrl, active: true });
        addDebugLog('recording_page_opened', {
          tabId: created?.id || null,
          model: String(msg.model || '').trim().toLowerCase(),
          targetUrl: result.targetUrl,
          source: result.source
        }, result.targetDomain);
        sendResponse({ ...result, action: 'created', tab_id: created?.id || null });
      })().catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    case 'start_network_calibration': {
      sendResponse({ ok: false, error: 'network_capture_disabled' });
      return true;
    }

    case 'cancel_network_calibration': {
      sendResponse({ ok: false, error: 'network_capture_disabled' });
      return true;
    }

    case 'get_browser_clients':
      fetch(`${LOCAL_API}/browser/clients`).then(r => r.json()).then(sendResponse).catch(error => sendResponse({ error: error.message }));
      return true;

    case 'model_name_for_domain': {
      const host = String(msg.domain || '').toLowerCase();
      const found = Object.entries(modelRoutes).find(([, d]) => {
        return routeDomain(d) === host;
      });
      sendResponse({ model: found?.[0] || '' });
      break;
    }

    case 'bind_model_route': {
      const model = String(msg.model || '').trim().toLowerCase();
      const domain = String(msg.domain || currentDomain || '').trim().toLowerCase();
      if (!model || !domain) { sendResponse({ error: 'model/domain required' }); break; }
      const recorded = normalizeSelectors(selectors[domain]);
      if (!hasExecutableRecordedProfile(recorded)) {
        sendResponse({ error: 'profile_incomplete' });
        break;
      }
      const targetUrl = safeRouteTargetUrl(msg.target_url, domain);
      modelRoutes[model] = { domain, target_url: targetUrl };
      persist();
      syncRoutesToBackend();
      sendResponse({ ok: true, model, domain, target_url: targetUrl });
      break;
    }

    case 'list_model_routes': {
      const list = Object.keys(modelRoutes).sort();
      // 反向表 + 已录制站点 = 所有可用的模型
      const domains = Object.keys(selectors).filter(k => {
        const recorded = normalizeSelectors(selectors[k]);
        return hasExecutableRecordedProfile(recorded);
      });
      const all = [...new Set([...list, ...domains])];
      sendResponse({ models: all, routes: modelRoutes });
      break;
    }

    case 'get_state': {
      (async () => {
        await storageReady;
        await profileRecoveryPromise;
        const domain = msg.domain;
        currentDomain = domain;
        const sel = normalizeSelectors(selectors[domain]);
        selectors[domain] = sel;
        const ds = domainState[domain] || { current: State.IDLE };
        const hasTemplate = hasExecutableRecordedProfile(sel);
        const current = hasTemplate ? State.ALL_DONE :
          sel.send ? State.SEND_DONE : sel.input ? State.INPUT_DONE : (ds.current || State.IDLE);
        sendResponse({
          domain,
          current,
          selectors: sel,
          conversations: conversations.slice(-50),
          conversationCount: conversations.length,
          hasTemplate,
          profileStatus: profileStatusForDomain(domain),
        });
      })().catch(error => sendResponse({ error: error?.message || String(error) }));
      return true;
    }

    case 'get_profile_status': {
      (async () => {
        await storageReady;
        await profileRecoveryPromise;
        sendResponse({ ok: true, profileStatus: profileStatusForDomain(msg.domain || currentDomain) });
      })().catch(error => sendResponse({ error: error?.message || String(error) }));
      return true;
    }

    case 'get_extension_diagnostics':
      sendResponse({
        ok: true,
        extension_version: chrome.runtime.getManifest?.().version || '',
        background_version: globalThis.__phantomRelayBackgroundVersion || '',
        content_script_version: CONTENT_SCRIPT_VERSION,
      });
      break;

    case 'record_profile_health': {
      (async () => {
        await storageReady;
        const report = msg.report && typeof msg.report === 'object' ? msg.report : null;
        const profileId = String(report?.profile_id || '');
        if (!profileId) throw new Error('profile_id_missing');
        profileStore = await PhantomRelayProfileStore.recordProfileHealth(profileStore, report);
        await PhantomRelayProfileStore.saveProfileStore(chrome.storage.local, profileStore);
        const payload = buildProfileHealthPayload(profileId, Number(report.revision), report);
        const response = await fetch(`${LOCAL_API}/browser/profiles/health`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const remote = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(remote?.error?.message || `profile_health_sync_failed:${response.status}`);
        sendResponse({ ok: true, profileStatus: profileStatusForDomain(msg.domain || currentDomain), remote });
      })().catch(error => sendResponse({ error: error?.message || String(error) }));
      return true;
    }

    case 'update_state': {
      const domain = msg.state.domain || currentDomain;
      if (!domainState[domain]) domainState[domain] = { current: State.IDLE };
      if (msg.state.current) domainState[domain].current = msg.state.current;
      setBadge(domain);
      persist();
      sendResponse({ ok: true });
      break;
    }

    case 'save_send_strategy': {
      (async () => {
        await storageReady;
        const domain = String(msg.domain || currentDomain || '').trim().toLowerCase();
        const strategy = msg.strategy && typeof msg.strategy === 'object' ? { ...msg.strategy } : null;
        const allowedKinds = new Set(['enter', 'shortcut']);
        if (!domain || !strategy || !allowedKinds.has(String(strategy.kind || ''))) {
          sendResponse({ ok: false, error: 'send_strategy_invalid' });
          return;
        }
        if (strategy.kind === 'enter') {
          strategy.key = 'Enter';
          strategy.modifiers = [];
        } else {
          strategy.key = String(strategy.key || 'Enter');
          strategy.modifiers = Array.isArray(strategy.modifiers) ? strategy.modifiers.map(String) : [];
        }
        const current = normalizeSelectors(selectors[domain]);
        selectors[domain] = { ...current, send: strategy };
        domainState[domain] = { ...(domainState[domain] || {}), current: State.SEND_DONE };
        currentDomain = domain;
        persist();
        const selectorPayload = { ...selectors[domain], response: selectors[domain].response || selectors[domain].copy || null };
        let syncStatus = 'synced';
        try {
          const remote = await fetch(LOCAL_API + '/browser/selectors', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, selectors: selectorPayload })
          });
          if (!remote.ok) {
            syncStatus = 'pending';
            addDebugLog('selector_sync_deferred', { domain, role: 'send', error: `selector_sync_failed:${remote.status}` }, domain);
          }
        } catch (error) {
          // Recording is a local browser capability. A temporarily stopped or
          // unreachable backend must not discard the user's Enter choice.
          syncStatus = 'pending';
          addDebugLog('selector_sync_deferred', { domain, role: 'send', error: error?.message || String(error) }, domain);
        }
        const tabId = Number(msg.tab_id);
        if (Number.isFinite(tabId) && tabId > 0) {
          await chrome.tabs.sendMessage(tabId, {
            action: 'set_selectors',
            selectors: selectorPayload,
            profile_revision: activeProfileRevisionForDomain(domain),
          }).catch(() => {});
        }
        setBadge(domain);
        sendResponse({ ok: true, domain, strategy, selectors: selectors[domain], sync_status: syncStatus });
      })().catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    case 'save_conversation':
      conversations.push({
        user: msg.user, assistant: msg.assistant,
        timestamp: Date.now(), source: msg.source || currentDomain || 'unknown',
      });
      persist();
      sendResponse({ ok: true, total: conversations.length });
      break;

    case 'save_pending':
      // Deprecated: retained for messages from an older popup.
      sendResponse({ ok: true });
      break;

    case 'clear_conversations':
      conversations = [];
      persist();
      sendResponse({ ok: true });
      break;

    case 'clear_selectors': {
      const domain = msg.domain || currentDomain;
      if (domain) {
        delete selectors[domain];
        delete domainState[domain];
      }
      persist();
      sendResponse({ ok: true });
      break;
    }

    case 'export_json':
      downloadJSON(msg.conversations || conversations);
      sendResponse({ ok: true });
      break;

    case 'export_to_server':
      sendToServer(msg.conversations || conversations).then(sendResponse);
      return true;

    case 'reset': {
      const domain = msg.domain || currentDomain;
      if (domain) {
        domainState[domain] = { current: State.IDLE };
        if (selectors[domain]) selectors[domain] = emptySelectors();
      }
      setBadge(domain);
      persist();
      sendResponse({ ok: true });
      break;
    }

    case 'list_sites':
      sendResponse({
        sites: Object.keys(selectors).map(d => ({
          domain: d,
          ready: !!(selectors[d]?.input && selectors[d]?.send),
        }))
      });
      break;
  }
});

// ── 导出 ──────────────────────────────────────────────────
async function downloadJSON(convs) {
  const openai = convs.map(c => ({
    messages: [{ role: 'user', content: c.user }, { role: 'assistant', content: c.assistant }],
    metadata: { timestamp: new Date(c.timestamp).toISOString(), source: c.source || 'unknown' },
  }));
  const blob = new Blob([JSON.stringify(openai, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await chrome.downloads.download({ url, filename: `phantom-relay-${ts}.json`, saveAs: true });
}

async function sendToServer(convs) {
  try {
    const res = await fetch(`${LOCAL_API}/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: convs, source: 'phantom-relay' }),
    });
    return await res.json();
  } catch (e) {
    return { error: `服务未启动 (${LOCAL_API}): ${e.message}` };
  }
}

setBadge(null);
console.log('👻 Phantom Relay background v3 ready (multi-site)');
