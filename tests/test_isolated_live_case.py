import json
from pathlib import Path

import pytest

import scripts.run_isolated_live_case as live_case

from scripts.run_isolated_live_case import (
    HarnessConfig,
    HarnessError,
    build_browser_command,
    preflight,
)


def _profile():
    return {
        "profileId": "fixture-profile",
        "origin": "https://fixture.example/chat",
        "domain": "fixture.example",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        "response": {
            "selector": "[data-role='assistant']",
            "identity": {"attributes": ["data-message-id"]},
        },
    }


def _config(tmp_path, profile_path):
    return HarnessConfig(
        api_url="http://127.0.0.1:8765",
        domain="fixture.example",
        profile_path=profile_path,
        profile_id="",
        model="fixture-model",
        browser_profile_dir=tmp_path / "isolated-browser-profile",
        cdp_port=0,
        extension_dir=Path(__file__).resolve().parents[1] / "extension",
        chrome_binary=None,
        chromedriver=None,
        run=False,
        skip_api_check=True,
    )


def test_preflight_is_provider_neutral_and_derives_target_from_profile(tmp_path):
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(_profile()), encoding="utf-8")

    result = preflight(_config(tmp_path, profile_path))

    assert result["ok"] is True
    assert result["mode"] == "dry-run"
    assert result["domain"] == "fixture.example"
    assert result["target_url"] == "https://fixture.example/chat"
    assert result["browser_profile_dir"] == str(tmp_path / "isolated-browser-profile")
    assert result["cdp_port"] > 0
    assert not (tmp_path / "isolated-browser-profile").exists()


def test_preflight_rejects_profile_domain_mismatch(tmp_path):
    profile_path = tmp_path / "profile.json"
    profile = _profile()
    profile["domain"] = "other.example"
    profile_path.write_text(json.dumps(profile), encoding="utf-8")

    with pytest.raises(HarnessError, match="profile_domain_mismatch"):
        preflight(_config(tmp_path, profile_path))


def test_preflight_rejects_project_local_or_shared_browser_profile(tmp_path):
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(_profile()), encoding="utf-8")
    config = _config(tmp_path, profile_path)
    config.browser_profile_dir = Path(__file__).resolve().parents[1] / ".chrome-debug-live"

    with pytest.raises(HarnessError, match="browser_profile_must_be_isolated"):
        preflight(config)


def test_preflight_requires_explicit_chrome_binary_for_run(tmp_path):
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(_profile()), encoding="utf-8")
    config = _config(tmp_path, profile_path)
    config.run = True

    with pytest.raises(HarnessError, match="chrome_binary_required"):
        preflight(config)


def test_preflight_resolves_driver_from_selected_browser_version(tmp_path, monkeypatch):
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(json.dumps(_profile()), encoding="utf-8")
    browser = tmp_path / "browser"
    browser.write_text("#!/bin/sh\nprintf '%s\\n' 'Chromium 153.0.8010.2'\n", encoding="utf-8")
    browser.chmod(0o700)
    driver = tmp_path / ".tools" / "chromedriver-153.0.8010.2" / "chromedriver"
    driver.parent.mkdir(parents=True)
    driver.write_text("fixture", encoding="utf-8")
    driver.chmod(0o700)
    config = _config(tmp_path, profile_path)
    config.run = True
    config.chrome_binary = browser
    config.chromedriver = None
    config.browser_profile_dir = tmp_path.parent / f"{tmp_path.name}-isolated-browser"

    monkeypatch.setattr(live_case, "ROOT", tmp_path)
    result = live_case.preflight(config)

    assert result["browser_version"] == "153.0.8010.2"
    assert result["chromedriver"] == str(driver.resolve())


def test_browser_command_enables_isolated_extension_and_observable_cdp(tmp_path):
    result = {
        "chrome_binary": "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "browser_profile_dir": str(tmp_path / "isolated-browser-profile"),
        "cdp_port": 9335,
        "extension_dir": str(Path(__file__).resolve().parents[1] / "extension"),
        "target_url": "https://fixture.example/chat",
    }

    command = build_browser_command(result)

    assert "--enable-unsafe-extension-debugging" in command
    assert "--remote-allow-origins=http://127.0.0.1:9335" in command
    assert "--disable-features=CalculateNativeWinOcclusion" in command
    assert "--disable-backgrounding-occluded-windows" in command
    assert not any(item.startswith("--load-extension=") for item in command)
