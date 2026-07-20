import importlib.util
import pathlib
import threading

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


def test_completed_response_is_replayable():
    api.IDEMPOTENCY.clear()
    record, owner, _ = api.claim_idempotency('req-3', 'fp-a')
    response = {'id': 'chatcmpl-1', 'choices': [{'message': {'content': 'ok'}}]}
    api.complete_idempotency('req-3', response)
    assert record['status'] == 'completed'
    assert api.idempotency_response(record) == response
    assert record['event'].is_set()


if __name__ == '__main__':
    test_claim_and_replay_are_single_owner()
    test_same_key_different_body_conflicts()
    test_completed_response_is_replayable()
    print('API_IDEMPOTENCY_TESTS_PASS')
