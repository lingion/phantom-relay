import importlib
import json


def _api(monkeypatch, tmp_path):
    api = importlib.import_module("server.api_server")
    monkeypatch.setattr(api, "REGISTRY_DIR", "")
    monkeypatch.setattr(api, "LEGACY_BINDINGS_FILE", str(tmp_path / "user_bindings.json"))
    api._routes, api._aliases, api._settings = api.load_model_config()
    api.model_routes = api.load_routes()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()
    return api


def test_custom_model_binding_survives_reload_and_resolves_target(monkeypatch, tmp_path):
    api = _api(monkeypatch, tmp_path)
    client = api.app.test_client()

    synced = client.post("/browser/sync-routes", json={
        "routes": {"my-local-model": "https://custom.example/workspace/chat"},
    })

    assert synced.status_code == 200
    assert synced.get_json()["count"] == 1
    assert api.route_entry("my-local-model")["domain"] == "custom.example"
    assert api.route_entry("my-local-model")["target_url"] == "https://custom.example/workspace/chat"

    api.reload_model_config_globals()

    resolved = api.route_entry("my-local-model")
    assert resolved["domain"] == "custom.example"
    assert resolved["target_url"] == "https://custom.example/workspace/chat"
    persisted = json.loads((tmp_path / "user_bindings.json").read_text(encoding="utf-8"))
    assert persisted["bindings"]["my-local-model"] == {
        "domain": "custom.example",
        "target_url": "https://custom.example/workspace/chat",
    }


def test_recorded_target_url_is_preserved_when_model_binding_is_synced(monkeypatch, tmp_path):
    api = _api(monkeypatch, tmp_path)
    client = api.app.test_client()

    synced = client.post("/browser/sync-routes", json={
        "routes": {
            "qwen-turbo": {
                "domain": "www.qianwen.com",
                "target_url": "https://www.qianwen.com/qianwen/",
            }
        },
    })

    assert synced.status_code == 200
    resolved = api.route_entry("qwen-turbo")
    assert resolved["domain"] == "www.qianwen.com"
    assert resolved["target_url"] == "https://www.qianwen.com/qianwen/"
    persisted = json.loads((tmp_path / "user_bindings.json").read_text(encoding="utf-8"))
    assert persisted["bindings"]["qwen-turbo"] == {
        "domain": "www.qianwen.com",
        "target_url": "https://www.qianwen.com/qianwen/",
    }


def test_model_routes_endpoint_returns_extension_route_shape(monkeypatch, tmp_path):
    api = _api(monkeypatch, tmp_path)
    client = api.app.test_client()
    synced = client.post("/browser/sync-routes", json={
        "routes": {
            "recorded-model": {
                "domain": "custom.example",
                "target_url": "https://custom.example/workspace/chat",
            }
        },
    })
    payload = client.get("/model-routes").get_json()

    assert synced.status_code == 200
    assert set(payload["routes"]) == {"recorded-model"}
    assert payload["routes"]["recorded-model"]["domain"] == "custom.example"
    assert payload["routes"]["recorded-model"]["target_url"] == \
        "https://custom.example/workspace/chat"
    assert "models" not in payload["routes"]
    assert "aliases" not in payload["routes"]


def test_legacy_aliases_for_one_domain_share_one_canonical_recorded_target(monkeypatch, tmp_path):
    api = _api(monkeypatch, tmp_path)
    bindings_path = tmp_path / "user_bindings.json"
    bindings_path.write_text(json.dumps({
        "version": 1,
        "bindings": {
            "primary-model": {
                "domain": "custom.example",
                "target_url": "https://custom.example/workspace/chat",
            },
            "custom.example": {
                "domain": "custom.example",
                "target_url": "https://custom.example/",
            },
            "alias-model": {
                "domain": "custom.example",
                "target_url": "https://custom.example/",
            },
        },
    }, ensure_ascii=False), encoding="utf-8")

    api._routes, api._aliases, api._settings = api.load_model_config()

    assert api.route_entry("primary-model")["target_url"] == "https://custom.example/workspace/chat"
    assert api.route_entry("alias-model")["target_url"] == "https://custom.example/workspace/chat"
    assert api.route_entry("custom.example")["target_url"] == "https://custom.example/workspace/chat"
    persisted = json.loads(bindings_path.read_text(encoding="utf-8"))
    assert {
        value["target_url"] for value in persisted["bindings"].values()
    } == {"https://custom.example/workspace/chat"}
