// ============================================================
// Phantom Relay — Content Script (v2: Single-Action Recording)
// 每次录制只捕获一个元素 → 录完立刻停 → 防止乱按
// ============================================================

(function () {
  'use strict';
  // Static content_scripts 与 popup 的 executeScript fallback 可能同时注入。
  // DOM 属性跨 isolated world 共享，用它做真正的单例闸门；否则两个实例会
  // 同时点击发送，日志就会出现两套完全相同的 auto_capture/trace。
  const CONTENT_SCRIPT_VERSION = '2026-08-20.09'; // bounded worker-owned extension reload recovery
  const INSTANCE_MARKER = 'data-phantom-relay-content-instance';
  const INSTANCE_HEARTBEAT_MARKER = 'data-phantom-relay-content-heartbeat';
  const INSTANCE_OWNER_MARKER = 'data-phantom-relay-content-owner';
  const INSTANCE_EVENT_NAME = 'phantom-relay:content-instance-ping';
  const root = document.documentElement;
  // The manifest content script and the worker's executeScript fallback can
  // run in different isolated worlds. A window property cannot coordinate
  // those worlds, so use a DOM heartbeat handshake before starting another
  // runtime. A stale marker after an extension reload has no listener and is
  // therefore safely replaced.
  const markerVersion = root?.getAttribute(INSTANCE_MARKER) || '';
  if (markerVersion === CONTENT_SCRIPT_VERSION) {
    const heartbeatBefore = root?.getAttribute(INSTANCE_HEARTBEAT_MARKER) || '';
    const ownerBefore = root?.getAttribute(INSTANCE_OWNER_MARKER) || '';
    document.dispatchEvent(new Event(INSTANCE_EVENT_NAME));
    const heartbeatAfter = root?.getAttribute(INSTANCE_HEARTBEAT_MARKER) || '';
    if (ownerBefore && heartbeatAfter !== heartbeatBefore && heartbeatAfter.startsWith(`${CONTENT_SCRIPT_VERSION}:`)) return;
  }
  root?.removeAttribute(INSTANCE_HEARTBEAT_MARKER);
  root?.setAttribute(INSTANCE_MARKER, CONTENT_SCRIPT_VERSION);
  const instanceHeartbeatNonce = Math.random().toString(16).slice(2);
  root?.setAttribute(INSTANCE_OWNER_MARKER, instanceHeartbeatNonce);
  const instanceHeartbeat = () => `${CONTENT_SCRIPT_VERSION}:${Date.now()}:${instanceHeartbeatNonce}`;
  const acknowledgeInstance = () => {
    if (root?.getAttribute(INSTANCE_MARKER) === CONTENT_SCRIPT_VERSION
        && root?.getAttribute(INSTANCE_OWNER_MARKER) === instanceHeartbeatNonce) {
      root.setAttribute(INSTANCE_HEARTBEAT_MARKER, instanceHeartbeat());
    }
  };
  document.addEventListener(INSTANCE_EVENT_NAME, acknowledgeInstance, true);
  const touchInstanceHeartbeat = () => {
    if (root?.getAttribute(INSTANCE_OWNER_MARKER) === instanceHeartbeatNonce) {
      root.setAttribute(INSTANCE_HEARTBEAT_MARKER, instanceHeartbeat());
    }
  };
  touchInstanceHeartbeat();

  // 每次重新注入时让旧实例失效，避免 popup 收到两份响应/日志
  const generation = (window.__phantomRelayGeneration || 0) + 1;
  window.__phantomRelayGeneration = generation;
  const isCurrentGeneration = () => window.__phantomRelayGeneration === generation;
  const CaptureLock = window.PhantomRelayCaptureLock || null;
  const CAPTURE_LOCK_ATTRIBUTE = CaptureLock?.CAPTURE_LOCK_ATTRIBUTE || 'data-phantom-relay-capture-lock';
  const previousCaptureLockOwner = root?.getAttribute(CAPTURE_LOCK_ATTRIBUTE) || '';
  if (previousCaptureLockOwner && (
    CaptureLock?.lockNeedsClear?.(previousCaptureLockOwner, generation) ||
    (!CaptureLock && String(previousCaptureLockOwner) !== String(generation))
  )) {
    root.removeAttribute(CAPTURE_LOCK_ATTRIBUTE);
  }
  const pageSessionId = (globalThis.crypto?.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `page_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // ── 状态锁 ──────────────────────────────────────────────
  let lock = {
    active: false,        // 是否正在等待一次点击
    targetRole: null,     // 'input' | 'send' | 'response'
    captured: false,      // 本次是否已捕获
    callback: null,       // 捕获后回调
  };

  let selectors = {
    input: null,
    send: null,
    response: null,
    profile: null,
  };

  // A locally captured selector is only a candidate until the background
  // worker acknowledges persistence. The popup uses this gate to avoid
  // showing a false recorded state while profile sync is still pending.
  const selectorCaptureStatus = {
    input: null,
    send: null,
    response: null,
  };
  const pendingSelectorCaptures = new Map();

// 默认使用 Enter 发送；录制后会被具体策略覆盖。
  let sendStrategy = { kind: 'enter', key: 'Enter', modifiers: [] };
  let shortcutListening = false;
  let captureDebug = [];
  let pageTraceObserver = null;
  let pageTraceSeq = 0;
  let autoCaptureInFlight = false;
  let currentCaptureJobId = '';
  let captureCancelRequested = false;
  let captureCancelJobId = '';
  let captureCancelReason = '';
  let networkResponseObserved = false;
  let relayClientId = '';
  let highlightEl = null;
  const Universal = window.PhantomRelayUniversal || null;
  const ProfileContract = window.PhantomRelayProfile || null;
  const ProfileHealth = window.PhantomRelayProfileHealth || null;
  const SelectorRecovery = window.PhantomRelaySelectorRecovery || null;
  const SendObservation = window.PhantomRelaySendObservation || null;
  const ResponseObservation = window.PhantomRelayResponseObservation || null;
  let activeProfile = null;
  // Lifecycle metadata is runtime state, not part of the provider-neutral
  // profile contract. The background worker supplies the active revision when
  // it applies the authoritative selector template.
  let activeProfileRevision = 0;

  function normalizeProfileRevision(value) {
    const revision = Number(value);
    return Number.isInteger(revision) && revision > 0 ? revision : 0;
  }

  function cloneCaptureValue(value) {
    if (value == null || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function beginSelectorCapture(role) {
    const randomPart = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const captureId = `capture-${role}-${randomPart}`;
    pendingSelectorCaptures.set(role, {
      captureId,
      snapshot: {
        selectors: cloneCaptureValue(selectors),
        activeProfile: cloneCaptureValue(activeProfile),
        activeProfileRevision,
        sendStrategy: cloneCaptureValue(sendStrategy),
      },
    });
    return captureId;
  }

  function resolveSelectorCaptureAck(role, captureId, ack, runtimeError = '') {
    const pending = pendingSelectorCaptures.get(role);
    const acknowledgedCaptureId = String(ack?.capture_id || '').trim();
    if (!pending || pending.captureId !== captureId
        || (acknowledgedCaptureId && acknowledgedCaptureId !== captureId)) {
      emitPageTrace('selector_capture_ack_stale_ignored', {
        role,
        captureId,
        acknowledgedCaptureId,
      });
      return { ignored: true };
    }

    if (!runtimeError && ack?.ok) {
      pendingSelectorCaptures.delete(role);
      selectorCaptureStatus[role] = {
        state: 'accepted',
        capture_id: captureId,
        capturedAt: selectors[role]?.capturedAt || Date.now(),
        profile_revision: Number(ack.profile_revision || 0),
        profile_synced: ack.profile_synced !== false,
      };
      return { accepted: true };
    }

    selectors = cloneCaptureValue(pending.snapshot.selectors);
    activeProfile = cloneCaptureValue(pending.snapshot.activeProfile);
    activeProfileRevision = pending.snapshot.activeProfileRevision;
    sendStrategy = cloneCaptureValue(pending.snapshot.sendStrategy);
    pendingSelectorCaptures.delete(role);
    const error = runtimeError || ack?.error || 'selector_capture_ack_missing';
    const detail = ack?.detail || '';
    selectorCaptureStatus[role] = {
      state: 'rejected',
      capture_id: captureId,
      capturedAt: selectors[role]?.capturedAt || Date.now(),
      error,
      detail,
    };
    emitPageTrace('selector_capture_ack_failed', { role, captureId, error, detail });
    return { accepted: false, error, detail };
  }

  function refreshActiveProfile(candidate = selectors.profile) {
    activeProfile = null;
    if (!candidate || !ProfileContract) return null;
    try {
      // The profile stores the recording-time selector, while the authoritative
      // selector bundle may also contain verified alternatives learned during
      // recording or migration. Keep those alternatives in the health-check
      // profile so a stale primary class does not make the page unusable.
      const runtimeInputSelector = normalizeRecordedSelector(selectors.input);
      const profile = runtimeInputSelector
        ? { ...candidate, input: { ...(candidate.input || {}), selector: runtimeInputSelector } }
        : candidate;
      activeProfile = ProfileContract.normalizeProfile(profile);
      return activeProfile;
    } catch (error) {
      emitPageTrace('profile_contract_invalid', {
        code: error?.code || 'profile_invalid',
        detail: error?.message || String(error)
      });
      return null;
    }
  }

  function hasExecutablePageProfile() {
    if (!activeProfile || !ProfileContract || !selectorText(selectors.input)) return false;
    const mode = String(activeProfile.capture?.mode || 'dom').trim().toLowerCase();
    if (mode === 'network' || mode === 'hybrid') return false;
    if (!activeProfile.send || !activeProfile.response) return false;
    try {
      return ProfileContract.hasRecordedIdentityVerification(activeProfile);
    } catch (_) {
      return false;
    }
  }

  function responseContract() {
    if (String(activeProfile?.capture?.mode || '').trim().toLowerCase() === 'network') return null;
    if (activeProfile?.response) return activeProfile.response;
    return null;
  }

  function hasStreamingContract() {
    const indicators = responseContract()?.streamingIndicators;
    return Array.isArray(indicators) && indicators.length > 0;
  }

  function networkOnlyProfile() {
    return String(activeProfile?.capture?.mode || '').trim().toLowerCase() === 'network';
  }

  function runProfileHealthCheck(profile = activeProfile, options = {}) {
    if (!ProfileHealth || typeof ProfileHealth.runProfileHealthCheck !== 'function') {
      return {
        profile_id: String(profile?.profileId || ''),
        revision: 0,
        state: 'invalid',
        checks: { input: 'fail', send: 'fail', response: 'fail', identity: 'fail', streaming: 'fail' },
        reason_codes: ['profile_health_unavailable']
      };
    }
    return ProfileHealth.runProfileHealthCheck(profile, {
      requireRecordedIdentity: options.requireRecordedIdentity !== false,
      ...options,
      revision: activeProfileRevision,
      document: Object.prototype.hasOwnProperty.call(options, 'document') ? options.document : document,
      identityProbe: (element) => {
        if (!profile || !ProfileContract || !element) return false;
        return ProfileContract.messageIdentity(profile, elementRecord(element));
      }
    });
  }

  function profileHealthError(report) {
    if (ProfileHealth && typeof ProfileHealth.profileHealthError === 'function') {
      return ProfileHealth.profileHealthError(report);
    }
    const reasonCodes = Array.isArray(report?.reason_codes) ? report.reason_codes.slice() : [];
    return {
      error: reasonCodes[0] || 'profile_invalid',
      detail: `录制 profile 健康检查失败: ${reasonCodes.join(', ') || 'profile_invalid'}`,
      reason_codes: reasonCodes,
      profile_health: report || null,
      recoverable: true
    };
  }

  function responseSelectorSet() {
    const response = responseContract();
    if (!response) return [];
    return [response.selector, response.containerSelector]
      .filter(Boolean)
      .flatMap(value => [value.css, ...(value.alternatives || []), ...(SelectorRecovery?.deriveAlternatives?.(value) || [])])
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  function responseProjectionSelectorSet(value = responseContract()?.selector) {
    if (!value) return [];
    return [value.css || value.selector, ...(value.alternatives || []), ...(SelectorRecovery?.deriveAlternatives?.(value) || [])]
      .filter(Boolean)
      .filter((selector, index, values) => values.indexOf(selector) === index);
  }

  function recordedProjectionElements(value = responseContract()?.selector) {
    const elements = responseProjectionSelectorSet(value).flatMap(css => {
      try { return Array.from(document.querySelectorAll(css)); } catch (_) { return []; }
    });
    return Array.from(new Set(elements)).sort((left, right) => {
      if (left === right || typeof left.compareDocumentPosition !== 'function') return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function responseProjectionElements() {
    return recordedProjectionElements().filter(isWithinRecordedResponseScope);
  }

  function usesRecordedResponseIndexIdentity() {
    return String(responseContract()?.identity?.path || '') === 'recordedResponseIndex';
  }

  function recordedResponseScopeElements() {
    const response = responseContract();
    const tag = String(response?.elementTag || '').trim().toLowerCase();
    const container = response?.containerSelector;
    if (!/^[a-z][a-z0-9-]*$/.test(tag) || !container?.css) return [];
    const scopes = [];
    for (const css of [container.css, ...(container.alternatives || [])]) {
      try { scopes.push(...Array.from(document.querySelectorAll(css))); } catch (_) {}
    }
    return scopes.flatMap(scope => {
      try { return Array.from(scope.querySelectorAll(tag)); } catch (_) { return []; }
    });
  }

  function recordedResponseContainerSelectors() {
    const container = responseContract()?.containerSelector;
    if (!container) return [];
    return [container.css, ...(container.alternatives || []), ...(SelectorRecovery?.deriveAlternatives?.(container) || [])]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  function isWithinRecordedResponseScope(element) {
    const containerSelectors = recordedResponseContainerSelectors();
    if (!containerSelectors.length) return true;
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      if (containerSelectors.some(selector => matchesProfileSelector(current, selector))) return true;
    }
    return false;
  }

  function responseRegionElements() {
    if (usesRecordedResponseIndexIdentity()) return responseProjectionElements();
    const projections = responseProjectionElements().filter(isWithinRecordedResponseScope);
    const containers = recordedResponseContainerSelectors().flatMap(css => {
      try { return Array.from(document.querySelectorAll(css)); } catch (_) { return []; }
    }).filter(isWithinRecordedResponseScope);
    const fallbacks = Array.from(new Set([...containers, ...recordedResponseScopeElements()]));
    if (ResponseObservation?.mergeRecordedRegionElements) {
      return ResponseObservation.mergeRecordedRegionElements(
        projections,
        fallbacks,
        element => messageIdentity(element),
      );
    }
    return projections.length ? projections : fallbacks;
  }

  function elementDepth(element) {
    let depth = 0;
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      depth += 1;
    }
    return depth;
  }

  function recordedProjectionSpecificity(element) {
    const selectors = responseProjectionSelectorSet();
    for (let index = 0; index < selectors.length; index += 1) {
      if (matchesProfileSelector(element, selectors[index])) return selectors.length - index + 1;
    }
    return 0;
  }

  function recordedResponseActivityScope(element) {
    if (!element) return null;
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      if (recordedResponseContainerSelectors().some(selector => matchesProfileSelector(current, selector))) {
        return current;
      }
    }
    return declaredIdentityElement(element) || element;
  }

  function recordedResponseActivityToken(snapshot) {
    if (!snapshot?.region) return '';
    const scope = recordedResponseActivityScope(snapshot.region);
    if (!scope) return '';
    const scopeText = ProfileContract.normalizeText(activeProfile, extractMessageText(scope));
    let elementCount = 0;
    try { elementCount = scope.querySelectorAll?.('*')?.length || 0; } catch (_) {}
    return JSON.stringify({
      key: snapshot.key || '',
      selectedTextLength: String(snapshot.text || '').length,
      scopeTextLength: scopeText.length,
      elementCount,
      streaming: !!snapshot.streaming,
    });
  }

  function declaredIdentityElement(element) {
    const attributes = Array.isArray(responseContract()?.identity?.attributes)
      ? responseContract().identity.attributes
      : [];
    if (!attributes.length) return null;
    let current = element;
    // Recorded response selectors can point deep inside a virtualized message
    // row. The profile already declares which attributes are authoritative, so
    // walk to the document boundary instead of imposing a site-shaped depth.
    for (; current && current !== document.documentElement; current = current.parentElement) {
      if (attributes.some(attribute => {
        try { return !!String(current.getAttribute(attribute) || '').trim(); } catch (_) { return false; }
      })) return current;
    }
    return null;
  }

  function matchesProfileSelector(node, selector) {
    if (!node || !selector) return false;
    try { return !!node.matches?.(selector); } catch (_) { return false; }
  }

  function matchesElementOrAncestor(node, selector) {
    for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
      if (matchesProfileSelector(current, selector)) return true;
    }
    return false;
  }

  function matchesElementOrDescendant(node, selector) {
    if (!node || !selector) return false;
    if (matchesProfileSelector(node, selector)) return true;
    try { return !!node.querySelector?.(selector); } catch (_) { return false; }
  }

  function selectorStateAttribute(selector) {
    const match = String(selector || '').match(/^\[\s*([a-zA-Z_:][\w:.-]*)\s*=\s*(['"])(.*?)\2\s*\]$/);
    return match ? match[1] : '';
  }

  function attributeElementOrAncestor(node, attribute) {
    for (let current = node, depth = 0;
      current && current !== document.documentElement && depth < 24;
      current = current.parentElement, depth += 1) {
      if (current.hasAttribute?.(attribute)) return current;
    }
    return null;
  }

  function elementRecord(el) {
    const response = responseContract();
    let identityElement = el;
    // A recorded response selector often points at an inner text node while
    // the stable identity lives on its message row. Prefer the profile's
    // declared identity attribute while walking ancestors; a generated
    // container selector is only a fallback for profiles whose identity is
    // exposed on that exact container.
    const declared = declaredIdentityElement(el);
    if (declared) {
      identityElement = declared;
    } else if (response?.containerSelector?.css && el?.closest) {
      try { identityElement = el.closest(response.containerSelector.css) || el; } catch (_) {}
    }
    const attributes = {};
    for (const attribute of Array.from(el?.attributes || [])) attributes[attribute.name] = attribute.value;
    for (const attribute of Array.from(identityElement?.attributes || [])) {
      if (attributes[attribute.name] == null) attributes[attribute.name] = attribute.value;
    }
    const indicatorStates = (response?.streamingIndicators || [])
      .filter(indicator => indicator.selector)
      .map(indicator => {
        const matched = matchesElementOrDescendant(el, indicator.selector) ||
          matchesElementOrDescendant(identityElement, indicator.selector) ||
          matchesElementOrAncestor(el, indicator.selector) ||
          matchesElementOrAncestor(identityElement, indicator.selector);
        const attribute = selectorStateAttribute(indicator.selector);
        const attributeElement = attribute
          ? (attributeElementOrAncestor(el, attribute) || attributeElementOrAncestor(identityElement, attribute))
          : null;
        return {
          selector: indicator.selector,
          observed: matched || !!attributeElement,
          matched,
        };
      });
    const streamingSelectors = indicatorStates
      .filter(state => state.matched)
      .map(state => state.selector);
    const projectionElements = usesRecordedResponseIndexIdentity()
      ? responseProjectionElements()
      : [];
    const projectionElement = projectionElements.find(item => (
      item === el || item.contains?.(el) || el?.contains?.(item)
    ));
    const recordedResponseIndex = projectionElement
      ? projectionElements.indexOf(projectionElement)
      : -1;
    return {
      attributes,
      ...(recordedResponseIndex >= 0 ? { recordedResponseIndex } : {}),
      role: attributes['data-role'] || attributes.role || attributes['data-message-role'] || '',
      messageRole: attributes['data-message-role'] || '',
      busy: attributes['aria-busy'] === 'true' || attributes['data-streaming'] === 'true',
      ariaBusy: attributes['aria-busy'] === 'true',
      loading: !!el.querySelector?.('[aria-busy="true"], [data-streaming="true"]') ||
        !!identityElement.querySelector?.('[aria-busy="true"], [data-streaming="true"]'),
      selectors: streamingSelectors,
      indicatorStates,
    };
  }

  function pageNodeInfo(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return { nodeType: node?.nodeType || null };
    const attrs = {};
    for (const name of ['id', 'class', 'role', 'aria-label', 'disabled', 'style', 'data-testid']) {
      if (el.hasAttribute?.(name)) attrs[name] = el.getAttribute(name);
    }
    return {
      tag: el.tagName,
      path: cssPath(el),
      attrs
    };
  }

  // Page text is required only inside the capture algorithm. It is not
  // diagnostic data. Keep traces metadata-only so prompts, assistant output,
  // and arbitrary page HTML cannot leak into the local trace file or API.
  function sanitizeTraceValue(value, key = '', depth = 0) {
    if (depth > 5) return undefined;
    const normalizedKey = String(key || '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();
    const lengthMetadata = /^(?:text|assistant|input_value|value|body|response_text|best_text|latest_observed_text)_(?:length|len)$/;
    const forbiddenPageContentFields = new Set([
      'text', 'html', 'content', 'prompt', 'assistant', 'user_message',
      'input_value', 'value', 'body', 'page_text', 'response_text',
      'input_value_preview', 'value_preview', 'body_tail', 'user_message_preview',
    ]);
    const pageContentKey = /(?:^|_)(?:text|html|content|prompt|assistant|user_message|input_value|value|body|page_text|response_text|title|url|stack)(?:_|$)/;
    if (forbiddenPageContentFields.has(normalizedKey) || (!lengthMetadata.test(normalizedKey) && pageContentKey.test(normalizedKey))) return undefined;
    if (Array.isArray(value)) return value.map(item => sanitizeTraceValue(item, '', depth + 1)).filter(item => item !== undefined);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        const clean = sanitizeTraceValue(childValue, childKey, depth + 1);
        if (clean !== undefined) out[childKey] = clean;
      }
      return out;
    }
    if (typeof value === 'string' && value.length > 256) return value.slice(0, 256);
    return value;
  }

  function emitPageTrace(kind, data = {}) {
    if (!isCurrentGeneration()) return;
    const cleanData = sanitizeTraceValue(data) || {};
    const entry = { seq: ++pageTraceSeq, page_session_id: pageSessionId, time: new Date().toISOString(), kind, ...cleanData };
    console.debug('[Phantom Relay][PAGE_TRACE]', entry);
    chrome.runtime.sendMessage({
      type: 'page_trace', page_session_id: pageSessionId, entry
    }).catch(() => {});
  }

  function startPageTrace(reason) {
    stopPageTrace();
    pageTraceSeq = 0;
    emitPageTrace('trace_start', {
      reason,
      hostname: location.hostname,
      readyState: document.readyState,
      copySelector: selectors.copy?.selector?.css || null,
      copyCount: getCopyButtons().length
    });
    pageTraceObserver = new MutationObserver((mutations) => {
      if (!isCurrentGeneration()) return;
      for (const m of mutations) {
        emitPageTrace('mutation', {
          mutationType: m.type,
          target: pageNodeInfo(m.target),
          attributeName: m.attributeName || null,
          oldValue: m.oldValue || null,
          added: Array.from(m.addedNodes).slice(0, 20).map(pageNodeInfo),
          removed: Array.from(m.removedNodes).slice(0, 20).map(pageNodeInfo),
          copyCount: getCopyButtons().length
        });
      }
    });
    pageTraceObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      characterDataOldValue: true
    });
  }

  function stopPageTrace() {
    if (pageTraceObserver) {
      pageTraceObserver.disconnect();
      pageTraceObserver = null;
      emitPageTrace('trace_stop', { copyCount: getCopyButtons().length });
    }
  }

  function reportCaptureProgress(message, details = null) {
    if (!isCurrentGeneration()) return;
    const safeDetails = sanitizeTraceValue(details);
    captureDebug.push(`${new Date().toISOString()} ${message}${safeDetails ? ` ${JSON.stringify(safeDetails)}` : ''}`);
    if (captureDebug.length > 30) captureDebug.shift();
    chrome.runtime.sendMessage({
      type: 'capture_progress',
      page_session_id: pageSessionId,
      message,
      debug: captureDebug.slice(-10)
    }).catch(() => {});
  }

  async function postBrowserResultWithRetry(payload, label = 'direct_result') {
    if (!payload?.job_id) return false;
    const clientId = String(payload.client_id || relayClientId || '');
    if (clientId) payload = { ...payload, client_id: clientId };
    emitPageTrace('direct_result_relay_requested', { label, jobId: payload.job_id, assistantLength: String(payload?.assistant || '').length });
    // The worker owns the server result submission. Wait only for its bounded
    // localhost POST acknowledgement; this is separate from the long-running
    // auto_capture trigger and lets transient worker/API failures retry safely.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = Date.now();
      try {
        const ack = await new Promise(resolve => {
          let settled = false;
          const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(value || { ok: false, error: 'result_relay_empty_ack' });
          };
          const timeoutId = setTimeout(
            () => finish({ ok: false, error: 'result_relay_ack_timeout' }),
            5000,
          );
          try {
            chrome.runtime.sendMessage({ type: 'browser_result_relay', payload }, value => {
              const runtimeError = chrome.runtime.lastError;
              finish(runtimeError
                ? { ok: false, error: runtimeError.message || 'result_relay_runtime_error' }
                : value);
            });
          } catch (error) {
            finish({ ok: false, error: error?.message || String(error) });
          }
        });
        if (ack?.ok) {
          emitPageTrace('direct_result_relay_acknowledged', { label, jobId: payload.job_id, attempt, waitedMs: Date.now() - started });
          return true;
        }
        emitPageTrace('direct_result_relay_rejected', {
          label,
          jobId: payload.job_id,
          attempt,
          status: Number(ack?.status || 0),
          error: String(ack?.error || 'result_relay_failed'),
          waitedMs: Date.now() - started,
        });
      } catch (error) {
        emitPageTrace('direct_result_relay_dispatch_failed', { label, jobId: payload.job_id, attempt, error: error?.message || String(error), waitedMs: Date.now() - started });
      }
      if (attempt < 3) await sleep(attempt * 1000);
    }
    return false;
  }

  function relayCaptureSnapshot(candidate, context = {}) {
    if (!candidate?.text || !context?.jobId) return;
    try {
      chrome.runtime.sendMessage({
        type: 'capture_delta',
        page_session_id: pageSessionId,
        job_id: context.jobId,
        claim_token: context.claimToken || '',
        conversation_id: context.conversationId || '',
        tab_id: context.tabId,
        key: candidate.key || '',
        text: candidate.text,
        // This is an intermediate DOM snapshot. The terminal state is
        // reported separately through /browser/result after the page activity
        // boundary and repeated identity-checked snapshot boundary.
        streaming: true,
        completion_reason: ''
      }).catch(() => {});
    } catch (_) {}
  }

  // ── 高亮 ────────────────────────────────────────────────
  function highlight(el, color = '#00E676') {
    clearHighlight();
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '2px';
    el.style.transition = 'outline 0.15s';
    highlightEl = el;
  }

  function clearHighlight() {
    if (highlightEl) {
      highlightEl.style.outline = '';
      highlightEl.style.outlineOffset = '';
      highlightEl.style.transition = '';
      highlightEl = null;
    }
  }

  // ── 录制候选框 ──────────────────────────────────────────
  // Recording used to ask the user to click a page element without showing
  // what would actually be captured. Keep this overlay provider-neutral: it
  // only visualizes generic DOM candidates and never becomes part of selector
  // discovery or replay.
  let recordingOverlayHost = null;
  let recordingOverlayShadow = null;
  let recordingOverlayRole = '';
  let recordingOverlayPointerHandler = null;
  let recordingOverlayKeyHandler = null;
  let recordingOverlayRefreshRaf = 0;
  let recordingOverlayMutationObserver = null;
  let recordingOverlayHover = null;
  let recordingOverlayHoverLabel = null;
  let recordingOverlayCandidates = [];
  const recordingOverlayRoleLabels = Object.freeze({
    input: '输入框候选',
    send: '发送按钮候选',
    response: '回复候选'
  });

  function recordingElementVisible(element) {
    if (!element || element === recordingOverlayHost || !element.getClientRects?.().length) return false;
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'SVG', 'PATH'].includes(element.tagName)) return false;
    try {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch (_) {
      return false;
    }
  }

  function recordingIdentityHints(element) {
    const names = ['data-message-id', 'data-lid', 'data-row-key', 'data-id', 'data-key', 'id'];
    return names.filter(name => String(element?.getAttribute?.(name) || '').trim()).slice(0, 2);
  }

  const recordingResponseSemanticPattern = /(?:^|[-_\s])(?:message|answer|response|reply|assistant|markdown|output|result|turn)(?:[-_\s]|$)/i;
  const recordingResponseStructuralPattern = /(?:^|[-_\s])(?:app|root|conversation|chat|container|wrapper|scroll|layout|header|footer|aside|nav|toolbar|panel|page|flow|history|input|tool|login|body)(?:[-_\s]|$)/i;
  const recordingResponseControlPattern = /(?:^|[-_\s])(?:menu|hover|feedback|rating|action|control|copy|retry|regenerate|like|dislike)(?:[-_\s]|$)/i;

  function recordingResponseElementSignature(element) {
    const className = typeof element?.className === 'string'
      ? element.className
      : String(element?.className?.baseVal || '');
    const attributes = Array.from(element?.attributes || []).map(attribute => attribute.name).join(' ');
    return [
      String(element?.tagName || ''),
      String(element?.id || ''),
      className,
      String(element?.getAttribute?.('role') || ''),
      String(element?.getAttribute?.('aria-label') || ''),
      attributes
    ].join(' ');
  }

  function recordingResponseIdentityAnchor(element) {
    let current = element;
    for (let depth = 0; current && current !== document.body && depth < 24; depth += 1, current = current.parentElement) {
      const hints = recordingIdentityHints(current);
      if (hints.some(name => name !== 'id')) return current;
      const id = String(current.getAttribute('id') || '').trim();
      // A semantic message id groups inner text projections under one visible
      // candidate. Layout ids such as conversation roots are deliberately
      // excluded so they cannot become a response recording anchor.
      if (id && recordingResponseSemanticPattern.test(id) && !recordingResponseStructuralPattern.test(id)) return current;
    }
    return null;
  }

  function recordingResponseCandidateAllowed(element, textLength) {
    if (!recordingElementVisible(element) || textLength < 2 || textLength > 1600) return false;
    if (element.matches?.('button, a, input, textarea, select, [role="button"], [contenteditable="true"]')) return false;
    if (element.querySelector?.('button, a, input, textarea, select, [role="button"], [contenteditable="true"]')) return false;

    const signature = recordingResponseElementSignature(element);
    const hints = recordingIdentityHints(element);
    const hasDataIdentity = hints.some(name => name !== 'id');
    const hasSemanticSignal = recordingResponseSemanticPattern.test(signature);
    const hasControlSignal = recordingResponseControlPattern.test(signature);
    const hasSemanticTag = /^(article|main|section|li|p)$/.test(String(element.tagName || '').toLowerCase()) ||
      ['article', 'listitem', 'main'].includes(String(element.getAttribute?.('role') || '').toLowerCase());
    const hasStructuralSignal = recordingResponseStructuralPattern.test(signature);
    const childElements = Array.from(element.children || []);
    const hasTextBearingChild = childElements.some(child => {
      const childText = String(child.innerText || child.textContent || '').trim();
      return childText.length > 1 && childText.length >= textLength * 0.95;
    });
    const hasFocusedProjection = childElements.some(child => {
      const childText = String(child.innerText || child.textContent || '').trim();
      return childText.length >= 2 && childText.length < textLength * 0.9 &&
        recordingResponseSemanticPattern.test(recordingResponseElementSignature(child));
    });
    const rect = element.getBoundingClientRect();
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const coversMostViewport = (rect.width * rect.height) / viewportArea >= 0.7;

    if (hasControlSignal) return false;
    // Structural layout nodes are not useful response boundaries. A generic
    // identity or message/content semantic signal is enough to keep a real
    // message projection, regardless of the provider's DOM vocabulary.
    if (hasStructuralSignal && !hasSemanticSignal && (!hasDataIdentity || hasFocusedProjection)) return false;
    if (coversMostViewport && !hasDataIdentity && !hasSemanticSignal) return false;
    if (!hasDataIdentity && !hasSemanticSignal && !hasSemanticTag && (hasTextBearingChild || childElements.length > 3)) return false;
    return hasDataIdentity || hasSemanticSignal || hasSemanticTag;
  }

  function recordingCandidateForTarget(target, role) {
    if (!target || target === recordingOverlayHost) return null;
    if (role === 'input') {
      return target.closest?.('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]') || null;
    }
    if (role === 'send') {
      return target.closest?.('button, [role="button"], input[type="submit"], [onclick]') || null;
    }
    if (role === 'response') {
      const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
      if (!element) return null;
      const candidates = recordingOverlayCandidates.length
        ? recordingOverlayCandidates
        : recordingCandidateElements(role);
      const boxed = candidates.find(candidate => (
        candidate === element || candidate.contains?.(element)
      ));
      if (boxed) return boxed;
      let current = element;
      while (current && current !== document.body && current.textContent.trim().length < 2) current = current.parentElement;
      return current && current !== document.body ? current : null;
    }
    return null;
  }

  function recordingCandidateElements(role) {
    const selectorsByRole = {
      input: 'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]',
      send: 'button, [role="button"], input[type="submit"], [onclick]',
      response: 'article, section, main, li, div, p, span'
    };
    const selector = selectorsByRole[role];
    if (!selector) return [];
    let elements = [];
    try { elements = Array.from(document.querySelectorAll(selector)); } catch (_) { return []; }
    const candidates = elements.filter(element => {
      if (role !== 'response') return recordingElementVisible(element);
      const length = String(element.innerText || element.textContent || '').trim().length;
      return recordingResponseCandidateAllowed(element, length);
    }).map((element, index) => {
      const textLength = String(element.innerText || element.textContent || '').trim().length;
      const hints = recordingIdentityHints(element);
      const signature = recordingResponseElementSignature(element);
      const semanticSignal = role === 'response' && recordingResponseSemanticPattern.test(signature);
      const semanticTag = /^(article|section|main|li|p)$/.test(element.tagName.toLowerCase());
      const hasElementChildText = Array.from(element.children || []).some(child => {
        const childText = String(child.innerText || child.textContent || '').trim();
        return childText.length > 1 && childText.length >= textLength * 0.95;
      });
      const identityAnchor = role === 'response' ? recordingResponseIdentityAnchor(element) : null;
      const hasDataIdentity = hints.some(name => name !== 'id');
      const hasFocusedProjection = Array.from(element.children || []).some(child => {
        const childText = String(child.innerText || child.textContent || '').trim();
        return childText.length >= 2 && childText.length < textLength * 0.9 &&
          recordingResponseSemanticPattern.test(recordingResponseElementSignature(child));
      });
      const rect = element.getBoundingClientRect();
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
      const areaPenalty = role === 'response'
        ? Math.min(20, (rect.width * rect.height / viewportArea) * 20)
        : 0;
      const score = role === 'response'
        ? (hasDataIdentity ? 35 : 0) + (semanticSignal ? 50 : 0) + (semanticTag ? 18 : 0) +
          (identityAnchor && identityAnchor !== element ? 35 : 0) + (hasElementChildText ? -15 : 12) -
          (hasFocusedProjection ? 55 : 0) + areaPenalty * -1 - Math.min(12, textLength / 140)
        : (hints.length ? 5 : 0) - index / 10000;
      return { element, score, textLength, hints, identityAnchor };
    });
    candidates.sort((a, b) => b.score - a.score || a.textLength - b.textLength);

    if (role !== 'response') return candidates.slice(0, 40).map(item => item.element);
    const responseGroups = new Map();
    for (const item of candidates) {
      const groupKey = item.identityAnchor || item.element;
      const existing = responseGroups.get(groupKey);
      if (!existing || item.score > existing.score || (item.score === existing.score && item.textLength < existing.textLength)) {
        responseGroups.set(groupKey, item);
      }
    }
    const selectedItems = Array.from(responseGroups.values())
      .sort((a, b) => b.score - a.score || a.textLength - b.textLength);
    const selected = [];
    for (const item of selectedItems) {
      const isBroadAncestor = selected.some(existing =>
        item.element.contains?.(existing.element) && item.textLength > existing.textLength + 2
      );
      if (isBroadAncestor) continue;
      selected.push(item);
    }
    return selected.slice(0, role === 'response' ? 24 : 40).map(item => item.element);
  }

  function recordingOverlayLabelFor(element, role) {
    const tag = String(element?.tagName || 'element').toLowerCase();
    const hints = recordingIdentityHints(element);
    const identityAnchor = role === 'response' ? recordingResponseIdentityAnchor(element) : null;
    const anchorHints = recordingIdentityHints(identityAnchor);
    const identity = hints.length ? ` · ${hints.join(', ')}` : '';
    const anchor = role === 'response' && anchorHints.length &&
      !anchorHints.some(name => hints.includes(name))
      ? ` · 身份锚点 ${anchorHints.join(', ')}`
      : '';
    return `${recordingOverlayRoleLabels[role] || '页面元素'} · ${tag}${identity}${anchor}`;
  }

  function createRecordingOverlay() {
    const host = document.createElement('div');
    host.setAttribute('data-phantom-relay-recording-overlay', 'true');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    document.documentElement.appendChild(host);
    recordingOverlayHost = host;
    recordingOverlayShadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    recordingOverlayShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .candidate, .hover { position: fixed; box-sizing: border-box; pointer-events: none; }
        .candidate { border: 1px dashed rgba(88,166,255,.8); background: rgba(88,166,255,.07); }
        .candidate-label, .hover-label, .hint { position: absolute; font: 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; white-space: nowrap; color: #f0f6fc; background: #0d1117; border: 1px solid #58a6ff; border-radius: 4px; padding: 3px 6px; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
        .candidate-label { top: -22px; left: -1px; opacity: .92; }
        .hover { border: 2px solid #f0883e; background: rgba(240,136,62,.12); }
        .hover-label { top: -26px; left: -2px; color: #fff; border-color: #f0883e; font-weight: 600; }
        .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); border-color: #3fb950; color: #aff5b4; }
      </style>
      <div class="hint">移动鼠标查看候选，点击确认；按 Esc 取消</div>`;
    return recordingOverlayShadow;
  }

  function positionRecordingOverlayBox(box, element) {
    if (!box || !recordingElementVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    box.style.left = `${Math.max(0, rect.left)}px`;
    box.style.top = `${Math.max(0, rect.top)}px`;
    box.style.width = `${Math.max(2, rect.width)}px`;
    box.style.height = `${Math.max(2, rect.height)}px`;
    return true;
  }

  function refreshRecordingOverlay() {
    if (!recordingOverlayShadow || !recordingOverlayRole) return;
    recordingOverlayShadow.querySelectorAll('.candidate').forEach(node => node.remove());
    const fragment = document.createDocumentFragment();
    recordingOverlayCandidates = recordingCandidateElements(recordingOverlayRole);
    for (const element of recordingOverlayCandidates) {
      const box = document.createElement('div');
      box.className = 'candidate';
      if (!positionRecordingOverlayBox(box, element)) continue;
      const label = document.createElement('span');
      label.className = 'candidate-label';
      label.textContent = recordingOverlayLabelFor(element, recordingOverlayRole);
      box.appendChild(label);
      fragment.appendChild(box);
    }
    recordingOverlayShadow.appendChild(fragment);
  }

  function scheduleRecordingOverlayRefresh() {
    if (recordingOverlayRefreshRaf) return;
    recordingOverlayRefreshRaf = requestAnimationFrame(() => {
      recordingOverlayRefreshRaf = 0;
      refreshRecordingOverlay();
    });
  }

  function isRecordingOverlayNode(node) {
    if (!node || !recordingOverlayHost) return false;
    if (node === recordingOverlayHost) return true;
    if (recordingOverlayShadow && node.getRootNode?.() === recordingOverlayShadow) return true;
    try {
      return node.closest?.('[data-phantom-relay-recording-overlay]') === recordingOverlayHost;
    } catch (_) {
      return false;
    }
  }

  function recordingOverlayMutationIsPageChange(records) {
    return Array.from(records || []).some(record => {
      if (isRecordingOverlayNode(record.target)) return false;
      const changedNodes = [
        ...Array.from(record.addedNodes || []),
        ...Array.from(record.removedNodes || [])
      ];
      if (changedNodes.length && changedNodes.every(isRecordingOverlayNode)) return false;
      return true;
    });
  }

  function updateRecordingOverlayHover(target) {
    const element = recordingCandidateForTarget(target, recordingOverlayRole);
    if (!element || !recordingOverlayShadow) return;
    if (!recordingOverlayHover) {
      recordingOverlayHover = document.createElement('div');
      recordingOverlayHover.className = 'hover';
      recordingOverlayHoverLabel = document.createElement('span');
      recordingOverlayHoverLabel.className = 'hover-label';
      recordingOverlayHover.appendChild(recordingOverlayHoverLabel);
      recordingOverlayShadow.appendChild(recordingOverlayHover);
    }
    if (!positionRecordingOverlayBox(recordingOverlayHover, element)) return;
    recordingOverlayHoverLabel.textContent = `当前选择：${recordingOverlayLabelFor(element, recordingOverlayRole)}`;
  }

  function startRecordingOverlay(targetRole) {
    stopRecordingOverlay();
    recordingOverlayRole = targetRole === 'send_button' ? 'send' : targetRole;
    createRecordingOverlay();
    refreshRecordingOverlay();
    recordingOverlayPointerHandler = (event) => updateRecordingOverlayHover(event.target);
    recordingOverlayKeyHandler = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelCapture();
    };
    document.addEventListener('pointermove', recordingOverlayPointerHandler, true);
    document.addEventListener('keydown', recordingOverlayKeyHandler, true);
    document.addEventListener('scroll', scheduleRecordingOverlayRefresh, true);
    window.addEventListener('resize', scheduleRecordingOverlayRefresh, true);
    recordingOverlayMutationObserver = new MutationObserver((records) => {
      if (recordingOverlayMutationIsPageChange(records)) scheduleRecordingOverlayRefresh();
    });
    recordingOverlayMutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class', 'style', 'hidden', 'aria-hidden', 'disabled', 'id',
        'data-message-id', 'data-lid', 'data-row-key', 'data-id', 'data-key'
      ]
    });
  }

  function stopRecordingOverlay() {
    if (recordingOverlayPointerHandler) document.removeEventListener('pointermove', recordingOverlayPointerHandler, true);
    if (recordingOverlayKeyHandler) document.removeEventListener('keydown', recordingOverlayKeyHandler, true);
    document.removeEventListener('scroll', scheduleRecordingOverlayRefresh, true);
    window.removeEventListener('resize', scheduleRecordingOverlayRefresh, true);
    recordingOverlayMutationObserver?.disconnect();
    if (recordingOverlayRefreshRaf) cancelAnimationFrame(recordingOverlayRefreshRaf);
    recordingOverlayRefreshRaf = 0;
    recordingOverlayMutationObserver = null;
    recordingOverlayPointerHandler = null;
    recordingOverlayKeyHandler = null;
    recordingOverlayHover = null;
    recordingOverlayHoverLabel = null;
    recordingOverlayCandidates = [];
    recordingOverlayShadow = null;
    recordingOverlayHost?.remove();
    recordingOverlayHost = null;
    recordingOverlayRole = '';
  }

  function selectorClassTokens(el) {
    const volatile = /(?:^|[-_])(active|current|last|first|show|hide|loading|streaming|busy|disabled|selected|focus|focused|hover|open|close|transition|animation|enter|leave|visible|hidden|blank|empty|rank|index|position|order)(?:[-_]|$)/i;
    const generated = /^_?[a-z][\w-]*_[a-z0-9]{4,}_\d+$/i;
    return Array.from(el?.classList || []).filter(token =>
      /^[a-zA-Z_-][\w-]*$/.test(token) && !volatile.test(token) && !generated.test(token)
    );
  }

  function generateStableContainerSelector(el, identityAttributes = []) {
    const attributeScopes = Array.from(new Set(
      (Array.isArray(identityAttributes) ? identityAttributes : [])
        .map(attribute => String(attribute || '').trim().toLowerCase())
        // `[id]` is a page-wide layout selector on many SPAs. Stable data
        // identity attributes are safe as presence-only scopes because their
        // per-message value remains reserved for freshness checks.
        .filter(attribute => /^data-[a-z][a-z0-9_.:-]*$/.test(attribute))
        .map(attribute => `[${CSS.escape(attribute)}]`)
    ));
    if (attributeScopes.length) {
      return {
        css: attributeScopes[0],
        alternatives: attributeScopes.slice(1),
        method: 'identity-attribute-presence'
      };
    }
    const tag = el?.tagName?.toLowerCase() || '';
    const classes = selectorClassTokens(el);
    if (tag && classes.length) {
      // Container selectors are an identity scope, not an assertion that the
      // recorded message remains the only message on the page. Keep a stable
      // semantic class even when several message projections share it.
      return { css: `${tag}.${CSS.escape(classes[0])}`, method: 'tag+stable-class' };
    }
    return { css: cssPath(el), method: 'css-path' };
  }

  // ── 选择器生成 (优先级: id > data-* > aria > 唯一class > CSS路径) ──
  function generateSelector(el) {
    // 1. id
    if (el.id && /^[a-zA-Z_][\w-]*$/.test(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      if (document.querySelectorAll(sel).length === 1) return { css: sel, method: 'id' };
    }

    // 2. data-* 属性
    const dataAttrs = ['data-testid', 'data-id', 'data-e2e', 'data-qa', 'data-test-id', 'data-automation', 'data-selector'];
    for (const attr of dataAttrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${CSS.escape(val)}"]`;
        if (document.querySelectorAll(sel).length === 1) return { css: sel, method: attr };
      }
    }

    // 3. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length < 50) {
      const sel = `[aria-label="${CSS.escape(ariaLabel)}"]`;
      if (document.querySelectorAll(sel).length <= 2) return { css: sel, method: 'aria-label' };
    }

    // 4. 唯一 tag + class 组合
    // 重要：class 经常在 AI 网站中被复用；只有录制时是唯一且刷新后仍可定位才使用。
    const validClasses = selectorClassTokens(el);
    if (validClasses.length > 0) {
      for (let depth = validClasses.length; depth >= 1; depth--) {
        const combo = validClasses.slice(0, depth).map(c => `.${CSS.escape(c)}`).join('');
        const sel = el.tagName.toLowerCase() + combo;
        try {
          if (document.querySelectorAll(sel).length === 1) return { css: sel, method: 'tag+class' };
        } catch (e) { continue; }
      }
    }

    // 5. CSS 路径 fallback
    return { css: cssPath(el), method: 'css-path' };
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 6) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (same.length > 1) seg += `:nth-child(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ── 元素分类器 ──────────────────────────────────────────
  function classifyElement(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const role = el.getAttribute('role') || '';

    // === 输入框检测 ===
    const isInput =
      tag === 'textarea' ||
      (tag === 'input' && ['text', 'search', 'email', 'url', ''].includes(el.type || '')) ||
      el.getAttribute('contenteditable') === 'true' ||
      role === 'textbox' ||
      (tag === 'div' && el.getAttribute('contenteditable') === 'true');
    if (isInput) return { role: 'input', confidence: 'high' };

    // contenteditable 的父元素（有些 AI 聊天用 div[contenteditable] 套壳）
    const editableParent = el.closest('[contenteditable="true"]');
    if (editableParent && el !== editableParent) {
      return { role: 'input', confidence: 'medium', target: editableParent };
    }

    // === 发送按钮检测 ===
    const btn = el.closest('button, [role="button"]') || el;
    const btnText = (btn.textContent || '').trim().toLowerCase();
    const btnAria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const sendKW = ['send', '发送', 'submit', 'arrow_upward', 'arrow', '➤', '▶', 'go', 'enter', '确认'];
    const hasSendIcon = btn.querySelector(
      'svg[class*="send"], svg[class*="submit"], [class*="send-icon"], [class*="submit-icon"], svg path[d*="send"]'
    ) !== null;
    const looksLikeSendBtn = sendKW.some(kw => btnText.includes(kw) || btnAria.includes(kw));
    const nearInput = isNearInput(btn);

    if (looksLikeSendBtn || (hasSendIcon && nearInput) || (nearInput && btnText === '' && hasSendIcon)) {
      return { role: 'send', confidence: looksLikeSendBtn ? 'high' : 'medium' };
    }

    // === 复制按钮检测 ===
    const copyKW = ['copy', '复制', 'clipboard', 'content_copy', 'content-copy', 'file_copy', '📋'];
    const btnParent = el.closest('button, [role="button"], span[class*="copy"]');
    if (btnParent) {
      const parentText = (btnParent.textContent || '').trim().toLowerCase();
      const parentAria = (btnParent.getAttribute('aria-label') || '').toLowerCase();
      if (copyKW.some(kw => parentText.includes(kw) || parentAria.includes(kw))) {
        return { role: 'copy', confidence: 'high' };
      }
    }
    // 纯图标复制按钮（无文字）
    const hasCopyIcon = el.querySelector('svg[class*="copy"], [class*="copy-icon"], svg use[href*="copy"]');
    if (hasCopyIcon || el.closest('svg[class*="copy"]')) {
      return { role: 'copy', confidence: 'medium' };
    }

    return { role: 'unknown', confidence: 'low' };
  }

  function isNearInput(el) {
    const inputs = Array.from(document.querySelectorAll(
      'textarea, [contenteditable="true"], input[type="text"], input:not([type]), [role="textbox"]'
    )).filter(inp => inp.getClientRects().length && getComputedStyle(inp).visibility !== 'hidden');
    if (!inputs.length) return false;
    const inputEl = inputs.reduce((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (ra.width * ra.height) > (rb.width * rb.height) ? a : b;
    });
    const ir = inputEl.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const dx = Math.abs(er.left + er.width/2 - ir.left - ir.width/2);
    const dy = Math.abs(er.top + er.height/2 - ir.top - ir.height/2);
    if (dx > 500 || dy > 500) return false;
    
    // DOM 树距离检查
    let p = el;
    for (let i = 0; i < 15 && p && p !== document.documentElement; i++) {
      if (p.contains(inputEl)) return true;
      p = p.parentElement;
    }
    
    let ip = inputEl.parentElement;
    for (let i = 0; i < 15 && ip && ip !== document.documentElement; i++) {
      if (ip.contains(el)) return true;
      ip = ip.parentElement;
    }
    
    return false;
  }

  // ── 普适发送按钮自动发现 ──────────────────────────────
  function findUniversalSendButton(inputEl) {
    // Scan all visible clickable elements near the input. Heuristic:
    // buttons, [role=button], SVGs, and clickable divs within 500px.
    // Uses the same send-keyword matching as classifyElement (provider-neutral).
    const center = inputEl ? inputEl.getBoundingClientRect() : null;
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], svg, div[class*="send" i], span[class*="send" i]'
    )).filter(el => {
      if (!el.getClientRects().length) return false;
      if (getComputedStyle(el).visibility === 'hidden') return false;
      if (center) {
        const r = el.getBoundingClientRect();
        const dx = Math.abs(r.left + r.width/2 - center.left - center.width/2);
        const dy = Math.abs(r.top + r.height/2 - center.top - center.height/2);
        if (dx > 500 || dy > 500) return false;
      }
      return true;
    });
    const sendKW = ['send', '发送', 'submit', 'arrow_upward', 'arrow', '➤', '▶', 'go', 'enter'];
    // Score each candidate: keyword match > near-input > size
    const scored = candidates.map(el => {
      let score = 0;
      const btn = el.closest('button, [role="button"]') || el;
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const btnClass = typeof btn.className === 'string' ? btn.className : (btn.className?.baseVal || '');
      const elClass = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
      const cls = (btnClass + elClass).toLowerCase();
      for (const kw of sendKW) {
        if (text.includes(kw)) score += 30;
        if (aria.includes(kw)) score += 25;
        if (cls.includes(kw)) score += 15;
      }
      // SVG send icons
      if (el.tagName === 'SVG' || el.querySelector('svg')) {
        const svgClass = (el.className || '').toLowerCase();
        for (const kw of sendKW) { if (svgClass.includes(kw)) score += 20; }
      }
      if (isNearInput(btn)) score += 10;
      // Prefer smaller elements (typical send buttons are compact)
      const area = btn.getClientRects()[0];
      if (area) { score -= Math.max(0, (area.width * area.height - 2500) / 500); }
      return { el: btn, score };
    }).filter(c => c.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.el || null;
  }

  // ── 单次点击捕获器 ──────────────────────────────────────
  let clickCapture = null;
  let captureEventProbe = null;

  function clearCaptureEventProbe() {
    if (!captureEventProbe) return;
    for (const eventType of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click']) {
      document.removeEventListener(eventType, captureEventProbe, true);
    }
    captureEventProbe = null;
  }

  function startSingleCapture(targetRole) {
    if (lock.active) {
      console.warn('[Phantom Relay] Already capturing, reject');
      return { error: 'already_capturing' };
    }

    lock.active = true;
    lock.targetRole = targetRole;
    lock.captured = false;
    clearHighlight();
    startRecordingOverlay(targetRole);
    clearCaptureEventProbe();
    captureEventProbe = (e) => {
      if (!lock.active || lock.captured) return;
      const eventTarget = e?.target?.nodeType === Node.ELEMENT_NODE ? e.target : e?.target?.parentElement;
      emitPageTrace('recording_input_event_seen', {
        role: targetRole,
        eventType: String(e?.type || ''),
        trusted: !!e?.isTrusted,
        targetTag: String(eventTarget?.tagName || '').toLowerCase()
      });
    };
    for (const eventType of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click']) {
      document.addEventListener(eventType, captureEventProbe, true);
    }

    // 在整个 document 上监听（捕获阶段，最高优先级）
    clickCapture = function (e) {
      if (!lock.active || lock.captured) return;

      // Keep the recording boundary observable without copying page text or
      // HTML into diagnostics. This distinguishes a missing DOM event from a
      // selector/profile rejection during real-browser verification.
      const eventTarget = e?.target?.nodeType === Node.ELEMENT_NODE ? e.target : e?.target?.parentElement;
      emitPageTrace('recording_click_seen', {
        role: targetRole,
        trusted: !!e?.isTrusted,
        targetTag: String(eventTarget?.tagName || '').toLowerCase(),
        targetClass: typeof eventTarget?.className === 'string' ? eventTarget.className.slice(0, 160) : ''
      });

      // 回复区域不是按钮：保留用户点击的消息行/正文节点；输入和发送才提升到可交互祖先。
      let target = e.target;
      if (targetRole === 'response') {
        // Persist the exact candidate represented by the hover/selection box.
        // A click naturally lands on an inner text span; recording that raw
        // descendant would produce a brittle nth-child path unrelated to the
        // element the user was shown.
        target = recordingCandidateForTarget(e.target, 'response');
        if (!target || target === document.body || target === document.documentElement) return;
      } else {
        // 找到最合适的可交互元素
        for (let depth = 0; depth < 5 && target; depth++) {
          if (target.tagName === 'BODY' || target.tagName === 'HTML') break;
          const tag = target.tagName.toLowerCase();
          if (['button', 'textarea', 'input', 'a', 'svg'].includes(tag) ||
              target.getAttribute('role') === 'button' ||
              target.getAttribute('role') === 'textbox' ||
              target.getAttribute('contenteditable') === 'true' ||
              target.closest('[contenteditable="true"]')) {
            break;
          }
          target = target.parentElement;
        }
      }

      // 分类
      const result = classifyElement(target);
      // A click on an icon is still a recording of the containing action.
      // Persist the actionable button so replay and health checks do not
      // depend on an icon's DOM nesting.
      const classifiedTarget = result.target || target;
      const actualTarget = targetRole === 'send'
        ? (classifiedTarget.closest?.('button, [role="button"]') || classifiedTarget)
        : classifiedTarget;

      // 阻止事件传播（copy 模式不拦截，让复制正常触发）
      if (targetRole !== 'copy') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }

      // 验证是否匹配目标角色
      if (targetRole === 'response' && actualTarget.textContent.trim().length >= 2) {
        result.role = 'response';
        result.confidence = 'manual';
      }
      if (result.role !== targetRole) {
        // ── 宽松模式：send 和 copy 按钮往往是纯图标，分类器容易漏 ──
        const isInteractive = (
          actualTarget.tagName === 'BUTTON' ||
          actualTarget.tagName === 'SVG' ||
          actualTarget.closest('button') ||
          actualTarget.closest('[role="button"]') ||
          actualTarget.closest('[onclick]') ||
          getComputedStyle(actualTarget).cursor === 'pointer' ||
          getComputedStyle(actualTarget.closest('*[style*="cursor:pointer"]') || actualTarget).cursor === 'pointer'
        );
        
        if (targetRole === 'send' && isInteractive) {
          // 用户录制时实际点击的元素就是权威，不根据按钮文字猜测其功能。
          // 某些站点的复制按钮可能显示业务文案或无语义文本，必须允许录入。
          result.role = targetRole;
          result.confidence = 'manual';
        } else {
          // 不匹配 → 闪烁红色提示
          highlight(actualTarget, '#FF1744');
          setTimeout(() => {
            if (lock.active && !lock.captured) clearHighlight();
          }, 800);
          return;
        }
      }

      // ✅ 匹配! 生成选择器
      const selector = generateSelector(actualTarget);
      // 选择器本身可能依赖运行时 class / 虚拟列表位置。把同一个“用户刚点击的
      // 元素”可验证的备用 CSS 一起保存；刷新后只在原 selector 失效时尝试这些
      // 同元素候选，不根据按钮文字猜测目标。
      selector.alternatives = selectorAlternatives(actualTarget, selector.css);
      highlight(actualTarget, '#00E676');

      const recordedProfile = targetRole === 'response'
        ? buildRecordedProfile(actualTarget, selector)
        : selectors.profile;
      if (targetRole === 'response' && !recordedProfile) {
        // A response selector that cannot produce either a stable attribute
        // identity or a complete selector-position identity is not executable.
        lock.captured = false;
        lock.active = false;
        stopRecordingOverlay();
        clearCaptureEventProbe();
        document.removeEventListener('click', clickCapture, true);
        clickCapture = null;
        highlight(actualTarget, '#FF1744');
        emitPageTrace('profile_recording_rejected', {
          role: targetRole,
          error: 'profile_identity_unavailable'
        });
        chrome.runtime.sendMessage({
          type: 'selector_capture_rejected',
          role: targetRole,
          error: 'profile_identity_unavailable',
          detail: '回复候选无法形成完整身份边界，请选择框出的单条已完成回复',
          domain: window.location.hostname
        });
        setTimeout(clearHighlight, 1500);
        return;
      }
      const captureId = beginSelectorCapture(targetRole);
      // Store the selector only after the response profile has passed its
      // identity contract. A failed re-record must leave the last-known-good
      // response/profile untouched.
      selectors[targetRole] = {
        selector,
        elementTag: actualTarget.tagName.toLowerCase(),
        elementHTML: actualTarget.outerHTML.substring(0, 500),
        classification: result,
        capturedAt: Date.now(),
      };
      selectorCaptureStatus[targetRole] = {
        state: 'pending',
        capture_id: captureId,
        capturedAt: selectors[targetRole].capturedAt,
      };
      if (targetRole === 'response') {
        selectors.profile = recordedProfile;
        refreshActiveProfile(selectors.profile);
      }

      lock.captured = true;
      lock.active = false;
      stopRecordingOverlay();

      // 移除监听
      document.removeEventListener('click', clickCapture, true);
      clickCapture = null;
      clearCaptureEventProbe();

      // 通知 background
      const domain = window.location.hostname;
      chrome.runtime.sendMessage({
        type: 'selector_captured',
        role: targetRole,
        selector,
        confidence: result.confidence,
        elementTag: actualTarget.tagName.toLowerCase(),
        profile: targetRole === 'response' ? recordedProfile : undefined,
        domain,
        capture_id: captureId,
      }, (ack) => {
        const runtimeError = chrome.runtime.lastError?.message || '';
        const resolution = resolveSelectorCaptureAck(targetRole, captureId, ack, runtimeError);
        if (resolution.ignored) return;
        if (resolution.accepted) {
          // Keep the role-local assignment explicit for diagnostics and older
          // popup readers that inspect the content source contract directly.
          selectorCaptureStatus[targetRole] = {
            state: 'accepted',
            capture_id: captureId,
            capturedAt: selectorCaptureStatus[targetRole]?.capturedAt || Date.now(),
            profile_revision: Number(ack?.profile_revision || 0),
            profile_synced: ack?.profile_synced !== false,
          };
          return;
        }
        chrome.runtime.sendMessage({
          type: 'selector_capture_rejected',
          role: targetRole,
          error: resolution.error,
          detail: resolution.detail || '录制结果未得到后端确认，请重试',
          domain,
          capture_id: captureId,
        }).catch(() => {});
      });

      // 1.5 秒后清除高亮
      setTimeout(clearHighlight, 1500);
    };

    document.addEventListener('click', clickCapture, true);

    return { status: 'listening', role: targetRole };
  }

  function cancelCapture() {
    lock.active = false;
    lock.captured = false;
    lock.targetRole = null;
    if (clickCapture) {
      document.removeEventListener('click', clickCapture, true);
      clickCapture = null;
    }
    clearCaptureEventProbe();
    if (shortcutCaptureHandler) {
      document.removeEventListener('keydown', shortcutCaptureHandler, true);
      shortcutCaptureHandler = null;
    }
    shortcutListening = false;
    stopRecordingOverlay();
    clearHighlight();
  }

  function captureCancellationRequested(jobId = currentCaptureJobId) {
    if (!captureCancelRequested) return false;
    const requestedJobId = String(captureCancelJobId || '');
    const activeJobId = String(jobId || currentCaptureJobId || '');
    return !requestedJobId || !activeJobId || requestedJobId === activeJobId;
  }

  function throwIfCaptureCancelled(jobId = currentCaptureJobId) {
    if (!captureCancellationRequested(jobId)) return;
    const error = new Error('capture_cancelled');
    error.code = 'capture_cancelled';
    error.reason = captureCancelReason || 'claim_invalidated';
    throw error;
  }

  function requestAutoCaptureCancellation(jobId, reason) {
    const requestedJobId = String(jobId || '');
    if (!autoCaptureInFlight) return { ok: true, cancelled: false, ignored: true, reason: 'capture_not_in_flight' };
    if (requestedJobId && currentCaptureJobId && requestedJobId !== currentCaptureJobId) {
      return { ok: true, cancelled: false, ignored: true, reason: 'job_mismatch' };
    }
    captureCancelRequested = true;
    captureCancelJobId = currentCaptureJobId || requestedJobId;
    captureCancelReason = String(reason || 'claim_invalidated');
    emitPageTrace('auto_capture_cancel_requested', {
      jobId: captureCancelJobId,
      reason: captureCancelReason
    });
    reportCaptureProgress('自动抓取已请求取消');
    return { ok: true, cancelled: true, job_id: captureCancelJobId, reason: captureCancelReason };
  }

  // ── 快捷键录制 ──────────────────────────────────────────
  let shortcutCaptureHandler = null;
  function startShortcutRecording() {
    if (shortcutCaptureHandler) document.removeEventListener('keydown', shortcutCaptureHandler, true);
    shortcutCaptureHandler = function (e) {
      const ignoredKeys = new Set(['Shift','Control','Alt','Meta','CapsLock','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
      if (ignoredKeys.has(e.key)) return;
      if (!e.isTrusted) return;
      e.preventDefault(); e.stopPropagation();
      const modifiers = [];
      if (e.metaKey) modifiers.push('Meta');
      if (e.ctrlKey) modifiers.push('Control');
      if (e.altKey) modifiers.push('Alt');
      if (e.shiftKey) modifiers.push('Shift');
      const key = e.key === 'Enter' ? 'Enter' : (e.code?.replace(/^Key/,'') || e.key);
      const strategy = { kind: 'shortcut', key, modifiers, code: e.code };
      const captureId = beginSelectorCapture('send');
      sendStrategy = strategy;
      selectors.send = strategy;
      selectorCaptureStatus.send = { state: 'pending', capture_id: captureId, capturedAt: Date.now() };
      document.removeEventListener('keydown', shortcutCaptureHandler, true);
      shortcutCaptureHandler = null;
      shortcutListening = false;
      const domain = window.location.hostname;
      chrome.runtime.sendMessage({ type: 'selector_captured', role: 'send', selector: JSON.stringify(strategy), confidence: 'manual', elementTag: 'keyboard', domain, capture_id: captureId }, (ack) => {
        const runtimeError = chrome.runtime.lastError?.message || '';
        const resolution = resolveSelectorCaptureAck('send', captureId, ack, runtimeError);
        if (resolution.ignored || resolution.accepted) return;
        chrome.runtime.sendMessage({
          type: 'selector_capture_rejected',
          role: 'send',
          error: resolution.error,
          detail: resolution.detail || '录制结果未得到后端确认，请重试',
          domain,
          capture_id: captureId,
        }).catch(() => {});
      });
    };
    document.addEventListener('keydown', shortcutCaptureHandler, true);
  }

  // ── 自动回放 ────────────────────────────────────────────
  function discoverReplaySelectors() {
    const input = Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]'))
      .find(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none');
    if (!input) return { error: 'input_not_found' };
    const inputTarget = input.closest('[contenteditable="true"]') || input;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], [onclick]'));
    const send = buttons.find(el => {
      if (!el.getClientRects().length || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('data-slot') === 'dropdown-menu-trigger') return false;
      return isNearInput(el) && classifyElement(el).role === 'send';
    }) || buttons.find(el => {
      if (!el.getClientRects().length || el.disabled) return false;
      if (el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('data-slot') === 'dropdown-menu-trigger') return false;
      return isNearInput(el);
    });
    if (!send) return { error: 'send_not_found' };
    return {
      selectors: {
        input: { selector: generateSelector(inputTarget), elementTag: inputTarget.tagName.toLowerCase(), confidence: 'discovered' },
        send: { selector: generateSelector(send), elementTag: send.tagName.toLowerCase(), confidence: 'discovered' },
        response: null
      }
    };
  }

  function setDiscoveredSelectors(discovered) {
    if (!discovered?.selectors) return false;
    selectors = {
      ...selectors,
      input: normalizeRecordedSelector(discovered.selectors.input),
      send: normalizeRecordedSelector(discovered.selectors.send),
      response: null,
      profile: null
    };
    refreshActiveProfile();
    return !!selectors.input && !!selectors.send;
  }

  // Submission is a side effect. Once the recorded keyboard sequence has been
  // dispatched, an absent DOM projection is unknown evidence, never permission
  // to submit the same prompt through another event path. The page owns focus;
  // the background worker owns the trusted Chromium keyboard dispatch.
  function recordedInputOwnsFocus(inputEl) {
    if (!inputEl?.isConnected) return false;
    const focusOwner = inputEl.matches?.('textarea, input, [contenteditable="true"], [role="textbox"]')
      ? inputEl
      : (inputEl.closest?.('textarea, input, [contenteditable="true"], [role="textbox"]') || inputEl);
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return !!active && (active === focusOwner || focusOwner.contains?.(active));
  }

  async function dispatchRecordedKeyboardOnce(inputEl, options = {}) {
    if (!inputEl) return { status: 'unknown', error: 'input_not_found', method: 'cdp-input' };
    const key = String(options.key || 'Enter');
    const code = String(options.code || key);
    const modifiers = Array.isArray(options.modifiers) ? options.modifiers : [];
    try {
      try { inputEl.focus({ preventScroll: true }); } catch (_) { inputEl.focus(); }
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      if (!recordedInputOwnsFocus(inputEl)) {
        const focusFailure = {
          ok: false,
          status: 'unknown',
          method: 'cdp-input',
          trusted: false,
          error: 'keyboard_focus_not_acquired',
          kind: 'keyboard_focus_not_acquired',
          documentHasFocus: document.hasFocus(),
          activeTag: document.activeElement?.tagName || '',
        };
        reportPageEvent('keyboard_focus_not_acquired', focusFailure);
        return focusFailure;
      }
      reportPageEvent('keyboard_focus_acquired', {
        documentHasFocus: document.hasFocus(),
        activeTag: document.activeElement?.tagName || '',
      });
      const result = await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          resolve(value || { status: 'unknown', method: 'cdp-input', error: 'keyboard_bridge_empty_response' });
        };
        try {
          chrome.runtime.sendMessage({
            type: 'dispatch_recorded_keyboard',
            tab_id: options.tabId,
            job_id: options.jobId,
            claim_token: options.claimToken,
            key,
            code,
            modifiers,
          }, finish);
        } catch (error) {
          finish({ status: 'unknown', method: 'cdp-input', error: 'keyboard_bridge_unavailable', detail: error?.message || String(error) });
        }
      });
      reportPageEvent('send_keyboard_dispatched_once', result);
      return result;
    } catch (error) {
      const result = { status: 'unknown', method: 'cdp-input', key, error: error?.message || String(error) };
      reportPageEvent('send_keyboard_dispatch_unknown', result);
      return result;
    }
  }

  function recordedInputValue(element) {
    if (!element) return '';
    if ('value' in element) return String(element.value || '').trim();
    return String(element.innerText || element.textContent || '').trim();
  }

  function resolveRecordedInputOwner(inputSelector, inputElement) {
    if (inputElement?.isConnected) return inputElement;
    if (!inputSelector) return null;
    const selector = typeof inputSelector === 'string'
      ? inputSelector
      : (typeof inputSelector?.css === 'string'
        ? inputSelector.css
        : (typeof inputSelector?.selector === 'string' ? inputSelector.selector : ''));
    if (!selector) return null;
    try { return document.querySelector(selector); } catch (_) { return null; }
  }

  function recordedInputCandidates(inputSelector, inputElement = null) {
    const normalized = selectorDescriptor(inputSelector);
    const selectorsToTry = [normalized?.css, ...(normalized?.alternatives || [])]
      .filter(Boolean);
    const candidates = [];
    const append = (element) => {
      if (!element || !element.matches?.('textarea,input,[contenteditable="true"],[role="textbox"]')) return;
      if (!candidates.includes(element)) candidates.push(element);
    };
    append(inputElement);
    for (const css of selectorsToTry) {
      try {
        document.querySelectorAll(css).forEach(append);
      } catch (_) {}
    }
    return candidates;
  }

  function inputCandidateInteractable(element) {
    if (typeof ProfileHealth !== 'undefined' && ProfileHealth?.isInputInteractable) {
      return ProfileHealth.isInputInteractable(element, document);
    }
    return !!element?.isConnected && !!element?.getClientRects?.().length;
  }

  function resolveInteractableRecordedInput(inputSelector, inputElement = null) {
    const candidates = recordedInputCandidates(inputSelector, inputElement);
    const interactable = candidates.filter(inputCandidateInteractable);
    if (!interactable.length) return null;

    // Keep the current owner when it is still usable. If a framework replaced
    // it, prefer the currently focused editor, then the first deterministic
    // live candidate from the recorded selector order.
    if (inputElement && interactable.includes(inputElement)) return inputElement;
    const active = interactable.filter(element => (
      document.activeElement === element || element.contains?.(document.activeElement)
    ));
    if (active.length === 1) return active[0];
    return interactable.length === 1 ? interactable[0] : null;
  }

  function recordedInputDiagnostics(inputSelector, inputElement = null) {
    return recordedInputCandidates(inputSelector, inputElement).map((element, index) => ({
      index,
      connected: element.isConnected !== false,
      interactable: inputCandidateInteractable(element),
      active: document.activeElement === element,
      tag: String(element.tagName || '').toLowerCase(),
      selectorMatch: selectorText(inputSelector),
    }));
  }

  async function waitForInteractableRecordedInput(inputSelector, inputElement = null, timeout = 1500) {
    const started = Date.now();
    let current = inputElement;
    while (Date.now() - started < timeout) {
      throwIfCaptureCancelled();
      current = resolveInteractableRecordedInput(inputSelector, current);
      if (current) return current;
      await sleep(100);
    }
    return resolveInteractableRecordedInput(inputSelector, current);
  }

  async function waitForSendObservation({
    userMessage,
    beforeKeys,
    inputSelector,
    inputElement,
    inputBefore,
    generationStateBefore,
    timeoutMs = 12000,
  }) {
    const started = Date.now();
    let lastInputValue = inputBefore;
    let weakEvidence = null;
    const observationWake = createRecordedResponseWake();
    try {
    while (Date.now() - started < timeoutMs) {
      throwIfCaptureCancelled();
      const userEvidence = findFreshUserMessage(userMessage, beforeKeys);
      const responseEvidence = freshResponseEvidence(userMessage, beforeKeys);
      const input = resolveInteractableRecordedInput(inputSelector, inputElement)
        || resolveRecordedInputOwner(inputSelector, inputElement);
      lastInputValue = recordedInputValue(input);
      const generationAfter = sendActivityState(recordedResponseRegion());
      const generationStarted = (
        (!generationStateBefore?.marker && generationAfter.marker) ||
        (!generationStateBefore?.control && generationAfter.control)
      );
      const observation = SendObservation?.classify?.({
        userObserved: !!userEvidence,
        assistantObserved: !!responseEvidence,
        generationStarted,
        inputBefore,
        inputAfter: lastInputValue,
      }) || { observed: !!(userEvidence || responseEvidence || generationStarted), reason: 'runtime_fallback' };
      if (observation.observed) {
        if (responseEvidence) {
          reportPageEvent('send_response_evidence', {
            key: responseEvidence.key,
            textLength: responseEvidence.text.length,
            streaming: !!responseEvidence.streaming,
            waitedMs: Date.now() - started,
          });
        }
        reportPageEvent('send_observed', {
          reason: observation.reason,
          waitedMs: Date.now() - started,
          inputBeforeLength: String(inputBefore || '').length,
          inputAfterLength: String(lastInputValue || '').length,
        });
        return { ...observation, waitedMs: Date.now() - started };
      }
      if (observation.weak) {
        weakEvidence = observation;
        return {
          ...observation,
          waitedMs: Date.now() - started,
          inputBeforeLength: String(inputBefore || '').length,
          inputAfterLength: String(lastInputValue || '').length,
        };
      }
      await observationWake.wait(250);
    }
    return {
      observed: false,
      weak: !!weakEvidence,
      reason: weakEvidence?.reason || 'no_effect',
      waitedMs: Date.now() - started,
      inputBeforeLength: String(inputBefore || '').length,
      inputAfterLength: String(lastInputValue || '').length,
    };
    } finally {
      observationWake.disconnect();
    }
  }

  // 这里不再依赖 copy 按钮。回复的唯一边界是：发送前快照 → 新用户消息 →
  // 其后的逻辑消息节点；如何识别逻辑身份由录制 profile 声明。
  async function autoCapture(userMessage, jobId = '', conversationId = '', tabId = null, claimToken = '', allowToolCalls = false, captureTimeoutMs = 240000) {
    if (!isCurrentGeneration()) return { error: 'stale_content_script' };
    const expectedConversationId = String(conversationId || '');
    const expectedTabId = tabId == null ? null : Number(tabId);
    const requestedCaptureTimeoutMs = Math.max(120000, Math.min(900000, Number(captureTimeoutMs) || 240000));
    const captureDeadlineAt = Date.now() + requestedCaptureTimeoutMs;
    if (autoCaptureInFlight) return { error: 'capture_in_flight', detail: '已有自动抓取正在运行，请等待结束' };
    const profileHealth = runProfileHealthCheck(activeProfile, { allowMissingResponse: true });
    if (profileHealth.state === 'invalid') return profileHealthError(profileHealth);
    // Keep the ready lease alive while a capture is running.  The background
    // worker uses the lease to recover after API restarts and to claim the next
    // request; stopping it here makes the page disappear after the first turn.
    // Replay is strictly recording-driven. Never discover or infer a selector
    // during a user request; a missing recorded input is a configuration error.
    if (!selectorText(selectors.input)) {
      return { error: 'recorded_input_missing', detail: '当前站点没有录制输入 selector' };
    }
    if (!activeProfile || (!responseContract() && !networkOnlyProfile())) {
      return { error: 'response_contract_missing', detail: '当前站点没有完整的录制 response profile' };
    }
    // The recorded input is mandatory. A recorded CSS send selector is a
    // concrete user action and must remain the primary strategy. Enter is only
    // the default when the user explicitly recorded a keyboard action or when
    // no send control was recorded at all.
    const recordedButtonSelector = selectors.send && typeof selectors.send === 'object' && selectors.send.selector
      ? selectorText(selectors.send.selector)
      : (typeof selectors.send === 'string' ? selectorText(selectors.send) : '');
    const strategy = selectors.send && typeof selectors.send === 'object' && selectors.send.kind
      ? selectors.send
      : recordedButtonSelector
        ? { kind: 'button', selector: recordedButtonSelector }
        : { kind: 'enter', key: 'Enter', modifiers: [] };
    const inputSelector = selectorText(selectors.input);
    if (!inputSelector) {
      return { error: 'input_not_found', detail: '当前页面没有发现可用输入框' };
    }
    const captureLock = CAPTURE_LOCK_ATTRIBUTE;
    if (document.documentElement.hasAttribute(captureLock)) {
      return { error: 'capture_in_flight', detail: '页面已有抓取实例正在运行' };
    }
    document.documentElement.setAttribute(captureLock, String(generation));
    window.__phantomRelayCaptureUserMessage = userMessage;
    // Establish the previous-turn boundary before input mutation or the
    // response monitor can publish an unchanged old assistant snapshot.
    window.__phantomRelayCaptureBeforeMessages = logicalMessageSnapshot().map(n => ({ key: n.key, text: n.text }));
    latestObservedResponse = null;
    autoCaptureInFlight = true;
    currentCaptureJobId = jobId || '';
    captureCancelRequested = false;
    captureCancelJobId = String(jobId || '');
    captureCancelReason = '';
    networkResponseObserved = false;

    // Capture heartbeat: keep the client lease alive independently of the
    // page_ready→background→wait_until_ready chain. Even if the SW restarts
    // and activeClaims is lost, this ensures the server sees last_seen < 45s.
    const captureDomain = document.domain || '';
    const captureTabId = tabId;
    const captureHeartbeatInterval = setInterval(() => {
      if (!isCurrentGeneration()) return;
      try {
        chrome.runtime.sendMessage({
          type: 'capture_heartbeat',
          domain: captureDomain,
          tab_id: captureTabId,
          conversation_id: expectedConversationId,
          job_id: jobId,
          claim_token: claimToken,
          page_session_id: pageSessionId,
          content_script_version: CONTENT_SCRIPT_VERSION,
        }, value => {
          void chrome.runtime.lastError;
          if (value?.claim_valid === false) {
            requestAutoCaptureCancellation(jobId, 'claim_invalidated');
          }
        });
      } catch (_) {}
    }, 5000);
    try {
      let inputEl = await waitForInteractableRecordedInput(
        selectorDescriptor(selectors.input),
        null,
        Math.min(120000, Math.max(1, captureDeadlineAt - Date.now())),
      );
      throwIfCaptureCancelled();
      if (!inputEl) {
        const diagnostics = recordedInputDiagnostics(selectorDescriptor(selectors.input));
        emitPageTrace('recorded_input_resolution_failed', {
          phase: 'before_fill',
          candidateCount: diagnostics.length,
          candidates: diagnostics,
        });
        return {
          error: diagnostics.length ? 'recorded_input_not_interactable' : 'input_not_ready_timeout',
          detail: diagnostics.length
            ? '录制输入框当前被遮挡、禁用或不可交互'
            : '等待输入框后仍未找到录制目标',
          reason_codes: diagnostics.length ? ['recorded_input_not_interactable'] : ['profile_input_unavailable'],
          recoverable: true
        };
      }
      const identityGapBeforeSend = recordedResponseIdentityGap();
      if (identityGapBeforeSend) {
        emitPageTrace('recorded_response_identity_preflight_failed', identityGapBeforeSend);
        return {
          error: 'profile_identity_unavailable',
          detail: '录制回复身份已失效，请重新录制回复区域后再试',
          reason_codes: ['profile_identity_unavailable'],
          profile_identity_gap: identityGapBeforeSend,
          recoverable: true
        };
      }
      // Content script owns the single recorded input mutation. The following
      // recorded send action must not inject text a second time.
      setInputValue(inputEl, userMessage);
      await sleep(250);
      throwIfCaptureCancelled();

      // Execute the recorded strategy exactly. A recorded button is not
      // converted into Enter, and a recorded Enter is not converted into a
      // button fallback.
      // Respect the recording. A recorded CSS selector (no .kind) means
      // the user captured a button click; a {kind:"enter"} object means
      // Enter is the primary method. Never guess or override.
      const currentStrategy = strategy;
      if (Universal) {
        const plan = Universal.buildSendPlan({ send: currentStrategy }, {
          keyboardFallback: false,
          allowMultipleSubmissions: false
        });
        const decision = Universal.nextSendAction(plan, { actionIndex: 0, submissionCount: 0 });
        if (!decision.action) return { error: decision.terminal || 'send_strategy_missing' };
      }
    const recordedResponseBefore = responseContract()
      ? recordedResponseSnapshot('', new Set())
      : null;
    const responseAnchorBefore = recordedResponseBefore
      ? { key: recordedResponseBefore.key || '', text: recordedResponseBefore.text || '' }
      : null;
      const before = logicalMessageSnapshot();
      const beforeEntries = [...before];
      if (recordedResponseBefore?.key && !beforeEntries.some(node => node.key === recordedResponseBefore.key)) {
        beforeEntries.push({
          key: recordedResponseBefore.key,
          text: recordedResponseBefore.text || '',
          role: 'assistant',
          streaming: !!recordedResponseBefore.streaming,
        });
      }
      const beforeKeys = new Set(beforeEntries.map(n => n.key));
      window.__phantomRelayCaptureBeforeMessages = beforeEntries.map(n => ({ key: n.key, text: n.text }));
      const generationStateBefore = sendActivityState(recordedResponseBefore?.region || null);
      const preSendInput = await waitForInteractableRecordedInput(
        selectorDescriptor(selectors.input),
        inputEl,
        Math.min(3000, Math.max(1, captureDeadlineAt - Date.now())),
      );
      if (!preSendInput) {
        const diagnostics = recordedInputDiagnostics(selectorDescriptor(selectors.input), inputEl);
        emitPageTrace('recorded_input_resolution_failed', {
          phase: 'before_send',
          candidateCount: diagnostics.length,
          candidates: diagnostics,
        });
        return {
          error: 'recorded_input_not_interactable',
          detail: '录制输入框在发送前已不可交互',
          reason_codes: ['recorded_input_not_interactable'],
          recoverable: true
        };
      }
      inputEl = preSendInput;
      const preSendInputValue = recordedInputValue(preSendInput);
      reportCaptureProgress(`发送前逻辑消息 ${beforeEntries.length} 条`);
      reportPageEvent('capture_boundary', {
        phase: 'before_send',
        userMessageLength: String(userMessage || '').length,
        sendStrategy: currentStrategy,
        inputValueLength: preSendInput ? String(preSendInput.value || preSendInput.textContent || '').length : -1,
        nodes: beforeEntries.map(debugNode),
        recordedResponseBefore: recordedResponseBefore ? {
          key: recordedResponseBefore.key || '',
          textLength: String(recordedResponseBefore.text || '').length,
        } : null,
        generationStateBefore: {
          marker: generationStateBefore.marker,
          control: generationStateBefore.control,
        },
      });
      // The recorded send strategy is the complete site contract. Do not
      // replace a recorded button with Enter or use CDP as an execution path.
      let sendKind = currentStrategy?.kind || 'enter';
      let sendKey = currentStrategy?.kind === 'shortcut' ? (currentStrategy.key || 'Enter') : 'Enter';
      let sendModifiers = currentStrategy?.kind === 'shortcut' ? (currentStrategy.modifiers || []) : [];
      reportPageEvent('send_target', { strategy: { kind: sendKind, key: sendKey, modifiers: sendModifiers } });

      if (activeProfile?.capture?.mode === 'network' || activeProfile?.capture?.mode === 'hybrid') {
        let boundaryAck = false;
        await new Promise(resolve => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          try {
            chrome.runtime.sendMessage({
              type: 'network_capture_boundary',
              job_id: jobId,
              conversation_id: expectedConversationId,
              tab_id: expectedTabId
            }, value => {
              void chrome.runtime.lastError;
              boundaryAck = !!value?.ok;
              emitPageTrace('network_capture_boundary_ack', { ok: !!value?.ok, boundaryAt: value?.boundary_at || 0 });
              finish();
            });
          } catch (_) { finish(); }
          setTimeout(finish, 500);
        });
        if (activeProfile.capture.mode === 'network' && !boundaryAck) {
          return {
            error: 'network_capture_boundary_unavailable',
            detail: '网络捕获未能在真实发送前建立请求边界；请录制回复区域或重试',
            recoverable: true
          };
        }
      }

      // Enter and shortcut strategies use the background's browser-native input
      // bridge. The page still owns focus, while Chromium owns the trusted key
      // event that framework editors accept as a real user action.
      if (sendKind === 'enter') {
        const dispatch = await dispatchRecordedKeyboardOnce(inputEl, {
          key: sendKey,
          code: currentStrategy?.code || sendKey,
          modifiers: sendModifiers,
          tabId: expectedTabId,
          jobId,
          claimToken,
        });
        if (dispatch.status !== 'dispatched') {
          reportPageEvent('send_dispatch_unknown_observe_only', {
            error: dispatch.error || 'dom_keyboard_dispatch_unknown',
            action: 'observe_response_without_retry'
          });
        }
        if (networkResponseObserved && (networkOnlyProfile() || activeProfile?.capture?.mode === 'hybrid')) {
          reportPageEvent('network_response_observed_after_single_dispatch', {
            action: 'continue_without_retry'
          });
        }
      } else if (sendKind === 'shortcut') {
        // The recorded keyboard action is the send contract. A provider may
        // render only the assistant region and expose no keyed user-message
        // node, so a missing user projection cannot turn a real dispatch into
        // a retry loop that may submit the prompt more than once.
        throwIfCaptureCancelled();
        const shortcut = await dispatchRecordedKeyboardOnce(inputEl, {
          key: strategy.key || 'Enter',
          code: strategy.code || strategy.key || 'Enter',
          modifiers: strategy.modifiers || [],
          tabId: expectedTabId,
          jobId,
          claimToken,
        });
        const shortcutDispatched = shortcut.status === 'dispatched';
        reportPageEvent('send_recorded_shortcut_dispatched', { key: strategy.key || 'Enter', modifiers: strategy.modifiers || [], dispatched: shortcutDispatched, method: shortcut.method });
        if (!shortcutDispatched) return { error: 'send_no_effect', detail: '录制快捷键没有可用输入目标' };
      } else if (sendKind === 'button') {
        // Button click: find send element, wait enabled, click once only
        const selector = strategy?.selector || selectorText(selectors.send);
        const sendStarted = Date.now();
        let sendEl = null;
        while (Date.now() - sendStarted < 120000) {
          throwIfCaptureCancelled();
          sendEl = await waitForElement(selectorDescriptor(
            selectors.send?.kind === 'button' ? selectors.send : strategy?.selector || selectors.send
          ), 1000, 'send');
          if (sendEl && sendEl.getClientRects().length) break;
          await sleep(250);
        }
        if (!sendEl) return { error: 'send_not_ready_timeout', detail: '等待发送按钮 120 秒后仍未就绪', selector };
        const sendControl = sendEl.closest('button, [role="button"], [data-testid*="send" i], [id*="send" i]') || sendEl;
        const sendReadyStarted = Date.now();
        while (Date.now() - sendReadyStarted < 120000) {
          throwIfCaptureCancelled();
          const disabled = sendControl.disabled || sendControl.getAttribute('disabled') !== null ||
            sendControl.getAttribute('aria-disabled') === 'true' || /disable/i.test(sendEl.getAttribute('class') || '');
          if (!disabled) break;
          await sleep(250);
        }
        const sendDisabled = sendControl.disabled || sendControl.getAttribute('disabled') !== null ||
          sendControl.getAttribute('aria-disabled') === 'true' || /disable/i.test(sendEl.getAttribute('class') || '');
        reportPageEvent('send_state_before_click', { selector, disabled: sendDisabled, inputLength: String(inputEl.value || inputEl.textContent || '').length });
        if (sendDisabled) {
          return { error: 'send_not_ready_timeout', detail: '发送按钮持续禁用，等待 120 秒后仍未就绪', selector };
        }
        throwIfCaptureCancelled();
        reportPageEvent('send_button_ready', { selector, waitedMs: Date.now() - sendReadyStarted });
        // Execute the exact recorded control once. CDP is inspection-only;
        // no worker-side click, text injection, form submit, or Enter fallback.
        const clicked = safeClick(sendControl);
        reportPageEvent('recorded_button_click', { clicked, method: 'recorded-dom-click', hostname: location.hostname });
        if (!clicked) return { error: 'send_click_failed', detail: '发送按钮点击未执行', selector };
        reportPageEvent('send_click_dispatched', { selector, tag: sendControl.tagName, className: String(sendControl.className || '').slice(0, 200),
          rect: (() => { const r = sendControl.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
          hitTag: (() => { const r = sendControl.getBoundingClientRect(); return document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))?.tagName || ''; })() });
        // The recorded click is the only send action. Its effect is confirmed
        // below without retrying through another input path.
      }
      // Do not equate DOM representation count with send count.  Virtualized
      // chat pages commonly expose one logical message through multiple
      // containers/IDs (for example a row plus an inner message node).  The
      // send action itself is already guarded and executed once; duplicate
      // candidates are diagnostic only and must not block extraction.
      // Sending and model generation are separate boundaries. A page with no
      // observable effect must fail inside a bounded window. Input consumption
      // is intentionally weaker than acceptance proof, but it means the one
      // recorded action may already be in flight, so continue to the
      // authoritative fresh-response boundary without submitting again.
      const sendObservationTimeoutMs = Math.max(
        2000,
        Math.min(30000, captureDeadlineAt - Date.now()),
      );
      const sendObservation = await waitForSendObservation({
        userMessage,
        beforeKeys,
        inputSelector,
        inputElement: inputEl,
        inputBefore: preSendInputValue,
        generationStateBefore,
        timeoutMs: sendObservationTimeoutMs,
      });
      if (!sendObservation.observed && !sendObservation.weak) {
        reportPageEvent('send_not_observed', {
          kind: sendKind,
          waitedMs: sendObservation.waitedMs,
          inputBeforeLength: sendObservation.inputBeforeLength,
          inputAfterLength: sendObservation.inputAfterLength,
        });
        return {
          error: 'send_not_observed',
          detail: '发送动作已执行一次，但在请求期限内没有出现用户消息、生成状态或新回复',
          recoverable: true,
        };
      }
      if (sendObservation.weak) {
        reportPageEvent('send_observation_pending', {
          kind: sendKind,
          reason: sendObservation.reason,
          waitedMs: sendObservation.waitedMs,
          inputBeforeLength: sendObservation.inputBeforeLength,
          inputAfterLength: sendObservation.inputAfterLength,
          action: 'observe_response_without_retry',
        });
      }
      await sleep(350);
      const freshUserMessages = logicalMessageSnapshot().filter(n =>
        !beforeKeys.has(n.key) && sameUserMessage(n.text, userMessage)
      );
      if (freshUserMessages.length > 1) {
        reportPageEvent('duplicate_send_detected', {
          expected: 1,
          actual: freshUserMessages.length,
          keys: freshUserMessages.map(n => n.key),
          action: 'diagnostic_only',
          reason: 'multiple_dom_representations_are_not_proof_of_multiple_submissions'
        });
      }
      reportCaptureProgress(sendObservation.observed
        ? `发送已确认（${sendObservation.reason}），等待模型回复`
        : `输入已消费（${sendObservation.reason}），继续确认模型回复`);
      // A network-only profile deliberately has no DOM response selector. The
      // debugger-backed capture owns the assistant result and will settle the
      // job through /browser/result. Returning here keeps the page action
      // finite and prevents a DOM timeout from masking a valid network stream.
      if (networkOnlyProfile()) {
        reportPageEvent('network_only_send_complete', { jobId, conversationId: expectedConversationId });
        return {
          success: true,
          user: userMessage,
          assistant: '',
          network_pending: true,
          conversation_id: expectedConversationId,
          tab_id: expectedTabId,
          response_region: 'network-sse'
        };
      }
      // The answer duration is independent of prompt length. A short prompt
      // can request a long streamed answer, so never collapse the response
      // window to a 15-second branch. Completion remains event-driven: a
      // stable recorded snapshot returns immediately; this is only the upper
      // bound for a provider that keeps generating or pauses between DOM
      // updates.
      const freshTimeoutMs = Math.max(1, captureDeadlineAt - Date.now());
      // The recorded-region monitor is both the freshness and completion
      // boundary. Waiting for a separate "visible response" phase first used
      // long minimum-generation and quiet windows, delaying every caller even
      // after the page had stopped changing.
      const visibleResponse = null;
      const response = await waitForFreshAssistantResponse(
        userMessage,
        beforeKeys,
        freshTimeoutMs,
        responseAnchorBefore,
        {
          jobId,
          claimToken,
          conversationId: expectedConversationId,
          tabId: expectedTabId,
          generationStateBefore,
        },
      );
      throwIfCaptureCancelled();
      // The recorded-region monitor can see a fresh assistant snapshot before
      // the logical-node reader can classify it. Preserve that authoritative
      // recorded-region result instead of waiting to the API timeout and
      // turning a real non-empty reply into browser_timeout.
      const directResponse = response || (
        visibleResponse?.text &&
        visibleResponse?.key &&
        !beforeKeys.has(visibleResponse.key) &&
        !likelyUserEcho(visibleResponse.text, userMessage, visibleResponse.role) &&
        !isStrictPromptReplyPrefix(visibleResponse.text, userMessage)
          ? visibleResponse
          : null
      );
      // A fresh DOM identity proves freshness, not authorship. Unknown-role
      // prompt projections and pre-send text remain ineligible even when a
      // virtualized page rehydrates them under a new key.
      const directResponseIsUserEcho = directResponse?.text &&
        likelyUserEcho(directResponse.text, userMessage, directResponse.role);
      if (directResponseIsUserEcho) {
        emitPageTrace('response_candidate_rejected_user_echo', { key: directResponse.key || '', textLength: String(directResponse.text || '').length });
      }
      const acceptedResponse = directResponseIsUserEcho ? null : directResponse;
      if (!acceptedResponse?.text) {
        return { error: 'response_timeout', completion_reason: 'no_content_timeout', detail: `${Math.round(freshTimeoutMs / 1000)} 秒内未检测到模型回复`, debug: captureDebug };
      }
      reportCaptureProgress(`已提取回复，文本 ${acceptedResponse.text.length} 字`);
      // Text extraction is the P0 deliverable. Build and post the browser result
      // before optional tool parsing so a provider-specific parser can never
      // swallow a valid assistant response and leave the API waiter hanging.
      const finalResult = { success: true, user: userMessage, assistant: acceptedResponse.text, key: acceptedResponse.key,
        conversation_id: expectedConversationId, tab_id: expectedTabId,
        response_region: acceptedResponse.key, completion_reason: acceptedResponse.completion_reason || 'stable_snapshot',
        tool_call: null };
      // Parse tool calls before posting the result. The previous order posted
      // tool_call:null first, then filled the local object afterward, so the
      // API caller could only ever receive the raw XML as assistant content.
      try {
        finalResult.tool_call = allowToolCalls && Universal?.parseToolCall ? (Universal.parseToolCall(acceptedResponse.text) || null) : null;
      } catch (toolError) {
        emitPageTrace('tool_parse_failed_nonfatal', { error: toolError?.message || String(toolError) });
      }
      emitPageTrace('capture_result_ready', {
        jobId,
        assistantLength: acceptedResponse.text.length,
        key: acceptedResponse.key || '',
        toolCall: finalResult.tool_call ? finalResult.tool_call.tool || '' : ''
      });
      if (jobId) {
        throwIfCaptureCancelled();
        const relayDispatched = await postBrowserResultWithRetry(
          { job_id: jobId, claim_token: claimToken, ...finalResult, domain: location.hostname },
          'final_result'
        );
        emitPageTrace('final_result_post_attempt_finished', {
          jobId,
          relayDispatched,
          assistantLength: acceptedResponse.text.length,
          key: acceptedResponse.key || ''
        });
      }
      return finalResult;
    } catch (err) {
      emitPageTrace('auto_capture_exception', {
        error: err?.message || String(err),
        jobId,
        hasStack: !!err?.stack
      });
      return { error: err?.message || String(err), debug: captureDebug };
    } finally {
      if (captureHeartbeatInterval) clearInterval(captureHeartbeatInterval);
      autoCaptureInFlight = false;
      currentCaptureJobId = '';
      captureCancelRequested = false;
      captureCancelJobId = '';
      captureCancelReason = '';
      window.__phantomRelayCaptureUserMessage = '';
      window.__phantomRelayCaptureBeforeMessages = [];
      latestObservedResponse = null;
      document.documentElement.removeAttribute(captureLock);
    }
  }

  function deriveStableSelectorAlternatives(css) {
    const source = String(css || '').trim();
    if (!source) return [];
    const volatile = /(?:^|[-_])(active|current|last|first|show|hide|loading|streaming|busy|disabled|selected|focus|focused|hover|open|close|transition|animation|enter|leave|visible|hidden|blank|empty|rank|index|position|order)(?:[-_]|$)/i;
    const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const volatileClasses = Array.from(source.matchAll(/\.([a-zA-Z_-][\w-]*)/g))
      .map(match => match[1])
      .filter((token, index, tokens) => volatile.test(token) && tokens.indexOf(token) === index);
    if (!volatileClasses.length) return [];

    let candidate = source;
    for (const token of volatileClasses) {
      candidate = candidate.replace(
        new RegExp(`\\.${escapeRegExp(token)}(?=[.#\\[:\\s>+~]|$)`, 'g'),
        '',
      );
    }
    if (!candidate || candidate === source) return [];
    try {
      // A fallback is executable only when it remains an unambiguous page
      // target. Broadening a recorded selector would be worse than failing
      // closed and asking for a re-record.
      if (document.querySelectorAll(candidate).length !== 1) return [];
    } catch (_) {
      return [];
    }
    return [candidate];
  }

  function normalizeRecordedSelector(value) {
    if (!value) return null;
    let normalized = null;
    if (typeof value === 'string') normalized = { css: value, alternatives: [] };
    else if (typeof value.css === 'string') normalized = value;
    else if (typeof value.selector === 'string') normalized = { css: value.selector, alternatives: value.alternatives || [] };
    else if (value.selector?.css) normalized = { ...value.selector, alternatives: value.selector.alternatives || [] };
    if (!normalized) return null;
    const alternatives = Array.isArray(normalized.alternatives) ? normalized.alternatives : [];
    return {
      ...normalized,
      alternatives: [...new Set([
        ...alternatives,
        ...deriveStableSelectorAlternatives(normalized.css),
      ])],
    };
  }

  function selectorText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value.selector === 'string') return value.selector;
    if (typeof value.css === 'string') return value.css;
    if (value.selector && typeof value.selector.css === 'string') return value.selector.css;
    return '';
  }

  function selectorDescriptor(value) {
    const normalized = normalizeRecordedSelector(value);
    return normalized || { css: selectorText(value), alternatives: [] };
  }

  function sendClickFallback(inputEl) {
    const container = inputEl.closest('form, [class*="footer"], [class*="input"], [class*="composer"], [class*="chat"]') || inputEl.parentElement?.parentElement;
    const candidates = Array.from((container || document).querySelectorAll('button, [role="button"], [onclick]'))
      .filter(el => el.getClientRects().length && !el.disabled && el !== inputEl);
    return candidates.find(el => {
      const text = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''} ${el.textContent || ''}`.toLowerCase();
      return /send|submit|发送|提交|enter|arrow-up|paper-plane/.test(text);
    }) || candidates[candidates.length - 1] || null;
  }

  function setInputValue(el, value) {
    const editable = el.matches?.('[contenteditable="true"]') ? el : el.closest?.('[contenteditable="true"]');
    if (editable) {
      editable.focus();
      editable.textContent = value;
      editable.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      editable.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      emitPageTrace('input_value_set', {
        kind: 'contenteditable',
        targetTag: editable.tagName,
        textLength: String(editable.textContent || '').length,
      });
      return;
    }
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    // Semi/React controlled textareas consume a real InputEvent. A plain Event
    // can update the visible value while leaving the framework's state empty,
    // which makes the subsequent send click create no generation.
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      emitPageTrace('input_value_set', {
        kind: 'input',
        targetTag: el.tagName,
        valueLength: String(el.value || '').length,
      });
  }

  function reportPageEvent(kind, data = {}) {
    emitPageTrace(kind, data);
  }

  function normalizeMessageKey(el) {
    return messageIdentity(el);
  }

  function messageIdentity(el) {
    if (!activeProfile || !ProfileContract || !el) return '';
    return ProfileContract.messageIdentity(activeProfile, elementRecord(el));
  }

  function messageRole(el) {
    if (!activeProfile || !ProfileContract || !el) return 'unknown';
    return ProfileContract.messageRole(activeProfile, elementRecord(el));
  }

  function messageIsStreaming(el) {
    if (!activeProfile || !ProfileContract || !el) return false;
    return ProfileContract.isStreaming(activeProfile, elementRecord(el));
  }

  // A recorded page may expose no streaming attribute on the response node.
  // Use only generic interaction semantics as a second activity signal; this
  // deliberately does not contain provider names or site-specific selectors.
  const GENERATION_CONTROL_PATTERN = /(?:stop|cancel|abort|pause|停止|取消|中止|暂停|终止)/i;

  function isVisibleEnabledControl(element) {
    if (!element || !element.isConnected) return false;
    try {
      if (!element.getClientRects?.().length) return false;
      const style = window.getComputedStyle?.(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      if (element.disabled || element.getAttribute('disabled') !== null) return false;
      if (element.getAttribute('aria-disabled') === 'true') return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
    } catch (_) {
      return false;
    }
    return true;
  }

  function activeGenerationControl() {
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], [aria-label], [title], [data-testid], [data-action]'
    ));
    return candidates.find(element => {
      if (!isVisibleEnabledControl(element)) return false;
      const attributes = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.getAttribute('data-action')
      ].filter(Boolean).join(' ');
      const text = /^(BUTTON|[A-Z]+)$/.test(element.tagName || '')
        ? String(element.textContent || '').trim().slice(0, 64)
        : '';
      return GENERATION_CONTROL_PATTERN.test(`${attributes} ${text}`);
    }) || null;
  }

  function sendActivityState(element) {
    const marker = !!(element && messageIsStreaming(element));
    const control = !!activeGenerationControl();
    return { streaming: marker || control, marker, control };
  }

  function responseActivityState(element, generationStateBefore = null) {
    const state = element && activeProfile && ProfileContract?.streamingState
      ? ProfileContract.streamingState(activeProfile, elementRecord(element))
      : { active: !!(element && messageIsStreaming(element)), explicitlySettled: false };
    const marker = state.active;
    // The generic stop/cancel control is evidence only when it appeared after
    // this request's send boundary. A control already present before send may
    // belong to another page workflow and cannot own this response.
    const control = !!activeGenerationControl() && !generationStateBefore?.control;
    const streaming = ResponseObservation
      ? ResponseObservation.isResponseStreaming({ recordedMarker: marker, requestControl: control })
      : (marker || control);
    return {
      streaming,
      marker,
      explicitlySettled: state.explicitlySettled,
      streamingSeen: state.active === true,
      control,
    };
  }

  function domToMarkdown(root, profile = activeProfile) {
    const render = (node, ctx = {}) => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      if (['button', 'svg', 'script', 'style', 'noscript'].includes(tag)) return '';
      const excluded = profile?.response?.excludedSelectors || [];
      const excludedSelector = `[aria-hidden="true"], [data-testid*="copy" i], [class*="copy" i]${excluded.length ? `, ${excluded.join(', ')}` : ''}`;
      if (matchesProfileSelector(node, excludedSelector)) return '';
      const inner = Array.from(node.childNodes).map(child => render(child, { tag })).join('');
      if (!inner.trim() && !['br','hr'].includes(tag)) return '';
      if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
      if (tag === 'strong' || tag === 'b') return `**${inner.trim()}**`;
      if (tag === 'em' || tag === 'i') return `*${inner.trim()}*`;
      if (tag === 'del' || tag === 's') return `~~${inner.trim()}~~`;
      if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${inner.trim()}\``;
      if (tag === 'pre') return `\n\n\`\`\`\n${(node.innerText || node.textContent || '').replace(/\n+$/,'')}\n\`\`\`\n\n`;
      if (tag === 'a') return `[${inner.trim()}](${node.getAttribute('href') || ''})`;
      if (tag === 'br') return '\n';
      if (tag === 'hr') return '\n\n---\n\n';
      if (tag === 'li') return `${ctx.listType === 'ol' ? `${ctx.index}. ` : '- '}${inner.trim()}\n`;
      if (tag === 'ul' || tag === 'ol') {
        let index = 0;
        const items = Array.from(node.children).map(child => {
          index += 1;
          return render(child, { listType: tag, index });
        }).join('');
        return `\n${items}\n`;
      }
      if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'blockquote' || tag === 'tr') return `\n${inner.trim()}\n`;
      if (tag === 'th' || tag === 'td') return ` ${inner.trim()} |`;
      return inner;
    };
    return render(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractMessageText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    // Do not remove every aria-label node: chat message containers use
    // aria-label for accessibility, and deleting them can delete the answer
    // subtree from the cloned DOM. Buttons/role=button/SVG already cover the
    // controls that must be excluded.
    const excluded = activeProfile?.response?.excludedSelectors || [];
    const selectorsToRemove = ['button', '[role="button"]', 'svg', '[data-testid*="copy" i]', '[class*="copy" i]', ...excluded];
    try { clone.querySelectorAll(selectorsToRemove.join(', ')).forEach(n => n.remove()); } catch (_) {
      clone.querySelectorAll('button, [role="button"], svg').forEach(n => n.remove());
    }
    return domToMarkdown(clone, activeProfile);
  }

  function logicalMessageSnapshot() {
    if (!activeProfile || !ProfileContract) return [];
    const candidates = [];
    for (const css of responseSelectorSet()) {
      try { candidates.push(...Array.from(document.querySelectorAll(css))); } catch (_) {}
    }
    const byLogicalIdentity = new Map();
    for (const el of candidates) {
      const rawText = extractMessageText(el);
      const text = ProfileContract.normalizeText(activeProfile, rawText);
      const visibleText = text || Universal?.responseText?.(el.innerText || el.textContent || '') || (el.innerText || el.textContent || '').trim();
      if (!visibleText) continue;

      const logicalKey = messageIdentity(el);
      if (!logicalKey) continue;

      const group = byLogicalIdentity.get(logicalKey) || [];
      group.push({
        element: el,
        text: visibleText,
        index: candidates.indexOf(el),
        specificity: recordedProjectionSpecificity(el),
        depth: elementDepth(el),
      });
      byLogicalIdentity.set(logicalKey, group);
    }
    return Array.from(byLogicalIdentity.values()).map((group, index) => {
      const chosen = selectRecordedProjection(group);
      const { element, text } = chosen;
      return {
      key: messageIdentity(element) || `logical:${index}`,
      element,
      index,
      text,
      role: messageRole(element),
      streaming: messageIsStreaming(element),
      };
    });
  }

  function selectRecordedProjection(group) {
    if (ResponseObservation?.selectRecordedProjection) {
      return ResponseObservation.selectRecordedProjection(group);
    }
    return (Array.isArray(group) ? group : []).reduce((best, item) => {
      if (!best) return item;
      if (Number(item?.specificity || 0) !== Number(best?.specificity || 0)) {
        return Number(item?.specificity || 0) > Number(best?.specificity || 0) ? item : best;
      }
      return Number(item?.depth || 0) > Number(best?.depth || 0) ? item : best;
    }, null);
  }

  function debugNode(n) {
    return { key: n.key, role: n.role, streaming: n.streaming, textLength: n.text.length };
  }

  function normalizeComparableText(value) {
    const raw = String(value || '')
      .replace(/[\u00a0\u200b]/g, ' ')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
    const normalized = activeProfile && ProfileContract
      ? ProfileContract.normalizeText(activeProfile, raw)
      : raw;
    return normalized
      // 页面可能自动在中文标点、引号、数字之间插入空白；比较用户消息时忽略所有空白。
      .replace(/\s+/g, '')
      .trim();
  }

  function userComparableText(value) {
    const comparable = Universal?.comparableText
      ? Universal.comparableText(value)
      : normalizeComparableText(value);
    return comparable.replace(/^(?:user|human|用户)[:：]?/i, '').trim();
  }

  function sameUserMessage(actual, expected) {
    return userComparableText(actual) === userComparableText(expected);
  }

  function likelyUserEcho(candidateText, userMessage, role = 'unknown') {
    if (!ResponseObservation?.isLikelyUserEcho) return sameUserMessage(candidateText, userMessage);
    const previousTexts = Array.isArray(window.__phantomRelayCaptureBeforeMessages)
      ? window.__phantomRelayCaptureBeforeMessages.map(item => String(item?.text || ''))
      : [];
    return ResponseObservation.isLikelyUserEcho({
      candidateText,
      promptText: userMessage,
      previousTexts,
      role,
    });
  }

  function isFreshUserProjection(key, currentText, beforeKeys) {
    const normalizedKey = String(key || '');
    const nextText = String(currentText || '');
    if (!normalizedKey || !nextText) return false;
    if (!beforeKeys?.has(normalizedKey)) return true;
    const before = Array.isArray(window.__phantomRelayCaptureBeforeMessages)
      ? window.__phantomRelayCaptureBeforeMessages
      : [];
    const prior = before.find(item => String(item?.key || '') === normalizedKey);
    // Message rows can reuse one logical class/key for both turns. A changed
    // user projection is fresh evidence even when its logical key was present
    // before the send; an unchanged projection remains stale.
    return !!prior && !sameUserMessage(prior.text || '', nextText);
  }

  function findFreshUserMessage(userMessage, beforeKeys) {
    const logical = logicalMessageSnapshot().find(n =>
      isFreshUserProjection(n.key, n.text, beforeKeys) && sameUserMessage(n.text, userMessage)
    );
    if (logical) return logical;

    // A recorded response selector is intentionally allowed to describe only
    // assistant output. Enter-based submission still needs independent proof
    // that the page accepted the prompt, so inspect generic keyed message
    // candidates without guessing a site or provider. This keeps the response
    // boundary authoritative while removing the accidental requirement that a
    // response profile also match user rows.
    const candidates = [];
    try {
      candidates.push(...document.querySelectorAll(
        '[data-role], [role], [data-message-id], [data-row-key], [data-observe-row], [data-virtual-list-item-key]'
      ));
    } catch (_) {}
    for (const el of Array.from(new Set(candidates))) {
      const key = messageNodeKey(el);
      if (!key) continue;
      const text = ProfileContract.normalizeText(activeProfile, extractMessageText(el));
      if (!isFreshUserProjection(key, text, beforeKeys)) continue;
      if (!text || !sameUserMessage(text, userMessage)) continue;
      if (messageRole(el) === 'assistant') continue;
      return { key, element: el, text, role: messageRole(el), streaming: false };
    }
    return null;
  }

  function isNodeAfterFreshUser(candidateEl, userMessage, beforeKeys) {
    if (!candidateEl || !userMessage) return true;
    const freshUser = findFreshUserMessage(userMessage, beforeKeys);
    const userEl = freshUser?.element;
    if (!userEl || !userEl.isConnected) return true;
    if (candidateEl === userEl || candidateEl.contains?.(userEl) || userEl.contains?.(candidateEl)) {
      const candidateText = extractMessageText(candidateEl);
      return !sameUserMessage(candidateText, userMessage);
    }
    const pos = userEl.compareDocumentPosition(candidateEl);
    return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function strictRequestedReply(userMessage) {
    const prompt = normalizeComparableText(userMessage);
    if (!prompt) return '';
    // Common "reply only with X" prompts: compare against the requested
    // payload, not arbitrary page text. This is generic and provider-neutral.
    return prompt.split(/[:：]/).pop() || '';
  }

  function isStrictPromptReplyPrefix(candidateText, userMessage) {
    const candidate = normalizeComparableText(candidateText);
    const requested = strictRequestedReply(userMessage);
    if (!candidate || !requested) return false;
    return requested.length > candidate.length && requested.startsWith(candidate);
  }

  function recordedResponseRegion() {
    if (!activeProfile || !ProfileContract) return null;
    // The clicked response node can be more specific than the stable identity
    // container recorded alongside it. If the former disappears on the next
    // turn, the container remains the provider-neutral replay boundary.
    for (const css of responseSelectorSet()) {
      const el = findElement({ css, alternatives: [] }, 'response');
      if (!el || !el.isConnected) continue;
      const rect = el.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) continue;
      return el;
    }
    return null;
  }

  function responseTextWasPresentBefore(text) {
    const candidate = normalizeComparableText(text);
    if (!candidate) return false;
    const before = Array.isArray(window.__phantomRelayCaptureBeforeMessages)
      ? window.__phantomRelayCaptureBeforeMessages
      : [];
    return before.some(item => normalizeComparableText(item?.text) === candidate);
  }

  function isVisibleInViewport(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    const viewportWidth = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
    const viewportHeight = Number(window.innerHeight || document.documentElement?.clientHeight || 0);
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
      rect.left < viewportWidth && rect.top < viewportHeight;
  }

  function responseChangedSinceBefore(key, currentText, element = null) {
    const before = Array.isArray(window.__phantomRelayCaptureBeforeMessages)
      ? window.__phantomRelayCaptureBeforeMessages
      : [];
    const prior = before.find(item => String(item?.key || '') === String(key || ''));
    if (!prior) return false;
    const oldText = String(prior.text || '');
    const nextText = String(currentText || '');
    const oldComparable = normalizeComparableText(oldText);
    const nextComparable = normalizeComparableText(nextText);
    // An unchanged logical node is stale even when the text is a valid answer.
    // A later turn may legitimately produce the same text, but that case must
    // arrive under a fresh message identity and is handled by the caller.
    if (oldComparable === nextComparable) return false;
    if (sameUserMessage(oldText, nextText)) return false;
    // A recorded selector may point at an inner projection of the same
    // pre-send response. If that projection is shorter but is wholly contained
    // in the pre-send text, it is stale DOM evidence, not a new turn.
    if (
      nextComparable.length < oldComparable.length &&
      oldComparable.includes(nextComparable)
    ) {
      return false;
    }
    // Appending citations, recommendations, or status text to an old assistant
    // node does not create a new request-owned response. A reused identity must
    // replace the old body rather than contain it in either direction.
    if (oldComparable.includes(nextComparable) || nextComparable.includes(oldComparable)) return false;
    if (nextText.length >= oldText.length) return !responseTextWasPresentBefore(nextText);
    // A reused logical key can represent multiple DOM rows. When the old row
    // is virtualized out of view and the new row is visible, the new response
    // may legitimately be shorter than the historical response.
    const visibleInViewport = isVisibleInViewport(element);
    return visibleInViewport && !responseTextWasPresentBefore(nextText);
  }

  function isFreshRecordedResponse(key, currentText, beforeKeys, element = null) {
    const normalizedKey = String(key || '');
    if (!normalizedKey || !currentText) return false;
    const oldKeys = beforeKeys || new Set();
    if (!oldKeys.has(normalizedKey)) return true;
    return responseChangedSinceBefore(normalizedKey, currentText, element);
  }

  function recordedResponseSnapshot(userMessage = '', beforeKeys = new Set()) {
    if (!activeProfile || !ProfileContract) return null;
    const response = responseContract();
    // Keep the recorded response selector as the only search boundary. A
    // broad recorded selector can match both the newest user row and the
    // assistant row in a virtualized list, so prefer a fresh non-user match.
    const regions = responseRegionElements().filter(el => {
      const rect = el.getBoundingClientRect?.();
      return el.isConnected && el.getClientRects?.().length && (!rect || (rect.width > 0 && rect.height > 0));
    });
    if (!regions.length) return null;
    // A response node may not exist at startup and can be created only after
    // the recorded send action. Re-run the structural health check once the
    // live page exposes the recorded boundary. This prevents a fixed
    // conversation/layout container from being accepted as the assistant
    // message simply because the pre-send check allowed a missing response.
    const liveBoundaryHealth = runProfileHealthCheck(activeProfile, { allowMissingResponse: false });
    if (liveBoundaryHealth.reason_codes?.includes('profile_response_scope_too_broad')) {
      emitPageTrace('recorded_response_boundary_rejected', {
        reason: 'profile_response_scope_too_broad',
        profileId: activeProfile?.profileId || '',
        revision: activeProfileRevision
      });
      const failure = profileHealthError(liveBoundaryHealth);
      const error = new Error(failure.detail || 'recorded response boundary is too broad');
      error.code = failure.error || 'profile_response_scope_too_broad';
      error.reason_codes = failure.reason_codes || ['profile_response_scope_too_broad'];
      throw error;
    }
    const identity = response.identity || {};
    const identityConfigured = Array.isArray(identity.attributes) && identity.attributes.length > 0 || !!identity.path;
    const snapshots = regions.map((region, index) => {
      const rawText = ProfileContract.normalizeText(activeProfile, extractMessageText(region));
      return {
        region,
        index,
        key: messageIdentity(region) || (identityConfigured ? '' : region.getAttribute('data-message-id') || region.getAttribute('data-observe-row') || 'recorded-response-region'),
        text: Universal?.responseText ? Universal.responseText(rawText) : rawText,
        streaming: messageIsStreaming(region),
        role: messageRole(region),
        specificity: recordedProjectionSpecificity(region),
        depth: elementDepth(region),
      };
    }).filter(item => item.text && item.key);
    if (!snapshots.length) return null;
    // Identity ancestors establish ownership only. The recorded response
    // selector establishes the body projection, so a longer outer container
    // cannot pull prompts, citations, recommendations, or page chrome into the
    // returned assistant text.
    const byIdentity = new Map();
    for (const item of snapshots) {
      const group = byIdentity.get(item.key) || [];
      group.push(item);
      byIdentity.set(item.key, group);
    }
    const projections = [];
    for (const group of byIdentity.values()) {
      const selected = selectRecordedProjection(group);
      if (!selected) continue;
      const selectedRect = selected.region?.getBoundingClientRect?.();
      const connected = selected.region?.isConnected === true;
      const visible = connected && !!selected.region?.getClientRects?.().length &&
        (!selectedRect || (selectedRect.width > 0 && selectedRect.height > 0));
      projections.push({
        ...selected,
        projectionCount: group.length,
        selectedIndex: selected.index,
        selectedSpecificity: selected.specificity,
        selectedDepth: selected.depth,
        connected,
        visible,
      });
    }
    const normalizedSnapshots = projections.filter(Boolean);
    // Diagnostic only: preserve the recorded selector boundary while exposing
    // which recorded-region identities are visible during a capture.
    if (userMessage && (Date.now() % 5 === 0)) {
    emitPageTrace('recorded_response_probe', { beforeKeys: Array.from(beforeKeys).slice(-12), snapshots: normalizedSnapshots.map(item => ({ key: item.key, textLength: String(item.text || '').length, streaming: !!item.streaming, projectionCount: item.projectionCount, selectedIndex: item.selectedIndex, selectedSpecificity: item.selectedSpecificity, selectedDepth: item.selectedDepth, connected: item.connected, visible: item.visible })) });
    }
    const requestedReply = strictRequestedReply(userMessage);
    const evaluatedCandidates = normalizedSnapshots.map(item => {
      const freshIdentity = !beforeKeys.has(item.key);
      const freshResponse = isFreshRecordedResponse(item.key, item.text, beforeKeys, item.region);
      const userEcho = !!userMessage && likelyUserEcho(item.text, userMessage, item.role);
      const afterFreshUser = isNodeAfterFreshUser(item.region, userMessage, beforeKeys);
      const promptPrefix = !!userMessage && isStrictPromptReplyPrefix(item.text, userMessage);
      const domText = normalizeComparableText(item.region?.innerText || item.region?.textContent || '');
      const identityElement = declaredIdentityElement(item.region);
      const identityText = normalizeComparableText(
        identityElement?.innerText || identityElement?.textContent || '',
      );
      return {
        item,
        freshIdentity,
        freshResponse,
        userEcho,
        afterFreshUser,
        promptPrefix,
        requestedLength: requestedReply.length,
        domLength: domText.length,
        identityLength: identityText.length,
        domContainsRequested: !!requestedReply && domText.includes(requestedReply),
        identityContainsRequested: !!requestedReply && identityText.includes(requestedReply),
        eligible: freshResponse && !userEcho && !promptPrefix && afterFreshUser,
      };
    });
    if (userMessage && (Date.now() % 5 === 0)) {
      emitPageTrace('recorded_response_candidate_evaluated', {
        candidateCount: evaluatedCandidates.length,
        candidates: evaluatedCandidates.map(candidate => ({
          key: candidate.item.key,
          textLength: String(candidate.item.text || '').length,
          role: candidate.item.role,
          projectionCount: candidate.item.projectionCount,
          selectedIndex: candidate.item.selectedIndex,
          selectedSpecificity: candidate.item.selectedSpecificity,
          selectedDepth: candidate.item.selectedDepth,
          connected: candidate.item.connected,
          visible: candidate.item.visible,
          freshIdentity: candidate.freshIdentity,
          freshResponse: candidate.freshResponse,
          userEcho: candidate.userEcho,
          afterFreshUser: candidate.afterFreshUser,
          promptPrefix: candidate.promptPrefix,
          requestedLength: candidate.requestedLength,
          domLength: candidate.domLength,
          identityLength: candidate.identityLength,
          domContainsRequested: candidate.domContainsRequested,
          identityContainsRequested: candidate.identityContainsRequested,
          eligible: candidate.eligible,
        })),
      });
    }
    const freshAssistant = evaluatedCandidates
      .filter(candidate => candidate.eligible)
      .map(candidate => candidate.item);
    // A pre-send key is not sufficient evidence of a stale response when a
    // page reuses a logical node. Freshness is the key+text contract above.
    if (beforeKeys.size && !freshAssistant.length) return null;
    const pool = freshAssistant.length ? freshAssistant : normalizedSnapshots;
    // Before sending, the last recorded identity is the newest visible
    // conversation item. Prefer an explicitly assistant-role item when the
    // profile exposes one; otherwise retain DOM order and avoid selecting the
    // longest user prompt as the response anchor.
    const assistantPool = !userMessage ? pool.filter(item => item.role === 'assistant') : [];
    const orderedPool = assistantPool.length ? assistantPool : pool;
    const chosen = orderedPool[orderedPool.length - 1] || null;
    if (!chosen) return null;
    return {
      key: chosen.key,
      text: chosen.text,
      streaming: chosen.streaming,
      role: chosen.role,
      region: chosen.region,
      activityToken: recordedResponseActivityToken(chosen),
    };
  }

  function recordedResponseIdentityGap() {
    const response = responseContract();
    const identity = response?.identity || {};
    const identityConfigured = (Array.isArray(identity.attributes) && identity.attributes.length > 0) || !!identity.path;
    if (!identityConfigured) return null;
    const regions = responseRegionElements().filter(el => {
      const rect = el.getBoundingClientRect?.();
      return el.isConnected && el.getClientRects?.().length && (!rect || (rect.width > 0 && rect.height > 0));
    });
    const nonEmpty = regions.filter(el => {
      const text = ProfileContract.normalizeText(activeProfile, extractMessageText(el));
      return !!text;
    });
    if (!nonEmpty.length || nonEmpty.some(el => !!messageIdentity(el))) return null;
    return {
      regionCount: regions.length,
      nonEmptyRegionCount: nonEmpty.length,
      identityAttributes: Array.isArray(identity.attributes) ? identity.attributes.slice() : [],
      identityPath: String(identity.path || ''),
    };
  }

  function findElement(sel, role = null) {
    if (!sel) return null;
    const candidates = [sel.css, ...(sel.alternatives || [])].filter(Boolean);
    for (const css of candidates) {
      try {
        const matches = document.querySelectorAll(css);
        if (matches.length === 1) return matches[0];
        if (role === 'response' && matches.length > 1) {
          // The recorded response selector may match several virtualized
          // message containers after the page grows. Keep the recorded CSS
          // contract; disambiguate only among its own visible matches by
          // taking the last rendered region, which is the newest chat item.
          const visible = Array.from(matches).filter(el => el.isConnected && el.getClientRects?.().length);
          if (visible.length) {
            const textful = visible.filter(el => extractMessageText(el).trim());
            return (textful.length ? textful : visible)[(textful.length ? textful : visible).length - 1];
          }
        }
        if (role === 'input') {
          const editable = Array.from(matches).find(el =>
            el.matches('textarea,input,[contenteditable="true"]') &&
            el.getClientRects().length > 0 &&
            getComputedStyle(el).visibility !== 'hidden' &&
            getComputedStyle(el).display !== 'none'
          );
          if (editable) return editable;
        }
      } catch {}
    }
    // 兼容旧版本已保存的 tag+class selector：class 变化时保留录制时的 tag。
    const tag = sel.css?.match(/^([a-zA-Z][\w-]*)[.#[]/)?.[1];
    if (tag) {
      try {
        const matches = document.querySelectorAll(tag);
        if (matches.length === 1) return matches[0];
      } catch {}
    }
    // 旧版本只保存了运行时 class selector。页面刷新后 class 可能重建，
    // 但录制时的标签仍然有价值；input 只在同标签的可编辑元素中恢复。
    const structure = sel.css?.match(/^([a-zA-Z][\w-]*)([^>]+)?$/);
    if (structure && role === 'input') {
      const tag = structure[1].toLowerCase();
      const classes = [...(structure[2] || '').matchAll(/\.([\w-]+)/g)].map(m => m[1]);
      if (classes.length) {
        try {
          const candidates = Array.from(document.querySelectorAll(tag)).filter(el => {
            const visible = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
            return visible && classes.every(c => el.classList.contains(c));
          });
          if (candidates.length === 1) return candidates[0];
          const editable = candidates.find(el => el.matches('textarea,input,[contenteditable="true"]'));
          if (editable) return editable;
        } catch {}
      }
    }
    return null;
  }

  function selectorAlternatives(el, primary) {
    const out = [];
    const push = (css) => {
      if (!css || css === primary || out.includes(css)) return;
      try { if (document.querySelectorAll(css).length === 1) out.push(css); } catch {}
    };
    if (el.id && /^[a-zA-Z_][\w-]*$/.test(el.id)) push(`#${CSS.escape(el.id)}`);
    for (const attr of ['data-testid', 'data-id', 'data-e2e', 'data-qa', 'data-test-id', 'data-automation', 'data-selector']) {
      const value = el.getAttribute(attr);
      if (value) push(`[${attr}="${CSS.escape(value)}"]`);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 100) push(`[aria-label="${CSS.escape(aria)}"]`);
    if (el.tagName) push(el.tagName.toLowerCase());
    return out;
  }

  function stableIdentityElement(element) {
    const stableIdentityAttributes = ['data-message-id', 'data-lid', 'data-observe-row', 'data-virtual-list-item-key', 'data-row-key', 'data-id', 'data-key'];
    const genericIdentityExcluded = /(?:^|[-_:])(app|root|role|status|state|streaming|loading|busy|typing|generating|thinking|processing|pending|complete|completed|finished|active|current|selected|disabled|expanded|pressed|checked|open|closed|visible|hidden|focus|hover|animation|transition|test|qa|click|show|hide|base|share|delete|session|query|conversation|chat|content|text|html|style|log|rank|index|position|order|offset|page|count|sort|spm|track|trace|analytics|telemetry|event|anchor|source|exposure|exposed|exposured|impression|intersection|observer|panel|layout|container|wrapper|scroll|flow|history|header|footer|aside|nav|toolbar|viewport|main|body|input|tool|login)(?:[-_:]|$)/i;
    const volatilePlainId = (value) => {
      const normalized = String(value || '').trim();
      if (!normalized || /^\d{1,4}$/.test(normalized)) return true;
      // Plain ids on layout, conversation, and scroll containers are unique
      // in the document but do not identify one logical assistant message.
      // Never promote them to a recorded response identity; keep walking for
      // a stable data-* message key or fail closed.
      if (genericIdentityExcluded.test(normalized)) return true;
      if (/(?:^|[-_:])(message|response|reply|result|item|row|node|turn)[-:.]?(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{6,}|[a-z0-9]{12,})$/i.test(normalized)) return true;
      return /(?:^|[-_:])(message|response|reply|result|item|row|node|turn)(?:[-_:]|$)/i.test(normalized);
    };
    const dynamicMessageId = (value) => {
      const normalized = String(value || '').trim();
      return /(?:^|[-_:])(message|response|reply|result|item|row|turn)(?:[-:.]|$)/i.test(normalized) &&
        /(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{6,}|[a-z0-9]{12,})$/i.test(normalized);
    };
    const uniqueAttribute = (candidate, attribute, allowScopedDuplicate = false, allowDynamicMessageId = false) => {
      const value = String(candidate?.getAttribute?.(attribute) || '').trim();
      if (!value) return false;
      if (String(attribute).toLowerCase() === 'id' && volatilePlainId(value) &&
          !(allowDynamicMessageId && dynamicMessageId(value))) return false;
      try {
        const matches = Array.from(document.querySelectorAll('[' + CSS.escape(attribute) + ']'))
          .filter(item => String(item.getAttribute(attribute) || '').trim() === value);
        if (matches.length === 1) return true;
        return allowScopedDuplicate && matches.length > 1 && matches.every(item => item === candidate || candidate.contains?.(item));
      } catch (_) {
        return false;
      }
    };
    const genericIdentityAttribute = (attribute) => {
      const name = String(attribute?.name || '').trim().toLowerCase();
      const value = String(attribute?.value || '').trim();
      if (!name.startsWith('data-') || genericIdentityExcluded.test(name)) return false;
      if (!/^data-[a-z][a-z0-9_.:-]*$/.test(name) || !value || value.length > 256 || /\s/.test(value)) return false;
      return true;
    };
    const identityAttributesFor = (candidate) => {
      const fixed = stableIdentityAttributes.filter(attribute => uniqueAttribute(candidate, attribute));
      if (fixed.length) return fixed;
      const generic = Array.from(candidate?.attributes || [])
        .filter(genericIdentityAttribute)
        .map(attribute => attribute.name)
        .filter((attribute, index, values) => values.indexOf(attribute) === index)
        .filter(attribute => uniqueAttribute(candidate, attribute, true));
      if (generic.length) return generic;
      // A plain id is a last-resort identity. Many applications use short
      // ancestor ids for layout or routing; data-* message identities must win
      // whenever both are available on the recorded element's ancestry.
      if (uniqueAttribute(candidate, 'id', false, true)) return ['id'];
      return [];
    };
    let current = element;
    const minimumIdentityDepth = 16;
    for (let depth = 0; current && current !== document.body; depth += 1, current = current.parentElement) {
      // Search to the document boundary; the explicit minimum keeps deeply
      // nested render trees from being rejected solely because of markup depth.
      if (depth < minimumIdentityDepth || current.parentElement) {
        const found = identityAttributesFor(current);
        if (found.length) return { element: current, attributes: found };
      }
    }
    return { element, attributes: [] };
  }

  function recordedStreamingIndicators(element) {
    const stateName = /(?:^|[-_:])(streaming|loading|busy|typing|generating|thinking|processing|pending|complete|completed|finished)(?:[-_:]|$)/i;
    const indicators = [];
    for (let current = element, depth = 0;
      current && current !== document.body && depth < 24;
      current = current.parentElement, depth += 1) {
      for (const attribute of Array.from(current.attributes || [])) {
        const name = String(attribute.name || '').trim().toLowerCase();
        const value = String(attribute.value || '').trim().toLowerCase();
        if (!(name === 'aria-busy' || (name.startsWith('data-') && stateName.test(name)))) continue;
        if (value !== 'true' && value !== 'false') continue;
        const activeValue = value === 'true' ? 'false' : 'true';
        const selector = `[${CSS.escape(name)}="${activeValue}"]`;
        if (!indicators.some(item => item.selector === selector)) {
          indicators.push({ selector, equals: true });
        }
      }
    }
    return indicators;
  }

  function buildRecordedProfile(responseElement, responseSelector) {
    if (!ProfileContract || !selectors.input || !selectors.send || !responseElement) return null;
    const identity = stableIdentityElement(responseElement);
    const structuralIdentity = !identity.attributes.length;
    const projectionIndex = structuralIdentity
      ? recordedProjectionElements(responseSelector).indexOf(responseElement)
      : -1;
    if (structuralIdentity && projectionIndex < 0) return null;
    const containerSelector = !structuralIdentity
      // Never persist the recorded identity value as the scope selector. The
      // value is expected to change for every new assistant message; it is
      // used only by messageIdentity() to prove freshness. The reusable scope
      // may therefore describe stable structure or safe data-* attribute
      // presence, but never the recorded message's concrete identity value.
      ? generateStableContainerSelector(identity.element, identity.attributes)
      : null;
    const inputEl = selectorText(selectors.input) ? findElement(normalizeRecordedSelector(selectors.input), 'input') : null;
    const inputKind = inputEl?.matches?.('[contenteditable="true"]') ? 'contenteditable' : 'textarea';
    const send = selectors.send?.kind
      ? selectors.send
      : { kind: 'button', selector: selectorText(selectors.send) };
    const candidate = {
      profileId: `recorded-${location.hostname}-v1`,
      origin: `${location.protocol}//${location.host}`,
      domain: location.hostname,
      input: { selector: selectorText(selectors.input), kind: inputKind },
      send,
      response: {
        elementTag: responseElement.tagName.toLowerCase(),
        selector: {
          ...responseSelector,
          alternatives: [
            ...(responseSelector.alternatives || []),
            ...(SelectorRecovery?.deriveAlternatives?.(responseSelector) || [])
          ].filter((value, index, values) => values.indexOf(value) === index)
        },
        ...(containerSelector ? { containerSelector } : {}),
        identity: structuralIdentity
          ? { path: 'recordedResponseIndex' }
          : { attributes: identity.attributes },
        identityVerification: structuralIdentity
          ? {
              status: 'verified',
              method: 'selector-index-at-recording',
              identityKind: 'selector-position',
              attributes: []
            }
          : {
              status: 'verified',
              method: 'dom-unique-at-recording',
              attributes: identity.attributes,
              ...(identity.attributes.includes('id') ? { identityKind: 'unique-per-message' } : {})
            },
        role: { user: ['user', 'human'], assistant: ['assistant', 'model', 'bot'] },
        streamingIndicators: [
          ...recordedStreamingIndicators(responseElement),
          { selector: '[data-streaming="true"]', equals: true },
          { selector: '[aria-busy="true"]', equals: true }
        ].filter((item, index, values) => values.findIndex(candidate => candidate.selector === item.selector) === index),
        excludedSelectors: ['[aria-hidden="true"]', '[data-testid*="copy" i]', '[class*="copy" i]'],
        textNormalization: [{ kind: 'trim' }, { kind: 'collapse-whitespace' }]
      },
      capabilities: { text: true, streaming: 'dom-snapshot' }
    };
    try {
      return ProfileContract.normalizeProfile(candidate);
    } catch (error) {
      // Keep recording failures actionable without copying page text/HTML into
      // diagnostics. This is especially important for sites whose logical
      // message id is discovered on an ancestor rather than the clicked text
      // projection.
      emitPageTrace('profile_build_failed', {
        code: error?.code || 'profile_invalid',
        detail: error?.message || String(error),
        identityAttributes: identity.attributes,
        identityPath: structuralIdentity ? 'recordedResponseIndex' : '',
        recordedResponseIndex: projectionIndex,
        identityTag: identity.element?.tagName?.toLowerCase() || '',
        identityClass: typeof identity.element?.className === 'string'
          ? identity.element.className.slice(0, 160)
          : '',
        identityHasId: !!identity.element?.getAttribute?.('id'),
        responseSelector: responseSelector?.css || responseSelector?.selector || '',
        containerSelector: containerSelector?.css || containerSelector?.selector || ''
      });
      return null;
    }
  }

  function selectorMatchCount(sel) {
    if (!sel) return 0;
    return [sel.css, ...(sel.alternatives || [])].reduce((n, css) => {
      try { return n + document.querySelectorAll(css).length; } catch { return n; }
    }, 0);
  }

  async function waitForElement(sel, timeout, role = null) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      throwIfCaptureCancelled();
      const el = findElement(sel, role);
      if (el) return el;
      await sleep(250);
    }
    return findElement(sel, role);
  }

  function dispatchRecordedPointerClick(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    // A recorded selector may identify a wrapper DIV while the framework's
    // delegated handler is attached to the visual child under the hit point.
    // Use the actual hit-test target when it remains inside the recorded node.
    const hit = document.elementFromPoint(x, y);
    const target = hit && (hit === el || el.contains(hit)) ? hit : el;
    const init = { bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, buttons: 1, clientX: x, clientY: y };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
      return true;
    } catch (_) { return false; }
  }

  function safeClick(el, force = false) {
    if (!el) return false;
    // One logical click only. Prefer the native control ancestor, but honor the
    // exact recorded element when a provider uses a clickable div without
    // role="button" is a valid recorded control even when the element is not
    // a native button.
    const target = el.matches('button, [role="button"], div[role="button"], span[role="button"]')
      ? el
      : el.closest('button, [role="button"], div[role="button"], span[role="button"]') || el;
    if (!target || !(target instanceof HTMLElement)) return false;
    if (!force && (target.disabled || target.getAttribute('disabled') !== null || target.getAttribute('aria-disabled') === 'true')) return false;
    try {
      if (!['BUTTON', 'INPUT'].includes(target.tagName) && target.getAttribute('role') !== 'button') {
        return dispatchRecordedPointerClick(target);
      }
      target.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function getCopyButtons() {
    if (!selectors.copy?.selector?.css) return [];
    let matched = [];
    try { matched = Array.from(document.querySelectorAll(selectors.copy.selector.css)); }
    catch (e) { matched = []; }
    // 录制时用户点到的可能是按钮里的 SVG；回放必须提升到实际 button，
    // 再按消息行过滤。不能把 SVG 当成最终点击对象，也不能要求它自身带 copy 文案。
    const promoted = [];
    const seen = new Set();
    for (const el of matched) {
      const target = el.closest?.('button, [role="button"], [onclick]') || el;
      if (seen.has(target)) continue;
      seen.add(target);
      if (getMessageContainer(target)) promoted.push(target);
    }
    if (promoted.length) return promoted;

    // selector 失效时，只在消息行内复用录制元素的 tag/class 结构；
    // 对 SVG selector 要找其所在 button，而不是要求 SVG 本身有 copy marker。
    const fallback = [];
    for (const row of getMessageNodes()) {
      let candidates = [];
      try { candidates = Array.from(row.querySelectorAll(selectors.copy.selector.css)); } catch {}
      for (const el of candidates) {
        const target = el.closest?.('button, [role="button"], [onclick]') || el;
        if (!seen.has(target) && getMessageContainer(target)) {
          seen.add(target);
          fallback.push(target);
        }
      }
    }
    return fallback;
  }

  function getExactRecordedCopyButton(responseText = '') {
    const css = selectors.copy?.selector?.css;
    if (!css) return null;
    const rows = getMessageNodes();
    const assistantRows = rows.filter(row => {
      const text = (row.innerText || row.textContent || '').trim();
      return responseText && text.includes(responseText.trim());
    }).reverse();
    const promote = (el) => el?.closest?.('button, [role="button"], [onclick]') || el;
    // First resolve the recorded global selector, then restrict the result to
    // the newest assistant row. This handles selectors recorded on SVG icons.
    try {
      const globalMatches = Array.from(document.querySelectorAll(css));
      for (const row of assistantRows) {
        const hit = globalMatches.find(el => row.contains(el));
        if (hit) return promote(hit);
      }
    } catch {}
    // cssPath is rooted at the page, so retry progressively shorter suffixes
    // inside the current virtual-list row.
    const parts = css.split(' > ');
    for (const row of assistantRows) {
      for (let start = 0; start < parts.length; start++) {
        const suffix = parts.slice(start).join(' > ');
        try {
          const hits = Array.from(row.querySelectorAll(suffix));
          if (hits.length === 1) return promote(hits[0]);
        } catch {}
      }
    }
    // If the response row is not represented in the DOM, only accept a
    // globally unique recorded selector; never choose among multiple matches.
    try {
      const matches = Array.from(document.querySelectorAll(css));
      return matches.length === 1 ? promote(matches[0]) : null;
    } catch { return null; }
  }

  function isExactRecordedCopyButton(el) {
    const css = selectors.copy?.selector?.css;
    if (!css) return false;
    try { return document.querySelectorAll(css).length === 1 && document.querySelector(css) === el; }
    catch { return false; }
  }

  function isRecordedCopyTarget(el) {
    const recorded = selectors.copy?.selector?.css || '';
    const tag = recorded.match(/([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase() || '';
    if (tag && el.tagName.toLowerCase() !== tag) return false;
    const recordedClasses = [...recorded.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    if (recordedClasses.length && !recordedClasses.every(c => el.classList.contains(c))) return false;
    const html = el.outerHTML || '';
    const attrs = ['data-copy', 'data-copy-button', 'data-testid', 'data-e2e', 'data-qa', 'aria-label', 'title'];
    const marker = attrs.some(a => el.hasAttribute(a) && /copy|复制|clipboard|剪贴板/i.test(el.getAttribute(a) || ''));
    return marker || /copy|复制|clipboard|content_copy|剪贴板/i.test(html);
  }

  function copyButtonFingerprint(btn) {
    const r = btn.getBoundingClientRect();
    return `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}`;
  }

  function getButtonState(btn) {
    const style = getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();
    const hidden = (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      style.pointerEvents === 'none' ||
      btn.getAttribute('aria-hidden') === 'true' ||
      btn.hasAttribute('hidden') ||
      btn.disabled ||
      btn.getAttribute('aria-disabled') === 'true' ||
      btn.classList.contains('disabled')
    );
    return {
      usable: !hidden && rect.width > 0 && rect.height > 0,
      fingerprint: `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`,
      disabled: hidden
    };
  }

  function getMessageContainer(copyButton) {
    const keyed = copyButton?.closest?.('[data-message-id]');
    if (keyed) return keyed;
    // A virtualized chat may render the copy action outside the message row;
    // follow its row identity when available instead of selecting an unrelated
    // input-area action.
    const row = copyButton?.closest?.('[data-observe-row]');
    if (row) {
      const text = row.textContent.trim();
      if (text.length > 10) return row;
    }
    let el = copyButton?.parentElement;
    for (let i = 0; i < 10 && el && el !== document.body; i++) {
      const text = el.textContent.trim();
      const hasContent = !!el.querySelector('code, pre, h1, h2, h3, p, strong, em, ul, ol, table, a');
      if (hasContent && text.length > 20 && text.length < 50000) return el;
      el = el.parentElement;
    }
    return null;
  }

  function findAssistantResponseAfter(userMessage, oldMessageIds = new Set()) {
    const nodes = getMessageNodes();
    let userIndex = -1;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const id = messageNodeKey(nodes[i]);
      const text = (nodes[i].innerText || nodes[i].textContent || '').trim();
      if (!oldMessageIds.has(id) && text === userMessage.trim()) { userIndex = i; break; }
    }
    if (userIndex < 0) return '';
    for (let i = userIndex + 1; i < nodes.length; i++) {
      const id = messageNodeKey(nodes[i]);
      const text = (nodes[i].innerText || nodes[i].textContent || '').trim();
      if (!oldMessageIds.has(id) && text && text !== userMessage.trim() && text.length >= 2) return text;
    }
    return '';
  }

  function getMessageNodes() {
    if (!activeProfile || !ProfileContract) return [];
    const nodes = [];
    for (const selector of responseSelectorSet()) {
      try { nodes.push(...Array.from(document.querySelectorAll(selector))); } catch (_) {}
    }
    return Array.from(new Set(nodes))
      .filter((el) => {
        const text = ProfileContract.normalizeText(activeProfile, extractMessageText(el));
        return text.length > 0;
      });
  }

  function freshResponseEvidence(userMessage, beforeKeys) {
    const snapshot = recordedResponseSnapshot(userMessage, beforeKeys);
    if (!snapshot?.key || !snapshot.text) return null;
    if (likelyUserEcho(snapshot.text, userMessage, snapshot.role)) return null;
    if (Universal?.isStatusLine?.(snapshot.text)) return null;
    return snapshot;
  }

  function createRecordedResponseWake() {
    let pendingMutation = false;
    let disconnected = false;
    const waiters = new Set();
    const observer = new MutationObserver(() => {
      if (disconnected) return;
      if (!waiters.size) {
        pendingMutation = true;
        return;
      }
      for (const finish of Array.from(waiters)) finish('mutation');
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    const wait = (delayMs = 250) => {
      if (pendingMutation) {
        pendingMutation = false;
        return Promise.resolve('mutation');
      }
      return new Promise(resolve => {
        let settled = false;
        let fallbackTimer = null;
        const finish = (reason) => {
          if (settled) return;
          settled = true;
          waiters.delete(finish);
          clearTimeout(fallbackTimer);
          resolve(reason);
        };
        const schedulePageTimerFallback = () => {
          if (settled) return;
          fallbackTimer = setTimeout(() => finish('page_timer_fallback'), delayMs);
        };
        waiters.add(finish);
        try {
          chrome.runtime.sendMessage({
            type: 'capture_observation_tick',
            delay_ms: delayMs,
          }, response => {
            const runtimeError = chrome.runtime.lastError;
            if (!runtimeError && response?.ok) finish('worker_tick');
            else schedulePageTimerFallback();
          });
        } catch (_) {
          schedulePageTimerFallback();
        }
      });
    };

    const disconnect = () => {
      disconnected = true;
      observer.disconnect();
      for (const finish of Array.from(waiters)) finish('disconnected');
      waiters.clear();
    };
    return { wait, disconnect };
  }

  async function waitForFreshAssistantResponse(userMessage, beforeKeys, timeout = 90000, responseAnchorBefore = null, captureContext = {}) {
    const started = Date.now();
    let best = null;
    let pendingIdentityGap = null;
    let lastIdentityPendingTraceAt = 0;
    let lastCompletionTraceAt = 0;
    let lastCompletionTraceSignature = '';
    let responseIdentityState = ResponseObservation
      ? ResponseObservation.createIdentityState()
      : { key: '', observations: 0, qualified: false };
    let responseCompletionState = ResponseObservation?.createCompletionState
      ? ResponseObservation.createCompletionState()
      : null;
    const withActivityState = (snapshot) => {
      if (!snapshot) return null;
      const activity = responseActivityState(snapshot.region, captureContext.generationStateBefore);
      return { ...snapshot, streaming: activity.streaming, activity };
    };
    const responseWake = createRecordedResponseWake();
    try {
    while (Date.now() - started < timeout) {
      throwIfCaptureCancelled();
      const identityGap = recordedResponseIdentityGap();
      if (identityGap) {
        pendingIdentityGap = identityGap;
        if (Date.now() - lastIdentityPendingTraceAt >= 1000) {
          lastIdentityPendingTraceAt = Date.now();
          emitPageTrace('recorded_response_identity_pending', {
            ...identityGap,
            elapsed: Date.now() - started,
          });
        }
        await responseWake.wait(250);
        continue;
      }
      pendingIdentityGap = null;
      const snapshot = withActivityState(recordedResponseSnapshot(userMessage, beforeKeys));
      // The recorded response region narrows the candidate set, but must prove
      // that fresh recorded node directly instead of waiting for a user/answer
      // pair that cannot exist inside the selector's matched subtree.
      const isPromptPrefix = isStrictPromptReplyPrefix(snapshot?.text || '', userMessage);
      if (snapshot?.key && snapshot.text && !likelyUserEcho(snapshot.text, userMessage, snapshot.role) && !isPromptPrefix &&
          (!beforeKeys.has(snapshot.key) || responseChangedSinceBefore(snapshot.key, snapshot.text, snapshot.region))) {
        const observedAt = Date.now();
        const requestStreamingSeen = responseCompletionState?.streamingSeen === true || snapshot.streaming === true;
        const requestActivity = {
          ...snapshot.activity,
          streamingSeen: requestStreamingSeen,
        };
        const identityMinimum = ResponseObservation?.identityQualificationMinimum
          ? ResponseObservation.identityQualificationMinimum(requestActivity)
          : (requestActivity.explicitlySettled && requestActivity.streamingSeen ? 1 : 3);
        const identityObservation = ResponseObservation
          ? ResponseObservation.observeIdentity(responseIdentityState, snapshot.key, identityMinimum)
          : {
              state: { key: snapshot.key, observations: 3, qualified: true },
              qualified: true,
              becameQualified: true,
            };
        responseIdentityState = identityObservation.state;
        const completionObservation = ResponseObservation?.observeCompletion
          ? ResponseObservation.observeCompletion(responseCompletionState, {
              key: snapshot.key,
              text: snapshot.text,
              identityQualified: identityObservation.qualified,
              streaming: snapshot.streaming,
              explicitlySettled: requestActivity.explicitlySettled,
              streamingSeen: requestActivity.streamingSeen,
              activityToken: snapshot.activityToken,
            }, observedAt)
          : {
              state: responseCompletionState,
              complete: identityObservation.qualified && snapshot.activity?.explicitlySettled && !snapshot.streaming,
              changed: identityObservation.becameQualified,
              reason: 'recorded_activity_settled',
            };
        responseCompletionState = completionObservation.state;
        const completionTraceSignature = JSON.stringify({
          key: snapshot.key,
          textLength: snapshot.text.length,
          identityObservations: identityObservation.state.observations,
          identityQualified: identityObservation.qualified,
          streaming: snapshot.streaming,
          marker: requestActivity.marker,
          control: requestActivity.control,
          explicitlySettled: requestActivity.explicitlySettled,
          streamingSeen: completionObservation.state?.streamingSeen === true,
          complete: completionObservation.complete,
          reason: completionObservation.reason,
          projectionRegressed: completionObservation.projectionRegressed === true,
          discontinuous: completionObservation.state?.discontinuous === true,
        });
        if (completionTraceSignature !== lastCompletionTraceSignature || observedAt - lastCompletionTraceAt >= 1000) {
          lastCompletionTraceSignature = completionTraceSignature;
          lastCompletionTraceAt = observedAt;
          emitPageTrace('recorded_response_completion_state', {
            key: snapshot.key,
            textLength: snapshot.text.length,
            elapsed: observedAt - started,
            identityObservations: identityObservation.state.observations,
            identityMinimum,
            identityQualified: identityObservation.qualified,
            streaming: snapshot.streaming,
            marker: !!requestActivity.marker,
            control: !!requestActivity.control,
            explicitlySettled: !!requestActivity.explicitlySettled,
            streamingSeen: completionObservation.state?.streamingSeen === true,
            textQuietMs: Math.max(0, observedAt - Number(completionObservation.state?.lastTextChangeAt || observedAt)),
            activityQuietMs: Math.max(0, observedAt - Number(completionObservation.state?.lastActivityChangeAt || observedAt)),
            complete: completionObservation.complete,
            projectionRegressed: completionObservation.projectionRegressed === true,
            discontinuous: completionObservation.state?.discontinuous === true,
            retainedTextLength: String(completionObservation.state?.text || '').length,
            completion_reason: completionObservation.reason,
          });
        }
        if (completionObservation.projectionRegressed) {
          await responseWake.wait(250);
          continue;
        }
        if (identityObservation.qualified && (completionObservation.changed || identityObservation.becameQualified)) {
          relayCaptureSnapshot(snapshot, captureContext);
        }
        if (identityObservation.qualified) best = snapshot;
        if (completionObservation.complete && snapshot.text.length >= 1) {
          const reason = completionObservation.reason;
          emitPageTrace('fresh_response_complete', { key: snapshot.key, textLength: snapshot.text.length, completion_reason: reason });
          return { ...snapshot, completion_reason: reason };
        }
        await responseWake.wait(250);
        continue;
      }
      if (Date.now() - started < timeout) {
        const elapsed = Date.now() - started;
        if (elapsed === 0 || Math.floor(elapsed / 5000) !== Math.floor((elapsed - 200) / 5000)) {
          const input = findElement(normalizeRecordedSelector(selectors.input), 'input');
          const send = findElement(normalizeRecordedSelector(selectors.send), 'send');
          emitPageTrace('response_probe', {
            elapsed,
            userMessageLength: String(userMessage || '').length,
            nodes: snapshot ? [debugNode(snapshot)] : [],
            inputValueLength: String(input?.value || input?.textContent || '').length,
            sendDisabled: !!(send?.disabled || send?.getAttribute('aria-disabled') === 'true'),
            responseSelector: responseSelectorSet().join(',')
          });
        }
      }
      await responseWake.wait(250);
    }
    if (pendingIdentityGap && !best) {
      emitPageTrace('recorded_response_identity_missing', {
        ...pendingIdentityGap,
        elapsed: Date.now() - started,
        terminal: true,
      });
      const error = new Error('recorded_response_identity_missing');
      error.code = 'recorded_response_identity_missing';
      error.reason_codes = ['recorded_response_identity_missing'];
      throw error;
    }
    if (best) emitPageTrace('fresh_response_timeout_with_candidate', { key: best.key, role: best.role, textLength: best.text.length });
    return null;
    } finally {
      responseWake.disconnect();
    }
  }

  async function waitForVisibleResponse(userMessage, timeout = 30000, beforeKeys = new Set()) {
    // Kept as a compatibility wrapper for older callers. There must be one
    // response boundary; a second visibility loop would reintroduce a hidden
    // provider-duration wait before the terminal result.
    return waitForFreshAssistantResponse(userMessage, beforeKeys, timeout, null, {});
  }

  function messageNodeKey(el) {
    return messageIdentity(el);
  }

  let responseMonitorObserver = null;
  let responseMonitorTimer = null;
  let responseMonitorSignature = '';
  let latestObservedResponse = null;
  // The recorded response region is authoritative, but its DOM node can be
  // represented by nested virtualized rows. Preserve its real busy/streaming
  // state; hard-coding false turns the first token into a completed answer.
  function recordedStreamingState(key, textValue) {
    if (!responseContract()) return false;
    for (const selector of responseSelectorSet()) {
      let regions = [];
      try { regions = Array.from(document.querySelectorAll(selector)); } catch (_) { continue; }
      for (const region of regions) {
        const regionKey = messageIdentity(region);
        const regionText = ProfileContract.normalizeText(activeProfile, extractMessageText(region));
        if ((key && regionKey === key) || (textValue && regionText && regionText.includes(textValue))) {
          return messageIsStreaming(region);
        }
      }
    }
    return false;
  }

  function emitResponseMonitorSnapshot(reason) {
    const nodes = getMessageNodes().slice(-20).map((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      return {
        key: messageNodeKey(el),
        messageId: el.getAttribute('data-message-id'),
        observeRow: el.getAttribute('data-observe-row'),
        text,
        textLength: text.length
      };
    });
    const signature = JSON.stringify(nodes);
    if (signature === responseMonitorSignature) return;
    responseMonitorSignature = signature;
    const userText = String(window.__phantomRelayCaptureUserMessage || '').trim();
    const beforeMessages = Array.isArray(window.__phantomRelayCaptureBeforeMessages)
      ? window.__phantomRelayCaptureBeforeMessages : [];
    const beforeByKey = new Map(beforeMessages.map(item => [String(item.key || ''), String(item.text || '')]));
    const assistantNodes = nodes.filter(n => {
      // An anonymous projection can be a login/error/overlay region. A
      // recorded identity is the authority boundary for both deltas and the
      // final result, so it must never enter latestObservedResponse.
      if (!n.key || !n.text) return false;
      if (!n.text || (userText && sameUserMessage(n.text, userText))) return false;
      const oldText = beforeByKey.get(String(n.key || ''));
      // Ignore an unchanged assistant node from the previous turn. A reused
      // virtualized row is eligible only after its text grows/changes.
      return oldText === undefined || oldText !== n.text;
    });
    if (assistantNodes.length) {
      const latest = assistantNodes[assistantNodes.length - 1];
      latestObservedResponse = {
        key: latest.key,
        text: latest.text,
        streaming: recordedStreamingState(latest.key, latest.text),
        updatedAt: Date.now()
      };
    }
    const diagnosticNodes = nodes.map(({ text, ...metadata }) => metadata);
    emitPageTrace('response_monitor', {
      reason,
      nodeCount: nodes.length,
      nodes: diagnosticNodes
    });
  }

  function startResponseMonitor() {
    if (responseMonitorObserver || !document.documentElement) return;
    responseMonitorObserver = new MutationObserver(() => {
      clearTimeout(responseMonitorTimer);
      responseMonitorTimer = setTimeout(() => emitResponseMonitorSnapshot('mutation'), 250);
    });
    responseMonitorObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-message-id', 'data-observe-row']
    });
    emitResponseMonitorSnapshot('monitor_start');
  }

  function waitForNewCopyButton(oldCopySet, oldCopySnapshot, timeout, oldPageText = '', userMessage = '', oldMessageIds = new Set()) {
    return new Promise((resolve) => {
      let settled = false;
      let mutationCount = 0;
      let quietTimer = null;
      let pageChanged = false;
      let lastPageText = oldPageText;
      let directCandidate = '';
      let directStableCount = 0;
      let directFallbackTimer = null;
      let copiedText = '';
      const onCopy = () => {
        const selected = window.getSelection()?.toString()?.trim();
        if (selected) copiedText = selected;
      };
      document.addEventListener('copy', onCopy, true);
      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(quietTimer);
        clearTimeout(directFallbackTimer);
        document.removeEventListener('copy', onCopy, true);
      };
      const finish = (text) => {
        if (settled) return;
        settled = true;
        cleanup();
        stopPageTrace();
        reportCaptureProgress(text ? `已点击新 copy，文本 ${text.length} 字` : '监听超时');
        resolve(text || '');
      };

      const inspect = () => {
        if (!isCurrentGeneration() || settled) return;
        mutationCount++;
        const buttons = getCopyButtons();
        emitPageTrace('capture_snapshot', {
          copyCandidates: buttons.map((btn, index) => {
            const container = getMessageContainer(btn);
            const state = getButtonState(btn);
            const messageLength = container?.textContent?.trim()?.length || 0;
            return { index, usable: state.usable, messageId: container?.getAttribute?.('data-message-id') || null, messageLength, streaming: container?.getAttribute?.('data-streaming') || null };
          }),
          messageNodes: getMessageNodes().slice(-20).map((el) => {
            const text = (el.innerText || el.textContent || '').trim();
            return { messageId: el.getAttribute('data-message-id'), observeRow: el.getAttribute('data-observe-row'), key: messageNodeKey(el), streaming: el.getAttribute('data-streaming'), textLength: text.length };
          })
        });
        reportCaptureProgress(`第 ${mutationCount} 次检查：找到 ${buttons.length} 个 copy`, {
          buttons: buttons.map((btn, index) => {
            const container = getMessageContainer(btn);
            const state = getButtonState(btn);
            return {
              index,
              tag: btn.tagName,
              usable: state.usable,
              disabled: state.disabled,
              display: getComputedStyle(btn).display,
              visibility: getComputedStyle(btn).visibility,
              opacity: getComputedStyle(btn).opacity,
              rect: state.fingerprint,
              containerFound: !!container,
              containerLength: container ? container.textContent.trim().length : 0,
              isOldInstance: oldCopySet.has(btn)
            };
          })
        });
        const pageText = document.body.innerText;
        const directResponse = findAssistantResponseAfter(userMessage, oldMessageIds);
        if (directResponse && directResponse !== userMessage.trim()) {
          if (directResponse === directCandidate) directStableCount++;
          else { directCandidate = directResponse; directStableCount = 1; }
          emitPageTrace('assistant_response_candidate', { textLength: directResponse.length, stableCount: directStableCount });
          if (directStableCount >= 2) {
            const exact = getExactRecordedCopyButton(directResponse);
            if (exact) {
              emitPageTrace('copy_dispatch', { mode: 'recorded_selector', selector: selectors.copy.selector.css, reason: 'assistant_response_stable', responseTextLength: directResponse.length });
              reportCaptureProgress('回复稳定，开始按录制的 copy selector 触发复制');
              safeClick(exact);
              emitPageTrace('copy_dispatched', { mode: 'recorded_selector', selector: selectors.copy.selector.css, tag: exact.tagName });
            } else {
              emitPageTrace('copy_dispatch_skipped', { selector: selectors.copy.selector.css, reason: 'recorded_selector_no_match_in_assistant_row', responseTextLength: directResponse.length });
            }
            reportCaptureProgress(`按消息节点捕获回复，文本 ${directResponse.length} 字`);
            finish(directResponse);
            return;
          }
          if (directStableCount === 1 && !directFallbackTimer) {
            directFallbackTimer = setTimeout(() => {
              if (!settled && directCandidate) {
                emitPageTrace('copy_dispatch', { mode: 'recorded_selector', selector: selectors.copy.selector.css, reason: 'assistant_response_ready', fallbackTextLength: directCandidate.length });
                reportCaptureProgress('已识别回复，正在按录制的 copy selector 触发复制');
                const exact = getExactRecordedCopyButton(directCandidate);
                if (exact) {
                  safeClick(exact);
                  emitPageTrace('copy_dispatched', { mode: 'recorded_selector', selector: selectors.copy.selector.css, tag: exact.tagName });
                } else {
                  emitPageTrace('copy_dispatch_skipped', { selector: selectors.copy.selector.css, reason: 'recorded_selector_no_match' });
                }
              }
            }, 250);
          }
        }
        if (pageText !== lastPageText) {
          pageChanged = true;
          lastPageText = pageText;
          reportCaptureProgress('检测到页面文本变化，等待 copy 可用');
        }
        for (let i = buttons.length - 1; i >= 0; i--) {
          const btn = buttons[i];
          const container = getMessageContainer(btn);
          const state = getButtonState(btn);
          // 精确命中用户录制 selector 时，允许使用该按钮的真实祖先容器；
          // 只有 fallback 候选必须带 data-message-id/data-observe-row。
          const exactRecorded = isExactRecordedCopyButton(btn);
          if (!container || (!exactRecorded && !container.closest?.('[data-message-id], [data-observe-row]'))) continue;
          const text = container.textContent.trim();
          const currentState = getButtonState(btn);
          if (!currentState.usable || text.length < 10) continue;

          const isNewButton = !oldCopySet.has(btn);
          const oldSnapshot = oldCopySnapshot.get(btn);
          const becameUsable = oldSnapshot && !oldSnapshot.buttonState.usable && currentState.usable;
          const isNewMessageButton = oldSnapshot && oldSnapshot.container !== container && currentState.usable;
          const messageIdChanged = oldSnapshot && oldSnapshot.messageId !== (container.getAttribute('data-message-id') || null);
          const isReplacedButton = isNewButton && currentState.usable;
          const buttonMarkupChanged = oldSnapshot && oldSnapshot.html !== btn.outerHTML;
          const containerTextChanged = oldSnapshot && oldSnapshot.text !== text;

          if (isReplacedButton || becameUsable || isNewMessageButton || messageIdChanged || (buttonMarkupChanged && containerTextChanged)) {
            reportCaptureProgress(`命中可用 copy：${isReplacedButton ? '新按钮' : becameUsable ? '按钮变可用' : '新消息按钮'}，准备点击`);
            safeClick(btn);
            setTimeout(() => finish(copiedText || container.textContent.trim()), 0);
            return;
          }
        }
      };

      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'aria-label', 'disabled']
      });
      const timer = setTimeout(() => finish(''), timeout);
      inspect();
    });
  }

  async function waitForResponseComplete(oldText, timeout) {
    const start = Date.now();
    let lastText = '';
    let stableCount = 0;
    while (Date.now() - start < timeout) {
      const msg = findLastAssistantMessage();
      const text = msg ? msg.textContent.trim() : '';
      // 新文本出现了 → 等待稳定（流式结束）
      if (text && text.length > 10 && text !== oldText) {
        if (text === lastText) {
          stableCount++;
          if (stableCount >= 3) return text; // 3×300ms 稳定
        } else {
          lastText = text;
          stableCount = 0;
        }
      }
      await sleep(300);
    }
    const last = findLastAssistantMessage();
    const t = last ? last.textContent.trim() : '';
    return t !== oldText ? t : '';
  }

  function findLastAssistantMessage() {
    // 方法1: 用录好的 copy 按钮定位 → 向上找所属消息气泡
    if (selectors.copy?.selector) {
      try {
        const copyBtns = document.querySelectorAll(selectors.copy.selector.css);
        if (copyBtns.length > 0) {
          const lastCopy = copyBtns[copyBtns.length - 1];
          let el = lastCopy.parentElement;
          for (let i = 0; i < 8 && el && el !== document.body; i++) {
            const text = el.textContent.trim();
            const hasContent = !!el.querySelector('code, pre, h1, h2, h3, p, strong, em, ul, ol, table, a');
            if (hasContent && text.length > 20 && text.length < 50000) return el;
            el = el.parentElement;
          }
        }
      } catch(e) {}
    }

    // 方法2: 通用 fallback — 找最小但有 markdown 的消息容器
    const candidates = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="response"], [class*="answer"], [class*="reply-item"]'
    );
    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
      const text = c.textContent.trim();
      if (text.length < 20 || text.length > 50000) continue;
      const hasMD = !!c.querySelector('code, pre, h1, h2, h3, p, strong, em, ul, ol, table');
      // 有 markdown 加分，文本越短越好（越精确）
      const score = (hasMD ? 2000 : 0) - text.length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── 复制事件拦截 ────────────────────────────────────────
  function enableCopyMonitor() {
    document.addEventListener('copy', onCopyCapture, true);
  }

  function disableCopyMonitor() {
    document.removeEventListener('copy', onCopyCapture, true);
  }

  function onCopyCapture(e) {
    const text = window.getSelection()?.toString()?.trim();
    if (!text || text.length < 10) return;

    chrome.runtime.sendMessage({
      type: 'text_copied',
      text,
      length: text.length,
      timestamp: Date.now(),
    });
  }

  // ── 消息路由 ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isCurrentGeneration()) return;
    switch (msg.action) {
      case 'record_input':
        cancelCapture();
        sendResponse(startSingleCapture('input'));
        break;

      case 'record_send':
      case 'record_send_button':
      case 'record_send_strategy':
        cancelCapture();
        sendResponse(startSingleCapture('send'));
        break;

      case 'record_shortcut':
        cancelCapture();
        shortcutListening = true;
        startShortcutRecording();
        sendResponse({ status: 'listening', role: 'shortcut' });
        break;

      case 'record_response':
        cancelCapture();
        startResponseMonitor();
        sendResponse(startSingleCapture('response'));
        break;

      case 'cancel_record':
        cancelCapture();
        sendResponse({ status: 'cancelled' });
        break;

      case 'cancel_auto_capture':
        sendResponse(requestAutoCaptureCancellation(msg.job_id, msg.reason));
        break;

      case 'network_capture_response_observed':
        if (msg.job_id && currentCaptureJobId && String(msg.job_id) !== String(currentCaptureJobId)) {
          sendResponse({ ok: false, ignored: true, reason: 'job_mismatch' });
          break;
        }
        networkResponseObserved = true;
        sendResponse({ ok: true });
        break;

      case 'get_selectors':
        sendResponse({ selectors, selector_capture_status: selectorCaptureStatus });
        break;

          case 'set_selectors':
            if (msg.profile_revision !== undefined && msg.profile_revision !== null) {
              const incomingRevision = normalizeProfileRevision(msg.profile_revision);
              // An omitted/unknown revision from an older popup must not erase
              // authoritative lifecycle metadata already applied by the worker.
              if (incomingRevision > 0) activeProfileRevision = incomingRevision;
            }
            for (const role of ['input', 'send', 'copy', 'response']) {
          const value = role === 'response' ? (msg.selectors?.response ?? msg.selectors?.copy) : msg.selectors?.[role];
          if (role === 'send') {
            if (value && typeof value === 'object' && value.kind) {
              sendStrategy = value;
              selectors.send = value;
            } else if (value) {
              // A recorded CSS selector is a concrete button action. Preserve
              // it as the primary replay strategy; only explicit {kind: ...}
              // values select keyboard replay.
              const buttonSelector = selectorText(value);
              selectors.send = { ...normalizeRecordedSelector(value), selector: buttonSelector };
              sendStrategy = { kind: 'button', selector: buttonSelector };
            } else {
              selectors.send = null;
              sendStrategy = { kind: 'enter', key: 'Enter', modifiers: [] };
            }
          } else {
            selectors[role] = value ? normalizeRecordedSelector(value) : null;
          }
        }
        selectors.profile = msg.selectors?.profile || selectors.profile || null;
        refreshActiveProfile(selectors.profile);
        startReadyLeaseIfExecutable();
        reportPageEvent('recorded_selectors_loaded', {
          input: selectorText(selectors.input),
          send: selectorText(selectors.send),
          sendTag: selectors.send?.elementTag || '',
          sendHTML: selectors.send?.elementHTML || ''
        });
        sendResponse({ ok: true, selectors });
        break;

      case 'get_lock':
        sendResponse({ lock: { active: lock.active, targetRole: lock.targetRole, captured: lock.captured } });
        break;

      case 'ping':
        sendResponse({ pong: true, page_session_id: pageSessionId, content_script_version: CONTENT_SCRIPT_VERSION });
        break;

      case 'discover_selectors':
        sendResponse(discoverReplaySelectors());
        break;

      case 'wait_until_ready': {
        const timeout = Math.min(120000, Math.max(1000, Number(msg.timeout) || 30000));
        (async () => {
          const started = Date.now();
          // DOM-backed health is eventually consistent: SPA pages can load the
          // recorded profile before the composer exists. Validate the static
          // profile contract immediately, then let the bounded readiness loop
          // wait for live elements instead of turning a render race into a
          // permanent profile_input_unavailable state.
          const profileHealth = activeProfile
            ? runProfileHealthCheck(activeProfile, {
              allowMissingResponse: true,
              requireRecordedIdentity: true,
              document: null,
            })
            : null;
          if (profileHealth?.state === 'invalid') {
            sendResponse({
              ready: false,
              input_ready: profileHealth.checks.input === 'pass',
              send_ready: profileHealth.checks.send === 'pass',
              content_script_version: CONTENT_SCRIPT_VERSION,
              profile_health: profileHealth,
              reason_codes: profileHealth.reason_codes,
              waited_ms: 0
            });
            return;
          }
          let inputEl = null;
          let inputReady = false;
          let sendReady = false;
          let liveHealth = null;
          while (Date.now() - started < timeout) {
            // The selector init is async (fetch from API). Wait until the
            // input selector is populated before testing readiness.
            if (!selectorText(selectors.input)) {
              await sleep(200); continue;
            }
            inputEl = await waitForInteractableRecordedInput(
              selectorDescriptor(selectors.input),
              inputEl,
              250,
            );
            const recordedButtonSelector = selectors.send && typeof selectors.send === 'object' && selectors.send.selector
              ? selectorText(selectors.send.selector)
              : (typeof selectors.send === 'string' ? selectorText(selectors.send) : '');
            inputReady = !!inputEl;
            // A recorded button or explicit keyboard strategy both satisfy the
            // readiness contract; replay chooses the exact strategy later.
            sendReady = inputReady;
            if (inputReady && sendReady) {
              liveHealth = activeProfile
                ? runProfileHealthCheck(activeProfile, {
                  allowMissingResponse: true,
                  requireRecordedIdentity: true,
                })
                : null;
              if (liveHealth?.state === 'invalid') {
                await sleep(100);
                continue;
              }
              reportPageEvent('recorded_elements_ready', { content_script_version: CONTENT_SCRIPT_VERSION, waitedMs: Date.now() - started, input: selectorText(selectors.input), send: recordedButtonSelector || null, sendKind: selectors.send?.kind || (recordedButtonSelector ? 'button' : 'enter') });
              sendResponse({ ready: true, input_ready: true, send_ready: true, content_script_version: CONTENT_SCRIPT_VERSION, waited_ms: Date.now() - started });
              return;
            }
              await sleep(100);
          }
          const finalHealth = liveHealth || (activeProfile
            ? runProfileHealthCheck(activeProfile, { allowMissingResponse: true, requireRecordedIdentity: true })
            : null);
          sendResponse({
            ready: false,
            input_ready: inputReady,
            send_ready: sendReady,
            content_script_version: CONTENT_SCRIPT_VERSION,
            profile_health: finalHealth,
            reason_codes: finalHealth?.reason_codes || [],
            waited_ms: Date.now() - started,
          });
        })();
        return true;
      }

      case 'get_profile_health':
        {
          const profileHealth = runProfileHealthCheck();
          sendResponse({ profile_health: profileHealth, reason_codes: profileHealth.reason_codes });
        }
        break;

      case 'auto_capture': {
        startResponseMonitor();
        relayClientId = String(msg.client_id || relayClientId || '');
        const capturePromise = Promise.resolve()
          .then(() => autoCapture(msg.message, msg.job_id || '', msg.conversation_id || '', msg.tab_id, msg.claim_token || '', !!msg.allow_tool_calls, Number(msg.capture_timeout_ms) || 240000))
        // The production action is deliberately one-way: the browser result is
        // relayed independently of the runtime message acknowledgement. The
        // handle is exposed only to the repository's isolated DOM harness so it
        // can await the same capture completion without changing production
        // messaging semantics.
        if (window.__phantomRelayDomTest && typeof window.__phantomRelayDomTest === 'object') {
          window.__phantomRelayDomTest.capturePromise = capturePromise;
        }
        capturePromise.then(async (result) => {
            // A failed capture must settle the claimed job immediately. Leaving
            // it claimed turns a local send failure into an opaque API timeout.
            if (result?.error && msg.job_id) {
              await postBrowserResultWithRetry({
                job_id: msg.job_id,
                claim_token: msg.claim_token || '',
                success: false,
                error: result.error,
                detail: result.detail || '',
                conversation_id: msg.conversation_id || '',
                tab_id: msg.tab_id,
                domain: location.hostname
              }, 'capture_failure');
            }
          })
          .catch(async error => {
            console.error('[Phantom Relay] auto_capture failed', error);
            if (msg.job_id) {
              await postBrowserResultWithRetry({
                job_id: msg.job_id,
                claim_token: msg.claim_token || '',
                success: false,
                error: error?.message || String(error),
                conversation_id: msg.conversation_id || '',
                tab_id: msg.tab_id,
                domain: location.hostname
              }, 'capture_exception');
            }
          });
        // This is intentionally a one-way trigger. Long-running execution and
        // both terminal outcomes use browser_result_relay, not sendResponse.
        break;
      }

      case 'find_response':
        const resp = findLatestResponse();
        sendResponse({ text: resp ? resp.textContent.trim().substring(0, 10000) : '', found: !!resp });
        break;

          case 'clear_selectors':
            selectors = { input: null, send: null, response: null, profile: null };
            activeProfile = null;
            activeProfileRevision = 0;
            stopReadyLease();
            sendResponse({ status: 'cleared' });
        break;
    }
  });

  // page_ready 是“录制元素可用”握手，不是仅仅 DOMContentLoaded。
  // 页面保持 ready 租约，避免后台短暂休眠后后端误判离线。
  let readyLeaseInFlight = false;
  let readyLeaseIntervalId = null;
  let directBridgeInFlight = false;
  let directBridgeReady = false;
  let directBridgeTimer = null;

  function stopReadyLease() {
    if (readyLeaseIntervalId) clearInterval(readyLeaseIntervalId);
    readyLeaseIntervalId = null;
  }

  function startReadyLeaseIfExecutable() {
    if (!hasExecutablePageProfile()) return false;
    if (readyLeaseIntervalId) return true;
    requestReadyLease().catch(() => {});
    readyLeaseIntervalId = setInterval(requestReadyLease, 3000);
    return true;
  }

  const RUNTIME_RELOAD_MARKER = 'data-phantom-relay-runtime-reload';
  const RUNTIME_RELOAD_THROTTLE_MS = 30000;

  async function recoverRuntimeVersionMismatch(response) {
    if (response?.error !== 'content_script_version_mismatch') return false;
    stopReadyLease();
    const requestedAt = Date.now();
    try {
      const previous = root?.getAttribute(RUNTIME_RELOAD_MARKER) || '';
      const [previousVersion, previousRequestedAt] = previous.split(':');
      if (previousVersion === CONTENT_SCRIPT_VERSION
          && requestedAt - Number(previousRequestedAt || 0) < RUNTIME_RELOAD_THROTTLE_MS) {
        emitPageTrace('runtime_reload_suppressed', {
          reason: 'reload_throttled',
          content_script_version: CONTENT_SCRIPT_VERSION,
        });
        return false;
      }
      if (!root) throw new Error('document_root_unavailable');
          root?.setAttribute(RUNTIME_RELOAD_MARKER, `${CONTENT_SCRIPT_VERSION}:${requestedAt}`);
      emitPageTrace('runtime_reload_requested', {
        reason: 'content_script_version_mismatch',
        content_script_version: CONTENT_SCRIPT_VERSION,
      });
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          chrome.runtime.sendMessage({
            type: 'reload_extension_runtime',
            reason: 'content_script_version_mismatch',
            content_script_version: CONTENT_SCRIPT_VERSION,
          }, (value) => {
            const runtimeError = chrome.runtime.lastError?.message || '';
            if (runtimeError || value?.ok === false || value?.error) {
              emitPageTrace('runtime_reload_failed', {
                error: runtimeError || value?.error || 'runtime_reload_rejected',
              });
            }
            finish();
          });
          setTimeout(finish, 1500);
        } catch (error) {
          emitPageTrace('runtime_reload_failed', {
            error: error?.message || String(error),
          });
          finish();
        }
      });
      return true;
    } catch (error) {
      emitPageTrace('runtime_reload_failed', {
        error: error?.message || String(error),
      });
      return false;
    }
  }

      async function requestReadyLease() {
        touchInstanceHeartbeat();
        if (readyLeaseInFlight || !isCurrentGeneration()) return;
    readyLeaseInFlight = true;
    try {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        try {
          chrome.runtime.sendMessage({ type: 'page_ready', page_session_id: pageSessionId, content_script_version: CONTENT_SCRIPT_VERSION }, (value) => {
            void chrome.runtime.lastError;
            if (value?.error === 'content_script_version_mismatch') {
              recoverRuntimeVersionMismatch(value).finally(finish);
              return;
            }
            if (value?.suppressed === 'older_same_domain_tab' && readyLeaseIntervalId) {
              clearInterval(readyLeaseIntervalId);
              readyLeaseIntervalId = null;
              emitPageTrace('ready_lease_suppressed', { newest_tab_id: value?.newest_tab_id || null });
            }
            finish();
          });
          setTimeout(finish, 4000);
        } catch (_) { finish(); }
      });
    } finally {
      readyLeaseInFlight = false;
    }
  }

  async function loadDirectBridgeSelectors() {
    let loadedAuthoritative = false;
    // HTTPS page fetches cannot reliably reach localhost; ask the extension
    // worker for the server-backed template first. Retry because the API and
    // the page can start in either order.
    for (let attempt = 1; attempt <= 10 && !loadedAuthoritative; attempt++) {
      try {
        const remote = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'get_server_selectors', domain: location.hostname }, (value) => {
            void chrome.runtime.lastError;
            resolve(value || null);
          });
            });
            const saved = remote?.selectors;
            if (saved?.input) {
              const remoteRevision = normalizeProfileRevision(remote?.profile_revision);
              if (remoteRevision) activeProfileRevision = remoteRevision;
              selectors = {
            ...selectors,
            input: normalizeRecordedSelector(saved.input),
            // A recorded send strategy is preserved. Missing send data means
            // universal Enter; it is never converted into a fake selector.
            send: saved.send
              ? ((saved.send && typeof saved.send === 'object' && saved.send.kind) ? saved.send : normalizeRecordedSelector(saved.send))
              : { kind: 'enter', key: 'Enter', modifiers: [] },
            response: normalizeRecordedSelector(saved.response),
            profile: saved.profile || null
          };
          refreshActiveProfile(selectors.profile);
          loadedAuthoritative = !!selectorText(selectors.input);
        }
      } catch (_) {}
      if (!loadedAuthoritative) await sleep(500);
    }
    if (loadedAuthoritative) return selectors;
    try {
      const data = await new Promise(resolve => chrome.storage.local.get(['phantomSelectors'], resolve));
      const local = data?.phantomSelectors?.[location.hostname];
      if (local?.input && local?.send) {
        selectors = {
          ...selectors,
          input: normalizeRecordedSelector(local.input),
          send: (local.send && typeof local.send === 'object' && local.send.kind) ? local.send : normalizeRecordedSelector(local.send),
          response: normalizeRecordedSelector(local.response),
          profile: local.profile || null
        };
        refreshActiveProfile(selectors.profile);
      }
    } catch (_) {}
    return selectors;
  }

  async function directBrowserBridgeTick() {
    // Deprecated: the background worker owns scheduling and tab identity.
    return;
    /*
    if (directBridgeInFlight || !isCurrentGeneration()) return;
    directBridgeInFlight = true;
    try {
      const inputEl = await waitForElement({ css: selectorText(selectors.input), alternatives: [] }, 50, 'input');
      const isStrategySend = selectors.send && typeof selectors.send === 'object' && selectors.send.kind;
      const inputReady = !!inputEl && !!inputEl.getClientRects().length;
      let sendReady = isStrategySend && (selectors.send.kind === 'enter' || selectors.send.kind === 'shortcut');
      if (!sendReady) {
        const sendEl = await waitForElement({ css: selectorText(selectors.send), alternatives: [] }, 50, 'send');
        sendReady = !!sendEl && !!sendEl.getClientRects().length;
      }
      directBridgeReady = inputReady && sendReady;
      const heartbeat = {
        domain: location.hostname,
        tab_id: null,
        url: location.href,
        source: 'content-direct',
        ready: directBridgeReady,
        input_ready: inputReady,
        send_ready: sendReady
      };
      await fetch(`${globalThis.PhantomRelayBackendConfig?.DEFAULT_BACKEND_URL || ''}/browser/heartbeat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeat)
      });
      if (!directBridgeReady) return;
      const poll = await fetch(`${globalThis.PhantomRelayBackendConfig?.DEFAULT_BACKEND_URL || ''}/browser/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: relayClientId, domain: location.hostname })
      });
      const data = await poll.json();
      if (!data?.job) return;
      const job = data.job;
      const result = await autoCapture(job.message, job.id, job.conversation_id || '', tab.id, job.claim_token || '');
      await fetch(`${globalThis.PhantomRelayBackendConfig?.DEFAULT_BACKEND_URL || ''}/browser/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: relayClientId, job_id: job.id, claim_token: job.claim_token || '', conversation_id: job.conversation_id || '', tab_id: tab.id, domain: location.hostname, model: job.model || '', ...result })
      });
    } catch (_) {
      // The page may be navigating or the local API may be restarting.
    } finally {
      directBridgeInFlight = false;
    }
    */
  }

  function startDirectBrowserBridge() {
    // direct bridge is deprecated; remove the dead timer that formerly ran here.
    // Content script only reports readiness; background drives the job lifecycle.
  }

  // Load selectors before the first ready lease. This prevents a freshly
  // reloaded page from advertising ready=false using empty defaults.
  (async () => {
    await loadDirectBridgeSelectors();
    if (!hasExecutablePageProfile()) return;
    startReadyLeaseIfExecutable();
  })();
  // Content script only reports readiness and executes assigned jobs; do not
  // run a second direct poller here, otherwise one API request can be sent twice.

  // ── init ────────────────────────────────────────────────
  console.log('👻 Phantom Relay content script ready');
})();
