import os
from pathlib import Path

import pytest

from scripts.run_isolated_dom_case import (
    DOM_CAPTURE_TIMEOUT_SECONDS,
    DOM_FIXTURE_RUNTIME_SCRIPTS,
    DOM_NAVIGATION_TIMEOUT_SECONDS,
    _cdp_key_modifiers,
    build_driver_options,
    build_fixture_profile,
    run_case,
)


def test_isolated_dom_driver_uses_bounded_eager_navigation():
    options = build_driver_options(Path("/tmp/phantom-relay-dom-test"))

    assert options.page_load_strategy == "eager"
    assert DOM_NAVIGATION_TIMEOUT_SECONDS == 15
    assert DOM_CAPTURE_TIMEOUT_SECONDS > 120


def test_isolated_dom_runtime_loads_response_qualification_before_content():
    assert DOM_FIXTURE_RUNTIME_SCRIPTS == (
        "backend_config.js",
        "universal_bridge.js",
        "profile_contract.js",
        "profile_lifecycle.js",
        "profile_health.js",
        "selector_recovery.js",
        "capture_lock.js",
        "send_observation.js",
        "response_observation.js",
        "content.js",
    )


def test_isolated_runtime_queues_keyboard_bridge_until_cdp_dispatch():
    profile = build_fixture_profile("http://127.0.0.1:12345", "contenteditable")

    from scripts.run_isolated_dom_case import _chrome_runtime_stub

    source = _chrome_runtime_stub(profile)
    assert "keyboardRequests" in source
    assert "resolveKeyboardRequest" in source
    assert "Input.dispatchKeyEvent" not in source


def test_fixture_cdp_modifier_mask_matches_production_bitwise_semantics():
    assert _cdp_key_modifiers(["Alt", "Control", "Meta", "Shift"]) == 15
    assert _cdp_key_modifiers(["Control", "Control", "Unknown"]) == 2


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser runtime test is opt-in",
)
def test_recorded_profile_executes_against_generic_dom_fixture():
    result = run_case()
    assert result["success"] is True
    assert result["elapsed_ms"] < 10000
    assert result["profile_health"]["state"] == "verified"
    assert result["profile_health"]["reason_codes"] == []
    assert result["user"] == "hello from isolated fixture"
    assert result["assistant"] == "Echo: hello from isolated fixture"
    assert result["response_region"] == "attribute:data-message-id=assistant-2"


def test_fixture_profile_is_provider_neutral():
    profile = build_fixture_profile("http://127.0.0.1:12345")
    assert profile["domain"] == "127.0.0.1"
    assert profile["response"]["identity"]["attributes"] == ["data-message-id"]
    assert profile["response"]["identityVerification"] == {
        "status": "verified",
        "method": "fixture-dom-unique",
        "attributes": ["data-message-id"],
    }
    assert "provider" not in profile


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser runtime test is opt-in",
)
def test_contenteditable_enter_profile_executes_against_generic_dom_fixture():
    result = run_case("contenteditable")
    assert result["success"] is True
    assert result["user"] == "hello from contenteditable fixture"
    assert result["assistant"] == "Echo: hello from contenteditable fixture"
    assert result["response_region"] == "attribute:data-message-id=assistant-2"


def test_contenteditable_enter_case_is_recorded_as_keyboard_action():
    profile = build_fixture_profile("http://127.0.0.1:12345", "contenteditable")
    assert profile["input"] == {"selector": "[contenteditable='true']", "kind": "contenteditable"}
    assert profile["send"] == {"kind": "enter", "key": "Enter", "modifiers": []}
    assert "provider" not in profile


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser runtime test is opt-in",
)
def test_nested_response_uses_outer_identity_and_inner_text():
    result = run_case("nested")
    assert result["success"] is True
    assert result["elapsed_ms"] < 30000
    assert result["user"] == "hello from nested fixture"
    assert result["assistant"] == "Echo: hello from nested fixture"
    assert result["response_region"] == "attribute:data-message-id=assistant-2"


def test_nested_case_declares_inner_response_and_outer_identity():
    profile = build_fixture_profile("http://127.0.0.1:12345", "nested")
    assert profile["response"]["selector"] == "[data-message-body]"
    assert profile["response"]["containerSelector"] == "[data-message-id]"
    assert profile["response"]["identity"]["attributes"] == ["data-message-id"]
    assert "provider" not in profile


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser runtime test is opt-in",
)
def test_broad_recorded_selector_keeps_user_text_out_of_assistant_result():
    result = run_case("broad_selector")
    assert result["success"] is True
    assert result["user"] == "hello from broad selector fixture"
    assert result["assistant"] == "Echo: hello from broad selector fixture"
    assert result["response_region"] == "attribute:data-message-id=assistant-2"


def test_broad_selector_case_is_provider_neutral():
    profile = build_fixture_profile("http://127.0.0.1:12345", "broad_selector")
    assert profile["response"]["selector"] == "div > div"
    assert profile["response"]["identity"]["attributes"] == ["data-message-id"]
    assert "provider" not in profile


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser runtime test is opt-in",
)
def test_virtualized_streaming_row_keeps_outer_identity_until_stable():
    result = run_case("virtualized")
    assert result["success"] is True
    assert result["elapsed_ms"] < 30000
    assert result["user"] == "hello from virtualized fixture"
    assert result["assistant"] == "Echo: hello from virtualized fixture"
    assert result["response_region"] == "attribute:data-row-key=row-assistant-2"
    assert result["identity_keys"] == [
        "attribute:data-row-key=row-user-1",
        "attribute:data-row-key=row-assistant-1",
        "attribute:data-row-key=row-user-2",
        "attribute:data-row-key=row-assistant-2",
    ]
    assert len(result["identity_keys"]) == len(set(result["identity_keys"]))
    assert result["identity_keys"].count(result["response_region"]) == 1
    assert "actions" not in result["assistant"]


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser runtime test is opt-in",
)
def test_shortcut_capture_does_not_require_a_keyed_user_projection():
    result = run_case("assistant_only_shortcut")
    assert result["success"] is True
    assert result["user"] == "hello from assistant-only shortcut fixture"
    assert result["assistant"] == "Echo: hello from assistant-only shortcut fixture"
    assert result["response_region"] == "attribute:id=assistant-2"


def test_assistant_only_shortcut_case_is_provider_neutral():
    profile = build_fixture_profile("http://127.0.0.1:12345", "assistant_only_shortcut")
    assert profile["send"]["kind"] == "shortcut"
    assert profile["response"]["containerSelector"] == ".assistant-shell"
    assert profile["response"]["identityVerification"] == {
        "status": "verified",
        "method": "dom-unique-at-recording",
        "identityKind": "unique-per-message",
        "attributes": ["id"],
    }
    assert "provider" not in profile


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser runtime test is opt-in",
)
def test_descendant_identity_response_recovers_fresh_reply_inside_recorded_scope():
    result = run_case("descendant_identity")
    assert result["success"] is True
    assert result["user"] == "hello from descendant identity fixture"
    assert result["assistant"] == "Echo: hello from descendant identity fixture"
    assert result["response_region"] == "attribute:data-message-id=assistant-2"


def test_descendant_identity_case_declares_recorded_response_tag():
    profile = build_fixture_profile("http://127.0.0.1:12345", "descendant_identity")
    assert profile["response"]["containerSelector"] == ".chat-row"
    assert profile["response"]["elementTag"] == "p"
    assert profile["response"]["identity"]["attributes"] == ["data-message-id"]
    assert "provider" not in profile


def test_virtualized_case_declares_row_identity_and_streaming_contract():
    profile = build_fixture_profile("http://127.0.0.1:12345", "virtualized")
    assert profile["response"]["selector"] == "article[data-message-id]"
    assert profile["response"]["containerSelector"] == "[data-row-key]"
    assert profile["response"]["identity"]["attributes"] == ["data-row-key"]
    assert "provider" not in profile
