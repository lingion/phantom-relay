import importlib.util
import json
from pathlib import Path


def _load_legacy_api(module_name, monkeypatch, tmp_path):
    monkeypatch.delenv("PHANTOM_RELAY_REGISTRY_DIR", raising=False)
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(module_name, root / "server" / "api_server.py")
    api = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(api)
    api.SELECTOR_TEMPLATES_FILE = str(tmp_path / "selector_templates.json")
    api.selector_templates = api.load_selector_templates()
    return api


def _profile(identity_attribute="data-message-id", selector="[data-message-id]"):
    return {
        "profileId": "legacy-fixture-v1",
        "origin": "https://fixture.example/chat",
        "domain": "fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": selector,
            "identity": {"attributes": [identity_attribute]},
            "identityVerification": {
                "status": "verified",
                "method": "fixture-dom-unique",
                "attributes": [identity_attribute],
            },
        },
    }


def test_profile_reset_removes_legacy_selector_file_projection(tmp_path, monkeypatch):
    api = _load_legacy_api("legacy_profile_reset", monkeypatch, tmp_path)
    profile = _profile()
    payload = {
        "client_id": "client-a",
        "profile": profile,
        "revision": 1,
        "checksum": api.profile_checksum(profile),
    }
    app_client = api.app.test_client()
    assert app_client.post("/browser/profiles", json=payload).status_code == 200
    assert "fixture.example" in api.selector_templates

    response = app_client.delete("/browser/profiles?domain=fixture.example")

    assert response.status_code == 200
    assert response.get_json()["deleted_profile_ids"] == ["legacy-fixture-v1"]
    assert api.selector_templates.get("fixture.example") is None
    persisted = json.loads((tmp_path / "selector_templates.json").read_text(encoding="utf-8"))
    assert "fixture.example" not in persisted


def test_legacy_selector_read_drops_non_executable_profile_but_preserves_recording_inputs(tmp_path, monkeypatch):
    template_path = tmp_path / "selector_templates.json"
    template_path.write_text(json.dumps({
        "fixture.example": {
            "input": {"selector": "#prompt", "kind": "textarea"},
            "send": {"kind": "enter", "key": "Enter"},
            "profile": _profile("data-spm-anchor-id", "[data-spm-anchor-id]"),
        }
    }), encoding="utf-8")
    api = _load_legacy_api("phantom_legacy_selector_read_gate", monkeypatch, tmp_path)

    payload = api.app.test_client().get("/browser/selectors?domain=fixture.example").get_json()

    assert payload["selectors"]["input"]["selector"] == "#prompt"
    assert payload["selectors"]["send"]["kind"] == "enter"
    assert "profile" not in payload["selectors"]


def test_legacy_selector_merge_does_not_reintroduce_non_executable_profile(tmp_path, monkeypatch):
    api = _load_legacy_api("phantom_legacy_selector_write_gate", monkeypatch, tmp_path)

    response = api.app.test_client().post("/browser/selectors", json={
        "domain": "fixture.example",
        "selectors": {
            "input": {"selector": "#prompt", "kind": "textarea"},
            "send": {"kind": "enter", "key": "Enter"},
            "profile": _profile("data-spm-anchor-id", "[data-spm-anchor-id]"),
        },
    })

    assert response.status_code == 200
    assert "profile" not in response.get_json()["selectors"]
    persisted = json.loads((tmp_path / "selector_templates.json").read_text(encoding="utf-8"))
    assert "profile" not in persisted["fixture.example"]


def test_legacy_selector_read_preserves_executable_profile(tmp_path, monkeypatch):
    template_path = tmp_path / "selector_templates.json"
    template_path.write_text(json.dumps({
        "fixture.example": {"profile": _profile()},
    }), encoding="utf-8")
    api = _load_legacy_api("phantom_legacy_selector_valid_profile", monkeypatch, tmp_path)

    payload = api.app.test_client().get("/browser/selectors?domain=fixture.example").get_json()

    assert payload["selectors"]["profile"]["profileId"] == "legacy-fixture-v1"


def test_legacy_profile_without_lifecycle_is_adoptable_by_a_clean_extension(tmp_path, monkeypatch):
    template_path = tmp_path / "selector_templates.json"
    profile = _profile()
    template_path.write_text(json.dumps({
        "fixture.example": {"profile": profile},
    }), encoding="utf-8")
    api = _load_legacy_api("phantom_legacy_profile_clean_install", monkeypatch, tmp_path)
    api._seed_legacy_profile_registry_from_templates(api.selector_templates)

    fetched = api.app.test_client().get("/browser/profiles/legacy-fixture-v1")
    selectors = api.app.test_client().get("/browser/selectors?domain=fixture.example")

    assert fetched.status_code == 200
    assert fetched.get_json()["revision"] == 1
    assert fetched.get_json()["checksum"] == api.profile_checksum(profile)
    assert selectors.get_json()["profile_revision"] == 1


def test_legacy_selector_read_drops_a_conversation_container_even_when_id_is_unique(tmp_path, monkeypatch):
    template_path = tmp_path / "selector_templates.json"
    template_path.write_text(json.dumps({
        "fixture.example": {
            "input": {"selector": "#prompt", "kind": "textarea"},
            "send": {"kind": "enter", "key": "Enter"},
            "profile": _profile("id", "#conversation-flow-container"),
        }
    }), encoding="utf-8")
    api = _load_legacy_api("phantom_legacy_structural_response_gate", monkeypatch, tmp_path)

    payload = api.app.test_client().get("/browser/selectors?domain=fixture.example").get_json()

    assert payload["selectors"]["input"]["selector"] == "#prompt"
    assert payload["selectors"]["send"]["kind"] == "enter"
    assert "profile" not in payload["selectors"]


def test_legacy_profile_upsert_is_the_only_authority_and_survives_restart(tmp_path, monkeypatch):
    api = _load_legacy_api("phantom_legacy_profile_authority", monkeypatch, tmp_path)
    assert hasattr(api, "_seed_legacy_profile_registry_from_templates")
    api._seed_legacy_profile_registry_from_templates(api.selector_templates)
    app_client = api.app.test_client()
    profile = _profile()
    checksum = api.profile_checksum(profile)

    created = app_client.post("/browser/profiles", json={
        "client_id": "client-a",
        "profile": profile,
        "revision": 1,
        "checksum": checksum,
    })
    assert created.status_code == 200

    stale = _profile()
    stale["input"] = {"selector": "#stale-prompt", "kind": "textarea"}
    stale["send"] = {"kind": "button", "selector": "#stale-send"}
    stale["response"]["selector"] = "#stale-answer"
    selector_write = app_client.post("/browser/selectors", json={
        "domain": "fixture.example",
        "selectors": {
            "input": stale["input"],
            "send": stale["send"],
            "response": stale["response"]["selector"],
            "profile": stale,
        },
    })
    assert selector_write.status_code == 200
    assert selector_write.get_json()["profile_revision"] == 1
    assert api.profile_checksum(selector_write.get_json()["selectors"]["profile"]) == checksum

    restarted = _load_legacy_api("phantom_legacy_profile_restart", monkeypatch, tmp_path)
    restarted._seed_legacy_profile_registry_from_templates(restarted.selector_templates)
    fetched = restarted.app.test_client().get("/browser/profiles/legacy-fixture-v1")
    assert fetched.status_code == 200
    assert fetched.get_json()["revision"] == 1
    assert fetched.get_json()["checksum"] == checksum
    assert fetched.get_json()["profile"]["send"]["kind"] == "enter"
