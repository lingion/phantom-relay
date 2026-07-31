// ============================================================
// Phantom Relay — Background Service Worker v3
// 多站点: 按域名独立存储选择器模板
// ============================================================

importScripts('profile_lifecycle.js');

const LOCAL_API = 'http://localhost:8765';
const BROWSER_POLL_ALARM = 'phantom-relay-browser-poll';

const State = {
  IDLE: 'idle', RECORDING_INPUT: 'recording_input', INPUT_DONE: 'input_done',
  RECORDING_SEND: 'recording_send', SEND_DONE: 'send_done',
  RECORDING_RESPONSE: 'recording_response', ALL_DONE: 'all_done',
};

const STATE_LABELS = { '': '', recording_input: 'IN', input_done: '✓1', recording_send: 'SD', send_done: '✓2', recording_response: 'RP', all_done: '✓' };
const STATE_COLORS = { '': '#607D8B', recording_input: '#FF6D00', input_done: '#FF8A65', recording_send: '#1976D2', send_done: '#64B5F6', recording_response: '#7B1FA2', all_done: '#00C853' };

// ── 数据结构 ──────────────────────────────────────────────
// selectors: { "doubao.com": { input, send, copy }, "deepseek.com": { ... } }
// domainState: { "doubao.com": { current: 'all_done' }, ... }
let selectors = {};       // 所有站点的选择器
let domainState = {};     // 每个站点的录制状态
let currentDomain = null; // 当前活跃站点
let conversations = [];
let debugLogs = [];
let modelRoutes = {};      // 用户录制后绑定：模型名 -> 官网 hostname
let storageReadyResolve;
const storageReady = new Promise(resolve => { storageReadyResolve = resolve; });
const readyFlights = new Map();
function emptySelectors() {
  return { input: null, send: null, response: null };
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
  for (const role of Object.keys(out)) {
    const raw = value?.[role];
    // Strategy objects like {kind:'enter', key:'Enter', modifiers:[]} pass through
    if (raw && typeof raw === 'object' && raw.kind) {
      out[role] = raw;
    } else {
      out[role] = normalizeRoleSelector(raw);
    }
  }
  return out;
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
      const v = raw[role];
      if (role === 'send' && v && typeof v === 'object' && v.kind) {
        out[role] = v;
      } else {
        out[role] = normalizeRoleSelector(v);
      }
    }
  }
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
  console.log('[Phantom Relay]', entry);
}

// ── 持久化 ────────────────────────────────────────────────
chrome.storage.local.get(['phantomSelectors', 'phantomDomainState', 'phantomConversations', 'phantomDebugLogs', 'phantomModelRoutes'], (data) => {
  if (data.phantomSelectors) selectors = data.phantomSelectors;
  if (data.phantomDomainState) domainState = data.phantomDomainState;
  if (data.phantomConversations) conversations = data.phantomConversations;
  if (data.phantomDebugLogs) debugLogs = data.phantomDebugLogs;
  if (data.phantomModelRoutes) modelRoutes = data.phantomModelRoutes;
  storageReadyResolve();
});

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
  syncRoutesToBackend();
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
  if (value && typeof value === 'object') return String(value.domain || fallback || '').trim();
  return String(fallback || '').trim();
}

function modelNameForDomain(domain) {
  // 反向查找：哪个模型绑定到了这个域名
  const host = (domain || '').trim().toLowerCase();
  for (const [model, d] of Object.entries(modelRoutes)) {
    if (d === host) return model;
  }
  // 无绑定 → 用域名本身当模型名（去掉 www.）
  return host.replace(/^www\./, '');
}

async function waitForTabUrl(tabId, hostname, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && new URL(tab.url).hostname === hostname && tab.status === 'complete') return tab;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`model_route_timeout:${hostname}`);
}

function isUsableExecutionTab(tab) {
  return !!(tab?.id && tab.url && !/^(chrome|edge|about|devtools):/.test(tab.url));
}

async function getExecutionTab(preferredDomain = '') {
  const allTabs = await chrome.tabs.query({ windowType: 'normal' });
  const usable = allTabs.filter(t => t?.id && t.url && !/^(chrome|edge|about|devtools):/i.test(t.url));
  if (preferredDomain) {
    const exact = usable.find(t => {
      try { return new URL(t.url).hostname === preferredDomain; } catch (_) { return false; }
    });
    if (exact) return exact;
  }
  if (usable.length) return usable.find(t => t.active) || usable[0];
  const activeTabs = await chrome.tabs.query({ active: true });
  return activeTabs.find(t => t?.id) || null;
}

async function ensureContentScript(tab) {
  if (!isUsableExecutionTab(tab)) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['universal_bridge.js', 'content.js'] });
      await new Promise(resolve => setTimeout(resolve, 250));
      await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      addDebugLog('content_script_injected', { tabId: tab.id, url: tab.url }, new URL(tab.url).hostname);
      return true;
    } catch (e) {
      addDebugLog('content_script_inject_failed', { tabId: tab.id, url: tab.url, error: e?.message || String(e) }, tab.url || 'unknown');
      return false;
    }
  }
}

async function ensureContentScriptsInOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    for (const tab of tabs) {
      if (tab.status === 'complete') await ensureContentScript(tab);
    }
  } catch (_) {}
}

let browserPollInFlight = false;

async function browserBridgeTick() {
  if (browserPollInFlight) return;
  browserPollInFlight = true;
  let claimedJobId = null;
  let claimedDomain = '';
  try {
    const pendingResp = await fetch(`${LOCAL_API}/browser/pending-domains`).catch(() => null);
    const pendingData = pendingResp ? await pendingResp.json().catch(() => ({})) : {};
    const preferredDomain = pendingData?.domains?.[0] || '';

    // Resolve the execution tab BEFORE polling/claiming. Never let the currently
    // active wrong-model tab claim a job for another domain.
    let tab = null;
    if (preferredDomain) {
      const allTabs = await chrome.tabs.query({ windowType: 'normal' });
      tab = allTabs.find(t => {
        try { return isUsableExecutionTab(t) && new URL(t.url).hostname === preferredDomain; } catch (_) { return false; }
      }) || null;
      if (!tab) {
        const route = modelRoutes[preferredDomain] || `https://${preferredDomain}/`;
        const routeUrl = /^https?:\/\//i.test(route) ? route : `https://${preferredDomain}/`;
        addDebugLog('browser_target_tab_missing', { targetDomain: preferredDomain, routeUrl }, preferredDomain);
        try {
          const created = await chrome.tabs.create({ url: routeUrl, active: false });
          tab = await waitForTabUrl(created.id, preferredDomain, 30000);
          addDebugLog('browser_target_tab_ready', { targetDomain: preferredDomain, tabId: tab.id, url: tab.url }, preferredDomain);
          await ensureContentScript(tab);
        } catch (e) {
          addDebugLog('browser_target_tab_open_failed', { targetDomain: preferredDomain, error: e?.message || String(e) }, preferredDomain);
          return;
        }
      }
    } else {
      tab = await getExecutionTab('');
    }
    if (!tab?.id || !tab.url) return;
    const url = tab.url || '';
    const domain = /^(about|chrome|edge|devtools):/i.test(url) ? '' : (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    claimedDomain = domain || 'unknown';
    // At this point tab is already the exact target-domain tab. Claim only with
    // that tab identity; a wrong active page can never consume this job.
    await fetch(`${LOCAL_API}/browser/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, tab_id: tab.id, url: tab.url, source: 'background-poll' })
    }).catch(() => {});
    const response = await fetch(`${LOCAL_API}/browser/poll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, tab_id: tab.id })
    });
    const data = await response.json();
    if (!data.job) return;
    claimedJobId = data.job.id;
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
        try {
          const created = await chrome.tabs.create({ url: expectedUrl, active: false });
          executionTab = await waitForTabUrl(created.id, targetDomain, 30000);
        } catch (e) {
          throw new Error(`backend_target_open_failed:${e.message}`);
        }
      }
    }
    // 只有后端没有提供 target_url 时，才允许扩展按缓存路由创建页面。
    if (!data.job.target_url && (data.job.new_tab || domain !== targetDomain)) {
      addDebugLog('browser_model_route', { model: requestedModel, new_tab: data.job.new_tab, from: domain, to: targetDomain }, domain);
      try {
        const route = modelRoutes[requestedModel];
        const routeUrl = /^https?:\/\//i.test(route || '') ? route : `https://${targetDomain}/`;
        const tabsToClose = data.job.close_previous ? await chrome.tabs.query({ windowType: 'normal' }) : [];
        for (const oldTab of tabsToClose) {
          if (oldTab.id && oldTab.id !== tab.id && oldTab.url && oldTab.url.includes(targetDomain)) {
            try { await chrome.tabs.remove(oldTab.id); } catch (_) {}
          }
        }
        executionTab = await chrome.tabs.create({ url: routeUrl, active: false });
        addDebugLog('browser_tab_created', { tabId: executionTab.id, url: executionTab.url, pendingUrl: executionTab.pendingUrl }, domain);
        executionTab = await waitForTabUrl(executionTab.id, targetDomain, 30000);
        addDebugLog('browser_tab_ready', { tabId: executionTab.id, url: executionTab.url }, targetDomain);
        try {
          await chrome.tabs.sendMessage(executionTab.id, { action: 'ping' });
        } catch (_) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: executionTab.id }, files: ['universal_bridge.js', 'content.js'] });
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (e) { addDebugLog('browser_cs_inject_fail', { error: e.message }, targetDomain); }
        }
      } catch (e) {
        addDebugLog('browser_route_failed', { error: e.message, model: requestedModel, target: targetDomain }, domain);
        throw e;
      }
    }
    if (!executionTab?.id || !executionTab.url || /^about:blank$/i.test(executionTab.url)) {
      throw new Error('execution_tab_invalid');
    }
    const executionDomain = new URL(executionTab.url).hostname;
    claimedDomain = executionDomain;
    const { key: selectorDomain, value: selectorsForPage } = selectorsForDomain(executionDomain);
    await chrome.tabs.sendMessage(executionTab.id, { action: 'set_selectors', selectors: selectorsForPage });
    addDebugLog('browser_selector_template', {
      requestedDomain: domain,
      executionDomain,
      selectorDomain,
      input: selectorsForPage.input,
      send: selectorsForPage.send
    }, domain);
    const result = await chrome.tabs.sendMessage(executionTab.id, { action: 'auto_capture', message: data.job.message, job_id: data.job.id });
    let finalResult = result;
    if (result?.error && /send_selector_invalid|input_selector_invalid|send_selector_missing/.test(result.error)) {
      addDebugLog('browser_bridge_rejected_recorded_template', {
        domain,
        selectorDomain,
        error: result.error,
        detail: result.detail || ''
      }, domain);
    }
    await fetch(`${LOCAL_API}/browser/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: data.job.id, domain: executionDomain, model: requestedModel, completion_reason: finalResult?.completion_reason || '', ...finalResult })
    });
chrome.runtime.sendMessage({ type: 'capture_progress', message: finalResult?.success ? `后端任务完成：${finalResult.assistant?.length || 0} 字` : `后端任务失败：${finalResult?.error || 'unknown'}` }).catch(() => {});
  } catch (error) {
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
      body: JSON.stringify({ job_id: claimedJobId, success: false, error: error.message })
    }).catch(() => {});
  }
    // 服务未启动、页面不可注入时下一次 alarm 重试；不吞掉任务状态。
    console.debug('[Phantom Relay] browser bridge tick:', error.message);
  } finally {
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BROWSER_POLL_ALARM) scheduleBrowserBridgeTick(0);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isUsableExecutionTab(tab)) {
    ensureContentScript(tab).then(() => scheduleBrowserBridgeTick(0));
  }
});
chrome.tabs.onCreated.addListener((tab) => {
  if (isUsableExecutionTab(tab)) scheduleBrowserBridgeTick(250);
});
chrome.tabs.onActivated.addListener(() => scheduleBrowserBridgeTick(250));

function ensureBrowserBridgeAlarm() {
  chrome.alarms.create(BROWSER_POLL_ALARM, { periodInMinutes: 0.17 });
}

chrome.runtime.onInstalled.addListener(ensureBrowserBridgeAlarm);
chrome.runtime.onStartup.addListener(ensureBrowserBridgeAlarm);
loadRoutes();
// 扩展以 unpacked 方式加载/重载时不会稳定触发 onInstalled；必须显式确保 alarm 存在。
ensureBrowserBridgeAlarm();
// 首次加载延迟一次执行，避免与 storage/routes 初始化竞态。
setTimeout(() => { ensureContentScriptsInOpenTabs(); browserBridgeTick(); }, 1500);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'page_ready') {
    const pageDomain = sender.tab?.url ? new URL(sender.tab.url).hostname : '';
    const readyTabId = sender.tab?.id;
    (async () => {
      try {
        await storageReady;
        const { value: pageSelectors } = selectorsForDomain(pageDomain);
        await chrome.tabs.sendMessage(readyTabId, { action: 'set_selectors', selectors: pageSelectors });
        const ready = await chrome.tabs.sendMessage(readyTabId, { action: 'wait_until_ready', timeout: 30000 });
        fetch(`${LOCAL_API}/browser/heartbeat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: pageDomain, tab_id: readyTabId, url: sender.tab?.url || '', source: 'content-ready', ready: !!ready?.ready, input_ready: !!ready?.input_ready, send_ready: !!ready?.send_ready })
        }).catch(() => {});
        if (ready?.ready) {
          browserBridgeTick();
          setTimeout(() => browserBridgeTick(), 150);
          setTimeout(() => browserBridgeTick(), 500);
        }
        sendResponse({ ok: true, ready });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'page_trace') {
    addDebugLog('page_trace', msg.entry, sender.tab?.url ? new URL(sender.tab.url).hostname : currentDomain);
    fetch(`${LOCAL_API}/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'phantom-relay',
        domain: sender.tab?.url ? new URL(sender.tab.url).hostname : currentDomain,
        tabId,
        entry: msg.entry
      })
    }).catch((e) => addDebugLog('trace_write_failed', { error: e.message }));
    chrome.runtime.sendMessage({ type: 'page_trace', entry: msg.entry }).catch(() => {});
    return;
  }

  if (msg.type === 'capture_progress') {
    addDebugLog(msg.message, { debug: msg.debug || [] }, sender.tab?.url ? new URL(sender.tab.url).hostname : currentDomain);
    chrome.runtime.sendMessage({
      type: 'capture_progress',
      message: msg.message,
      debug: msg.debug || []
    }).catch(() => {});
    return;
  }

  if (msg.type === 'capture_delta') {
    fetch(`${LOCAL_API}/browser/delta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: msg.job_id, key: msg.key, text: msg.text, streaming: !!msg.streaming, completion_reason: msg.completion_reason || '' })
    }).catch((e) => addDebugLog('capture_delta_write_failed', { error: e?.message || String(e) }, currentDomain));
    return;
  }

  if (msg.type === 'selector_captured') {
    const domain = msg.domain || currentDomain || 'unknown';
    if (!selectors[domain]) selectors[domain] = emptySelectors();
    if (!domainState[domain]) domainState[domain] = { current: State.IDLE };
    // Detect send-strategy JSON vs legacy CSS selector
    let captured;
    if (msg.role === 'send' && typeof msg.selector === 'string' && /^\s*\{/.test(msg.selector)) {
      try { captured = JSON.parse(msg.selector); } catch (_) { captured = normalizeRoleSelector({ selector: msg.selector, alternatives: msg.alternatives || [] }); }
    } else {
      captured = normalizeRoleSelector({ selector: msg.selector, alternatives: msg.alternatives || [] });
    }
    selectors[domain][msg.role] = typeof captured === 'object' && captured.kind
      ? captured
      : { ...captured, confidence: msg.confidence, elementTag: msg.elementTag, capturedAt: Date.now() };

    if (msg.role === 'input') domainState[domain].current = State.INPUT_DONE;
    else if (msg.role === 'send') domainState[domain].current = State.SEND_DONE;
    else if (msg.role === 'response') {
      domainState[domain].current = State.ALL_DONE;
      const modelName = msg.model || domain;
      modelRoutes[String(modelName).trim().toLowerCase()] = domain;
      persist();
    }

    currentDomain = domain;
    setBadge(domain);
    persist();
    fetch(`${LOCAL_API}/browser/selectors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, selectors: selectors[domain] })
    }).catch(() => {});
  }

  // 旧版复制事件兼容：自动抓取现在由 popup 直接保存完整回复。
  if (msg.type === 'text_copied') return;
});

// ── Popup 消息 ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.from !== 'popup') return;

  switch (msg.action) {
    case 'browser_submit': {
      const domain = msg.domain || currentDomain;
      fetch(`${LOCAL_API}/browser/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg.message, domain, tab_id: msg.tab_id, model: msg.model || '' })
      }).then(r => r.json()).then(sendResponse).catch(error => sendResponse({ error: error.message }));
      return true;
    }

    case 'get_browser_clients':
      fetch(`${LOCAL_API}/browser/clients`).then(r => r.json()).then(sendResponse).catch(error => sendResponse({ error: error.message }));
      return true;

    case 'model_name_for_domain': {
      const host = String(msg.domain || '').toLowerCase();
      const found = Object.entries(modelRoutes).find(([, d]) => {
        try { return new URL(/^https?:\/\//.test(d) ? d : `https://${d}`).hostname === host; } catch (_) { return d === host; }
      });
      sendResponse({ model: found?.[0] || '' });
      break;
    }

    case 'bind_model_route': {
      const model = String(msg.model || '').trim().toLowerCase();
      const domain = msg.domain || currentDomain;
      if (!model || !domain) { sendResponse({ error: 'model/domain required' }); break; }
      modelRoutes[model] = domain;
      persist();
      syncRoutesToBackend();
      sendResponse({ ok: true, model, domain });
      break;
    }

    case 'list_model_routes': {
      const list = Object.keys(modelRoutes).sort();
      // 反向表 + 已录制站点 = 所有可用的模型
      const domains = Object.keys(selectors).filter(k => selectors[k]?.input && selectors[k]?.send);
      const all = [...new Set([...list, ...domains])];
      sendResponse({ models: all, routes: modelRoutes });
      break;
    }

    case 'get_state': {
      const domain = msg.domain;
      currentDomain = domain;
      const sel = normalizeSelectors(selectors[domain]);
      selectors[domain] = sel;
      const ds = domainState[domain] || { current: State.IDLE };
      const hasTemplate = !!(sel.input && sel.send);
      const current = hasTemplate ? State.ALL_DONE :
        sel.send ? State.SEND_DONE : sel.input ? State.INPUT_DONE : (ds.current || State.IDLE);
      sendResponse({
        domain,
        current,
        selectors: sel,
        conversations: conversations.slice(-50),
        conversationCount: conversations.length,
        hasTemplate,
      });
      break;
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
