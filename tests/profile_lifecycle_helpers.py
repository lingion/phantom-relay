import hashlib
import json
from pathlib import Path


def valid_profile() -> dict:
    return {
        "profileId": "fixture-profile",
        "origin": "https://fixture.example/chat",
        "domain": "fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        "response": {
            "selector": {"css": "[data-message-id]", "alternatives": []},
            "identity": {"attributes": ["data-message-id"]},
            "identityVerification": {"status": "verified", "method": "fixture-dom-unique", "attributes": ["data-message-id"]},
            "role": {"user": ["user"], "assistant": ["assistant"]},
            "streamingIndicators": [],
            "excludedSelectors": [],
            "textNormalization": [{"kind": "trim"}],
        },
        "capabilities": {"text": True, "streaming": "dom-snapshot"},
    }


def profile_checksum(profile: dict) -> str:
    canonical = json.dumps(profile, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def configure_registry_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("PHANTOM_RELAY_REGISTRY_DIR", str(tmp_path))
    return tmp_path


def profile_payload(revision=1, selector="#answer") -> dict:
    profile = valid_profile()
    profile["response"]["selector"] = {"css": selector, "alternatives": []}
    return {
        "client_id": "client-a",
        "profile": profile,
        "revision": revision,
        "checksum": profile_checksum(profile),
    }


def write_bound_registry(tmp_path) -> None:
    profile = valid_profile()
    Path(tmp_path, "model_registry.json").write_text(json.dumps({
        "version": 1,
        "models": [{"id": "fixture-model", "name": "Fixture", "api": "browser",
                     "profile_id": profile["profileId"], "capabilities": {}}],
        "aliases": {"fixture": "fixture-model"}, "settings": {}
    }), encoding="utf-8")
    Path(tmp_path, "profile_registry.json").write_text(json.dumps({
        "version": 1, "profiles": {profile["profileId"]: profile}
    }), encoding="utf-8")
    Path(tmp_path, "user_bindings.json").write_text(json.dumps({
        "version": 1, "bindings": {"fixture-model": {"profile_id": profile["profileId"]}}
    }), encoding="utf-8")


def write_unbound_registry(tmp_path) -> None:
    Path(tmp_path, "model_registry.json").write_text(json.dumps({
        "version": 1,
        "models": [{"id": "unbound-fixture-model", "name": "Fixture", "api": "browser",
                     "profile_id": "missing-profile", "capabilities": {}}],
        "aliases": {}, "settings": {}
    }), encoding="utf-8")
    Path(tmp_path, "profile_registry.json").write_text(json.dumps({
        "version": 1, "profiles": {}
    }), encoding="utf-8")
    Path(tmp_path, "user_bindings.json").write_text(json.dumps({
        "version": 1, "bindings": {}
    }), encoding="utf-8")


def load_api(module_name, monkeypatch, registry_dir):
    import importlib.util

    configure_registry_dir(registry_dir, monkeypatch)
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
