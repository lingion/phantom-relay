import os

import pytest

from scripts.run_isolated_profile_lifecycle_case import run_profile_lifecycle_case


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser lifecycle test is opt-in",
)
def test_profile_survives_runtime_reload_page_refresh_and_registry_restart():
    result = run_profile_lifecycle_case("interactive")
    assert result["revision_after_reload"] == result["revision_before"]
    assert result["state_after_reload"] == "verified"
    assert result["capture"]["success"] is True
    assert result["capture"]["assistant"] == "Echo: hello from isolated fixture"


@pytest.mark.skipif(
    os.environ.get("PHANTOM_RELAY_RUN_ISOLATED_DOM") != "1",
    reason="isolated browser lifecycle test is opt-in",
)
def test_broken_response_selector_fails_closed_before_capture_timeout():
    result = run_profile_lifecycle_case("interactive-broken-response")
    assert result["broken_profile_error"]["code"] == "profile_response_unavailable"
    assert result["broken_profile_error"]["recoverable"] is True
    assert result["broken_profile_error"]["elapsed_ms"] < 2000
