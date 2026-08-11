import importlib.util
import pathlib
import threading

import pytest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_api(module_name):
    spec = importlib.util.spec_from_file_location(module_name, ROOT / "server" / "api_server.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    module.BROWSER_JOBS.clear()
    module.BROWSER_EVENTS.clear()
    module.BROWSER_QUEUE.clear()
    module.BROWSER_BINDINGS.clear()
    module.IDEMPOTENCY.clear()
    return module


def install_recorded_route(api):
    route = api._build_model_route(
        {
            "id": "recorded-model",
            "name": "Recorded Model",
            "owned_by": "user",
            "api": "browser",
            "capabilities": {},
        },
        domain="custom.example",
        url="https://custom.example/workspace/chat",
        selectors={},
    )
    api._routes = {route.id: route}
    api._aliases = {}
    return route


def test_conversation_identity_prefers_explicit_top_level_then_relay_scope():
    api = load_api("phantom_conversation_identity_priority")

    assert api.resolve_conversation_id(
        {"conversation_id": "  client-thread-1  ", "phantom_relay": {"conversation_id": "relay"}},
        "fixture-model",
        "Fixture.Example",
    ) == "client-thread-1"
    assert api.resolve_conversation_id(
        {"phantom_relay": {"session_id": "relay-session-1"}},
        "fixture-model",
        "Fixture.Example",
    ) == "relay-session-1"
    assert api.resolve_conversation_id(
        {"messages": [{"role": "user", "content": "not identity"}]},
        "Fixture-Model",
        "Fixture.Example",
    ) == "default_fixture-model_fixture.example"


@pytest.mark.parametrize(
    "body",
    [
        {"conversation_id": ""},
        {"session_id": "   "},
        {"conversation": "x" * 257},
        {"conversation_id": 123},
    ],
)
def test_invalid_explicit_identity_fails_closed(body):
    api = load_api("phantom_conversation_identity_invalid")
    with pytest.raises(ValueError, match="conversation_id_invalid"):
        api.resolve_conversation_id(body, "fixture-model", "fixture.example")


def test_chat_completion_passes_stable_identity_to_browser_job(monkeypatch):
    api = load_api("phantom_conversation_identity_chat")
    monkeypatch.setattr(api, "REGISTRY_DIR", "")
    monkeypatch.setattr(api, "route_has_executable_profile", lambda route: True)
    monkeypatch.setattr(api, "save_conversation", lambda *args, **kwargs: None)
    route = install_recorded_route(api)
    calls = []

    def fake_new_browser_job(message, **kwargs):
        calls.append(kwargs)
        job_id = f"job-conversation-{len(calls)}"
        job = {
            "id": job_id,
            "conversation_id": kwargs["conversation_id"],
            "status": "completed",
            "model": kwargs["model"],
            "message": message,
            "request_meta": kwargs.get("request_meta") or {},
            "result": {"assistant": "ok"},
        }
        api.BROWSER_JOBS[job_id] = job
        event = threading.Event()
        event.set()
        api.BROWSER_EVENTS[job_id] = event
        return job

    monkeypatch.setattr(api, "new_browser_job", fake_new_browser_job)
    client = api.app.test_client()
    request = {"model": route.id, "messages": [{"role": "user", "content": "hello"}]}

    first = client.post("/v1/chat/completions", json=request)
    second = client.post("/v1/chat/completions", json=request)

    assert first.status_code == 200
    assert second.status_code == 200
    assert [call["conversation_id"] for call in calls] == [
        f"default_{route.id.lower()}_{route.domain.lower()}",
        f"default_{route.id.lower()}_{route.domain.lower()}",
    ]

    explicit = dict(request, phantom_relay={"conversation_id": "separate-thread"})
    third = client.post("/v1/chat/completions", json=explicit)
    assert third.status_code == 200
    assert calls[-1]["conversation_id"] == "separate-thread"


def test_idempotency_fingerprint_includes_conversation_identity():
    api = load_api("phantom_conversation_identity_fingerprint")
    first = api.request_fingerprint(
        "fixture-model", [{"role": "user", "content": "hello"}],
        {"conversation_id": "thread-a", "stream": False},
    )
    second = api.request_fingerprint(
        "fixture-model", [{"role": "user", "content": "hello"}],
        {"conversation_id": "thread-b", "stream": False},
    )
    assert first != second


def test_direct_browser_submit_uses_the_same_identity_resolver():
    api = load_api("phantom_conversation_identity_browser_submit")
    client = api.app.test_client()

    first = client.post("/browser/submit", json={
        "message": "one",
        "model": "fixture-model",
        "domain": "Fixture.Example",
    })
    second = client.post("/browser/submit", json={
        "message": "two",
        "model": "fixture-model",
        "domain": "Fixture.Example",
        "phantom_relay": {"conversation_id": "separate-thread"},
    })

    assert first.status_code == 202
    assert second.status_code == 202
    assert first.get_json()["domain"] == "fixture.example"
    assert first.get_json()["conversation_id"] == "default_fixture-model_fixture.example"
    assert second.get_json()["conversation_id"] == "separate-thread"


def test_same_idempotency_key_with_different_conversation_is_rejected(monkeypatch):
    api = load_api("phantom_conversation_identity_idempotency")
    monkeypatch.setattr(api, "REGISTRY_DIR", "")
    monkeypatch.setattr(api, "route_has_executable_profile", lambda route: True)
    monkeypatch.setattr(api, "save_conversation", lambda *args, **kwargs: None)
    route = install_recorded_route(api)

    def fake_new_browser_job(message, **kwargs):
        job_id = f"job-idempotency-{len(api.BROWSER_JOBS) + 1}"
        job = {
            "id": job_id,
            "conversation_id": kwargs["conversation_id"],
            "status": "completed",
            "model": kwargs["model"],
            "message": message,
            "request_meta": kwargs.get("request_meta") or {},
            "result": {"assistant": "ok"},
        }
        api.BROWSER_JOBS[job_id] = job
        event = threading.Event()
        event.set()
        api.BROWSER_EVENTS[job_id] = event
        return job

    monkeypatch.setattr(api, "new_browser_job", fake_new_browser_job)
    client = api.app.test_client()
    headers = {"Idempotency-Key": "conversation-bound-key"}
    base = {"model": route.id, "messages": [{"role": "user", "content": "hello"}]}

    first = client.post("/v1/chat/completions", json=base, headers=headers)
    second = client.post(
        "/v1/chat/completions",
        json={**base, "phantom_relay": {"conversation_id": "other-thread"}},
        headers=headers,
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.get_json()["error"]["code"] == "idempotency_key_conflict"
