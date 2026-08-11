import importlib.util
import pathlib
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
def _load_api_module():
    spec = importlib.util.spec_from_file_location('phantom_api', ROOT / 'server' / 'api_server.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

api = _load_api_module()


def test_claim_and_replay_are_single_owner():
    api.IDEMPOTENCY.clear()
    first, owner, conflict = api.claim_idempotency('req-1', 'fp-a')
    assert owner is True and conflict is False
    second, owner2, conflict2 = api.claim_idempotency('req-1', 'fp-a')
    assert owner2 is False and conflict2 is False
    assert second['key'] == first['key']
    assert second['event'] is first['event']


def test_same_key_different_body_conflicts():
    api.IDEMPOTENCY.clear()
    api.claim_idempotency('req-2', 'fp-a')
    _, owner, conflict = api.claim_idempotency('req-2', 'fp-b')
    assert owner is False and conflict is True


def test_non_object_chat_body_is_rejected_without_server_exception():
    assert api.normalize_messages(None) == []
    assert api.normalize_messages([]) == []


def test_tool_followup_prompt_keeps_tool_result_out_of_current_user_slot():
    messages = api.normalize_messages([
        {"role": "user", "content": "天气？"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "weather", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "晴"},
    ])
    prompt = api.browser_prompt(messages)
    assert "【当前用户问题】\n天气？" in prompt
    assert "工具结果（c1）：\n晴" in prompt


def test_completed_response_is_replayable():
    api.IDEMPOTENCY.clear()
    record, owner, _ = api.claim_idempotency('req-3', 'fp-a')
    response = {'id': 'chatcmpl-1', 'choices': [{'message': {'content': 'ok'}}]}
    api.complete_idempotency('req-3', response)
    assert record['status'] == 'completed'
    assert api.idempotency_response(record) == response
    assert record['event'].is_set()


def test_browser_prompt_selective_tool_injection_and_conversation_id():
    plain = api.browser_prompt([{'role': 'user', 'content': '你好'}], [{'type': 'function', 'function': {'name': 'search'}}])
    assert plain == '你好'
    prompted = api.browser_prompt([{'role': 'user', 'content': '请搜索天气'}], [{'type': 'function', 'function': {'name': 'search'}}])
    assert 'tool_json' in prompted and '请搜索天气' in prompted
    job = api.new_browser_job('x', model='m', conversation_id='session-1')
    assert job['conversation_id'] == 'session-1'


def test_tool_prompt_has_schema_and_keyword_gate():
    tools = [{'type': 'function', 'function': {'name': 'search', 'description': 'Find pages', 'parameters': {'type': 'object'}}}]
    assert api.browser_prompt([{'role': 'user', 'content': 'hello'}], tools) == 'hello'
    prompt = api.browser_prompt([{'role': 'user', 'content': '请搜索天气'}], tools)
    assert 'tool_json' in prompt and 'search' in prompt
    assert 'Find pages' in prompt


def test_conversation_persistence_keeps_execution_identity(tmp_path, monkeypatch):
    path = tmp_path / 'conversations.json'
    monkeypatch.setattr(api, 'DATA_FILE', str(path))
    saved = api.save_conversation('q', 'a', 'm', 'browser', 'conv-1', 'job-1', 'stable_snapshot')
    assert saved['conversation_id'] == 'conv-1'
    data = api.load_data()
    assert data['conversations'][0]['job_id'] == 'job-1'
    assert data['conversations'][0]['completion_reason'] == 'stable_snapshot'


def test_openai_tool_message_shape():
    msg = api.openai_assistant_message({'tool_call': {'tool': 'search', 'parameters': {'q': 'x'}}})
    assert msg['content'] is None
    assert msg['tool_calls'][0]['function']['name'] == 'search'


def test_stream_snapshot_delta_and_tool_message_are_consistent():
    assert api.stream_snapshot_delta('', 'hello') == 'hello'
    assert api.stream_snapshot_delta('hello', 'hello world') == ' world'
    assert api.stream_snapshot_delta('hello world', 'hello') == ''


def test_stream_snapshot_delta_does_not_reemit_reflowed_whitespace():
    previous = '编号-1：流式验证 编号-2：流式验证'
    reformatted = '编号-1：流式验证\n编号-2：流式验证'
    assert api.stream_snapshot_delta(previous, reformatted) == ''
    assert api.stream_snapshot_delta(previous, reformatted + ' 编号-3：流式验证') == ' 编号-3：流式验证'
    msg = api.openai_assistant_message({'tool_call': {'tool': 'search', 'parameters': {'q': 'x'}}})
    assert msg['tool_calls'][0]['function']['arguments'] == '{"q":"x"}'


def test_openai_stream_chunks_support_tool_calls_and_text():
    base = {'id': 'chatcmpl-test', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'm'}
    tool_response = {'choices': [{'message': api.openai_assistant_message({'tool_call': {'tool': 'search', 'parameters': {'q': 'x'}}})}]}
    tool_chunks = api.openai_stream_chunks(tool_response, base)
    assert tool_chunks[1]['choices'][0]['delta']['tool_calls'][0]['function']['name'] == 'search'
    assert tool_chunks[-1]['choices'][0]['finish_reason'] == 'tool_calls'
    text_chunks = api.openai_stream_chunks({'choices': [{'message': {'content': 'ok'}}]}, base)
    assert text_chunks[1]['choices'][0]['delta']['content'] == 'ok'
    assert text_chunks[-1]['choices'][0]['finish_reason'] == 'stop'


def test_browser_extension_available_is_brand_neutral():
    api.BROWSER_CLIENTS.clear()
    assert api.browser_extension_available() is False
    api.BROWSER_CLIENTS['browser-a'] = {
        'domain': 'example.test', 'tab_id': 7, 'last_seen': time.time(),
        'ready': True, 'input_ready': True, 'send_ready': True,
        'state': 'ready', 'source': 'content-ready',
        'url': 'https://example.test/chat',
        'capabilities': {'can_execute': True, 'can_observe': True},
    }
    assert api.browser_extension_available('chat.deepseek.com') is False
    assert api.browser_extension_available('example.test') is True


def test_stale_idempotency_records_are_reclaimed():
    api.IDEMPOTENCY['stale-key'] = {
        'fingerprint': 'old', 'status': 'completed', 'created_at': 0,
        'updated_at': 0, 'event': threading.Event(), 'response': None,
    }
    record, owner, conflict = api.claim_idempotency('fresh-key', 'new')
    assert owner is True and conflict is False
    assert record['key'] == 'fresh-key'
    assert 'stale-key' not in api.IDEMPOTENCY


def test_browser_capability_profile_is_explicit():
    profile = api.normalize_browser_capabilities({
        'source': 'content-ready', 'ready': True,
        'input_ready': True, 'send_ready': True,
        'capabilities': {'can_create_tab': True},
    })
    assert profile['transport'] == 'content-ready'
    assert profile['can_observe'] is True
    assert profile['can_execute'] is True
    assert profile['can_create_tab'] is False


def test_route_capabilities_and_unsupported_request():
    recorded_route = api._build_model_route(
        {
            'id': 'recorded-model',
            'name': 'Recorded Model',
            'owned_by': 'user',
            'api': 'browser',
            'capabilities': {'supports_tool_calling': True},
        },
        domain='custom.example',
        url='https://custom.example/workspace/chat',
        selectors={},
    )
    route = api.resolve_model('recorded-model', {recorded_route.id: recorded_route}, {})
    assert route.id == 'recorded-model'
    assert route.domain == 'custom.example'
    assert route.capabilities.supports_tool_calling is True


def test_claim_requires_observe_and_execute_capabilities():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear()
    job = api.new_browser_job('x', domain='example.com', model='m')
    api.BROWSER_CLIENTS['7'] = {'tab_id': 7, 'domain': 'example.com',
        'client_id': 'client-7', 'last_seen': time.time(), 'ready': True,
        'source': 'content-ready', 'capabilities': {
            'can_observe': True, 'can_execute': False,
        }}
    assert api.claim_browser_job('example.com', 7, client_id='client-7') is None
    api.BROWSER_CLIENTS['7']['capabilities']['can_execute'] = True
    assert api.claim_browser_job('example.com', 7,
        conversation_id=job['conversation_id'], client_id='client-7')['id'] == job['id']


def test_claim_promotes_registration_inventory_to_live_content_ready_owner():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()
    job = api.new_browser_job('x', domain='example.com', model='m', conversation_id='conv-1')
    api.BROWSER_CLIENTS['7'] = {
        'tab_id': 7, 'domain': 'example.com', 'client_id': 'client-7',
        'last_seen': time.time(), 'ready': True, 'input_ready': True,
        'send_ready': True, 'source': 'browser-register',
        'capabilities': {'can_observe': True, 'can_execute': True},
    }
    claimed = api.claim_browser_job('example.com', 7, job['conversation_id'], 'client-7')
    assert claimed['status'] == 'claimed'
    assert api.BROWSER_CLIENTS['7']['source'] == 'content-ready'
    api.purge_stale_browser_state()
    assert api.BROWSER_JOBS[job['id']]['status'] == 'claimed'
    assert api.BROWSER_JOBS[job['id']]['tab_id'] == 7


def test_claim_rejects_wrong_or_missing_conversation():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear()
    job = api.new_browser_job('x', domain='example.com', model='m', conversation_id='conv-expected')
    api.BROWSER_CLIENTS['7'] = {'tab_id': 7, 'domain': 'example.com',
        'client_id': 'client-7', 'last_seen': time.time(), 'ready': True,
        'source': 'content-ready', 'capabilities': {'can_observe': True, 'can_execute': True}}
    assert api.claim_browser_job('example.com', 7, conversation_id='wrong', client_id='client-7') is None
    assert api.claim_browser_job('example.com', 7, client_id='client-7') is None
    assert api.claim_browser_job('example.com', 7,
        conversation_id=job['conversation_id'], client_id='client-7')['id'] == job['id']


def test_browser_status_snapshot_exposes_capabilities_without_secrets():
    api.BROWSER_CLIENTS.clear(); api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS['7'] = {'tab_id': 7, 'domain': 'example.com', 'last_seen': __import__('time').time(), 'capabilities': {'can_execute': True}, 'token': 'never'}
    job = api.new_browser_job('x', domain='example.com', model='m')
    snap = api.browser_status_snapshot()
    assert snap['queue_depth'] == 1
    assert snap['clients']['7']['capabilities']['can_execute'] is True
    assert 'token' not in snap['clients']['7']
    assert snap['jobs'][job['id']]['status'] == 'queued'


def test_conversation_binding_prevents_cross_tab_claim():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()
    job = api.new_browser_job('x', domain='example.com', model='m', conversation_id='conv-1')
    api.BROWSER_BINDINGS[('conv-1', 'example.com')] = {
        'conversation_id': 'conv-1', 'domain': 'example.com', 'tab_id': 1,
        'last_seen': __import__('time').time(),
    }
    api.BROWSER_CLIENTS['2'] = {'tab_id': 2, 'domain': 'example.com', 'capabilities': {
        'can_observe': True, 'can_execute': True,
    }, 'last_seen': __import__('time').time()}
    assert api.claim_browser_job('example.com', 2, 'conv-1') is None
    assert api.BROWSER_JOBS[job['id']]['status'] == 'queued'


def test_job_actor_token_and_identity_are_required():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()
    job = api.new_browser_job('original', domain='example.com', model='m', conversation_id='conv-secure')
    api.BROWSER_CLIENTS['9'] = {'tab_id': 9, 'domain': 'example.com',
        'client_id': 'client-9', 'last_seen': time.time(), 'ready': True,
        'source': 'content-ready', 'capabilities': {
            'can_observe': True, 'can_execute': True,
        }}
    claimed = api.claim_browser_job('example.com', 9, 'conv-secure', 'client-9')
    assert claimed['claim_token'] == job['claim_token']
    valid = {'job_id': job['id'], 'claim_token': job['claim_token'], 'tab_id': 9,
             'conversation_id': 'conv-secure', 'domain': 'example.com'}
    assert api.validate_job_actor(valid)[1] is None
    assert api.validate_job_actor(dict(valid, claim_token='wrong'))[1] == 'claim_token_invalid'
    assert api.validate_job_actor(dict(valid, tab_id=10))[1] == 'tab_id_mismatch'
    assert api.validate_job_actor(dict(valid, conversation_id='other'))[1] == 'conversation_id_mismatch'


def test_terminal_job_cannot_be_overwritten():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_EVENTS.clear(); api.BROWSER_DELTAS.clear()
    job = api.new_browser_job('x', domain='example.com', model='m')
    job['status'] = 'claimed'; job['tab_id'] = 1
    first = api.finish_browser_job(job['id'], 'completed', result={'assistant': 'ok'})
    second = api.finish_browser_job(job['id'], 'failed', error='late')
    assert first['status'] == 'completed'
    assert second['status'] == 'completed'
    assert second['result'] == {'assistant': 'ok'}


def test_completed_browser_result_replay_is_idempotent_but_wrong_identity_is_rejected():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_EVENTS.clear(); api.BROWSER_DELTAS.clear()
    job = api.new_browser_job('prompt', domain='example.com', model='m', conversation_id='conv-1')
    job.update(status='claimed', tab_id=7, client_id='client-7')
    payload = {
        'job_id': job['id'], 'claim_token': job['claim_token'], 'client_id': 'client-7',
        'success': True, 'assistant': 'answer', 'key': 'response-1', 'tool_call': None,
        'conversation_id': 'conv-1', 'tab_id': 7, 'domain': 'example.com',
    }
    client = api.app.test_client()
    first = client.post('/browser/result', json=payload)
    replay = client.post('/browser/result', json=payload)
    wrong_token = client.post('/browser/result', json=dict(payload, claim_token='wrong'))
    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.get_json()['idempotent'] is True
    assert wrong_token.status_code in (404, 409)


if __name__ == '__main__':
    test_claim_and_replay_are_single_owner()
    test_same_key_different_body_conflicts()
    test_completed_response_is_replayable()
    print('API_IDEMPOTENCY_TESTS_PASS')
