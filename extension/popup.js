// Phantom Relay Popup v4 — 多站点，按域名自动切换模板
const $ = id => document.getElementById(id);

let appState = {
  domain: '',
  current: 'idle',
  selectors: { input: null, send: null, copy: null },
  conversations: [],
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

// ── Init ──────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  const domain = extractDomain(tab?.url || '');

  // 先从 background 按域名加载持久模板。
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
    renderStep('copy', 3, s.copy, stepCopy, step3Num, btnCopy, selCopy,
      appState.current === 'recording_copy');
  } else {
    btnCopy.disabled = false; btnCopy.textContent = '⏺ 录制'; btnCopy.className = 'step-btn btn-record';
    step3Num.className = 'step-num pending'; step3Num.textContent = '3'; selCopy.textContent = '';
  }

  updateStatusBar();
  renderConversations();

  const allDone = s.input && s.send && s.copy;
  captureSection.style.display = allDone ? 'block' : 'none';

  const hasConv = appState.conversationCount > 0;
  btnExport.disabled = !hasConv;
  btnSendServer.disabled = !hasConv;
}

function renderStep(role, num, sel, card, numEl, btn, selEl, rec) {
  if (sel) {
    card.className = 'step-card done';
    numEl.className = 'step-num done'; numEl.textContent = '✓';
    btn.textContent = '重录'; btn.className = 'step-btn btn-redo'; btn.disabled = false;
    selEl.textContent = `${sel.selector?.css || '?'} (${sel.selector?.method || '?'})`;
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
  const allDone = s.input && s.send && s.copy;
  if (appState.current.startsWith('recording_')) {
    const names = { input: '输入框', send: '发送按钮', copy: '复制按钮' };
    setStatus('recording', `🔴 请点击页面上的${names[appState.current.replace('recording_','')]}`);
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
    chrome.runtime.sendMessage({ from:'popup', action:'update_state', state:{current:appState.current,domain:appState.domain} });
    render(); startPolling(role);
  }
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
      }
    } catch(e) { clearInterval(pollTimer); pollTimer=null; }
  }, 500);
}

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
  const resp = await chrome.tabs.sendMessage(currentTabId, { action: 'auto_capture', message: msg });
  if (resp?.error) {
    const detail = resp.detail ? `：${resp.detail}` : '';
    captureStatus.textContent = `❌ ${resp.error}${detail}`;
    addDebug(`自动抓取失败：${resp.error}${detail}`, resp.debug || null);
  }
  else if (resp?.success) {
      captureStatus.textContent = '✅ 抓取成功！'; msgInput.value = '';
      chrome.runtime.sendMessage({ from:'popup', action:'save_conversation', user:resp.user, assistant:resp.assistant, source:appState.domain });
      setTimeout(() => { chrome.runtime.sendMessage({ from:'popup', action:'get_state', domain:appState.domain }, r => { if(r){appState=r;render();} }); }, 500);
    }
  } catch (e) { captureStatus.textContent = `❌ 失败: ${e.message}`; }
  btnCapture.disabled = false; btnCapture.textContent = '▶ 抓取';
});

// ── Bindings ──────────────────────────────────────────────
btnInput.addEventListener('click', ()=>handleRecord('input'));
btnSend.addEventListener('click', ()=>handleRecord('send'));
btnCopy.addEventListener('click', ()=>handleRecord('copy'));
btnExport.addEventListener('click', ()=>{ chrome.runtime.sendMessage({from:'popup',action:'export_json'},()=>window.close()); });
btnSendServer.addEventListener('click', ()=>{ chrome.runtime.sendMessage({from:'popup',action:'export_to_server'}, r=>{ alert(r?.error?`⚠️ ${r.error}\n\n启动: python3 server/api_server.py`:`✅ 已导入 ${r?.imported||0} 条`); }); });
btnReset.addEventListener('click', async ()=>{
  if(currentTabId){ try{await chrome.tabs.sendMessage(currentTabId,{action:'clear_selectors'});}catch(e){} try{await chrome.tabs.sendMessage(currentTabId,{action:'cancel_record'});}catch(e){} }
  chrome.runtime.sendMessage({from:'popup',action:'reset',domain:appState.domain});
  appState.current='idle'; appState.selectors={input:null,send:null,copy:null}; appState.hasTemplate=false; render();
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

setInterval(()=>{ chrome.runtime.sendMessage({from:'popup',action:'get_state',domain:appState.domain}, r=>{ if(r&&JSON.stringify({c:appState.current,s:appState.selectors,h:appState.hasTemplate})!==JSON.stringify({c:r.current,s:r.selectors,h:r.hasTemplate})){ appState=r; render(); }}); }, 2000);
window.addEventListener('unload',()=>{ if(pollTimer)clearInterval(pollTimer); });
init();
