const assert = require('assert');
const U = require('../extension/universal_bridge.js');

function testMessageNormalization() {
  const messages = U.normalizeMessages([
    { role: 'system', content: ' rules ' },
    { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
    { role: 'user', content: '  current  ' },
    { role: 'invalid', content: 'drop' },
    null,
  ]);
  assert.deepStrictEqual(messages, [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'old' },
    { role: 'user', content: 'current' },
  ]);
}

function testRecordedActionsAndBudget() {
  const buttonPlan = U.buildSendPlan({ send: '#send' }, { keyboard: true });
  assert.strictEqual(buttonPlan.actions.length, 1);
  assert.strictEqual(buttonPlan.actions[0].kind, 'button');
  assert.strictEqual(U.nextSendAction(buttonPlan, { actionIndex: 0, submissionCount: 0 }).action.kind, 'button');
  assert.strictEqual(U.nextSendAction(buttonPlan, { actionIndex: 1, submissionCount: 1 }).terminal, 'submission_budget_exhausted');

  const shortcutPlan = U.buildSendPlan({ send: '#send' }, { keyboardFallback: true, allowMultipleSubmissions: true });
  assert.strictEqual(shortcutPlan.actions.length, 2);
  assert.strictEqual(U.nextSendAction(shortcutPlan, { actionIndex: 1, submissionCount: 1, previousEvidence: 'unknown' }).terminal, 'fallback_blocked_without_no_effect_evidence');
  assert.strictEqual(U.nextSendAction(shortcutPlan, { actionIndex: 1, submissionCount: 1, previousEvidence: 'confirmed_no_effect' }).action.kind, 'enter');
  assert.strictEqual(U.nextSendAction(shortcutPlan, { actionIndex: 0, submissionCount: 2 }).terminal, 'submission_budget_exhausted');
  const conservativeShortcut = U.buildSendPlan({ send: { kind: 'shortcut', key: 'Enter' } }, { keyboardFallback: false });
  assert.strictEqual(conservativeShortcut.actions.length, 1);
  assert.strictEqual(conservativeShortcut.maxSubmissions, 1);
}

function testLogicalMessageMerge() {
  const snapshot = U.logicalMessageSnapshot([
    { observeRow: 'row-1', messageId: 'inner-1', text: 'hello' },
    { observeRow: 'row-1', messageId: 'inner-1', text: 'hello with rendered details' },
    { messageId: 'same-text-2', text: 'hello' },
  ]);
  assert.strictEqual(snapshot.length, 2);
  assert.strictEqual(snapshot.find(x => x.key === 'row:row-1').text, 'hello with rendered details');
}

function testFreshUserAndAssistant() {
  const before = new Set(['message:old']);
  const snapshot = U.logicalMessageSnapshot([
    { messageId: 'old', role: 'assistant', text: 'old answer' },
    { messageId: 'u1', role: 'user', text: '压力测试 1：请回复“收到 1”' },
    { messageId: 'a1', role: 'assistant', text: '收到 1', streaming: false },
  ]);
  const user = U.findFreshUser(snapshot, before, '压力测试 1：请回复"收到1"');
  assert.ok(user);
  const assistant = U.findAssistant(snapshot, before, '压力测试 1：请回复"收到1"');
  assert.ok(assistant);
  assert.strictEqual(assistant.text, '收到 1');
}

function testStreamingStateMachine() {
  let tracker = U.createResponseTracker();
  tracker.userText = 'question';
  tracker = U.observeResponse(tracker, { key: 'a1', text: 'a', streaming: true });
  tracker = U.observeResponse(tracker, { key: 'a1', text: 'answer', streaming: true });
  assert.strictEqual(U.responseDecision(tracker, false).status, 'waiting');
  tracker = U.observeResponse(tracker, { key: 'a1', text: 'answer', streaming: false });
  tracker = U.observeResponse(tracker, { key: 'a1', text: 'answer', streaming: false });
  tracker = U.observeResponse(tracker, { key: 'a1', text: 'answer', streaming: false });
  assert.strictEqual(U.responseDecision(tracker, false).status, 'complete');
  assert.strictEqual(U.responseDecision(tracker, false).text, 'answer');
}

function testReasoningAndStatusFiltering() {
  assert.strictEqual(U.isStatusLine('正在思考'), true);
  assert.strictEqual(U.isStatusLine('正在搜索几篇文章'), true);
  assert.strictEqual(U.isStatusLine('这是一个正常回答'), false);
  assert.strictEqual(U.cleanAssistantText('正在思考\n正在搜索几篇文章\n真正的答案\n第二段'), '真正的答案\n第二段');
  assert.strictEqual(U.responseText('thinking...\nThe answer is 42'), 'The answer is 42');
}

function testSnapshotDeltas() {
  let state = U.appendSnapshot(null, '正在思考');
  assert.strictEqual(state.text, '正在思考');
  state = U.appendSnapshot(state, '正在思考\n答案的一部分');
  assert.strictEqual(state.delta, '\n答案的一部分');
  assert.strictEqual(U.cleanAssistantText(state.text), '答案的一部分');
}

function testTimeoutAndDuplicateSafety() {
  let tracker = U.createResponseTracker();
  tracker.userText = 'q';
  tracker = U.observeResponse(tracker, { key: 'a', text: 'partial', streaming: true });
  assert.deepStrictEqual(U.responseDecision(tracker, true), {
    status: 'partial', text: 'partial', partial: true, streaming: true,
    completion_reason: 'idle_timeout'
  });

  const rows = U.logicalMessageSnapshot([
    { observeRow: 'r1', messageId: 'outer', text: 'same answer' },
    { observeRow: 'r1', messageId: 'inner', text: 'same answer with markdown' },
    { messageId: 'r2', text: 'same answer' },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.filter(x => x.text.includes('same answer')).length, 2);

  const base = 'A'.repeat(40) + 'B'.repeat(12);
  const expanded = base + 'C'.repeat(20);
  assert.strictEqual(U.mergeSnapshot(base, expanded), 'C'.repeat(20));
  assert.strictEqual(U.mergeSnapshot(expanded, base), '');
  assert.strictEqual(U.mergeSnapshot('hello', '被'), '被');
}

function testToolCallParsing() {
  assert.deepStrictEqual(U.parseToolCall('```tool_json\n{"tool":"search","parameters":{"q":"hello"}}\n```'), {
    tool: 'search', parameters: { q: 'hello' }
  });
  assert.deepStrictEqual(U.parseToolCall('<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>'), {
    tool: 'read', parameters: { path: 'a' }
  });
  assert.deepStrictEqual(U.parseToolCall('<tool_use><name>exec</name><arguments>{"code":"return 1"}</arguments></tool_use>'), {
    tool: 'exec', parameters: { code: 'return 1' }
  });
  assert.strictEqual(U.parseToolCall('ordinary answer'), null);
  assert.deepStrictEqual(U.parseToolCall('```tool_json\n{"tool":"write","parameters":{"content":"brace } in text","meta":{"nested":true}}}\n```'), {
    tool: 'write', parameters: { content: 'brace } in text', meta: { nested: true } }
  });
  assert.deepStrictEqual(U.parseToolCall('{"name":"exec","arguments":{"command":"printf x}"}}'), {
    tool: 'exec', parameters: { command: 'printf x}' }
  });
  assert.strictEqual(U.parseToolCall('{"tool":"bad tool","parameters":{}}'), null);
  assert.strictEqual(U.parseToolCall('{"tool":"exec","parameters":[]}'), null);
}

function testStatusFilteringPreservesNormalLines() {
  assert.strictEqual(U.cleanAssistantText('正在思考\n答案是 42\n第二段'), '答案是 42\n第二段');
  assert.strictEqual(U.cleanAssistantText('分析中但这是正文'), '分析中但这是正文');
}

testMessageNormalization();
testRecordedActionsAndBudget();
testLogicalMessageMerge();
testFreshUserAndAssistant();
testStreamingStateMachine();
testReasoningAndStatusFiltering();
testSnapshotDeltas();
testTimeoutAndDuplicateSafety();
testToolCallParsing();
testStatusFilteringPreservesNormalLines();
console.log('UNIVERSAL_BRIDGE_TESTS_PASS');
