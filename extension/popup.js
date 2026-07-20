// Phantom Relay Popup v4 — 多站点，按域名自动切换模板
const $ = id => document.getElementById(id);

let appState = {
  domain: '',
  pageUrl: '',
  current: 'idle',
  selectors: { input: null, send: null, response: null },
  sendKind: 'enter',
  conversationCount: 0,
  hasTemplate: false,
};
let currentTabId = null;
let pollTimer = null;
let debugLines = [];
let pageTraceLines = [];

function addPageTrace(entry) {
  const line = typeof entry === 'string' ? entry : `[${new Date().toLocaleTimeString()}] ${JSON.stringify(entry)}`;
  pageTraceLines.push(line);
  if (pageTraceLines.length > 1000) pageTraceLines.shift();
  if (typeof pageTraceLog !== 'undefined') {
    pageTraceLog.textContent = pageTraceLines.join('\n');
    pageTraceLog.scrollTop = pageTraceLog.scrollHeight;
  }
}
function addDebug(message, details = null) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}${details ? ` ${JSON.stringify(details)}` : ''}`;
  debugLines.push(line);
  if (debugLines.length > 200) debugLines.shift();
  if (typeof debugLog !== 'undefined') {
    debugLog.textContent = debugLines.join('\n');
    debugLog.scrollTop = debugLog.scrollHeight;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'capture_progress' && msg.message) {
    captureStatus.textContent = `🔎 ${msg.message}`;
    addDebug(msg.message);
  }
  if (msg.type === 'page_trace') {
    addPageTrace(msg.entry || msg);
  }
});

// ── 确保 content script 已注入 ────────────────────────────
async function ensureContentScript() {
  if (!currentTabId) return false;
  try {
    // 先试试直接通信
    await chrome.tabs.sendMessage(currentTabId, { action: 'ping' });
    return true;
  } catch (e) {
    // 未注入 → 手动注入
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: ['content.js']
      });
      await sleep(500);
      await chrome.tabs.sendMessage(currentTabId, { action: 'ping' });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

// ── Model ──────────────────────────────────────────────────
let currentModel = '';
let knownModels = [];

function loadModel() {
  chrome.storage.local.get({ phantomModel: '' }, (r) => {
    // 1. 从当前域名反查绑定的模型名
    if (r.phantomModel && appState.domain) {
      chrome.runtime.sendMessage({ from: 'popup', action: 'model_name_for_domain', domain: appState.domain }, (resp) => {
        const inferred = resp?.model || '';
        currentModel = inferred;
        modelName.value = inferred;
      });
    } else if (!r.phantomModel && appState.domain) {
      chrome.runtime.sendMessage({ from: 'popup', action: 'model_name_for_domain', domain: appState.domain }, (resp) => {
        const inferred = resp?.model || appState.domain.replace(/^www\./, '');
        currentModel = inferred;
        modelName.value = currentModel;
        if (inferred) setModel(inferred);
      });
    } else {
      currentModel = r.phantomModel || (appState.domain ? appState.domain.replace(/^www\./, '') : '');
      modelName.value = currentModel;
    }
    loadKnownModels();
  });
}

function loadKnownModels() {
  chrome.runtime.sendMessage({ from:'popup', action:'list_model_routes' }, (resp) => {
    if (resp?.models) {
      knownModels = resp.models;
      renderModelDatalist();
    }
  });
}

function setModel(name) {
  if (!name || !name.trim()) return;
  const normalized = name.trim().toLowerCase();
  currentModel = normalized;
  chrome.storage.local.set({ phantomModel: normalized });
  if (!knownModels.includes(normalized)) knownModels.push(normalized);
  renderModelDatalist();
}

function renderModelDatalist() {
  modelDatalist.innerHTML = knownModels.map(m => `<option value="${m}">`).join('');
  modelName.value = currentModel;
}

modelName.addEventListener('change', () => setModel(modelName.value.trim()));
modelName.addEventListener('blur', () => setModel(modelName.value.trim()));

// ── Init ──────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  const domain = extractDomain(tab?.url || '');
  appState.domain = domain;
  appState.pageUrl = tab?.url || '';
  loadModel();

  // 2. 从 background 按域名加载持久模板。
  const state = await new Promise(resolve => {
    chrome.runtime.sendMessage({ from: 'popup', action: 'get_state', domain }, resolve);
  });
  if (state) Object.assign(appState, state);
  appState.domain = domain;
  render();

  // 确保 content script 已注入
  const ok = await ensureContentScript();
  if (ok) {
    try {
      const r = await chrome.tabs.sendMessage(currentTabId, { action: 'set_selectors', selectors: appState.selectors });
      if (r?.selectors) appState.selectors = r.selectors;
    } catch (e) {}
  }
  render();
}

function extractDomain(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

// ── Render ────────────────────────────────────────────────
function render() {
  // 站点标识
  const siteLabel = appState.domain 
    ? (appState.hasTemplate ? `✅ ${appState.domain}` : `🆕 ${appState.domain} (新站点)`)
    : '未知站点';
  document.querySelector('.header p').textContent = siteLabel;

  const s = appState.selectors;

  renderStep('input', 1, s.input, stepInput, step1Num, btnInput, selInput,
    appState.current === 'recording_input');

  const s2ready = !!s.input;
  stepSend.className = s2ready ? 'step-card' : 'step-card waiting';
  if (s2ready) {
    renderStep('send', 2, s.send, stepSend, step2Num, btnSend, selSend,
      appState.current === 'recording_send');
  } else {
    btnSend.disabled = false; btnSend.textContent = '⏺ 录制'; btnSend.className = 'step-btn btn-record';
    step2Num.className = 'step-num pending'; step2Num.textContent = '2'; selSend.textContent = '';
  }

  const s3ready = !!s.send;
  stepCopy.className = s3ready ? 'step-card' : 'step-card waiting';
  if (s3ready) {
    renderStep('response', 3, s.response, stepCopy, step3Num, btnCopy, selCopy,
      appState.current === 'recording_response');
  } else {
    btnCopy.disabled = false; btnCopy.textContent = '⏺ 录制'; btnCopy.className = 'step-btn btn-record';
    step3Num.className = 'step-num pending'; step3Num.textContent = '3'; selCopy.textContent = '';
  }

  updateStatusBar();
  renderConversations();

  const allDone = s.input && s.send;
  captureSection.style.display = allDone ? 'block' : 'none';

  // send-kind tab state
  tabShortcut.className = 'send-tab' + (appState.sendKind === 'shortcut' ? ' active' : '');
  tabEnter.className = 'send-tab' + ((appState.sendKind || 'enter') === 'enter' ? ' active' : '');
  tabButton.className = 'send-tab' + (appState.sendKind === 'button' ? ' active' : '');

  const hasConv = appState.conversationCount > 0;
  btnExport.disabled = !hasConv;
  btnSendServer.disabled = !hasConv;
}

function renderStep(role, num, sel, card, numEl, btn, selEl, rec) {
  if (sel) {
    card.className = 'step-card done';
    numEl.className = 'step-num done'; numEl.textContent = '✓';
    btn.textContent = '重录'; btn.className = 'step-btn btn-redo'; btn.disabled = false;
    const css = typeof sel.selector === 'string' ? sel.selector : (sel.selector?.css || sel.css || '?');
    const method = typeof sel.selector === 'object' ? (sel.selector?.method || '?') : (sel.method || '?');
    selEl.textContent = `${css} (${method})`;
  } else if (rec) {
    card.className = 'step-card active';
    numEl.className = 'step-num active'; numEl.textContent = num;
    btn.textContent = '⏹ 取消'; btn.className = 'step-btn btn-record'; btn.disabled = false;
    selEl.textContent = '';
  } else {
    card.className = 'step-card';
    numEl.className = 'step-num pending'; numEl.textContent = num;
    btn.textContent = '⏺ 录制'; btn.className = 'step-btn btn-record'; btn.disabled = false;
    selEl.textContent = '';
  }
}

function setStatus(type, msg) {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar status-' + type;
}

function updateStatusBar() {
  const s = appState.selectors;
  const allDone = s.input && s.send;
  if (appState.current.startsWith('recording_')) {
    const names = { input: '输入框', send_strategy: '发送方式', response: '回复区域' };
    setStatus('recording', `🔴 请点击页面上的${names[appState.current.replace('recording_','')] || '元素'}`);
  } else if (allDone) setStatus('ready', '✅ 全部就绪！');
  else if (s.input) setStatus('recording', '👉 继续录制下一步');
  else if (appState.domain && !appState.hasTemplate) setStatus('idle', `🆕 新站点 ${appState.domain} — 点击 ① 开始录制`);
  else setStatus('idle', '按顺序点击 ①②③ 开始录制');
}

function renderConversations() {
  convSection.style.display = appState.conversationCount > 0 ? 'block' : 'none';
  convCount.textContent = appState.conversationCount;
  if (!appState.conversations.length) {
    convList.innerHTML = '<div class="empty">暂无对话</div>'; return;
  }
  convList.innerHTML = appState.conversations.slice(-15).reverse().map(c => `
    <div class="conv-item">
      <div><span class="conv-user">👤</span> <span class="conv-text">${esc(c.user?.substring(0,100))}</span></div>
      <div><span class="conv-assistant">🤖</span> <span class="conv-text">${esc(c.assistant?.substring(0,100))}</span></div>
      <div class="conv-meta">${fmtTime(c.timestamp)} · ${c.source||'?'}</div>
    </div>`).join('');
}
function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
function fmtTime(ts) { if(!ts) return ''; return new Date(ts).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }

// ── 录制 ──────────────────────────────────────────────────
async function handleRecord(role) {
  if (!currentTabId) { setStatus('error', '❌ 无法获取当前标签页'); return; }

  // send_strategy may use enter/shortcut (no page click) or button (page click)
  if (role === 'send_strategy') {
    const kind = appState.sendKind || 'enter';
    if (kind === 'enter') {
      // default: save Enter as the send strategy without recording
      appState.selectors.send = { kind: 'enter', key: 'Enter', modifiers: [] };
      appState.current = 'send_strategy_done';
      chrome.runtime.sendMessage({ from:'popup', action:'update_state', state:{current:appState.current, domain:appState.domain, selectors: appState.selectors, sendKind: kind} });
      bindCurrentModelRoute();
      render();
      return;
    }
    if (kind === 'shortcut') {
      // record a keyboard shortcut — send to content script for key capture
      if (appState.current === 'recording_send_strategy') {
        try { await chrome.tabs.sendMessage(currentTabId, { action: 'cancel_record' }); } catch(e) {}
        appState.current = 'idle';
        chrome.runtime.sendMessage({ from:'popup', action:'update_state', state:{current:'idle',domain:appState.domain} });
        render(); return;
      }
      setStatus('recording', '🔴 请在输入框内按下你的快捷键组合...');
      render();
      if (!await ensureContentScript()) { setStatus('error', '❌ 无法注入脚本'); return; }
      try {
        const resp = await chrome.tabs.sendMessage(currentTabId, { action: 'record_shortcut' });
        handleRecordResponse(resp, 'send_strategy');
      } catch (e) { setStatus('error', '❌ 通信失败'); }
      return;
    }
    // kind === 'button' — fall through to page click recording
    role = 'send_button';
  }

  if (appState.current === `recording_${role}`) {
    try { await chrome.tabs.sendMessage(currentTabId, { action: 'cancel_record' }); } catch(e) {}
    appState.current = 'idle';
    chrome.runtime.sendMessage({ from:'popup', action:'update_state', state:{current:'idle',domain:appState.domain} });
    render(); return;
  }

  setStatus('recording', '🔴 等待点击...');
  render();

  // 确保注入
  if (!await ensureContentScript()) {
    setStatus('error', '❌ 无法注入脚本，请刷新页面');
    return;
  }

  try {
    const resp = await chrome.tabs.sendMessage(currentTabId, { action: `record_${role}` });
    handleRecordResponse(resp, role);
  } catch (e) {
    setStatus('error', '❌ 通信失败，请刷新页面');
  }
}

function handleRecordResponse(resp, role) {
  if (!resp) { setStatus('error', '❌ 无响应'); return; }
  if (resp.error) { setStatus('error', `❌ ${resp.error}`); return; }
  if (resp.status === 'listening') {
    appState.current = `recording_${role}`;
    const kind = role === 'send_strategy' ? appState.sendKind : undefined;
    chrome.runtime.sendMessage({ from:'popup', action:'update_state', state:{current:appState.current, domain:appState.domain, sendKind:kind} });
    render(); startPolling(role);
  }
  // 录制完成立即绑定；不能等待后续步骤的 popup 状态刷新。
  if (role === 'response' || role === 'send_strategy'
      || appState.selectors.input && appState.selectors.send) bindCurrentModelRoute();
}
function bindCurrentModelRoute() {
  const model = String(currentModel || '').trim().toLowerCase();
  if (!model || !appState.domain || !appState.selectors.input || !appState.selectors.send) return;
  chrome.runtime.sendMessage({
    from: 'popup', action: 'bind_model_route', model, domain: appState.domain
  }, r => addDebug(`模型绑定: ${model} → ${appState.domain} ${r?.ok ? '✅' : '⚠️'}`));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startPolling(role) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!currentTabId) { clearInterval(pollTimer); pollTimer=null; return; }
    try {
      const r = await chrome.tabs.sendMessage(currentTabId, { action:'get_selectors' });
      if (r?.selectors?.[role]) {
        appState.selectors = r.selectors;
        appState.current = `${role}_done`;
        chrome.runtime.sendMessage({ from:'popup', action:'update_state', state:{current:appState.current,domain:appState.domain} });
        clearInterval(pollTimer); pollTimer=null; render();
        // 录制完成发生在轮询回调里；此时 selectors 已经包含最新一步。
        if (role === 'response') bindCurrentModelRoute();
      }
    } catch(e) { clearInterval(pollTimer); pollTimer=null; }
  }, 500);
}

// ── Send-kind tab clicks ──────────────────────────────────
tabShortcut.addEventListener('click', () => { appState.sendKind = 'shortcut'; render(); });
tabEnter.addEventListener('click', () => { appState.sendKind = 'enter'; render(); });
tabButton.addEventListener('click', () => { appState.sendKind = 'button'; render(); });

// ── Auto Capture ──────────────────────────────────────────
btnCapture.addEventListener('click', async () => {
  debugLines = [];
  if (typeof debugLog !== 'undefined') debugLog.textContent = '';
  addDebug('开始自动抓取');
  const msg = msgInput.value.trim();
  if (!msg) { captureStatus.textContent = '⚠️ 请输入消息'; return; }
  if (!currentTabId) return;

  // 确保注入
  if (!await ensureContentScript()) {
    captureStatus.textContent = '❌ 无法注入，请刷新页面';
    return;
  }
  btnCapture.disabled = true; btnCapture.textContent = '⏳...';
  captureStatus.textContent = `🔄 正在输入...`;
  try {
    const currentDomain = appState.domain;
    const result = await new Promise(resolve => chrome.runtime.sendMessage({
      from: 'popup', action: 'browser_submit', message: msg, domain: currentDomain, tab_id: currentTabId, model: currentModel
    }, resolve));
    if (result?.error) throw new Error(result.error);
    captureStatus.textContent = `⏳ 后端已排队：${result.id}`;
    addDebug(`后端任务已提交：${result.id}`);
  } catch (e) {
    captureStatus.textContent = `❌ 后端提交失败: ${e.message}`;
    addDebug(`后端提交失败：${e.message}`);
  }
  btnCapture.disabled = false; btnCapture.textContent = '▶ 抓取';
});

// ── Bindings ──────────────────────────────────────────────
btnInput.addEventListener('click', ()=>handleRecord('input'));
btnSend.addEventListener('click', ()=>handleRecord('send'));
btnCopy.addEventListener('click', ()=>handleRecord('response'));
btnExport.addEventListener('click', ()=>{ chrome.runtime.sendMessage({from:'popup',action:'export_json'},()=>window.close()); });
btnSendServer.addEventListener('click', ()=>{ chrome.runtime.sendMessage({from:'popup',action:'export_to_server'}, r=>{ alert(r?.error?`⚠️ ${r.error}\n\n启动: python3 server/api_server.py`:`✅ 已导入 ${r?.imported||0} 条`); }); });
btnReset.addEventListener('click', async ()=>{
  if(currentTabId){ try{await chrome.tabs.sendMessage(currentTabId,{action:'clear_selectors'});}catch(e){} try{await chrome.tabs.sendMessage(currentTabId,{action:'cancel_record'});}catch(e){} }
  chrome.runtime.sendMessage({from:'popup',action:'reset',domain:appState.domain});
  appState.current='idle'; appState.selectors={input:null,send:null,response:null}; appState.hasTemplate=false; render();
});
btnClear.addEventListener('click', ()=>{ if(!confirm('清除所有对话？'))return; chrome.runtime.sendMessage({from:'popup',action:'clear_conversations'}); appState.conversations=[]; appState.conversationCount=0; render(); });
btnCopyLog.addEventListener('click', async ()=>{
  const text = debugLines.join('\n');
  try { await navigator.clipboard.writeText(text); captureStatus.textContent = '✅ 日志已复制'; }
  catch (e) { captureStatus.textContent = '❌ 复制日志失败'; }
});
btnClearLog.addEventListener('click', ()=>{
  debugLines = [];
  debugLog.textContent = '已清空';
});
btnCopyPageTrace.addEventListener('click', async ()=>{
  try { await navigator.clipboard.writeText(pageTraceLines.join('\n')); captureStatus.textContent = '✅ 页面日志已复制'; }
  catch (e) { captureStatus.textContent = '❌ 复制页面日志失败'; }
});
btnClearPageTrace.addEventListener('click', ()=>{
  pageTraceLines = [];
  pageTraceLog.textContent = '已清空';
});

setInterval(()=>{ chrome.runtime.sendMessage({from:'popup',action:'get_state',domain:appState.domain}, r=>{ if(r&&JSON.stringify({c:appState.current,s:appState.selectors,h:appState.hasTemplate})!==JSON.stringify({c:r.current,s:r.selectors,h:r.hasTemplate})){ appState=r;render(); }}); }, 2000);
window.addEventListener('unload',()=>{ if(pollTimer)clearInterval(pollTimer); });
init();
