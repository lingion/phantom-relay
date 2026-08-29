import importlib.util
import pathlib
import stat
import sys

import pytest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "bidi_extension_probe",
    ROOT / "scripts" / "bidi_extension_probe.py",
)
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = probe
SPEC.loader.exec_module(probe)


@pytest.mark.parametrize(
    "candidate",
    [
        pathlib.Path("/"),
        pathlib.Path.home(),
        ROOT,
        pathlib.Path.home() / "Library/Application Support/Google/Chrome",
        pathlib.Path.home() / "Library/Application Support/Google/Chrome Canary",
        pathlib.Path.home() / "Library/Application Support/Chromium",
    ],
)
def test_probe_rejects_dangerous_profile_roots_before_creation(candidate):
    with pytest.raises(probe.ProbeProfileError, match="probe_profile_must_be_isolated"):
        probe.prepare_probe_profile(candidate)


def test_probe_rejects_non_temporary_and_existing_targets(tmp_path):
    with pytest.raises(probe.ProbeProfileError, match="probe_profile_must_be_temporary"):
        probe.prepare_probe_profile(pathlib.Path("/var/tmp/phantom-relay-probe-new"))

    existing = tmp_path / "existing-profile"
    existing.mkdir()
    with pytest.raises(probe.ProbeProfileError, match="probe_profile_must_not_exist"):
        probe.prepare_probe_profile(existing)


def test_probe_only_cleans_the_wrapper_it_created(tmp_path):
    wrapper = tmp_path / "phantom-relay-bidi-probe-owned"
    owned = probe.prepare_probe_profile(wrapper)
    (owned.user_data_dir / "chrome-data").write_text("fixture", encoding="utf-8")

    probe.cleanup_probe_profile(owned)

    assert not wrapper.exists()


def test_probe_cleanup_rejects_missing_or_wrong_ownership_marker(tmp_path):
    wrapper = tmp_path / "phantom-relay-bidi-probe-unowned"
    wrapper.mkdir()
    user_data = wrapper / "user-data"
    user_data.mkdir()
    unowned = probe.ProbeProfile(
        root_dir=wrapper,
        user_data_dir=user_data,
        ownership_token="expected-token",
    )

    with pytest.raises(probe.ProbeProfileError, match="probe_profile_ownership_missing"):
        probe.cleanup_probe_profile(unowned)
    assert wrapper.exists()

    (wrapper / probe.PROBE_OWNERSHIP_FILE).write_text("different-token", encoding="utf-8")
    with pytest.raises(probe.ProbeProfileError, match="probe_profile_ownership_mismatch"):
        probe.cleanup_probe_profile(unowned)
    assert wrapper.exists()


def _make_executable(path: pathlib.Path) -> pathlib.Path:
    path.parent.mkdir(parents=True)
    path.write_text("fixture", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_resolve_chromedriver_prefers_explicit_executable(monkeypatch, tmp_path):
    explicit = _make_executable(tmp_path / "custom" / "chromedriver")
    monkeypatch.setenv("PHANTOM_RELAY_CHROMEDRIVER", str(explicit))

    assert probe.resolve_chromedriver("153.0.8010.2", root=tmp_path) == explicit.resolve()


def test_resolve_chromedriver_uses_exact_canary_version(monkeypatch, tmp_path):
    monkeypatch.delenv("PHANTOM_RELAY_CHROMEDRIVER", raising=False)
    exact = _make_executable(
        tmp_path / ".tools" / "chromedriver-153.0.8010.2" / "chromedriver"
    )
    _make_executable(
        tmp_path / ".tools" / "chromedriver-153.0.8002.0" / "chromedriver"
    )

    assert probe.resolve_chromedriver("153.0.8010.2", root=tmp_path) == exact.resolve()


def test_resolve_chromedriver_rejects_missing_or_non_executable_match(monkeypatch, tmp_path):
    monkeypatch.delenv("PHANTOM_RELAY_CHROMEDRIVER", raising=False)
    non_executable = (
        tmp_path / ".tools" / "chromedriver-153.0.8010.2" / "chromedriver"
    )
    non_executable.parent.mkdir(parents=True)
    non_executable.write_text("fixture", encoding="utf-8")

    with pytest.raises(RuntimeError, match="matching_chromedriver_missing"):
        probe.resolve_chromedriver("153.0.8010.2", root=tmp_path)


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("Google Chrome 153.0.8010.2 canary", "153.0.8010.2"),
        ("Google Chrome for Testing 152.0.7962.0", "152.0.7962.0"),
    ],
)
def test_parse_browser_version_requires_four_part_version(output, expected):
    assert probe.parse_browser_version(output) == expected


def test_configured_target_url_is_optional_and_provider_neutral(monkeypatch):
    monkeypatch.delenv("PHANTOM_RELAY_BIDI_TARGET_URL", raising=False)
    assert probe.configured_target_url() == ""

    monkeypatch.setenv("PHANTOM_RELAY_BIDI_TARGET_URL", "https://example.test/path")
    assert probe.configured_target_url() == "https://example.test/path"


def test_configured_target_url_rejects_non_http(monkeypatch):
    monkeypatch.setenv("PHANTOM_RELAY_BIDI_TARGET_URL", "chrome://extensions/")
    with pytest.raises(RuntimeError, match="bidi_target_url_must_be_http"):
        probe.configured_target_url()
