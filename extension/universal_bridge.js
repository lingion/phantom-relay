/*
 * Phantom Relay — provider-neutral browser bridge primitives.
 * No website names, selectors, or provider assumptions belong here.
 * Site-specific behavior is supplied as recorded template data.
 */
(function (root) {
  'use strict';

  function text(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(text).join('');
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
    }
    return value == null ? '' : String(value);
  }

  function comparableText(value) {
    return text(value)
      .replace(/[\u00a0\u200b\ufeff]/g, ' ')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\s+\d+\s*\/\s*\d+\s*$/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function sameText(a, b) {
    return comparableText(a) === comparableText(b);
  }

  // Provider-neutral separation of UI progress/reasoning from answer text.
  var STATUS_LINE_PATTERNS = [
    /^(?:正在)?(?:思考|深度思考|推理|分析)(?:中|\.\.\.|…)?$/i,
    /^(?:正在)?(?:阅读|读取|浏览|查看)(?:中|\.\.\.|…)?$/i,
    /^(?:正在)?(?:搜索|检索|查找)(?:中|\.\.\.|…)?$/i,
    /^(?:正在)?(?:搜索|检索|查找)(?:几篇文章|一些文章|资料|网页)?$/i,
    /^(?:深度思考|智能搜索|快速模式|专家模式)$/i,
    /^(?:thinking|reasoning|searching|browsing|reading|loading)(?:\.\.\.|…)?$/i,
    /^(?:search|browse|read)\s+(?:a\s+few\s+)?articles?$/i,
    /^(?:内容由\s*AI\s*生成|开启新对话|暂无历史对话)$/i
  ];

  function isStatusLine(value) {
    var line = text(value).replace(/[\u00a0\u200b\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line || line.length > 80) return false;
    return STATUS_LINE_PATTERNS.some(function (pattern) { return pattern.test(line); });
  }

  function cleanAssistantText(value) {
    // The recorded response region is the authority. Do not classify or remove
    // language-specific words: a thinking panel, disclaimer panel, and final
    // answer panel are separate DOM regions and are selected by identity.
    return text(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .split('\n')
      .map(function (line) { return line.replace(/[\u00a0\u200b\ufeff]/g, ' ').replace(/[ \t]+$/g, ''); })
      .filter(function (line) { return !isStatusLine(line); })
      .join('\n').replace(/^\n+|\n+$/g, '');
  }

  function isReasoningOrStatusElement(el) {
    if (!el || !el.getAttribute) return false;
    var attrs = [
      el.getAttribute('role'), el.getAttribute('aria-live'),
      el.getAttribute('data-testid'), el.getAttribute('data-state'),
      el.getAttribute('class'), el.getAttribute('aria-label')
    ].filter(Boolean).join(' ').toLowerCase();
    if (/(^|[ _-])(status|progress|loading|thinking|reasoning|searching|browsing|citation)([ _-]|$)/.test(attrs)) return true;
    if (el.getAttribute('aria-busy') === 'true') return true;
    return isStatusLine(el.textContent || '');
  }

  function responseText(value) {
    return cleanAssistantText(value);
  }

  function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(function (item) {
      if (!item || typeof item !== 'object') return null;
      var role = String(item.role || 'user').trim().toLowerCase();
      if (['system', 'developer', 'user', 'assistant', 'tool'].indexOf(role) < 0) return null;
      var content = text(item.content).trim();
      return content ? { role: role, content: content } : null;
    }).filter(Boolean);
  }

  function recordedAction(template) {
    var send = template && template.send;
    if (send && typeof send === 'object' && send.kind) {
      return Object.assign({}, send);
    }
    var selector = typeof send === 'string' ? send : (send && (send.css || send.selector));
    if (selector && typeof selector === 'object') selector = selector.css;
    if (selector) return { kind: 'button', selector: String(selector) };
    return null;
  }

  /*
   * A plan is descriptive. The executor must report evidence before asking
   * for another action. No fallback action is implicitly executed here.
   */
  function buildSendPlan(template, capabilities) {
    var action = recordedAction(template);
    var caps = capabilities || {};
    var actions = [];
    if (action) actions.push(Object.assign({ source: 'recorded' }, action));
    if (!action && caps.keyboard !== false) {
      actions.push({ kind: 'enter', key: 'Enter', modifiers: [], source: 'generic_keyboard' });
    }
    if (action && action.kind === 'button' && caps.keyboardFallback === true) {
      actions.push({ kind: 'enter', key: 'Enter', modifiers: [], source: 'explicit_keyboard_fallback' });
    }
    return {
      actions: actions,
      maxSubmissions: caps.allowMultipleSubmissions === true ? Math.max(1, actions.length) : 1,
      requireFreshUserEvidence: true,
      allowSecondActionOnlyAfter: 'confirmed_no_effect'
    };
  }

  function nextSendAction(plan, state) {
    var current = state || {};
    var actions = (plan && plan.actions) || [];
    if (current.freshUserEvidence) return { action: null, terminal: 'accepted' };
    if (current.submissionCount >= (plan.maxSubmissions || 1)) {
      return { action: null, terminal: 'submission_budget_exhausted' };
    }
    var index = Number.isInteger(current.actionIndex) ? current.actionIndex : 0;
    if (index >= actions.length) return { action: null, terminal: 'no_send_strategy' };
    if (index > 0 && current.previousEvidence !== 'confirmed_no_effect') {
      return { action: null, terminal: 'fallback_blocked_without_no_effect_evidence' };
    }
    return { action: actions[index], terminal: null };
  }

  function logicalKey(record) {
    if (!record) return '';
    if (record.logicalKey) return 'logical:' + record.logicalKey;
    if (record.containerKey) return 'container:' + record.containerKey;
    if (record.observeRow) return 'row:' + record.observeRow;
    if (record.virtualKey) return 'virtual:' + record.virtualKey;
    if (record.messageId) return 'message:' + record.messageId;
    return '';
  }

  /*
   * Merge only when the page gives an explicit container/row identity.
   * Same text alone is never enough to merge two messages.
   */
  function logicalMessageSnapshot(records) {
    var grouped = new Map();
    (Array.isArray(records) ? records : []).forEach(function (record) {
      var key = logicalKey(record);
      var value = Object.assign({}, record, { text: text(record.text).trim(), key: key });
      if (!key || !value.text) return;
      var old = grouped.get(key);
      if (!old || value.text.length > old.text.length || value.authoritative === true) {
        grouped.set(key, value);
      }
    });
    return Array.from(grouped.values()).map(function (item, index) {
      return Object.assign({}, item, { index: index });
    });
  }

  function findFreshUser(snapshot, beforeKeys, expected) {
    var old = beforeKeys || new Set();
    return snapshot.find(function (item) {
      return !old.has(item.key) && (item.role === 'user' || item.role === 'unknown' || !item.role) && sameText(item.text, expected);
    }) || null;
  }

  function findAssistant(snapshot, beforeKeys, expected) {
    var old = beforeKeys || new Set();
    var fresh = snapshot.filter(function (item) { return !old.has(item.key) && item.text; });
    var userIndex = fresh.findIndex(function (item) { return sameText(item.text, expected); });
    var after = userIndex >= 0 ? fresh.slice(userIndex + 1) : fresh;
    var candidates = after.map(function (item) {
      return Object.assign({}, item, { text: responseText(item.text) });
    }).filter(function (item) {
      return item.text && !sameText(item.text, expected) && item.role !== 'user';
    });
    if (!candidates.length && userIndex >= 0) {
      candidates = fresh.slice(userIndex + 1).map(function (item) {
        return Object.assign({}, item, { text: responseText(item.text) });
      }).filter(function (item) { return item.text && !sameText(item.text, expected); });
    }
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function mergeSnapshot(existing, incoming, minOverlapLength = 32) {
    const previous = text(existing);
    const next = text(incoming);
    if (!next) return '';
    if (!previous) return next;
    if (next === previous || previous.startsWith(next)) return '';
    if (next.startsWith(previous)) return next.slice(previous.length);
    if (next.length < minOverlapLength) return next;
    const max = Math.min(previous.length, next.length);
    for (let length = max; length >= minOverlapLength; length -= 1) {
      if (previous.slice(-length) === next.slice(0, length)) return next.slice(length);
    }
    return next;
  }

  function appendSnapshot(state, snapshot, minOverlapLength = 32) {
    const current = state || { text: '', lastSnapshot: '' };
    const incoming = text(snapshot);
    const delta = mergeSnapshot(current.text, incoming, minOverlapLength);
    return { text: current.text + delta, lastSnapshot: incoming, delta };
  }

  function createResponseTracker() {
    return { key: '', text: '', stable: 0, seen: false, streaming: false, complete: false };
  }

  function observeResponse(tracker, candidate) {
    if (!candidate || !candidate.text) return tracker;
    var next = Object.assign({}, tracker);
    var candidateText = responseText(candidate.text);
    if (!candidateText || sameText(candidateText, tracker.userText || '')) return tracker;
    const sameKey = next.key === (candidate.key || '')
      || (next.text && (candidateText.startsWith(next.text) || next.text.startsWith(candidateText)));
    const delta = sameKey ? mergeSnapshot(next.text, candidateText) : candidateText;
    if (sameKey && next.text === candidateText) next.stable += 1;
    else { next.key = candidate.key || next.key || ''; next.text = candidateText; next.stable = sameKey ? next.stable + 1 : 1; }
    next.delta = delta;
    next.seen = true;
    next.streaming = candidate.streaming === true || candidate.busy === true;
    next.complete = next.stable >= 3 && !next.streaming;
    if (!next.bestText || candidateText.length >= next.bestText.length) next.bestText = candidateText;
    return next;
  }

  function responseDecision(tracker, timeoutReached) {
    if (tracker.complete && tracker.text) return { status: 'complete', text: tracker.text, partial: false, completion_reason: 'stable_snapshot' };
    if (timeoutReached && tracker.bestText) return { status: 'partial', text: tracker.bestText, partial: true, streaming: tracker.streaming, completion_reason: 'idle_timeout' };
    return { status: tracker.seen ? 'waiting' : 'not_found', text: '', completion_reason: tracker.seen ? 'waiting_for_content' : 'no_content_timeout' };
  }

  function safeJson(value) {
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function balancedJsonCandidates(source, limit) {
    var out = [];
    source = text(source);
    var max = Math.min(source.length, limit || 65536);
    for (var start = 0; start < max; start += 1) {
      if (source[start] !== '{') continue;
      var depth = 0, inString = false, escaped = false;
      for (var i = start; i < max; i += 1) {
        var ch = source[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) { out.push(source.slice(start, i + 1)); start = i; break; }
        }
      }
    }
    return out;
  }

  function parsedToolObject(value) {
    var parsed = typeof value === 'string' ? safeJson(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    var name = parsed.tool || parsed.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(name)) return null;
    var args = parsed.parameters !== undefined ? parsed.parameters : parsed.arguments;
    if (typeof args === 'string') args = safeJson(args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { tool: name, parameters: args };
  }

  function parseToolCall(value) {
    var source = text(value);
    if (!source || source.length > 65536) return null;
    var fenced = source.match(/```tool_json\s*\n?([\s\S]*?)\n?\s*```/i);
    var xml = source.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    var toolUse = source.match(/<tool_use[^>]*>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>[\s\S]*?<arguments>\s*([\s\S]*?)\s*<\/arguments>[\s\S]*?<\/tool_use>/i);
    var regions = [];
    if (fenced) regions.push(fenced[1]);
    if (xml) regions.push(xml[1]);
    if (toolUse) {
      var toolUseArgs = safeJson(toolUse[2]);
      if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(toolUse[1].trim()) && toolUseArgs && typeof toolUseArgs === 'object' && !Array.isArray(toolUseArgs)) {
        return { tool: toolUse[1].trim(), parameters: toolUseArgs };
      }
    }
    regions = regions.concat(balancedJsonCandidates(source, 65536));
    for (var i = 0; i < regions.length; i += 1) {
      var candidates = balancedJsonCandidates(regions[i], 65536);
      for (var j = 0; j < candidates.length; j += 1) {
        var parsed = parsedToolObject(candidates[j]);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  var api = {
    text: text,
    comparableText: comparableText,
    sameText: sameText,
    isStatusLine: isStatusLine,
    cleanAssistantText: cleanAssistantText,
    isReasoningOrStatusElement: isReasoningOrStatusElement,
    responseText: responseText,
    normalizeMessages: normalizeMessages,
    recordedAction: recordedAction,
    buildSendPlan: buildSendPlan,
    nextSendAction: nextSendAction,
    logicalMessageSnapshot: logicalMessageSnapshot,
    findFreshUser: findFreshUser,
    findAssistant: findAssistant,
    createResponseTracker: createResponseTracker,
    observeResponse: observeResponse,
    responseDecision: responseDecision,
    parseToolCall: parseToolCall,
    mergeSnapshot: mergeSnapshot,
    appendSnapshot: appendSnapshot
  };

  root.PhantomRelayUniversal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
