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
  profileStatus: null,
  recordingRoute: null,
};
let currentTabId = null;
let pollTimer = null;
let debugLines = [];
let pageTraceLines = [];
const profileStatusPanel = $('profileStatusPanel');
const btnReverify = $('btnReverify');
const backendUrlInput = $('backendUrl');
const btnSaveBackend = $('btnSaveBackend');
const backendStatus = $('backendStatus');
const recordingRouteStatus = $('recordingRouteStatus');
const recordingRouteTarget = $('recordingRouteTarget');
const btnOpenRecordingPage = $('btnOpenRecordingPage');
const footer = document.querySelector('.footer');
let expectedContentScriptVersion = '';

function loadRuntimeDiagnostics() {
  return new Promise(resolve => chrome.runtime.sendMessage(
    { from: 'popup', action: 'get_extension_diagnostics' },
    response => resolve(response?.ok ? response : {})
  ));
}

async function renderRuntimeVersion() {
  const manifestVersion = chrome.runtime.getManifest?.().version || 'unknown';
  const diagnostics = await loadRuntimeDiagnostics();
  expectedContentScriptVersion = String(diagnostics.content_script_version || '');
  if (footer) {
    footer.textContent = `v${manifestVersion} · Phantom Relay`;
    footer.title = [
      `manifest ${manifestVersion}`,
      `background ${diagnostics.background_version || 'unknown'}`,
      `content ${expectedContentScriptVersion || 'unknown'}`
    ].join('\n');
  }
}

function setBackendStatus(message, error = false) {
  if (!backendStatus) return;
  backendStatus.textContent = message || '';
  backendStatus.style.color = error ? '#f85149' : '#8b949e';
}

function loadBackendConfig() {
  chrome.runtime.sendMessage({ from: 'popup', action: 'get_backend_config' }, (response) => {
    if (chrome.runtime.lastError) {
      setBackendStatus('无法读取后端配置', true);
      return;
    }
    if (!response?.ok) {
      setBackendStatus(response?.error || '无法读取后端配置', true);
      return;
    }
    backendUrlInput.value = response.backend_url || response.default_backend_url || '';
    setBackendStatus('默认地址可直接使用，也支持局域网后端');
  });
}

function saveBackendConfig() {
  const value = String(backendUrlInput?.value || '').trim();
  btnSaveBackend.disabled = true;
  setBackendStatus('保存中…');
  chrome.runtime.sendMessage({ from: 'popup', action: 'set_backend_config', backend_url: value }, (response) => {
    btnSaveBackend.disabled = false;
    if (chrome.runtime.lastError || !response?.ok) {
      setBackendStatus(response?.error || '后端地址无效', true);
      return;
    }
    backendUrlInput.value = response.backend_url;
    setBackendStatus('已保存，后台连接将使用此地址');
  });
}

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
  if (msg.type === 'selector_capture_rejected') {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    appState.current = 'idle';
    chrome.runtime.sendMessage({
      from: 'popup',
      action: 'update_state',
      state: { current: 'idle', domain: appState.domain }
    });
    setStatus('error', `❌ ${msg.detail || msg.error || '录制失败'}`);
    addDebug('selector_capture_rejected', {
      role: msg.role || '',
      error: msg.error || ''
    });
    render();
  }
  if (msg.type === 'page_trace') {
    addPageTrace(msg.entry || msg);
  }
});

// ── 确保 content script 已注入 ────────────────────────────
function acceptContentScriptPing(ping) {
  const actualVersion = String(ping?.content_script_version || '');
  if (ping?.pong !== true || !actualVersion) return false;

  // The popup and the page can outlive a hot-reloaded MV3 service worker.
  // In that window the worker diagnostic may report an older build even though
  // the live page content script is present and answers the recording
  // protocol. The live handshake is authoritative for popup-owned recording;
  // keep the drift visible without blocking a valid re-record operation.
  if (expectedContentScriptVersion && actualVersion !== expectedContentScriptVersion) {
    addDebug('content_script_version_drift', {
      expected: expectedContentScriptVersion,
      actual: actualVersion,
      action: 'accept_live_handshake'
    });
  }
  expectedContentScriptVersion = actualVersion;
  return true;
}

async function ensureContentScript() {
  if (!currentTabId) return false;
  if (!expectedContentScriptVersion) {
    const diagnostics = await loadRuntimeDiagnostics();
    expectedContentScriptVersion = String(diagnostics.content_script_version || '');
  }
  try {
    // 先试试直接通信
    const ping = await chrome.tabs.sendMessage(currentTabId, { action: 'ping' });
    if (acceptContentScriptPing(ping)) return true;
  } catch (e) {
    // 未注入 → 手动注入
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      files: ['backend_config.js', 'universal_bridge.js', 'profile_contract.js', 'profile_lifecycle.js', 'profile_health.js', 'selector_recovery.js', 'capture_lock.js', 'send_observation.js', 'response_observation.js', 'content.js']
    });
    await sleep(500);
    const ping = await chrome.tabs.sendMessage(currentTabId, { action: 'ping' });
    return acceptContentScriptPing(ping);
  } catch (e2) {
    addDebug('content_script_injection_failed', { error: e2?.message || String(e2) });
    return false;
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
        const inferred = resp?.model || r.phantomModel || '';
        currentModel = inferred;
        modelName.value = inferred;
        refreshRecordingRoute();
      });
    } else if (!r.phantomModel && appState.domain) {
      chrome.runtime.sendMessage({ from: 'popup', action: 'model_name_for_domain', domain: appState.domain }, (resp) => {
        const inferred = resp?.model || appState.domain.replace(/^www\./, '');
        currentModel = inferred;
        modelName.value = currentModel;
        if (inferred) setModel(inferred);
        refreshRecordingRoute();
      });
    } else {
      currentModel = r.phantomModel || (appState.domain ? appState.domain.replace(/^www\./, '') : '');
      modelName.value = currentModel;
      refreshRecordingRoute();
    }
    loadKnownModels();
  });
}

async function refreshRecordingRoute() {
  if (!recordingRouteStatus) return;
  const response = await new Promise(resolve => chrome.runtime.sendMessage({
    from: 'popup',
    action: 'get_recording_route',
    model: String(modelName?.value || currentModel || '').trim(),
    domain: appState.domain,
    current_url: appState.pageUrl,
  }, resolve));
  appState.recordingRoute = response?.ok ? response : null;
  renderRecordingRoute(response);
}

function renderRecordingRoute(route = appState.recordingRoute) {
  if (!recordingRouteStatus || !recordingRouteTarget) return;
  if (!route?.ok) {
    recordingRouteStatus.textContent = '未找到可用录制页，请先在当前网页完成录制或检查当前标签页。';
    recordingRouteTarget.textContent = '';
    return;
  }
  const current = appState.domain || '未知域名';
  if (route.matchesCurrentPage) {
    recordingRouteStatus.textContent = `当前页面 ${current} 与录制域名 ${route.targetDomain} 一致。`;
  } else {
    recordingRouteStatus.textContent = `当前页面 ${current} 不是录制域名 ${route.targetDomain}。`;
  }
  recordingRouteTarget.textContent = route.targetUrl || '';
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

modelName.addEventListener('change', () => { setModel(modelName.value.trim()); refreshRecordingRoute(); });
modelName.addEventListener('blur', () => { setModel(modelName.value.trim()); refreshRecordingRoute(); });

async function openRecordingPage() {
  btnOpenRecordingPage.disabled = true;
  btnOpenRecordingPage.textContent = '打开中…';
  const response = await new Promise(resolve => chrome.runtime.sendMessage({
    from: 'popup',
    action: 'open_recording_page',
    model: String(modelName?.value || currentModel || '').trim(),
    domain: appState.domain,
    current_url: appState.pageUrl,
    tab_id: currentTabId,
  }, resolve));
  if (response?.ok) {
    appState.recordingRoute = response;
    renderRecordingRoute(response);
    setStatus('ready', `已调出录制页：${response.targetDomain}`);
  } else {
    setStatus('error', `❌ 无法调出录制页：${response?.error || 'recording_route_missing'}`);
  }
  btnOpenRecordingPage.disabled = false;
  btnOpenRecordingPage.textContent = '打开录制页';
}

btnOpenRecordingPage.addEventListener('click', openRecordingPage);

// ── Init ──────────────────────────────────────────────────
async function init() {
  loadBackendConfig();
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
  if (appState.selectors?.input && !appState.selectors?.send && (appState.sendKind || 'enter') === 'enter') {
    await persistSendStrategy({ kind: 'enter', key: 'Enter', modifiers: [] });
  }
  render();
  await refreshRecordingRoute();

  // 确保 content script 已注入
  const ok = await ensureContentScript();
  if (ok) {
    try {
      const r = await chrome.tabs.sendMessage(currentTabId, {
        action: 'set_selectors',
        selectors: appState.selectors,
        profile_revision: appState.profileStatus?.revision || 0,
      });
      if (r?.selectors) appState.selectors = r.selectors;
    } catch (e) {}
  }
  await loadProfileStatus();
  render();
}

async function loadProfileStatus() {
  if (!appState.domain) return;
  const status = await new Promise(resolve => chrome.runtime.sendMessage(
    { from: 'popup', action: 'get_profile_status', domain: appState.domain }, resolve
  ));
  if (status?.profileStatus) appState.profileStatus = status.profileStatus;
}

function extractDomain(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function hasCompleteRecordedProfile(value) {
  if (!value?.input || !value?.send || !value?.profile) return false;
  const mode = String(value.profile?.capture?.mode || 'dom').trim().toLowerCase();
  if (mode === 'network' || mode === 'hybrid') return false;
  try {
    const normalized = PhantomRelayProfile.normalizeProfile(value.profile);
    return !!value.response && PhantomRelayProfile.hasRecordedIdentityVerification(normalized);
  } catch (_) {
    return false;
  }
}

async function persistSendStrategy(strategy) {
  const response = await new Promise(resolve => chrome.runtime.sendMessage({
    from: 'popup', action: 'save_send_strategy', domain: appState.domain,
    tab_id: currentTabId, strategy
  }, resolve));
  if (chrome.runtime.lastError || !response?.ok) {
    addDebug('send_strategy_save_failed', { error: response?.error || 'background_unavailable' });
    return null;
  }
  appState.selectors = response.selectors || { ...appState.selectors, send: strategy };
  if (response.sync_status === 'pending') {
    addDebug('send_strategy_saved_locally', { sync_status: response.sync_status });
  }
  return response;
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
    const responseReady = hasCompleteRecordedProfile(s);
    stepCopy.className = s3ready ? 'step-card' : 'step-card waiting';
    if (s3ready) {
        renderStep('response', 3, responseReady ? s.response : null, stepCopy, step3Num, btnCopy, selCopy,
          appState.current === 'recording_response');
        if (!responseReady && s.response) {
          selCopy.textContent = '旧 selector 无稳定身份，请重新录制回复区域';
        }
    } else {
    btnCopy.disabled = false; btnCopy.textContent = '⏺ 录制'; btnCopy.className = 'step-btn btn-record';
    step3Num.className = 'step-num pending'; step3Num.textContent = '3'; selCopy.textContent = '';
  }
  responseStepLabel.textContent = '回复区域';
  responseStepDesc.textContent = '点击任意已完成的 AI 回复正文，作为回复锚点';

  updateStatusBar();
  renderProfileStatusPanel();
  renderConversations();

  const allDone = hasCompleteRecordedProfile(s);
  captureSection.style.display = allDone ? 'block' : 'none';

  // send-kind tab state
  tabShortcut.className = 'send-tab' + (appState.sendKind === 'shortcut' ? ' active' : '');
  tabEnter.className = 'send-tab' + ((appState.sendKind || 'enter') === 'enter' ? ' active' : '');
  tabButton.className = 'send-tab' + (appState.sendKind === 'button' ? ' active' : '');

  const hasConv = appState.conversationCount > 0;
  btnExport.disabled = !hasConv;
  btnSendServer.disabled = !hasConv;
}

function renderProfileStatusPanel() {
  if (!profileStatusPanel || !window.PhantomRelayPopupProfileStatus) return;
  profileStatusPanel.innerHTML = window.PhantomRelayPopupProfileStatus.renderProfileStatus(
    appState.profileStatus || { state: 'unavailable', profileId: '', revision: 0, reasonCodes: [] }
  );
  if (btnReverify) btnReverify.disabled = !currentTabId || !appState.profileStatus?.profileId;
}

function renderStep(role, num, sel, card, numEl, btn, selEl, rec) {
  if (sel) {
    card.className = 'step-card done';
    numEl.className = 'step-num done'; numEl.textContent = '✓';
    const strategyKind = String(sel.kind || '').trim().toLowerCase();
    if (strategyKind === 'enter') {
      btn.textContent = '已采用'; btn.className = 'step-btn btn-redo'; btn.disabled = true;
      selEl.textContent = '回车（无需录制按钮）';
      return;
    }
    if (strategyKind === 'shortcut') {
      btn.textContent = '重录'; btn.className = 'step-btn btn-redo'; btn.disabled = false;
      selEl.textContent = `快捷键 ${sel.key || '未命名'}`;
      return;
    }
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
  const allDone = hasCompleteRecordedProfile(s);
  if (appState.current.startsWith('recording_')) {
    const names = { input: '输入框', send_strategy: '发送方式', response: '回复区域' };
    setStatus('recording', `🔴 页面已框出候选：移动鼠标查看${names[appState.current.replace('recording_','')] || '元素'}，点击确认`);
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
      // Enter is a real profile field. Persist it through the worker so the
      // content runtime, local storage, and backend receive the same bundle.
      const strategy = { kind: 'enter', key: 'Enter', modifiers: [] };
      const response = await persistSendStrategy(strategy);
      if (!response) {
        setStatus('error', '❌ 发送方式保存失败：background_unavailable');
        return;
      }
      appState.current = 'send_strategy_done';
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
      } catch (e) { setStatus('error', `❌ 通信失败：${e?.message || e}`); addDebug('record_shortcut_failed', { error: e?.message || String(e), tabId: currentTabId }); }
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

  setStatus('recording', '🔴 正在框选页面候选：移动鼠标查看，点击确认');
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
    setStatus('error', `❌ 通信失败：${e?.message || e}，请刷新页面`);
    addDebug('record_failed', { role, error: e?.message || String(e), tabId: currentTabId, pageUrl: appState.pageUrl });
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
  if (role === 'response' || role === 'send_strategy') bindCurrentModelRoute();
}
function bindCurrentModelRoute() {
  const model = String(currentModel || '').trim().toLowerCase();
  if (!model || !appState.domain || !hasCompleteRecordedProfile(appState.selectors)) return;
  chrome.runtime.sendMessage({
    from: 'popup', action: 'bind_model_route', model, domain: appState.domain,
    target_url: appState.pageUrl
  }, r => addDebug(`模型绑定: ${model} → ${appState.domain} ${r?.ok ? '✅' : '⚠️'}`));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function reverifyProfile() {
  if (!currentTabId || !appState.profileStatus?.profileId) {
    setStatus('error', '❌ 当前没有可验证的 active profile');
    return;
  }
  btnReverify.disabled = true;
  btnReverify.textContent = '验证中…';
  try {
    if (!await ensureContentScript()) throw new Error('content_script_unavailable');
    const response = await chrome.tabs.sendMessage(currentTabId, { action: 'get_profile_health' });
    const report = response?.profile_health;
    if (!report) throw new Error('profile_health_missing');
    const saved = await new Promise(resolve => chrome.runtime.sendMessage({
      from: 'popup', action: 'record_profile_health', domain: appState.domain, report
    }, resolve));
    if (saved?.error) throw new Error(saved.error);
    if (saved?.profileStatus) appState.profileStatus = saved.profileStatus;
    else appState.profileStatus = {
      ...(appState.profileStatus || {}),
      revision: report.revision,
      state: report.state,
      reasonCodes: report.reason_codes || [],
    };
    setStatus(report.state === 'verified' ? 'ready' : 'error',
      report.state === 'verified' ? '✅ Profile 已重新验证' : `⚠️ Profile ${report.state}`);
    addDebug('profile_health_verified', { state: report.state, reason_codes: report.reason_codes || [] });
    render();
  } catch (error) {
    setStatus('error', `❌ 重新验证失败：${error?.message || error}`);
    addDebug('profile_health_verify_failed', { error: error?.message || String(error) });
  } finally {
    btnReverify.disabled = false;
    btnReverify.textContent = '重新验证';
    renderProfileStatusPanel();
  }
}

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
        if (role === 'input' && (appState.sendKind || 'enter') === 'enter' && !appState.selectors.send) {
          await persistSendStrategy({ kind: 'enter', key: 'Enter', modifiers: [] });
        }
        if (role === 'response') bindCurrentModelRoute();
      }
    } catch(e) { clearInterval(pollTimer); pollTimer=null; }
  }, 500);
}

// ── Send-kind tab clicks ──────────────────────────────────
tabShortcut.addEventListener('click', () => { appState.sendKind = 'shortcut'; render(); });
tabEnter.addEventListener('click', async () => {
  appState.sendKind = 'enter';
  if (appState.selectors?.input) await handleRecord('send_strategy');
  else render();
});
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
    if (result?.error) {
      const error = new Error(result.error);
      error.code = result.code || '';
      throw error;
    }
    captureStatus.textContent = `⏳ 后端已排队：${result.id}`;
    addDebug(`后端任务已提交：${result.id}`);
  } catch (e) {
    const unavailable = e?.code === 'backend_unreachable' || /failed to fetch|networkerror/i.test(String(e?.message || ''));
    const message = unavailable
      ? '后端不可达，请确认后端正在运行并检查地址'
      : `后端提交失败：${e?.message || e}`;
    captureStatus.textContent = `❌ ${message}`;
    addDebug(message);
  }
  btnCapture.disabled = false; btnCapture.textContent = '▶ 抓取';
});

// ── Bindings ──────────────────────────────────────────────
btnInput.addEventListener('click', ()=>handleRecord('input'));
btnSend.addEventListener('click', ()=>handleRecord('send_strategy'));
btnCopy.addEventListener('click', ()=>handleRecord('response'));
btnExport.addEventListener('click', ()=>{ chrome.runtime.sendMessage({from:'popup',action:'export_json'},()=>window.close()); });
btnSendServer.addEventListener('click', ()=>{ chrome.runtime.sendMessage({from:'popup',action:'export_to_server'}, r=>{ alert(r?.error?`⚠️ ${r.error}\n\n启动: python3 server/api_server.py`:`✅ 已导入 ${r?.imported||0} 条`); }); });
btnReset.addEventListener('click', async ()=>{
  if(currentTabId){ try{await chrome.tabs.sendMessage(currentTabId,{action:'clear_selectors'});}catch(e){} try{await chrome.tabs.sendMessage(currentTabId,{action:'cancel_record'});}catch(e){} }
  chrome.runtime.sendMessage({from:'popup',action:'reset',domain:appState.domain});
  appState.current='idle'; appState.selectors={input:null,send:null,response:null,profile:null}; appState.hasTemplate=false; render();
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
btnReverify.addEventListener('click', reverifyProfile);
btnSaveBackend.addEventListener('click', saveBackendConfig);
backendUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveBackendConfig();
});

setInterval(()=>{ chrome.runtime.sendMessage({from:'popup',action:'get_state',domain:appState.domain}, r=>{ if(r&&JSON.stringify({c:appState.current,s:appState.selectors,h:appState.hasTemplate,p:appState.profileStatus})!==JSON.stringify({c:r.current,s:r.selectors,h:r.hasTemplate,p:r.profileStatus})){ appState=r;render(); }}); }, 2000);
window.addEventListener('unload',()=>{ if(pollTimer)clearInterval(pollTimer); });
renderRuntimeVersion();
init();
