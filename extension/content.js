// ============================================================
// Phantom Relay — Content Script (v2: Single-Action Recording)
// 每次录制只捕获一个元素 → 录完立刻停 → 防止乱按
// ============================================================

(function () {
  'use strict';
  // Static content_scripts 与 popup 的 executeScript fallback 可能同时注入。
  // DOM 属性跨 isolated world 共享，用它做真正的单例闸门；否则两个实例会
  // 同时点击发送，日志就会出现两套完全相同的 auto_capture/trace。
  const INSTANCE_MARKER = 'data-phantom-relay-content-instance';
  const root = document.documentElement;
  // 同一扩展上下文重复注入：保留现有实例。
  // 扩展重载后 isolated-world 全局会重置，但 DOM 属性还在；此时清掉
  // 陈旧标记，允许新实例启动，避免必须刷新页面。
  if (root?.hasAttribute(INSTANCE_MARKER)) {
    // A page can survive an extension reload while the old isolated world is
    // gone. In that case the DOM marker is stale and must not block the new
    // content-script instance. Within the same isolated world, the generation
    // guard still prevents duplicate executeScript injections.
    if (window.__phantomRelayGeneration) return;
    root.removeAttribute(INSTANCE_MARKER);
  }
  root?.setAttribute(INSTANCE_MARKER, String(Date.now()));

  // 每次重新注入时让旧实例失效，避免 popup 收到两份响应/日志
  const generation = (window.__phantomRelayGeneration || 0) + 1;
  window.__phantomRelayGeneration = generation;
  const isCurrentGeneration = () => window.__phantomRelayGeneration === generation;

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
  };

// 默认使用 Enter 发送；录制后会被具体策略覆盖。
  let sendStrategy = { kind: 'enter', key: 'Enter', modifiers: [] };
  let shortcutListening = false;
  let captureDebug = [];
  let pageTraceObserver = null;
  let pageTraceSeq = 0;
  let autoCaptureInFlight = false;
  let currentCaptureJobId = '';
  const Universal = window.PhantomRelayUniversal || null;

  function pageNodeInfo(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return { nodeType: node?.nodeType || null };
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    const attrs = {};
    for (const name of ['id', 'class', 'role', 'aria-label', 'disabled', 'style', 'data-testid']) {
      if (el.hasAttribute?.(name)) attrs[name] = el.getAttribute(name);
    }
    return {
      tag: el.tagName,
      path: cssPath(el),
      attrs,
      text: text.slice(0, 300),
      textLength: text.length,
      html: el.outerHTML?.replace(/\\s+/g, ' ').slice(0, 600) || ''
    };
  }

  function emitPageTrace(kind, data = {}) {
    if (!isCurrentGeneration()) return;
    const entry = { seq: ++pageTraceSeq, time: new Date().toISOString(), kind, ...data };
    console.debug('[Phantom Relay][PAGE_TRACE]', entry);
    chrome.runtime.sendMessage({ type: 'page_trace', entry });
  }

  function startPageTrace(reason) {
    stopPageTrace();
    pageTraceSeq = 0;
    emitPageTrace('trace_start', {
      reason,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.length || 0,
      bodyTextTail: document.body?.innerText?.slice(-500) || '',
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
          copyCount: getCopyButtons().length,
          bodyTextLength: document.body?.innerText?.length || 0,
          bodyTextTail: document.body?.innerText?.slice(-300) || ''
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
    captureDebug.push(`${new Date().toISOString()} ${message}${details ? ` ${JSON.stringify(details)}` : ''}`);
    if (captureDebug.length > 30) captureDebug.shift();
    chrome.runtime.sendMessage({
      type: 'capture_progress',
      message,
      debug: captureDebug.slice(-10)
    });
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
    const validClasses = Array.from(el.classList).filter(c => /^[a-zA-Z_-][\w-]*$/.test(c));
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

  // ── 单次点击捕获器 ──────────────────────────────────────
  let clickCapture = null;

  function startSingleCapture(targetRole) {
    if (lock.active) {
      console.warn('[Phantom Relay] Already capturing, reject');
      return { error: 'already_capturing' };
    }

    lock.active = true;
    lock.targetRole = targetRole;
    lock.captured = false;
    clearHighlight();

    // 在整个 document 上监听（捕获阶段，最高优先级）
    clickCapture = function (e) {
      if (!lock.active || lock.captured) return;

      // 回复区域不是按钮：保留用户点击的消息行/正文节点；输入和发送才提升到可交互祖先。
      let target = e.target;
      if (targetRole === 'response') {
        target = e.target.closest?.('[data-observe-row], [data-message-id], [data-virtual-list-item-key]') || e.target;
        if (target === document.documentElement || target === document.body) return;
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
      const actualTarget = result.target || target;

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

      // 存入 selectors
      selectors[targetRole] = {
        selector,
        elementTag: actualTarget.tagName.toLowerCase(),
        elementHTML: actualTarget.outerHTML.substring(0, 500),
        classification: result,
        capturedAt: Date.now(),
      };

      lock.captured = true;
      lock.active = false;

      // 移除监听
      document.removeEventListener('click', clickCapture, true);
      clickCapture = null;

      // 通知 background
      const domain = window.location.hostname;
      chrome.runtime.sendMessage({
        type: 'selector_captured',
        role: targetRole,
        selector,
        confidence: result.confidence,
        elementTag: actualTarget.tagName.toLowerCase(),
        domain,
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
    if (shortcutCaptureHandler) {
      document.removeEventListener('keydown', shortcutCaptureHandler, true);
      shortcutCaptureHandler = null;
    }
    shortcutListening = false;
    clearHighlight();
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
      sendStrategy = strategy;
      selectors.send = strategy;
      document.removeEventListener('keydown', shortcutCaptureHandler, true);
      shortcutCaptureHandler = null;
      shortcutListening = false;
      const domain = window.location.hostname;
      chrome.runtime.sendMessage({ type: 'selector_captured', role: 'send', selector: JSON.stringify(strategy), confidence: 'manual', elementTag: 'keyboard', domain });
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
      response: null
    };
    return !!selectors.input && !!selectors.send;
  }
  // 这里不再依赖 copy 按钮。回复的唯一边界是：发送前快照 → 新用户消息 →
  // 其后的逻辑消息节点。对 Doubao，data-message-id 和 data-observe-row
  // 是同一条消息的两个 DOM 表示，先合并再判断顺序。
  async function autoCapture(userMessage, jobId = '') {
    if (!isCurrentGeneration()) return { error: 'stale_content_script' };
    if (autoCaptureInFlight) return { error: 'capture_in_flight', detail: '已有自动抓取正在运行，请等待结束' };
    if (!selectorText(selectors.input) || !selectors.send) {
      const discovered = discoverReplaySelectors();
      if (discovered.error || !setDiscoveredSelectors(discovered)) {
        return { error: 'recorded_selectors_missing', detail: `当前站点没有完整模板，通用发现失败: ${discovered.error || 'incomplete'}` };
      }
      reportPageEvent('universal_selectors_discovered', {
        input: selectorText(selectors.input),
        send: selectorText(selectors.send),
        evidence: 'unique_visible_input_and_nearby_send_control'
      });
    }
    // Resolve send strategy from selectors or local variable
    const strategy = (selectors.send && typeof selectors.send === 'object' && selectors.send.kind)
      ? selectors.send
      : (selectorText(selectors.send)
        ? { kind: 'button', selector: selectorText(selectors.send) }
        : sendStrategy);
    if (!strategy || !strategy.kind) {
      return { error: 'send_strategy_missing', detail: '没有录制发送策略' };
    }
    const inputSelector = selectorText(selectors.input);
    if (!inputSelector) {
      return { error: 'input_not_found', detail: '当前页面没有发现可用输入框' };
    }
    const captureLock = 'data-phantom-relay-capture-lock';
    if (document.documentElement.hasAttribute(captureLock)) {
      return { error: 'capture_in_flight', detail: '页面已有抓取实例正在运行' };
    }
    document.documentElement.setAttribute(captureLock, String(generation));
    autoCaptureInFlight = true;
    currentCaptureJobId = jobId || '';
    try {
      const inputEl = await waitForElement({ css: selectorText(selectors.input), alternatives: [] }, 120000, 'input');
      if (!inputEl) return { error: 'input_not_ready_timeout', detail: '等待输入框 120 秒后仍未就绪' };
      setInputValue(inputEl, userMessage);
      await sleep(250);

      const currentStrategy = (selectors.send && typeof selectors.send === 'object' && selectors.send.kind)
        ? selectors.send
        : (selectorText(selectors.send)
          ? { kind: 'button', selector: selectorText(selectors.send) }
          : sendStrategy);
      if (!currentStrategy || !currentStrategy.kind) {
        return { error: 'send_strategy_missing', detail: '没有录制发送策略' };
      }
      if (Universal) {
        const plan = Universal.buildSendPlan({ send: currentStrategy }, {
          keyboardFallback: currentStrategy.allowEnterFallback === true,
          allowMultipleSubmissions: currentStrategy.allowEnterFallback === true
        });
        const decision = Universal.nextSendAction(plan, { actionIndex: 0, submissionCount: 0 });
        if (!decision.action) return { error: decision.terminal || 'send_strategy_missing' };
      }
      const responseAnchorBefore = selectorText(selectors.response) ? (() => {
        const el = findElement(normalizeRecordedSelector(selectors.response), 'response');
        return el ? { key: messageIdentity(el) || el.closest?.('[data-observe-row], [data-virtual-list-item-key]')?.getAttribute('data-observe-row') || '', text: extractMessageText(el) } : null;
      })() : null;
      const before = logicalMessageSnapshot();
      const beforeKeys = new Set(before.map(n => n.key));
      reportCaptureProgress(`发送前逻辑消息 ${before.length} 条`);
      reportPageEvent('capture_boundary', { phase: 'before_send', userMessage, sendStrategy: strategy, nodes: before.map(debugNode) });
      // Resolve send plan from recorded strategy
      let sendKind = strategy?.kind || 'enter';
      let sendKey = strategy?.key || 'Enter';
      let sendModifiers = strategy?.modifiers || [];

      reportPageEvent('send_target', { strategy: { kind: sendKind, key: sendKey, modifiers: sendModifiers } });

      let sendEvidence = false;
      const sendWaitStarted = Date.now();

      if (sendKind === 'enter' || sendKind === 'shortcut') {
        // Keyboard dispatch: focus input, dispatch keydown+keypress+keyup
        const inputEl = document.querySelector(inputSelector);
        if (inputEl) {
          inputEl.focus();
          const modState = {};
          for (const m of sendModifiers) {
            if (m === 'Meta') modState.metaKey = true;
            if (m === 'Control') modState.ctrlKey = true;
            if (m === 'Alt') modState.altKey = true;
            if (m === 'Shift') modState.shiftKey = true;
          }
          const keyOpts = { key: sendKey, code: strategy?.code || sendKey, keyCode: 13, which: 13, bubbles: true, cancelable: true, ...modState };
          // One logical keyboard submission: dispatch keydown only.
          // DeepSeek handles Enter during keydown; emitting keypress/keyup can submit twice.
          inputEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
        }
        reportPageEvent('send_keyboard', { kind: sendKind, key: sendKey, modifiers: sendModifiers });
        while (Date.now() - sendWaitStarted < 8000) {
          sendEvidence = !!findFreshUserMessage(userMessage, beforeKeys);
          if (sendEvidence) break;
          await sleep(150);
        }
        if (!sendEvidence && sendKind === 'shortcut' && currentStrategy.allowEnterFallback === true) {
          // A second keyboard action is opt-in and is legal only because the
          // recorded template explicitly declared this fallback.
          reportPageEvent('shortcut_no_effect', { waitedMs: Date.now() - sendWaitStarted });
          const inputEl2 = document.querySelector(inputSelector);
          if (inputEl2) {
            inputEl2.focus();
            inputEl2.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true }));
            reportPageEvent('enter_fallback', {});
            while (Date.now() - sendWaitStarted < 12000) {
              sendEvidence = !!findFreshUserMessage(userMessage, beforeKeys);
              if (sendEvidence) break;
              await sleep(150);
            }
          }
        }
      } else if (sendKind === 'button') {
        // Button click: find send element, wait enabled, click once only
        const selector = strategy?.selector || selectorText(selectors.send);
        const sendStarted = Date.now();
        let sendEl = null;
        while (Date.now() - sendStarted < 120000) {
          sendEl = await waitForElement({ css: selector, alternatives: [] }, 1000, 'send');
          if (sendEl && sendEl.getClientRects().length) break;
          await sleep(250);
        }
        if (!sendEl) return { error: 'send_not_ready_timeout', detail: '等待发送按钮 120 秒后仍未就绪', selector };
        const sendControl = sendEl.closest('button, [role="button"], [data-testid*="send" i], [id*="send" i]') || sendEl;
        const sendReadyStarted = Date.now();
        while (Date.now() - sendReadyStarted < 120000) {
          const disabled = sendControl.disabled || sendControl.getAttribute('disabled') !== null ||
            sendControl.getAttribute('aria-disabled') === 'true' || /disable/i.test(sendEl.getAttribute('class') || '');
          if (!disabled) break;
          await sleep(250);
        }
        const sendDisabled = sendControl.disabled || sendControl.getAttribute('disabled') !== null ||
          sendControl.getAttribute('aria-disabled') === 'true' || /disable/i.test(sendEl.getAttribute('class') || '');
        if (sendDisabled) {
          return { error: 'send_not_ready_timeout', detail: '发送按钮持续禁用，等待 120 秒后仍未就绪', selector };
        }
        reportPageEvent('send_button_ready', { selector, waitedMs: Date.now() - sendReadyStarted });
        const clicked = safeClick(sendControl, false);
        if (!clicked) return { error: 'send_click_failed', detail: '发送按钮点击未执行', selector };
        const evidenceStarted = Date.now();
        while (Date.now() - evidenceStarted < 120000) {
          sendEvidence = !!findFreshUserMessage(userMessage, beforeKeys);
          if (sendEvidence) break;
          await sleep(150);
        }
        if (!sendEvidence) {
          // A recorded button is a complete site-specific send contract.  Never
          // synthesize a second Enter submission after a button click: the page
          // may have accepted the click while its message DOM is still settling.
          // A generic fallback would turn a slow/virtualized page into a real
          // duplicate send (Doubao is especially sensitive to this).
          reportPageEvent('button_no_effect', {
            waitedMs: Date.now() - sendWaitStarted,
            fallback: 'disabled_by_default'
          });
        }
      }

      if (!sendEvidence) {
        reportPageEvent('send_no_effect', { kind: sendKind, waitedMs: Date.now() - sendWaitStarted });
        return { error: 'send_no_effect', detail: `发送策略 ${sendKind} 执行后 ${Date.now() - sendWaitStarted}ms 内没有产生新的用户消息`, debug: captureDebug };
      }
      // Do not equate DOM representation count with send count.  Virtualized
      // chat pages commonly expose one logical message through multiple
      // containers/IDs (for example a row plus an inner message node).  The
      // send action itself is already guarded and executed once; duplicate
      // candidates are diagnostic only and must not block extraction.
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
      reportCaptureProgress('已发送，等待后继模型消息');

      const response = await waitForDirectResponse(userMessage, beforeKeys, 120000, responseAnchorBefore);
      if (!response?.text) {
        return { error: 'response_timeout', completion_reason: 'no_content_timeout', detail: '120 秒内未检测到模型回复', debug: captureDebug };
      }
      const wasStreaming = response.streaming ? '（流式超时，已返回已累积文本）' : '';
      reportCaptureProgress(`已提取回复，文本 ${response.text.length} 字${wasStreaming}`);
      return { success: true, user: userMessage, assistant: response.text, key: response.key };
    } catch (err) {
      return { error: err?.message || String(err), debug: captureDebug };
    } finally {
      autoCaptureInFlight = false;
      currentCaptureJobId = '';
      document.documentElement.removeAttribute(captureLock);
    }
  }

  function normalizeRecordedSelector(value) {
    if (!value) return null;
    if (typeof value === 'string') return { css: value, alternatives: [] };
    if (typeof value.css === 'string') return value;
    if (typeof value.selector === 'string') return { css: value.selector, alternatives: value.alternatives || [] };
    if (value.selector?.css) return { ...value.selector, alternatives: value.selector.alternatives || [] };
    return null;
  }

  function selectorText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value.selector === 'string') return value.selector;
    if (typeof value.css === 'string') return value.css;
    if (value.selector && typeof value.selector.css === 'string') return value.selector.css;
    return '';
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
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function reportPageEvent(kind, data = {}) {
    emitPageTrace(kind, data);
  }

  function normalizeMessageKey(el) {
    const id = el.getAttribute('data-message-id');
    const row = el.getAttribute('data-observe-row');
    const virtual = el.getAttribute('data-virtual-list-item-key');
    return id || row || virtual || '';
  }

  function messageIdentity(el) {
    const id = el.getAttribute('data-message-id');
    const row = el.getAttribute('data-observe-row');
    const virtual = el.getAttribute('data-virtual-list-item-key');
    const raw = id || row || virtual || '';
    return raw.replace(/^block_/, '');
  }

  function messageRole(el) {
    const attrs = [
      el.getAttribute('data-role'), el.getAttribute('role'), el.getAttribute('data-message-role'),
      el.getAttribute('data-render-engine'), el.getAttribute('data-plugin-identifier'), el.className
    ].filter(Boolean).join(' ').toLowerCase();
    if (/assistant|answer|response|reply|bot|model/.test(attrs)) return 'assistant';
    if (/user|human|question|prompt/.test(attrs)) return 'user';
    return 'unknown';
  }

  function messageIsStreaming(el) {
    return !!el.matches?.('[data-streaming="true"], [aria-busy="true"]') ||
      !!el.querySelector?.('[data-streaming="true"], [aria-busy="true"], .dot-flashing, [class*="loading"]');
  }

  function domToMarkdown(root) {
    const render = (node, ctx = {}) => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      if (['button', 'svg', 'script', 'style', 'noscript'].includes(tag)) return '';
      if (node.matches?.('[aria-hidden="true"], [data-testid*="copy" i], [class*="copy" i], .loading-container-AGJEWI, .dot-flashing-mIsXoz')) return '';
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
    clone.querySelectorAll('button, [role="button"], svg, [aria-label], [data-testid*="copy" i], [class*="copy" i], .loading-container-AGJEWI, .dot-flashing-mIsXoz').forEach(n => n.remove());
    return domToMarkdown(clone);
  }

  function logicalMessageSnapshot() {
    const candidates = Array.from(document.querySelectorAll(
      '[data-observe-row], [data-message-id], [data-virtual-list-item-key]'
    ));
    const byLogicalIdentity = new Map();
    for (const el of candidates) {
      const rawText = extractMessageText(el);
      const text = Universal?.responseText ? Universal.responseText(rawText) : rawText;
      if (!text) continue;

      // A virtualized chat UI may expose one logical message as an outer row
      // plus an inner message node. Their IDs are often different (Doubao),
      // so grouping by data-message-id alone falsely reports duplicates.
      const row = el.closest?.('[data-observe-row]');
      const rowKey = row?.getAttribute('data-observe-row') ||
        row?.getAttribute('data-virtual-list-item-key') || '';
      const ownKey = messageIdentity(el);
      const logicalKey = rowKey ? `row:${rowKey}` : `msg:${ownKey}`;
      if (!ownKey && !rowKey) continue;

      const existing = byLogicalIdentity.get(logicalKey);
      // Prefer the outer row because it is the logical message boundary and
      // contains the full rendered text/actions. If no row exists, retain the
      // first keyed message node and replace it only with a longer rendering.
      if (!existing ||
          (row && !existing.element.closest?.('[data-observe-row]')) ||
          text.length > existing.text.length) {
        byLogicalIdentity.set(logicalKey, { element: el, text });
      }
    }
    return Array.from(byLogicalIdentity.values()).map(({ element, text }, index) => ({
      key: messageIdentity(element) ||
        element.closest?.('[data-observe-row]')?.getAttribute('data-observe-row') || `logical:${index}`,
      element,
      index,
      text,
      role: messageRole(element),
      streaming: messageIsStreaming(element),
    }));
  }

  function debugNode(n) {
    return { key: n.key, role: n.role, streaming: n.streaming, text: n.text.slice(0, 1000), textLength: n.text.length };
  }

  function normalizeComparableText(value) {
    return String(value || '')
      .replace(/[\u00a0\u200b]/g, ' ')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      // DeepSeek may append a UI pagination marker such as "2 / 2" to a row.
      .replace(/\s+\d+\s*\/\s*\d+\s*$/g, '')
      // 页面可能自动在中文标点、引号、数字之间插入空白；比较用户消息时忽略所有空白。
      .replace(/\s+/g, '')
      .trim();
  }

  function sameUserMessage(actual, expected) {
    return Universal ? Universal.sameText(actual, expected) : normalizeComparableText(actual) === normalizeComparableText(expected);
  }

  function findFreshUserMessage(userMessage, beforeKeys) {
    return logicalMessageSnapshot().find(n => !beforeKeys.has(n.key) && sameUserMessage(n.text, userMessage));
  }

  function findDirectCandidate(userMessage, beforeKeys, responseAnchorBefore = null) {
    const anchor = selectorText(selectors.response) ? findElement(normalizeRecordedSelector(selectors.response), 'response') : null;
    const currentAnchorKey = anchor ? (messageIdentity(anchor) || anchor.closest?.('[data-observe-row], [data-virtual-list-item-key]')?.getAttribute('data-observe-row') || '') : '';
    const anchorKey = responseAnchorBefore?.key || currentAnchorKey;
    const nodes = logicalMessageSnapshot();
    const fresh = nodes.filter(n => {
      if (!beforeKeys.has(n.key)) return true;
      if (!anchorKey || n.key !== anchorKey || !responseAnchorBefore) return false;
      return !sameUserMessage(n.text, responseAnchorBefore.text || '');
    });
    const pool = anchorKey
      ? fresh.sort((a, b) => (a.key === anchorKey ? 1 : 0) - (b.key === anchorKey ? 1 : 0))
      : fresh;
    const user = userMessage.trim();
    const assistantFresh = pool.map(n => ({ ...n, text: Universal?.responseText ? Universal.responseText(n.text) : n.text }))
      .filter(n => n.text && !sameUserMessage(n.text, user) && n.role !== 'user');
    if (assistantFresh.length) return assistantFresh[assistantFresh.length - 1];
    const userIndex = pool.findIndex(n => sameUserMessage(n.text, user));
    if (userIndex >= 0) {
      const after = pool.slice(userIndex + 1).map(n => ({ ...n, text: Universal?.responseText ? Universal.responseText(n.text) : n.text }))
        .filter(n => n.text && !sameUserMessage(n.text, user));
      if (after.length) return after[after.length - 1];
    }
    return null;
  }

  async function waitForDirectResponse(userMessage, beforeKeys, timeout, responseAnchorBefore = null) {
    const started = Date.now();
    let lastKey = '';
    let lastText = '';
    let stable = 0;
    let lastDebug = 0;
    let bestResult = null; // 流式过程中最长文本
    let universalTracker = Universal ? Universal.createResponseTracker() : null;
    while (Date.now() - started < timeout) {
      let candidate = findDirectCandidate(userMessage, beforeKeys, responseAnchorBefore);
      if (candidate) {
        const cleanedCandidateText = Universal?.responseText ? Universal.responseText(candidate.text) : candidate.text;
        if (!cleanedCandidateText) {
          await sleep(150);
          continue;
        }
        candidate = { ...candidate, text: cleanedCandidateText };
        if (candidate.key === lastKey && candidate.text === lastText) stable++;
        else { lastKey = candidate.key; lastText = candidate.text; stable = 1; }
        if (Universal) {
          universalTracker.userText = userMessage;
          universalTracker = Universal.observeResponse(universalTracker, candidate);
        }
        if (Date.now() - lastDebug > 250) {
          reportPageEvent('response_candidate', { ...debugNode(candidate), stable, streaming: candidate.streaming });
          if (currentCaptureJobId) {
            chrome.runtime.sendMessage({ type: 'capture_delta', job_id: currentCaptureJobId, key: candidate.key, text: candidate.text, streaming: !!candidate.streaming, completion_reason: candidate.completion_reason || '' }).catch(() => {});
          }
          lastDebug = Date.now();
        }
        // 始终记录最长候选文本，供流式超时时返回
        if (candidate.text && candidate.text.length > (bestResult?.text?.length || 0)) {
          bestResult = { key: candidate.key, text: candidate.text, streaming: candidate.streaming };
        }
        // 文本不再增长且流式已停止 → 稳定结束
        if (stable >= 3 && !candidate.streaming && !sameUserMessage(candidate.text, userMessage)) {
          return { key: candidate.key, text: candidate.text, completion_reason: 'stable_snapshot' };
        }
      }
      await sleep(150);
    }
    // 超时了但可能有流式结果 → 返回最长的非用户消息
    if (bestResult && !sameUserMessage(bestResult.text, userMessage)) {
      reportPageEvent('response_streaming_timeout', { text: bestResult.text.substring(0, 200), length: bestResult.text.length });
      return { ...bestResult, completion_reason: 'idle_timeout' };
    }
    return null;
  }

  function findElement(sel, role = null) {
    if (!sel) return null;
    const candidates = [sel.css, ...(sel.alternatives || [])].filter(Boolean);
    for (const css of candidates) {
      try {
        const matches = document.querySelectorAll(css);
        if (matches.length === 1) return matches[0];
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

  function selectorMatchCount(sel) {
    if (!sel) return 0;
    return [sel.css, ...(sel.alternatives || [])].reduce((n, css) => {
      try { return n + document.querySelectorAll(css).length; } catch { return n; }
    }, 0);
  }

  async function waitForElement(sel, timeout, role = null) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = findElement(sel, role);
      if (el) return el;
      await sleep(250);
    }
    return findElement(sel, role);
  }

  function safeClick(el, force = false) {
    if (!el) return false;
    // One logical click only. Do not combine pointer/mouse events, native click,
    // and React fiber onClick: chat UIs may submit once per path.
    const target = el.matches('button, [role="button"], div[role="button"], span[role="button"]')
      ? el
      : el.closest('button, [role="button"], div[role="button"], span[role="button"]');
    if (!target) return false;
    if (!force && (target.disabled || target.getAttribute('disabled') !== null || target.getAttribute('aria-disabled') === 'true')) return false;
    try {
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
    // 豆包的 copy 候选可能落在消息行外的 action bar；根据其虚拟列表行
    // 的 data-target-id 回到对应消息行，避免 containerFound=false 时误点
    // “投影片生成”等输入区按钮。
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
    return Array.from(document.querySelectorAll('[data-message-id], [data-observe-row]'))
      .filter((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        return text.length > 0;
      });
  }

  function messageNodeKey(el) {
    return el.getAttribute('data-message-id') || el.getAttribute('data-observe-row') || '';
  }

  let responseMonitorObserver = null;
  let responseMonitorTimer = null;
  let responseMonitorSignature = '';

  function emitResponseMonitorSnapshot(reason) {
    const nodes = getMessageNodes().slice(-20).map((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      return {
        key: messageNodeKey(el),
        messageId: el.getAttribute('data-message-id'),
        observeRow: el.getAttribute('data-observe-row'),
        text: text.slice(0, 1000),
        textLength: text.length
      };
    });
    const signature = JSON.stringify(nodes);
    if (signature === responseMonitorSignature) return;
    responseMonitorSignature = signature;
    emitPageTrace('response_monitor', {
      reason,
      nodeCount: nodes.length,
      nodes
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
            const messageText = container?.textContent?.trim() || '';
            return { index, usable: state.usable, messageId: container?.getAttribute?.('data-message-id') || null, messageText: messageText.slice(0, 500), messageLength: messageText.length, streaming: container?.getAttribute?.('data-streaming') || null };
          }),
          messageNodes: getMessageNodes().slice(-20).map((el) => {
            const text = (el.innerText || el.textContent || '').trim();
            return { messageId: el.getAttribute('data-message-id'), observeRow: el.getAttribute('data-observe-row'), key: messageNodeKey(el), streaming: el.getAttribute('data-streaming'), text: text.slice(0, 500), textLength: text.length };
          })
        });
        reportCaptureProgress(`第 ${mutationCount} 次检查：找到 ${buttons.length} 个 copy`, {
          buttons: buttons.map((btn, index) => {
            const container = getMessageContainer(btn);
            const state = getButtonState(btn);
            return {
              index,
              tag: btn.tagName,
              text: (btn.innerText || btn.getAttribute('aria-label') || '').slice(0, 80),
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
          emitPageTrace('assistant_response_candidate', { text: directResponse.slice(0, 5000), textLength: directResponse.length, stableCount: directStableCount });
          if (directStableCount >= 2) {
            const exact = getExactRecordedCopyButton(directResponse);
            if (exact) {
              emitPageTrace('copy_dispatch', { mode: 'recorded_selector', selector: selectors.copy.selector.css, reason: 'assistant_response_stable', responseTextLength: directResponse.length });
              reportCaptureProgress('回复稳定，开始按录制的 copy selector 触发复制');
              safeClick(exact);
              emitPageTrace('copy_dispatched', { mode: 'recorded_selector', selector: selectors.copy.selector.css, tag: exact.tagName, html: exact.outerHTML.slice(0, 1000) });
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
                  emitPageTrace('copy_dispatched', { mode: 'recorded_selector', selector: selectors.copy.selector.css, tag: exact.tagName, html: exact.outerHTML.slice(0, 1000) });
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
        sendResponse(startSingleCapture('response'));
        break;

      case 'cancel_record':
        cancelCapture();
        sendResponse({ status: 'cancelled' });
        break;

      case 'get_selectors':
        sendResponse({ selectors });
        break;

      case 'set_selectors':
        for (const role of ['input', 'send', 'copy', 'response']) {
          const value = msg.selectors?.[role];
          if (role === 'send' && value && typeof value === 'object' && value.kind) {
            sendStrategy = value;
            selectors.send = value;
          } else {
            selectors[role] = value ? normalizeRecordedSelector(value) : null;
          }
        }
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
        sendResponse({ pong: true });
        break;

      case 'discover_selectors':
        sendResponse(discoverReplaySelectors());
        break;

      case 'wait_until_ready': {
        const timeout = Math.min(120000, Math.max(1000, Number(msg.timeout) || 30000));
        (async () => {
          const started = Date.now();
          let inputEl = null;
          let sendReady = false;
          while (Date.now() - started < timeout) {
            inputEl = await waitForElement({ css: selectorText(selectors.input), alternatives: [] }, 250, 'input');
            // Strategy-based send (enter/shortcut) is ready when input exists
            // Only when selectors.send IS actually a strategy object (has .kind)
            const isStrategySend = selectors.send && typeof selectors.send === 'object' && selectors.send.kind;
            sendReady = isStrategySend && (selectors.send.kind === 'enter' || selectors.send.kind === 'shortcut');
            if (!sendReady) {
              const sendEl = await waitForElement({ css: selectorText(selectors.send), alternatives: [] }, 250, 'send');
              sendReady = !!sendEl && !!sendEl.getClientRects().length;
            }
            const inputReady = !!inputEl && !!inputEl.getClientRects().length;
            if (inputReady && sendReady) {
              reportPageEvent('recorded_elements_ready', { waitedMs: Date.now() - started, input: selectorText(selectors.input), send: strategy?.kind || selectorText(selectors.send) });
              sendResponse({ ready: true, input_ready: true, send_ready: true, waited_ms: Date.now() - started });
              return;
            }
            await sleep(100);
          }
          sendResponse({ ready: false, input_ready: !!inputEl, send_ready: sendReady, waited_ms: Date.now() - started });
        })();
        return true;
      }

      case 'auto_capture':
        Promise.resolve().then(() => autoCapture(msg.message, msg.job_id || '')).then(sendResponse).catch(error => {
          console.error('[Phantom Relay] auto_capture failed', error);
          sendResponse({ error: error?.message || String(error) });
        });
        return true;

      case 'find_response':
        const resp = findLatestResponse();
        sendResponse({ text: resp ? resp.textContent.trim().substring(0, 10000) : '', found: !!resp });
        break;

      case 'clear_selectors':
        selectors = { input: null, send: null, response: null };
        sendResponse({ status: 'cleared' });
        break;
    }
  });

  // page_ready 是“录制元素可用”握手，不是仅仅 DOMContentLoaded。
  // 页面保持 ready 租约，避免后台短暂休眠后后端误判离线。
  let readyLeaseInFlight = false;
  let directBridgeInFlight = false;
  let directBridgeReady = false;
  let directBridgeTimer = null;

  async function requestReadyLease() {
    if (readyLeaseInFlight || !isCurrentGeneration()) return;
    readyLeaseInFlight = true;
    try {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        try {
          chrome.runtime.sendMessage({ type: 'page_ready' }, () => {
            void chrome.runtime.lastError;
            finish();
          });
          setTimeout(finish, 4000);
        } catch (_) { finish(); }
      });
    } finally {
      readyLeaseInFlight = false;
    }
  }

  function loadDirectBridgeSelectors() {
    try {
      chrome.storage.local.get(['phantomSelectors'], async (data) => {
        const local = data?.phantomSelectors?.[location.hostname];
        if (local?.input && local?.send) {
          selectors = {
            ...selectors,
            input: normalizeRecordedSelector(local.input),
            send: (local.send && typeof local.send === 'object' && local.send.kind) ? local.send : normalizeRecordedSelector(local.send),
            response: normalizeRecordedSelector(local.response)
          };
        }
        try {
          const resp = await fetch(`http://localhost:8765/browser/selectors?domain=${encodeURIComponent(location.hostname)}`);
          const remote = await resp.json();
          const saved = remote?.selectors;
          if (!saved?.input || !saved?.send) return;
          // Backend contains the latest manually recorded template. Prefer it
          // over stale local extension storage after a browser/profile restore.
          selectors = {
            ...selectors,
            input: normalizeRecordedSelector(saved.input),
            send: (saved.send && typeof saved.send === 'object' && saved.send.kind) ? saved.send : normalizeRecordedSelector(saved.send),
            response: normalizeRecordedSelector(saved.response)
          };
        } catch (_) {}
      });
    } catch (_) {}
  }

  async function directBrowserBridgeTick() {
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
      await fetch('http://localhost:8765/browser/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeat)
      });
      if (!directBridgeReady) return;
      const poll = await fetch('http://localhost:8765/browser/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: location.hostname })
      });
      const data = await poll.json();
      if (!data?.job) return;
      const job = data.job;
      const result = await autoCapture(job.message);
      await fetch('http://localhost:8765/browser/result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.id, domain: location.hostname, model: job.model || '', ...result })
      });
    } catch (_) {
      // The page may be navigating or the local API may be restarting.
    } finally {
      directBridgeInFlight = false;
    }
  }

  function startDirectBrowserBridge() {
    if (directBridgeTimer) return;
    loadDirectBridgeSelectors();
    directBrowserBridgeTick();
    directBridgeTimer = setInterval(directBrowserBridgeTick, 1500);
  }

  requestReadyLease();
  setInterval(requestReadyLease, 3000);
  // The background service worker is the sole job scheduler/claimer.
  // Content script only reports readiness and executes assigned jobs; do not
  // run a second direct poller here, otherwise one API request can be sent twice.
  loadDirectBridgeSelectors();

  // 页面加载完成后持续监测消息节点，不等到点击“自动抓取”才开始。
  // 这样模型正常回复但 copy 控件尚未出现时，也能看到真实新增/更新消息。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startResponseMonitor, { once: true });
  } else {
    startResponseMonitor();
  }

  // ── init ────────────────────────────────────────────────
  console.log('👻 Phantom Relay content script ready');
})();
