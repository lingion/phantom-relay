import os

import pytest

import scripts.run_isolated_profile_lifecycle_case as lifecycle_case
from scripts.run_isolated_dom_case import DOM_CAPTURE_TIMEOUT_SECONDS, build_fixture_profile


def test_lifecycle_capture_uses_the_one_way_capture_result_bridge(monkeypatch):
    completed = {"success": True, "assistant": "fixture result"}
    observed = {}

    def fake_capture(driver, message, timeout_seconds):
        observed.update(driver=driver, message=message, timeout_seconds=timeout_seconds)
        return completed

    monkeypatch.setattr(lifecycle_case, "_run_capture_with_cdp_bridge", fake_capture)
    driver = object()

    assert lifecycle_case._capture(driver, "fixture request") is completed
    assert observed == {
        "driver": driver,
        "message": "fixture request",
        "timeout_seconds": DOM_CAPTURE_TIMEOUT_SECONDS,
    }


def test_lifecycle_runtime_stub_exposes_capture_completion_without_send_response():
    profile = build_fixture_profile("http://127.0.0.1:12345", "interactive")
    source = lifecycle_case._runtime_stub(profile)

    assert "capturePromise" in source
    assert "captureResult" in source
    assert "message?.action === 'auto_capture'" in source
    assert "drainKeyboardRequests" in source


def test_lifecycle_injects_the_same_provider_neutral_runtime_as_dom_harness():
    assert lifecycle_case.DOM_FIXTURE_RUNTIME_SCRIPTS == (
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


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser lifecycle test is opt-in",
)
def test_profile_survives_runtime_reload_page_refresh_and_registry_restart():
    result = lifecycle_case.run_profile_lifecycle_case("interactive")
    assert result["revision_after_reload"] == result["revision_before"]
    assert result["state_after_reload"] == "verified"
    assert result["capture"]["success"] is True
    assert result["capture"]["assistant"] == "Echo: hello from isolated fixture"


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser lifecycle test is opt-in",
)
def test_broken_response_selector_fails_closed_before_capture_timeout():
    result = lifecycle_case.run_profile_lifecycle_case("interactive-broken-response")
    assert result["broken_profile_error"]["code"] == "profile_response_unavailable"
    assert result["broken_profile_error"]["recoverable"] is True
    assert result["broken_profile_error"]["elapsed_ms"] < 2000
