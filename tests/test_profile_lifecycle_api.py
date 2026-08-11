import json
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from profile_lifecycle_helpers import (
    load_api,
    profile_checksum,
    profile_payload,
    valid_profile,
    write_bound_registry,
    write_unbound_registry,
)


def test_profile_upsert_is_idempotent_for_same_revision_and_checksum(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_idempotent", monkeypatch, tmp_path)
    profile = valid_profile()
    payload = {"client_id": "client-a", "profile": profile, "revision": 1, "checksum": profile_checksum(profile)}
    app_client = api.app.test_client()
    first = app_client.post("/browser/profiles", json=payload)
    second = app_client.post("/browser/profiles", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.get_json()["state"] == "synced"


def test_profile_upsert_rejects_same_revision_with_different_checksum(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_conflict", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    first = app_client.post("/browser/profiles", json=profile_payload(revision=1))
    conflict = app_client.post("/browser/profiles", json=profile_payload(revision=1, selector="#changed"))
    assert first.status_code == 200
    assert conflict.status_code == 409
    assert conflict.get_json()["error"]["code"] == "profile_conflict"


def test_profile_get_returns_the_persisted_revision_and_checksum(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_get", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    payload = profile_payload()
    created = app_client.post("/browser/profiles", json=payload)
    fetched = app_client.get("/browser/profiles/fixture-profile")
    assert created.status_code == 200
    assert fetched.status_code == 200
    assert fetched.get_json()["revision"] == 1
    assert fetched.get_json()["checksum"] == payload["checksum"]


def test_selector_bootstrap_exposes_the_persisted_profile_revision(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_selector_revision", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    payload = profile_payload()
    created = app_client.post("/browser/profiles", json=payload)
    selectors = app_client.get("/browser/selectors?domain=fixture.example")
    assert created.status_code == 200
    assert selectors.status_code == 200
    assert selectors.get_json()["profile_revision"] == 1


def test_selector_read_uses_registry_profile_when_legacy_template_is_stale(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_selector_authority", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    payload = profile_payload()
    created = app_client.post("/browser/profiles", json=payload)
    assert created.status_code == 200

    stale_profile = deepcopy(payload["profile"])
    stale_profile["input"] = {"selector": "#stale-prompt", "kind": "textarea"}
    stale_profile["send"] = {"kind": "enter", "key": "Enter"}
    stale_profile["response"]["selector"] = {"css": "#stale-answer", "alternatives": []}
    stale_write = app_client.post("/browser/selectors", json={
        "domain": "fixture.example",
        "selectors": {
            "input": stale_profile["input"],
            "send": stale_profile["send"],
            "response": stale_profile["response"]["selector"],
            "profile": stale_profile,
        },
    })
    assert stale_write.status_code == 200

    fetched = app_client.get("/browser/selectors?domain=fixture.example")
    assert fetched.status_code == 200
    selectors = fetched.get_json()["selectors"]
    assert selectors["profile"]["profileId"] == payload["profile"]["profileId"]
    assert api.profile_checksum(selectors["profile"]) == payload["checksum"]
    assert selectors["input"] == payload["profile"]["input"]
    assert selectors["send"] == payload["profile"]["send"]
    assert selectors["response"] == payload["profile"]["response"]["selector"]


def test_profile_upsert_rejects_a_domain_mismatch_with_structured_error(tmp_path, monkeypatch):
    write_bound_registry(tmp_path)
    api = load_api("profile_lifecycle_domain", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    payload = profile_payload()
    payload["profile"]["domain"] = "other.example"
    payload["profile"]["origin"] = "https://other.example/chat"
    payload["checksum"] = profile_checksum(payload["profile"])
    response = app_client.post("/browser/profiles", json=payload)
    assert response.status_code == 422
    assert response.get_json()["error"]["code"] == "profile_domain_mismatch"


def test_profile_without_a_binding_cannot_execute_chat(tmp_path, monkeypatch):
    write_unbound_registry(tmp_path)
    api = load_api("profile_lifecycle_binding", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    response = app_client.post("/v1/chat/completions", json={
        "model": "unbound-fixture-model",
        "messages": [{"role": "user", "content": "hello"}],
    })
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "profile_incomplete"


def test_health_report_persists_only_structured_evidence(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_health", monkeypatch, tmp_path)
    app_client = api.app.test_client()
    app_client.post("/browser/profiles", json=profile_payload())
    response = app_client.post("/browser/profiles/health", json={
        "profile_id": "fixture-profile",
        "revision": 1,
        "state": "verified",
        "checks": {"input": "pass", "send": "pass", "response": "pass", "identity": "pass", "streaming": "pass"},
        "reason_codes": []
    })
    assert response.status_code == 200
    stored = app_client.get("/browser/profiles/fixture-profile").get_json()
    assert stored["health"]["checks"]["identity"] == "pass"
    health_payload = json.dumps(stored["health"])
    for forbidden in ("pageText", "prompt", "assistant_text", "cookie", "authorization"):
        assert forbidden not in health_payload


def test_network_only_profile_upload_does_not_require_dom_response_selector(tmp_path, monkeypatch):
    api = load_api("profile_lifecycle_network_only", monkeypatch, tmp_path)
    profile = valid_profile()
    profile["response"] = {}
    profile["capture"] = {
        "mode": "network",
        "response": {
            "url": {"origins": ["https://stream.fixture.example"], "pathPatterns": ["/events/*"]},
            "mimeTypes": ["text/event-stream"],
        },
        "parser": {
            "eventFormat": "sse",
            "textRules": [{"valuePath": "/text", "mode": "append"}],
            "finishRules": [{"eventPath": "/type", "eventEquals": "done"}],
        },
    }
    payload = {"client_id": "client-a", "profile": profile, "revision": 1, "checksum": profile_checksum(profile)}
    response = api.app.test_client().post("/browser/profiles", json=payload)
    assert response.status_code == 200
    assert response.get_json()["state"] == "synced"
