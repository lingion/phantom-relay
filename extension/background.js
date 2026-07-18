// ============================================================
// Phantom Relay — Background Service Worker v3
// 多站点: 按域名独立存储选择器模板
// ============================================================

const LOCAL_API = 'http://localhost:8765';

const State = {
  IDLE: 'idle', RECORDING_INPUT: 'recording_input', INPUT_DONE: 'input_done',
  RECORDING_SEND: 'recording_send', SEND_DONE: 'send_done',
  RECORDING_COPY: 'recording_copy', ALL_DONE: 'all_done',
};

const STATE_LABELS = { '': '', recording_input: 'IN', input_done: '✓1', recording_send: 'SD', send_done: '✓2', recording_copy: 'CP', all_done: '✓' };
const STATE_COLORS = { '': '#607D8B', recording_input: '#FF6D00', input_done: '#FF8A65', recording_send: '#1976D2', send_done: '#64B5F6', recording_copy: '#7B1FA2', all_done: '#00C853' };

// ── 数据结构 ──────────────────────────────────────────────
// selectors: { "doubao.com": { input, send, copy }, "deepseek.com": { ... } }
// domainState: { "doubao.com": { current: 'all_done' }, ... }
let selectors = {};       // 所有站点的选择器
let domainState = {};     // 每个站点的录制状态
let currentDomain = null; // 当前活跃站点
let conversations = [];
let debugLogs = [];

function emptySelectors() {
  return { input: null, send: null, copy: null, response: null };
}

function normalizeRoleSelector(value) {
  if (!value) return null;
  if (value.css) return { selector: value };
  return value.selector?.css ? value : null;
}

function normalizeSelectors(value) {
  const out = emptySelectors();
  for (const role of Object.keys(out)) out[role] = normalizeRoleSelector(value?.[role]);
  return out;
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
chrome.storage.local.get(['phantomSelectors', 'phantomDomainState', 'phantomConversations', 'phantomDebugLogs'], (data) => {
  if (data.phantomSelectors) selectors = data.phantomSelectors;
  if (data.phantomDomainState) domainState = data.phantomDomainState;
  if (data.phantomConversations) conversations = data.phantomConversations;
  if (data.phantomDebugLogs) debugLogs = data.phantomDebugLogs;
});

function persist() {
  chrome.storage.local.set({
    phantomSelectors: selectors,
    phantomDomainState: domainState,
    phantomConversations: conversations,
  });
}

function setBadge(domain) {
  const st = domainState[domain]?.current || State.IDLE;
  chrome.action.setBadgeText({ text: STATE_LABELS[st] || '' });
  chrome.action.setBadgeBackgroundColor({ color: STATE_COLORS[st] || '#607D8B' });
}

// ── 消息处理 ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

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

  if (msg.type === 'selector_captured') {
    const domain = msg.domain || currentDomain || 'unknown';
    if (!selectors[domain]) selectors[domain] = emptySelectors();
    if (!domainState[domain]) domainState[domain] = { current: State.IDLE };

    selectors[domain][msg.role] = {
      selector: msg.selector,
      confidence: msg.confidence,
      elementTag: msg.elementTag,
      capturedAt: Date.now()
    };

    if (msg.role === 'input') domainState[domain].current = State.INPUT_DONE;
    else if (msg.role === 'send') domainState[domain].current = State.SEND_DONE;
    else if (msg.role === 'copy') {
      domainState[domain].current = State.ALL_DONE;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: 'find_response' }, (resp) => {
          if (resp?.text) { /* stored */ }
        });
      }
    }

    currentDomain = domain;
    setBadge(domain);
    persist();
  }

  // text_copied
  if (msg.type === 'text_copied') {
    if (state._pendingConversation) {
      conversations.push({
        user: state._pendingConversation.user,
        assistant: msg.text,
        timestamp: Date.now(),
        source: state._pendingConversation.source || currentDomain || 'unknown',
      });
      state._pendingConversation = null;
      persist();
    }
  }
});

// ── Popup 消息 ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.from !== 'popup') return;

  switch (msg.action) {
    case 'get_state': {
      const domain = msg.domain;
      currentDomain = domain;
      const sel = normalizeSelectors(selectors[domain]);
      selectors[domain] = sel;
      const ds = domainState[domain] || { current: State.IDLE };
      const hasTemplate = !!(sel.input && sel.send && sel.copy);
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
      state._pendingConversation = { user: msg.user, source: msg.source };
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
          ready: !!(selectors[d]?.input && selectors[d]?.send && selectors[d]?.copy),
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
