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
    // DOM marker is shared by isolated worlds. Do not remove it here: removing it
    // lets a second executeScript fallback instance start and duplicate sends.
    return;
  }
  root?.setAttribute(INSTANCE_MARKER, String(Date.now()));

  // 每次重新注入时让旧实例失效，避免 popup 收到两份响应/日志
  const generation = (window.__phantomRelayGeneration || 0) + 1;
  window.__phantomRelayGeneration = generation;
  const isCurrentGeneration = () => window.__phantomRelayGeneration === generation;

  // ── 状态锁 ──────────────────────────────────────────────
  let lock = {
    active: false,        // 是否正在等待一次点击
    targetRole: null,     // 'input' | 'send' | 'copy' | 'response'
    captured: false,      // 本次是否已捕获
    callback: null,       // 捕获后回调
  };

  let selectors = {
    input: null,
    send: null,
    copy: null,
    response: null,
  };

  let highlightEl = null;
  let captureDebug = [];
  let pageTraceObserver = null;
  let pageTraceSeq = 0;
  let autoCaptureInFlight = false;

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
    // 检查元素是否在输入框附近（同一个容器或相邻容器）
    const inputEl = document.querySelector('textarea, [contenteditable="true"], input[type="text"], input:not([type]), [role="textbox"], div[contenteditable="true"]');
    if (!inputEl) return false;
    
    // 向上查 8 层，看是否共享祖先
    let p = el;
    for (let i = 0; i < 8 && p && p !== document.body; i++) {
      if (p.contains(inputEl)) return true;
      p = p.parentElement;
    }
    
    // 也查 inputEl 的祖先
    let ip = inputEl.parentElement;
    for (let i = 0; i < 8 && ip && ip !== document.body; i++) {
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

      // 找到最合适的可交互元素
      let target = e.target;
      // 向上查找可交互元素
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

      if (!target || target.tagName === 'BODY' || target.tagName === 'HTML') return;

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
        
        if ((targetRole === 'send' || targetRole === 'copy') && isInteractive) {
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
    clearHighlight();
  }

  // ── 自动回放 ────────────────────────────────────────────
  async function autoCapture(userMessage) {
    if (!isCurrentGeneration()) return { error: 'stale_content_script' };
    if (autoCaptureInFlight) return { error: 'capture_in_flight', detail: '已有自动抓取正在运行，请等待结束' };
    if (!selectors.input?.selector || !selectors.send?.selector) {
      return { error: 'missing_selectors', detail: '请先录制 input 和 send' };
    }
    const captureLock = 'data-phantom-relay-capture-lock';
    // tabs.sendMessage 可能会把消息投递给同一页面上的多个实例；共享 DOM
    // 锁保证只有一个实例真正执行输入和发送。
    if (document.documentElement.hasAttribute(captureLock)) {
      return { error: 'capture_in_flight', detail: '页面已有抓取实例正在运行' };
    }
    document.documentElement.setAttribute(captureLock, String(generation));

    autoCaptureInFlight = true;
    try {
      startPageTrace('auto_capture_before_input');
      reportCaptureProgress(`恢复模板：input=${selectors.input.selector.css}`);
      // 1. 填入输入框
      const inputEl = await waitForElement(selectors.input.selector, 10000, 'input');
      if (!inputEl) {
        emitPageTrace('selector_not_found', {
          role: 'input',
          selector: selectors.input.selector.css,
          alternatives: selectors.input.selector.alternatives || [],
          matchingCount: selectorMatchCount(selectors.input.selector),
          bodyTextLength: document.body?.innerText?.length || 0
        });
        stopPageTrace();
        return { error: 'input_not_found', selector: selectors.input.selector.css };
      }
      reportCaptureProgress(`已找到 input：${inputEl.tagName.toLowerCase()}`);

      if (inputEl.getAttribute('contenteditable') === 'true' || inputEl.closest('[contenteditable="true"]')) {
        const editable = inputEl.getAttribute('contenteditable') === 'true' ? inputEl : inputEl.closest('[contenteditable="true"]');
        editable.focus();
        editable.textContent = userMessage;
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        editable.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        inputEl.focus();
        const setter = Object.getOwnPropertyDescriptor(
          inputEl.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value'
        )?.set;
        if (setter) {
          setter.call(inputEl, userMessage);
        } else {
          inputEl.value = userMessage;
        }
        inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await sleep(400);

      // 2. 点击发送
      const sendEl = await waitForElement(selectors.send.selector, 10000, 'send');
      if (!sendEl) return { error: 'send_not_found', selector: selectors.send.selector.css };
      
      // 发送前记录 copy 按钮及其消息内容
      const oldCopyButtons = getCopyButtons();
      startPageTrace('auto_capture_before_send');
      const oldCopySet = new Set(oldCopyButtons);
      const oldCopySnapshot = new Map();
      for (const btn of oldCopyButtons) {
        const container = getMessageContainer(btn);
        oldCopySnapshot.set(btn, {
          container,
          messageId: container?.getAttribute?.('data-message-id') || null,
          text: container ? container.textContent.trim() : '',
          html: btn.outerHTML,
          fingerprint: copyButtonFingerprint(btn),
          buttonState: getButtonState(btn)
        });
      }
      reportCaptureProgress(`已记录 ${oldCopyButtons.length} 个旧 copy，准备发送`);

      // 必须在发送前安装监听，避免极快响应漏事件
      const oldMessageIds = new Set(getMessageNodes().map(el => messageNodeKey(el)).filter(Boolean));
      reportCaptureProgress(`发送前消息节点 ${oldMessageIds.size} 个`);
      const responsePromise = waitForNewCopyButton(oldCopySet, oldCopySnapshot, 30000, document.body.innerText, userMessage, oldMessageIds);
      reportCaptureProgress('监听已启动，正在点击发送');
      safeClick(sendEl);

      // 3. 新 copy 按钮/复用按钮发生变化时立即触发
      const response = await responsePromise;
      if (!response) return { error: 'copy_timeout', detail: '30 秒内未检测到新的 copy 按钮', debug: captureDebug };
      return { success: true, user: userMessage, assistant: response };
    } catch (err) {
      return { error: err.message };
    } finally {
      autoCaptureInFlight = false;
      document.documentElement.removeAttribute(captureLock);
    }
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

  function safeClick(el) {
    if (!el) return;
    // 爬到真正的可点元素 (button / [role=button])
    const target = el.closest('button, [role="button"], div[role="button"], span[role="button"]') || el;
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // 完整鼠标事件序列 — React/Vue 都认这套
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));

    // 兜底: 原生 click
    try { if (typeof target.click === 'function') target.click(); } catch(e) {}

    // React fiber 兜底: 直接调 onClick prop
    try {
      const fiberKey = Object.keys(target).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (fiberKey) {
        let fiber = target[fiberKey];
        while (fiber) {
          if (fiber.memoizedProps?.onClick) { fiber.memoizedProps.onClick({ nativeEvent: {}, stopPropagation: ()=>{}, preventDefault: ()=>{} }); break; }
          if (fiber.memoizedProps?.onPointerDown) { fiber.memoizedProps.onPointerDown({ nativeEvent: {} }); break; }
          fiber = fiber.return;
        }
      }
    } catch(e) {}
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
        enableCopyMonitor();
        sendResponse(startSingleCapture('input'));
        break;

      case 'record_send':
        cancelCapture();
        sendResponse(startSingleCapture('send'));
        break;

      case 'record_copy':
        cancelCapture();
        sendResponse(startSingleCapture('copy'));
        break;

      case 'cancel_record':
        cancelCapture();
        sendResponse({ status: 'cancelled' });
        break;

      case 'get_selectors':
        sendResponse({ selectors });
        break;

      case 'set_selectors':
        // content script 每次刷新页面都会重新创建；从 background 恢复持久模板。
        for (const role of ['input', 'send', 'copy', 'response']) {
          const value = msg.selectors?.[role];
          if (!value) selectors[role] = null;
          else if (value.selector?.css) selectors[role] = value;
          else if (value.css) selectors[role] = { selector: value };
        }
        sendResponse({ ok: true, selectors });
        break;

      case 'get_lock':
        sendResponse({ lock: { active: lock.active, targetRole: lock.targetRole, captured: lock.captured } });
        break;

      case 'ping':
        sendResponse({ pong: true });
        break;

      case 'auto_capture':
        autoCapture(msg.message).then(sendResponse);
        return true;

      case 'find_response':
        const resp = findLatestResponse();
        sendResponse({ text: resp ? resp.textContent.trim().substring(0, 10000) : '', found: !!resp });
        break;

      case 'clear_selectors':
        selectors = { input: null, send: null, copy: null, response: null };
        sendResponse({ status: 'cleared' });
        break;
    }
  });

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
