import pytest

from server.registry import (
    RegistryContractError,
    _profile_is_executable,
    normalize_model_registry,
    normalize_profile_registry,
    normalize_user_bindings,
    resolve_binding,
    split_legacy_config,
    build_migration_documents,
)


def legacy_config():
    return {
        "models": [{
            "id": "fixture-model",
            "name": "Fixture Model",
            "provider": {"type": "browser", "domain": "fixture.example"},
            "selectors": {"input": "#prompt", "response_area": "[data-message-id]"},
            "capabilities": {"supports_streaming": True},
        }],
        "aliases": {"fixture": "fixture-model"},
        "settings": {"request_timeout_ms": 1000},
    }


def test_split_legacy_config_removes_selectors_from_model_registry():
    split = split_legacy_config(legacy_config())

    model = split["model_registry"]["models"][0]
    assert "selectors" not in model
    assert model["profile_id"] == "legacy-domain:fixture.example:v1"
    assert split["user_bindings"]["bindings"]["fixture-model"]["profile_id"] == model["profile_id"]
    assert split["migration_hints"][0]["reason"] == "legacy selectors lack response identity contract"


def test_model_registry_rejects_selector_leakage():
    with pytest.raises(RegistryContractError) as exc:
        normalize_model_registry({"models": [{"id": "m", "selectors": {"response": "#x"}}]})
    assert exc.value.code == "model_selector_leakage"


def test_profile_and_binding_registry_have_explicit_ownership():
    profiles = normalize_profile_registry({
        "profiles": {
            "fixture-profile": {"profileId": "fixture-profile", "domain": "fixture.example"}
        }
    })
    bindings = normalize_user_bindings({
        "bindings": {"fixture-model": {"profile_id": "fixture-profile"}}
    })
    models = normalize_model_registry({"models": [{"id": "fixture-model"}], "aliases": {"fixture": "fixture-model"}})

    target = resolve_binding("fixture", models, bindings)
    assert target["model_id"] == "fixture-model"
    assert target["profile_id"] == "fixture-profile"
    assert profiles["profiles"][target["profile_id"]]["domain"] == "fixture.example"


def test_profile_key_mismatch_fails_at_boundary():
    with pytest.raises(RegistryContractError) as exc:
        normalize_profile_registry({"profiles": {"profile-a": {"profileId": "profile-b"}}})
    assert exc.value.code == "profile_id_mismatch"


def test_migration_promotes_only_recorded_complete_profiles():
    templates = {
        "fixture.example": {
            "input": {"selector": "#prompt"},
            "profile": {
                "profileId": "recorded-fixture-v1",
                "domain": "fixture.example",
                "response": {"identity": {"attributes": ["data-message-id"]}},
            },
        },
        "legacy.example": {"input": "#prompt", "response": "#answer"},
    }
    documents = build_migration_documents(legacy_config(), templates)

    assert "recorded-fixture-v1" in documents["profile_registry"]["profiles"]
    assert not any(profile.get("domain") == "legacy.example" for profile in documents["profile_registry"]["profiles"].values())
    assert any(item["reason"] == "profile_missing_for_binding" for item in documents["migration_hints"])


def test_network_only_profile_is_not_executable_without_dom_response_identity():
    profile = {
        "profileId": "network-profile-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {},
        "capture": {
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
        },
    }
    assert not __import__("server.registry", fromlist=["_profile_is_executable"])._profile_is_executable(profile)


def test_hybrid_profile_is_not_executable_even_with_dom_fallback():
    profile = {
        "profileId": "hybrid-profile-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": "[data-message-id]",
            "identity": {"attributes": ["data-message-id"]},
        },
        "capture": {"mode": "hybrid"},
    }
    assert not __import__("server.registry", fromlist=["_profile_is_executable"])._profile_is_executable(profile)


def test_dom_profile_without_recorded_identity_evidence_is_not_executable():
    profile = {
        "profileId": "legacy-profile-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": "[data-message-id]",
            "identity": {"attributes": ["data-message-id"]},
        },
    }
    assert not _profile_is_executable(profile)


def test_dom_profile_rejects_analytics_identity_attributes():
    profile = {
        "profileId": "analytics-identity-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": "[data-spm-anchor-id]",
            "identity": {"attributes": ["data-spm-anchor-id"]},
            "identityVerification": {
                "status": "verified",
                "method": "fixture-dom-unique",
                "attributes": ["data-spm-anchor-id"],
            },
        },
    }
    assert not _profile_is_executable(profile)


def test_dom_profile_rejects_layout_identity_attributes():
    for attribute in ("data-panel-id", "data-layout-key", "data-container-id", "data-viewport-id"):
        profile = {
            "profileId": f"{attribute}-identity-v1",
            "origin": "https://page.fixture.example/chat",
            "domain": "page.fixture.example",
            "input": {"selector": "#prompt", "kind": "textarea"},
            "send": {"kind": "enter", "key": "Enter"},
            "response": {
                "selector": ".markdown-text",
                "identity": {"attributes": [attribute]},
                "identityVerification": {
                    "status": "verified",
                    "method": "fixture-dom-unique",
                    "attributes": [attribute],
                },
            },
        }
        assert not _profile_is_executable(profile)


def test_dom_profile_rejects_transient_generation_state_attributes():
    for attribute in (
        "data-is-typing",
        "data-generating",
        "data-thinking",
        "data-processing",
        "data-pending",
        "data-completed",
        "data-active",
        "data-selected",
    ):
        profile = {
            "profileId": f"{attribute}-identity-v1",
            "origin": "https://page.fixture.example/chat",
            "domain": "page.fixture.example",
            "input": {"selector": "#prompt", "kind": "textarea"},
            "send": {"kind": "enter", "key": "Enter"},
            "response": {
                "selector": ".markdown-response",
                "identity": {"attributes": [attribute]},
                "identityVerification": {
                    "status": "verified",
                    "method": "dom-unique-at-recording",
                    "attributes": [attribute],
                },
            },
        }
        assert not _profile_is_executable(profile), attribute


def test_dom_profile_accepts_selector_position_identity():
    profile = {
        "profileId": "selector-position-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": ".markdown-response",
            "identity": {"path": "recordedResponseIndex"},
            "identityVerification": {
                "status": "verified",
                "method": "selector-index-at-recording",
                "identityKind": "selector-position",
                "attributes": [],
            },
            "streamingIndicators": [
                {"selector": '[data-is-typing="true"]', "equals": True},
            ],
        },
    }
    assert _profile_is_executable(profile)


def test_dom_profile_rejects_generated_message_id_selector_but_allows_stable_plain_id():
    generated = {
        "profileId": "generated-message-id-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": "#chat-response-message-bcd2d3ef-4119-4a7c-a33e-064b3aa476e7",
            "identity": {"attributes": ["id"]},
            "identityVerification": {
                "status": "verified",
                "method": "fixture-dom-unique",
                "attributes": ["id"],
            },
        },
    }
    assert not _profile_is_executable(generated)

    stable = {**generated, "profileId": "stable-plain-id-v1", "response": {
        **generated["response"],
        "selector": "#assistant-2",
    }}
    assert _profile_is_executable(stable)


def test_dom_profile_rejects_plain_id_with_only_generic_response_boundary():
    profile = {
        "profileId": "generic-id-boundary-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": "span.markdown-text",
            "containerSelector": "div.message-list",
            "identity": {"attributes": ["id"]},
            "identityVerification": {
                "status": "verified",
                "method": "fixture-dom-unique",
                "attributes": ["id"],
            },
        },
    }
    assert not _profile_is_executable(profile)


def test_dom_profile_accepts_dynamic_per_message_id_with_semantic_response_boundary():
    profile = {
        "profileId": "dynamic-message-id-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {
            "selector": "span.markdown-text",
            "containerSelector": "div.chat-response-message",
            "identity": {"attributes": ["id"]},
            "identityVerification": {
                "status": "verified",
                "method": "dom-unique-at-recording",
                "identityKind": "unique-per-message",
                "attributes": ["id"],
            },
        },
    }
    assert _profile_is_executable(profile)


def test_network_only_profile_without_capture_is_not_executable():
    profile = {
        "profileId": "network-profile-v1",
        "origin": "https://page.fixture.example/chat",
        "domain": "page.fixture.example",
        "input": {"selector": "#prompt"},
        "send": {"kind": "enter", "key": "Enter"},
        "response": {},
        "capture": {"mode": "network", "response": {}, "parser": {}},
    }
    assert not __import__("server.registry", fromlist=["_profile_is_executable"])._profile_is_executable(profile)
