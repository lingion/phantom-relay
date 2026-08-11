import importlib.util
import pathlib
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('phantom_api', ROOT / 'server' / 'api_server.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def reset():
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear(); api.BROWSER_CLIENTS.clear(); api.BROWSER_BINDINGS.clear()


def client(tab, domain='example.com'):
    api.BROWSER_CLIENTS[str(tab)] = {
        'tab_id': tab, 'domain': domain, 'last_seen': time.time(), 'ready': True,
        'capabilities': {'can_observe': True, 'can_execute': True},
    }


def test_default_conversation_is_stable():
    assert api.default_conversation_id('m', 'Example.COM') == 'default_m_example.com'


def test_default_page_reuse_binding_when_idle():
    reset(); job = api.new_browser_job('x', domain='example.com', model='m', conversation_id='default_m_example.com')
    job['conversation_bound'] = False
    api.BROWSER_BINDINGS[('default_m_example.com', 'example.com')] = {
        'conversation_id': 'default_m_example.com', 'domain': 'example.com', 'tab_id': 1, 'last_seen': time.time()
    }
    client(1)
    claimed = api.claim_browser_job('example.com', 1)
    assert claimed and claimed['id'] == job['id']


def test_busy_bound_page_does_not_claim_second_job_on_same_tab():
    reset(); first = api.new_browser_job('a', domain='example.com', model='m', conversation_id='default_m_example.com')
    first['conversation_bound'] = False
    first['status'] = 'claimed'; first['tab_id'] = 1
    second = api.new_browser_job('b', domain='example.com', model='m', conversation_id='default_m_example.com')
    second['conversation_bound'] = False
    api.BROWSER_BINDINGS[('default_m_example.com', 'example.com')] = {
        'conversation_id': 'default_m_example.com', 'domain': 'example.com', 'tab_id': 1, 'last_seen': time.time()
    }
    client(1)
    assert api.claim_browser_job('example.com', 1) is None


def test_explicit_context_is_bound_and_wrong_tab_rejected():
    reset(); job = api.new_browser_job('x', domain='example.com', model='m', conversation_id='agent-a')
    job['conversation_bound'] = True
    api.BROWSER_BINDINGS[('agent-a', 'example.com')] = {
        'conversation_id': 'agent-a', 'domain': 'example.com', 'tab_id': 1, 'last_seen': time.time()
    }
    client(2)
    assert api.claim_browser_job('example.com', 2, 'agent-a') is None
    client(1)
    assert api.claim_browser_job('example.com', 1, 'agent-a')['id'] == job['id']


def test_extension_namespace_is_optional_and_does_not_change_openai_messages():
    assert api.relay_context_options({'messages': [], 'phantom_relay': {'new_context': True}})['new_context'] is True
    assert api.relay_context_options({'messages': []}) == {}


if __name__ == '__main__':
    test_default_conversation_is_stable()
    test_default_page_reuse_binding_when_idle()
    test_busy_bound_page_does_not_claim_second_job_on_same_tab()
    test_explicit_context_is_bound_and_wrong_tab_rejected()
    test_extension_namespace_is_optional_and_does_not_change_openai_messages()
    print('PAGE_REUSE_TESTS_PASS')
