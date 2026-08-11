import importlib.util
import json
from pathlib import Path


def _profile(profile_id="fixture-profile"):
    return {
        "profileId": profile_id,
        "origin": "https://fixture.example/chat",
        "domain": "fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        "response": {
            "selector": {"css": "[data-role='assistant']", "alternatives": []},
            "identity": {"attributes": ["data-message-id"]},
            "identityVerification": {"status": "verified", "method": "fixture-dom-unique", "attributes": ["data-message-id"]},
            "role": {"user": ["user"], "assistant": ["assistant"]},
            "streamingIndicators": [],
            "excludedSelectors": [],
            "textNormalization": [{"kind": "trim"}],
        },
        "capabilities": {"text": True, "streaming": "dom-snapshot"},
    }


def _write_registry(directory: Path, *, include_profile=True, include_binding=True):
    directory.mkdir(parents=True, exist_ok=True)
    profile = _profile()
    (directory / "model_registry.json").write_text(json.dumps({
        "version": 1,
        "models": [{
            "id": "fixture-model",
            "name": "Fixture Model",
            "owned_by": "fixture",
            "api": "browser",
            "profile_id": profile["profileId"],
            "capabilities": {
                "supports_streaming": True,
                "max_input_chars": 8000,
            },
        }],
        "aliases": {"fixture": "fixture-model"},
        "settings": {"request_timeout_ms": 120000},
    }), encoding="utf-8")
    (directory / "profile_registry.json").write_text(json.dumps({
        "version": 1,
        "profiles": {profile["profileId"]: profile} if include_profile else {},
    }), encoding="utf-8")
    (directory / "user_bindings.json").write_text(json.dumps({
        "version": 1,
        "bindings": {"fixture-model": {"profile_id": profile["profileId"]}} if include_binding else {},
    }), encoding="utf-8")


def _load_api(module_name, monkeypatch, registry_dir):
    monkeypatch.setenv("PHANTOM_RELAY_REGISTRY_DIR", str(registry_dir))
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(module_name, root / "server" / "api_server.py")
    api = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(api)
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_REGISTRATIONS.clear()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    return api


def test_separated_runtime_uses_profile_for_domain_and_never_model_selectors(tmp_path, monkeypatch):
    _write_registry(tmp_path)
    api = _load_api("phantom_registry_runtime_complete", monkeypatch, tmp_path)

    route = api._routes["fixture-model"]
    assert route.domain == "fixture.example"
    assert route.url == "https://fixture.example/chat"
    assert route.selectors == {}

    models = api.app.test_client().get("/v1/models")
    assert models.status_code == 200
    assert models.get_json()["data"][0]["id"] == "fixture-model"

    selectors = api.app.test_client().get("/browser/selectors?domain=fixture.example")
    assert selectors.status_code == 200
    payload = selectors.get_json()["selectors"]
    assert payload["profile"]["profileId"] == "fixture-profile"
    assert payload["input"]["selector"] == "#prompt"
    assert payload["send"]["kind"] == "button"


def test_separated_runtime_fails_closed_until_recorded_profile_is_persisted(tmp_path, monkeypatch):
    _write_registry(tmp_path, include_profile=False)
    api = _load_api("phantom_registry_runtime_incomplete", monkeypatch, tmp_path)

    assert api._routes["fixture-model"].domain == ""
    missing = api.app.test_client().get("/browser/selectors?domain=fixture.example")
    assert missing.status_code == 200
    assert missing.get_json()["selectors"] == {}

    profile = _profile()
    recorded = api.app.test_client().post("/browser/profiles", json={
        "profile": profile,
        "revision": 1,
        "checksum": api.profile_checksum(profile),
    })
    assert recorded.status_code == 200

    persisted = json.loads((tmp_path / "profile_registry.json").read_text(encoding="utf-8"))
    assert persisted["profiles"]["fixture-profile"]["domain"] == "fixture.example"

    api.reload_model_config_globals()
    assert api._routes["fixture-model"].domain == "fixture.example"


def test_separated_recording_order_syncs_pending_model_binding(tmp_path, monkeypatch):
    _write_registry(tmp_path, include_profile=False, include_binding=False)
    api = _load_api("phantom_registry_runtime_binding_order", monkeypatch, tmp_path)
    client = api.app.test_client()

    synced = client.post("/browser/sync-routes", json={
        "routes": {"fixture-model": "fixture.example"},
    })
    assert synced.status_code == 200
    assert synced.get_json()["bindings_updated"] == 0

    profile = _profile()
    recorded = client.post("/browser/profiles", json={
        "profile": profile,
        "revision": 1,
        "checksum": api.profile_checksum(profile),
    })
    assert recorded.status_code == 200

    bindings = json.loads((tmp_path / "user_bindings.json").read_text(encoding="utf-8"))
    assert bindings["bindings"]["fixture-model"]["profile_id"] == "fixture-profile"
    assert api._routes["fixture-model"].domain == "fixture.example"


def test_separated_chat_rejects_model_without_executable_profile(tmp_path, monkeypatch):
    _write_registry(tmp_path, include_profile=False)
    api = _load_api("phantom_registry_runtime_chat_gate", monkeypatch, tmp_path)
    response = api.app.test_client().post("/v1/chat/completions", json={
        "model": "fixture-model",
        "messages": [{"role": "user", "content": "hello"}],
    })
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "profile_incomplete"


def test_separated_profile_write_rejects_domain_mismatch(tmp_path, monkeypatch):
    _write_registry(tmp_path, include_profile=False)
    api = _load_api("phantom_registry_runtime_domain_gate", monkeypatch, tmp_path)
    profile = _profile()
    response = api.app.test_client().post("/browser/selectors", json={
        "domain": "another.example",
        "selectors": {"profile": profile},
    })
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "profile_domain_mismatch"
