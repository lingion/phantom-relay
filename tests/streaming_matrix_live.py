#!/usr/bin/env python3
"""Real OpenAI-client-facing streaming matrix for a live Phantom Relay browser."""
import json, os, subprocess, sys, time, uuid, concurrent.futures
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = os.environ.get('PHANTOM_API', 'http://127.0.0.1:8765')
MODELS = ['deepseek', 'doubao', 'yiyan']
RESULTS = []

def call(model, messages, stream=True, timeout=90, phantom=None, label=''):
    body = {'model': model, 'messages': messages, 'stream': stream, 'timeout': timeout}
    if phantom is not None:
        body['phantom_relay'] = phantom
    key = 'matrix-' + uuid.uuid4().hex
    started = time.time()
    p = subprocess.run([
        'curl', '-sS', '-N', '--max-time', str(timeout + 35),
        '-H', 'Content-Type: application/json', '-H', 'Idempotency-Key: ' + key,
        API + '/v1/chat/completions', '-d', json.dumps(body, ensure_ascii=False)
    ], capture_output=True, text=True)
    elapsed = time.time() - started
    raw = p.stdout
    events, text_parts, finish = [], [], []
    done = '[DONE]' in raw
    for block in raw.split('\n\n'):
        line = next((x[5:].strip() for x in block.splitlines() if x.startswith('data:')), None)
        if not line or line == '[DONE]':
            continue
        try:
            item = json.loads(line); events.append(item)
            for choice in item.get('choices', []):
                delta = choice.get('delta') or {}
                if delta.get('content') is not None: text_parts.append(str(delta['content']))
                if choice.get('finish_reason'): finish.append(choice['finish_reason'])
        except Exception:
            pass
    text = ''.join(text_parts)
    error = None
    if '"error"' in raw:
        try: error = json.loads(raw).get('error')
        except Exception: error = raw[:500]
    result = {
        'label': label, 'model': model, 'stream': stream, 'elapsed_s': round(elapsed, 2),
        'http_process_rc': p.returncode, 'event_count': len(events), 'content_delta_count': len(text_parts),
        'content_chars': len(text), 'finish_reasons': finish, 'done': done,
        'has_heartbeat': ': heartbeat' in raw, 'error': error, 'raw_head': raw[:900],
        'pass': bool(not error and done and finish and finish[-1] == 'stop' and text_parts and p.returncode == 0)
    }
    RESULTS.append(result)
    (ROOT / 'tests' / 'streaming_matrix_results.partial.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result

def prompt(marker, extra=''):
    return f'请只回复以下内容，不要解释：{marker}{extra}'

def run():
    # Baseline short stream per model.
    for model in MODELS:
        call(model, [{'role':'user','content':prompt('MATRIX_SHORT_'+model)}], label='short')
    # Long answer stream per model: enough text to expose snapshot truncation/last-chunk bugs.
    long_instruction = '请输出编号1到120，每行一个编号，格式为“编号-N：流式验证”，不要省略、合并或解释。'
    for model in MODELS:
        call(model, [{'role':'user','content':long_instruction}], timeout=150, label='long')
    # Multi-turn in one caller-provided context, 4 turns per model.
    for model in MODELS:
        ctx = 'matrix-multi-' + model
        for i in range(1, 5):
            msgs = [{'role':'user','content':f'第{i}轮。上一轮的验收上下文由调用端保留。请只回复：{model}-TURN-{i}'}]
            call(model, msgs, phantom={'context_id':ctx}, label=f'multi_turn_{i}')
    # Ten sequential calls in one model/context.
    ctx = 'matrix-ten-deepseek'
    for i in range(1, 11):
        call('deepseek', [{'role':'user','content':f'连续上下文第{i}次，请只回复 TEN-{i}'}], phantom={'context_id':ctx}, label=f'ten_{i}')
    # Rapid model switching while the caller owns the context identity.
    switch = ['deepseek','doubao','yiyan','deepseek','doubao','yiyan']
    for i, model in enumerate(switch, 1):
        call(model, [{'role':'user','content':f'切换序列第{i}次，请只回复 SWITCH-{i}'}], phantom={'context_id':'matrix-switch'}, label=f'switch_{i}')
    # Independent-context switch without Qwen.
    for i in range(1, 4):
        call('yiyan', [{'role':'user','content':f'文心切换前连续第{i}轮，请只回复 YIYAN-PRE-{i}'}], phantom={'context_id':'matrix-before-switch'}, label=f'pre_switch_{i}')
    call('deepseek', [{'role':'user','content':'切换到 DeepSeek 的新独立上下文，请只回复 DEEPSEEK-AFTER-SWITCH'}], phantom={'context_id':'matrix-after-switch','new_context':True}, label='after_switch_new_context')
    # Three genuinely concurrent independent contexts.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        futs = [ex.submit(call, model, [{'role':'user','content':f'并发代理{n}，请只回复 AGENT-{n}'}], True, 120, {'context_id':f'agent-{n}','new_context':True}, f'parallel_agent_{n}') for n, model in enumerate(['deepseek','doubao','yiyan'], 1)]
        for f in futs: f.result()
    out = ROOT / 'tests' / 'streaming_matrix_results.json'
    out.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2), encoding='utf-8')
    passed = sum(1 for x in RESULTS if x['pass'])
    print(f'MATRIX_SUMMARY total={len(RESULTS)} passed={passed} failed={len(RESULTS)-passed} file={out}')
    return 0 if passed == len(RESULTS) else 2

if __name__ == '__main__':
    sys.exit(run())
