#!/usr/bin/env node
'use strict';

function parseNetworkSseBody(body) {
  let text = '';
  let finished = false;
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const item = JSON.parse(raw);
      const path = String(item.p || '');
      const operation = String(item.o || '').toUpperCase();
      const fragments = item.v?.response?.fragments;
      if (Array.isArray(fragments)) {
        const latest = fragments[fragments.length - 1];
        if (typeof latest?.content === 'string') text = latest.content;
      } else if (operation === 'APPEND' && /response\/fragments\/.*\/content$/i.test(path) && typeof item.v === 'string') {
        text += item.v;
      } else if (operation === 'SET' && /response\/.*content$/i.test(path) && typeof item.v === 'string') {
        text = item.v;
      } else if (!path && typeof item.v === 'string') {
        text += item.v;
      }
      if (item.p === 'response/status' && item.v === 'FINISHED') finished = true;
      if (Array.isArray(item.v) && item.v.some(x => x?.v === 'FINISHED')) finished = true;
    } catch (_) {}
  }
  return { text: text.trim(), finished };
}

const body = `event: ready
data: {"request_message_id":23,"response_message_id":24,"model_type":"default"}

data: {"v":{"response":{"fragments":[{"content":"网络"}]}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":"流"}

data: {"v":"原文"}

data: {"v":"探"}

data: {"v":"针"}

data: {"p":"response","o":"BATCH","v":[{"v":2400},{"p":"quasi_status","v":"FINISHED"}]}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: close
`;
const got = parseNetworkSseBody(body);
if (got.text !== '网络流原文探针' || !got.finished) {
  console.error('NETWORK_SSE_PARSER_FAIL', JSON.stringify(got));
  process.exit(1);
}
console.log('NETWORK_SSE_PARSER_PASS', JSON.stringify(got));
