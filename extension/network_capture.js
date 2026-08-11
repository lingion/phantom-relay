'use strict';

// Network capture is profile data, not a provider adapter. The profile owns
// the response contract; this module only matches and parses that contract.
(function attachNetworkCapture(global) {
  function asArray(value) {
    return Array.isArray(value) ? value : (value == null ? [] : [value]);
  }

  function readPointer(value, pointer) {
    if (pointer == null || pointer === '') return value;
    const parts = String(pointer).replace(/^\//, '').split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let current = value;
    for (const part of parts) {
      if (part === '') continue;
      if (part === '-1' && Array.isArray(current)) current = current[current.length - 1];
      else if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
      else if (current && typeof current === 'object') current = current[part];
      else return undefined;
      if (current === undefined) return undefined;
    }
    return current;
  }

  function globToRegExp(pattern) {
    const source = String(pattern || '').split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${source}$`, 'i');
  }

  function normalizeContract(contract) {
    const source = contract && typeof contract === 'object' ? contract : {};
    const response = source.response && typeof source.response === 'object' ? source.response : {};
    const url = response.url && typeof response.url === 'object' ? response.url : {};
    const parser = source.parser && typeof source.parser === 'object' ? source.parser : {};
    return {
      mode: String(source.mode || '').toLowerCase(),
      response: {
        origins: asArray(url.origins || url.origin).map(value => String(value || '').replace(/\/$/, '').toLowerCase()).filter(Boolean),
        pathPatterns: asArray(url.pathPatterns || url.pathPattern).map(value => String(value || '')).filter(Boolean),
        mimeTypes: asArray(response.mimeTypes || response.mimeType).map(value => String(value || '').toLowerCase()).filter(Boolean),
        queryPolicy: String(url.queryPolicy || 'ignore').toLowerCase(),
      },
      parser: {
        eventFormat: String(parser.eventFormat || 'sse').toLowerCase(),
        textRules: Array.isArray(parser.textRules) ? parser.textRules : [],
        finishRules: Array.isArray(parser.finishRules) ? parser.finishRules : [],
      },
    };
  }

  function matchNetworkResponse(response, contract) {
    const normalized = normalizeContract(contract);
    if (!['network', 'hybrid'].includes(normalized.mode)) return false;
    let parsed;
    try { parsed = new URL(String(response?.url || '')); } catch (_) { return false; }
    const origin = parsed.origin.toLowerCase();
    const pathname = parsed.pathname || '/';
    const mime = String(response?.mimeType || '').toLowerCase();
    if (normalized.response.origins.length && !normalized.response.origins.includes(origin)) return false;
    if (normalized.response.pathPatterns.length && !normalized.response.pathPatterns.some(pattern => globToRegExp(pattern).test(pathname))) return false;
    if (normalized.response.mimeTypes.length && !normalized.response.mimeTypes.some(expected => mime.includes(expected))) return false;
    return true;
  }

  function ruleMatches(item, rule) {
    const eventValue = readPointer(item, rule?.eventPath);
    if (rule?.eventEquals != null && String(eventValue) !== String(rule.eventEquals)) return false;
    if (rule?.eventPattern != null && !globToRegExp(rule.eventPattern).test(String(eventValue || ''))) return false;
    if (rule?.eventPathAbsent && eventValue !== undefined) return false;
    return true;
  }

  function appendOrSet(current, value, mode) {
    if (typeof value !== 'string') return current;
    return mode === 'set' ? value : current + value;
  }

  function decodeBase64Block(value) {
    try {
      const binary = atob(String(value || ''));
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch (_) {
      return null;
    }
  }

  // Chrome's Network.streamResourceContent can return several padded base64
  // blocks concatenated into one bufferedData string. It is not safe to call
  // atob() over the whole value because padding may occur in the middle of the
  // concatenation. Keep this transport quirk below the profile parser and
  // decode each block independently.
  function decodeConcatenatedBase64(value) {
    const raw = String(value || '');
    if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) return null;
    const parts = raw.match(/[A-Za-z0-9+/]+={0,2}/g);
    if (!parts || parts.join('') !== raw) return null;
    const bytes = [];
    for (const part of parts) {
      if (part.includes('=') && part.length % 4 !== 0) return null;
      if (!part.includes('=') && part.length % 4 === 1) return null;
      const block = decodeBase64Block(part);
      if (block == null) return null;
      bytes.push(block);
    }
    const totalLength = bytes.reduce((total, block) => total + block.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const block of bytes) {
      merged.set(block, offset);
      offset += block.length;
    }
    return new TextDecoder().decode(merged);
  }

  function decodeTransportChunk(value, declaredBase64 = false) {
    const raw = String(value || '');
    if (!raw) return '';
    const decoded = decodeConcatenatedBase64(raw);
    if (declaredBase64) return decoded == null ? raw : decoded;
    // Only reinterpret an undeclared chunk when the decoded value has SSE
    // framing. Plain-text SSE remains untouched, and arbitrary base64-looking
    // application data is not guessed into text.
    if (decoded != null && /(?:^|\n)(?:data|event):|\n\n/.test(decoded)) return decoded;
    return raw;
  }

  function parseJsonEvent(item, parser, state) {
    for (const rule of parser.textRules) {
      if (!ruleMatches(item, rule)) continue;
      let value = readPointer(item, rule.valuePath);
      if (rule.source === 'fragments' || rule.select === 'last') {
        const fragments = readPointer(item, rule.path || '/v/response/fragments');
        const latest = Array.isArray(fragments) ? fragments[fragments.length - 1] : undefined;
        value = readPointer(latest, rule.itemPath || '/content');
      }
      if (typeof value === 'string') state.text = appendOrSet(state.text, value, rule.mode || 'append');
    }
    for (const rule of parser.finishRules) {
      if (!ruleMatches(item, rule)) continue;
      const value = readPointer(item, rule.valuePath);
      if (rule.valueEquals == null || String(value) === String(rule.valueEquals)) state.finished = true;
    }
  }

  function parseSseBody(body, contract, incrementalState = null, finalize = false) {
    const normalized = normalizeContract(contract);
    const hasIncrementalState = incrementalState && typeof incrementalState === 'object';
    const state = hasIncrementalState
      ? incrementalState
      : { text: '', finished: false, processedRecords: 0 };
    if (normalized.parser.eventFormat !== 'sse') return state;
    const normalizedBody = String(body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const records = normalizedBody.split(/\n\n/);
    // Leave the trailing record unparsed until its blank-line SSE delimiter
    // arrives. This prevents a split JSON event from being consumed forever.
    const completeCount = normalizedBody.endsWith('\n\n')
      ? records.length - 1
      : (hasIncrementalState && !finalize ? Math.max(0, records.length - 1) : records.length);
    const start = Number.isInteger(state.processedRecords) ? state.processedRecords : 0;
    for (let index = start; index < completeCount; index += 1) {
      const record = records[index];
      const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
      if (!data) continue;
      if (data === '[DONE]') { state.finished = true; continue; }
      try {
        parseJsonEvent(JSON.parse(data), normalized.parser, state);
      } catch (_) {
        // A split JSON event is incomplete and will be parsed on the next call.
      }
    }
    state.processedRecords = completeCount;
    return { text: String(state.text || '').trim(), finished: !!state.finished };
  }

  global.PhantomRelayNetworkCapture = {
    normalizeContract,
    readPointer,
    matchNetworkResponse,
    parseSseBody,
    decodeTransportChunk,
  };
})(globalThis);
