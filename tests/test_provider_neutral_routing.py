import importlib
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_host_target_selection_uses_job_urls_without_provider_registry():
    host = importlib.import_module("scripts.bidi_browser_host")

    selected = host.select_target_url(
        {
            "jobs": {
                "claimed": {
                    "status": "claimed",
                    "domain": "custom.example",
                    "target_url": "https://custom.example/workspace/chat",
                }
            }
        },
        {"jobs": []},
        fallback="https://current.example/keep",
    )

    assert selected == "https://custom.example/workspace/chat"
    assert not hasattr(host, "TARGETS")


def test_host_target_selection_prefers_claimed_then_queued_then_current_page():
    host = importlib.import_module("scripts.bidi_browser_host")

    claimed = host.select_target_url(
        {
            "jobs": {
                "queued": {
                    "status": "queued",
                    "target_url": "https://queued.example/chat",
                },
                "claimed": {
                    "status": "claimed",
                    "target_url": "https://claimed.example/chat",
                },
            }
        },
        {"jobs": []},
        fallback="https://current.example/keep",
    )
    assert claimed == "https://claimed.example/chat"

    queued = host.select_target_url(
        {"jobs": {}},
        {
            "jobs": [{
                "domain": "recorded.example",
                "target_url": "https://recorded.example/conversation",
            }]
        },
        fallback="https://current.example/keep",
    )
    assert queued == "https://recorded.example/conversation"

    current = host.select_target_url(
        {"jobs": {}},
        {"jobs": []},
        fallback="https://current.example/keep",
    )
    assert current == "https://current.example/keep"


@pytest.mark.parametrize("value", ["", "javascript:alert(1)", "not a url", "ftp://custom.example/chat"])
def test_host_target_selection_rejects_non_http_targets(value):
    host = importlib.import_module("scripts.bidi_browser_host")

    assert host.select_target_url(
        {"jobs": {"job": {"status": "claimed", "target_url": value}}},
        {"jobs": []},
        fallback="https://current.example/keep",
    ) == "https://current.example/keep"


def test_direct_browser_submit_preserves_recorded_target_url_and_rejects_domain_mismatch():
    api = importlib.import_module("server.api_server")
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()

    client = api.app.test_client()
    response = client.post("/browser/submit", json={
        "message": "hello",
        "model": "recorded-model",
        "domain": "Recorded.Example",
        "target_url": "https://recorded.example/workspace/chat",
    })

    assert response.status_code == 202
    assert response.get_json()["domain"] == "recorded.example"
    assert response.get_json()["target_url"] == "https://recorded.example/workspace/chat"

    mismatch = client.post("/browser/submit", json={
        "message": "hello",
        "model": "recorded-model",
        "domain": "recorded.example",
        "target_url": "https://other.example/chat",
    })

    assert mismatch.status_code == 400
    assert mismatch.get_json()["error"]["code"] == "target_url_domain_mismatch"


def test_direct_browser_submit_derives_domain_and_target_from_model_route(monkeypatch):
    api = importlib.import_module("server.api_server")
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()
    monkeypatch.setattr(api, "route_has_executable_profile", lambda route: True)
    recorded_route = api._build_model_route(
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
    monkeypatch.setattr(api, "_routes", {recorded_route.id: recorded_route})
    monkeypatch.setattr(api, "_aliases", {})

    response = api.app.test_client().post("/browser/submit", json={
        "message": "hello",
        "model": "recorded-model",
        "new_tab": True,
    })

    assert response.status_code == 202
    payload = response.get_json()
    assert payload["domain"] == "custom.example"
    assert payload["target_url"] == "https://custom.example/workspace/chat"


def test_direct_browser_submit_preserves_explicit_execution_tab_id():
    api = importlib.import_module("server.api_server")
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()

    response = api.app.test_client().post("/browser/submit", json={
        "message": "hello",
        "model": "recorded-model",
        "domain": "recorded.example",
        "tab_id": 12345,
    })

    assert response.status_code == 202
    assert response.get_json()["tab_id"] == 12345


def test_browser_status_exposes_target_url_for_claimed_host_routing():
    api = importlib.import_module("server.api_server")
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    job = api.new_browser_job(
        "hello",
        domain="recorded.example",
        model="recorded-model",
        target_url="https://recorded.example/workspace/chat",
    )

    assert api.browser_status_snapshot()["jobs"][job["id"]]["target_url"] == \
        "https://recorded.example/workspace/chat"
