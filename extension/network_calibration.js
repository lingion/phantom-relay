'use strict';

// Infer a provider-neutral SSE capture contract from one real response. The
// caller must keep the raw body in memory only and discard it after inference.
(function attachNetworkCalibration(global) {
  function pointer(value, path) {
    if (!path) return value;
    return String(path).split('/').slice(1).reduce((current, part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (current == null) return undefined;
      if (key === '-1' && Array.isArray(current)) return current[current.length - 1];
      return current[key];
    }, value);
  }

  function escapePointerPart(value) {
    return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function leaves(value, path = '') {
    if (typeof value === 'string') return [{ path: path || '/', value }];
    if (!value || typeof value !== 'object') return [];
    const output = [];
    if (Array.isArray(value)) {
      value.forEach((item, index) => output.push(...leaves(item, `${path}/${index}`)));
    } else {
      Object.entries(value).forEach(([key, item]) => {
        output.push(...leaves(item, `${path}/${escapePointerPart(key)}`));
      });
    }
    return output;
  }

  function sseEvents(body) {
    return String(body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .split(/\n\n/).map(record => {
        const data = record.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
        if (!data || data === '[DONE]') return data === '[DONE]' ? { done: true } : null;
        try { return { value: JSON.parse(data) }; } catch (_) { return null; }
      }).filter(Boolean);
  }

  function normalizePath(path) {
    return String(path || '').replace(/\/\d+(?=\/|$)/g, '/*');
  }

  function sentinel(value) {
    return /^(?:\[?DONE\]?|FINISHED|COMPLETE(?:D)?|STOP(?:PED)?|END)$/i.test(String(value || '').trim()) ||
      /(?:^|[-_ ])(?:done|finish(?:ed)?|complete(?:d)?|stop(?:ped)?|end(?:ed)?|closed)(?:$|[-_ ])/i.test(String(value || '').trim());
  }

  function likelyTextKey(path) {
    const key = String(path || '').split('/').pop().toLowerCase();
    return ['text', 'content', 'delta', 'message', 'answer', 'output', 'value'].includes(key);
  }

  function repeatedScalarTextRule(eventValues) {
    const candidates = new Map();
    for (const value of eventValues) {
      const seenInEvent = new Set();
      for (const leaf of leaves(value)) {
        // A wildcard JSON Pointer cannot be evaluated by the runtime parser.
        // Prefer stable scalar fields; array-based candidates remain covered by
        // arrayTextRules() below when no stable field is available.
        if (/\/\d+(?=\/|$)/.test(leaf.path) || !likelyTextKey(leaf.path)) continue;
        if (!String(leaf.value || '').trim() || sentinel(leaf.value)) continue;
        if (seenInEvent.has(leaf.path)) continue;
        seenInEvent.add(leaf.path);
        const entry = candidates.get(leaf.path) || [];
        entry.push(String(leaf.value));
        candidates.set(leaf.path, entry);
      }
    }
    const ranked = [...candidates.entries()]
      .filter(([, values]) => values.length >= 3)
      .map(([path, values]) => {
        const key = path.split('/').pop().toLowerCase();
        const totalLength = values.reduce((sum, value) => sum + value.length, 0);
        const maxLength = Math.max(...values.map(value => value.length));
        const cumulative = values.length > 1 && values.slice(1).every((value, index) => value.startsWith(values[index]));
        const score = values.length * 10 + Math.min(maxLength, 500) + Math.min(totalLength / 100, 100) + (cumulative ? 50 : 0) + (key === 'value' ? 25 : 0);
        return { path, values, score, cumulative };
      })
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) return null;
    return {
      valuePath: best.path,
      mode: best.cumulative ? 'set' : 'append',
    };
  }

  function arrayTextRules(eventValues) {
    const counts = new Map();
    for (const item of eventValues) {
      const visit = (value, path) => {
        if (Array.isArray(value)) {
          const textItems = value.filter(entry => entry && typeof entry === 'object' &&
            Object.values(entry).some(child => typeof child === 'string' && child.trim()));
          if (textItems.length) {
            const stringKey = Object.keys(textItems[textItems.length - 1]).find(key =>
              typeof textItems[textItems.length - 1][key] === 'string' && textItems[textItems.length - 1][key].trim());
            if (stringKey) {
              const candidate = `${path}/${stringKey}`;
              counts.set(candidate, (counts.get(candidate) || 0) + 1);
            }
          }
          value.forEach((child, index) => visit(child, `${path}/${index}`));
        } else if (value && typeof value === 'object') {
          Object.entries(value).forEach(([key, child]) => visit(child, `${path}/${escapePointerPart(key)}`));
        }
      };
      visit(item, '');
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    const [path] = best;
    const parts = path.split('/').filter(Boolean);
    const itemKey = parts.pop();
    const arrayPath = `/${parts.join('/')}`.replace(/\/\d+(?=\/|$)/g, '');
    return { source: 'fragments', path: arrayPath || '/', itemPath: `/${itemKey}`, select: 'last', mode: 'set' };
  }

  function inferParser(events) {
    const textRules = [];
    const grouped = new Map();
    let finishRule = null;
    const jsonValues = events.filter(event => event.value).map(event => event.value);

    for (const value of jsonValues) {
      if (typeof value?.p === 'string' && sentinel(value?.v) && !finishRule) {
        finishRule = {
          eventPath: '/p',
          eventEquals: value.p,
          valuePath: '/v',
          valueEquals: value.v
        };
      }
      const all = leaves(value);
      for (const leaf of all) {
        if (sentinel(leaf.value) && !finishRule && leaf.path !== '/v') {
          // Match only the terminal sentinel. Including the parent object in
          // eventEquals can copy the full assistant text into the profile.
          finishRule = { valuePath: leaf.path, valueEquals: leaf.value };
        }
      }
      const eventPath = value && typeof value.p === 'string' ? '/p' : null;
      const valuePath = value && typeof value.v === 'string' ? '/v' : null;
      if (eventPath && valuePath && !sentinel(value.v)) {
        const key = normalizePath(value.p);
        const entry = grouped.get(key) || { values: [], exact: value.p };
        entry.values.push(String(value.v));
        grouped.set(key, entry);
      } else if (!eventPath && valuePath && !sentinel(value.v) && String(value.v).trim()) {
        textRules.push({ eventPath: '/p', eventPathAbsent: true, valuePath: '/v', mode: 'append' });
      }
    }

    // Some SSE protocols carry each update as a normal nested object instead
    // of the compact {p, v} form. Infer a stable scalar field before falling
    // back to array heuristics, which otherwise tend to select metadata lists.
    if (!grouped.size && !textRules.length) {
      const scalarRule = repeatedScalarTextRule(jsonValues);
      if (scalarRule) textRules.push(scalarRule);
      else {
        const arrayRule = arrayTextRules(jsonValues);
        if (arrayRule) textRules.unshift(arrayRule);
      }
    }
    if (!textRules.length) {
      const arrayRule = arrayTextRules(jsonValues);
      if (arrayRule) textRules.unshift(arrayRule);
    }
    for (const [pattern, entry] of grouped) {
      const joined = entry.values.join('');
      const cumulative = entry.values.length > 1 && entry.values.every((value, index) =>
        index === 0 || value.startsWith(entry.values[index - 1]));
      textRules.push({
        eventPath: '/p',
        eventPattern: pattern,
        valuePath: '/v',
        mode: cumulative && joined.length !== entry.values[entry.values.length - 1].length ? 'set' : 'append'
      });
    }
    const uniqueRules = [];
    const seen = new Set();
    for (const rule of textRules) {
      const key = JSON.stringify(rule);
      if (!seen.has(key)) { seen.add(key); uniqueRules.push(rule); }
    }
    return {
      eventFormat: 'sse',
      textRules: uniqueRules,
      finishRules: finishRule ? [finishRule] : [],
      ...(finishRule ? {} : { allowLoadingFinished: true })
    };
  }

  function inferProfile({ domain, origin, input, send, response, body }) {
    const events = sseEvents(body);
    const parser = inferParser(events);
    if (!parser.textRules.length) {
      const error = new Error('network_calibration_text_rule_unresolved');
      error.code = 'network_calibration_text_rule_unresolved';
      throw error;
    }
    const parsed = new URL(String(response?.url || ''));
    const mimeType = String(response?.mimeType || 'text/event-stream').split(';')[0].trim().toLowerCase();
    return {
      profileId: `recorded-${String(domain).trim().toLowerCase()}-network-v1`,
      origin: String(origin || '').trim(),
      domain: String(domain || '').trim().toLowerCase(),
      input,
      send,
      response: {},
      capture: {
        mode: 'network',
        response: {
          url: { origins: [parsed.origin.toLowerCase()], pathPatterns: [parsed.pathname || '/'], queryPolicy: 'ignore' },
          mimeTypes: [mimeType]
        },
        parser
      },
      capabilities: { text: true, streaming: 'network-sse' }
    };
  }

  global.PhantomRelayNetworkCalibration = { inferProfile, inferParser, sseEvents, pointer };
})(globalThis);
