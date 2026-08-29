#!/usr/bin/env python3
"""Cold-start Chrome Canary + WebDriver BiDi extension-install probe."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options

try:
    from scripts.chromedriver_resolution import (
        parse_browser_version,
        resolve_chromedriver as _resolve_chromedriver,
    )
except ModuleNotFoundError:
    from chromedriver_resolution import (
        parse_browser_version,
        resolve_chromedriver as _resolve_chromedriver,
    )

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
PROFILE = Path(os.environ.get("PHANTOM_RELAY_BIDI_PROFILE", "/tmp/phantom-relay-bidi-probe"))
BROWSER = "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
API = os.environ.get("PHANTOM_RELAY_API", "http://127.0.0.1:8765")
PROBE_OWNERSHIP_FILE = ".phantom-relay-probe-owned"


class ProbeProfileError(RuntimeError):
    """Raised when a probe profile is not provably disposable and isolated."""


@dataclass(frozen=True)
class ProbeProfile:
    root_dir: Path
    user_data_dir: Path
    ownership_token: str


def _path_is_under(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolved_dangerous_roots() -> tuple[Path, ...]:
    home = Path.home().resolve()
    return (
        home,
        ROOT.resolve(),
        home / "Library/Application Support/Google/Chrome",
        home / "Library/Application Support/Google/Chrome Canary",
        home / "Library/Application Support/Chromium",
        home / ".config/google-chrome",
        home / ".config/chromium",
    )


def _validate_probe_target(path: Path) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        raise ProbeProfileError("probe_profile_must_be_absolute")
    candidate = candidate.resolve()
    if candidate == Path("/") or any(
        candidate == root or _path_is_under(candidate, root)
        for root in _resolved_dangerous_roots()
    ):
        raise ProbeProfileError("probe_profile_must_be_isolated")
    temp_root = Path(tempfile.gettempdir()).resolve()
    if not _path_is_under(candidate, temp_root):
        raise ProbeProfileError("probe_profile_must_be_temporary")
    if candidate.exists():
        raise ProbeProfileError("probe_profile_must_not_exist")
    return candidate


def _initialize_probe_profile(root_dir: Path) -> ProbeProfile:
    ownership_token = secrets.token_urlsafe(32)
    user_data_dir = root_dir / "user-data"
    root_dir.mkdir(parents=False, exist_ok=False)
    try:
        user_data_dir.mkdir(parents=False, exist_ok=False)
        (root_dir / PROBE_OWNERSHIP_FILE).write_text(ownership_token, encoding="utf-8")
    except Exception:
        shutil.rmtree(root_dir, ignore_errors=False)
        raise
    return ProbeProfile(root_dir, user_data_dir, ownership_token)


def prepare_probe_profile(path: Path) -> ProbeProfile:
    """Create an explicitly named disposable profile only under the temp root."""
    return _initialize_probe_profile(_validate_probe_target(path))


def create_probe_profile() -> ProbeProfile:
    """Create a unique disposable profile without accepting a user-owned path."""
    temp_root = Path(tempfile.gettempdir()).resolve()
    for _ in range(10):
        root_dir = temp_root / f"phantom-relay-bidi-probe-{secrets.token_hex(12)}"
        try:
            return prepare_probe_profile(root_dir)
        except ProbeProfileError as exc:
            if str(exc) != "probe_profile_must_not_exist":
                raise
    raise ProbeProfileError("probe_profile_name_collision")


def cleanup_probe_profile(profile: ProbeProfile) -> None:
    """Remove only a profile carrying the exact ownership token created by us."""
    root_dir = Path(profile.root_dir).resolve()
    user_data_dir = Path(profile.user_data_dir).resolve()
    if user_data_dir != root_dir / "user-data":
        raise ProbeProfileError("probe_profile_layout_invalid")
    _validate_cleanup_target(root_dir)
    marker = root_dir / PROBE_OWNERSHIP_FILE
    if not marker.is_file():
        raise ProbeProfileError("probe_profile_ownership_missing")
    if marker.read_text(encoding="utf-8") != profile.ownership_token:
        raise ProbeProfileError("probe_profile_ownership_mismatch")
    shutil.rmtree(root_dir, ignore_errors=False)


def _validate_cleanup_target(root_dir: Path) -> None:
    if root_dir == Path("/") or any(
        root_dir == root or _path_is_under(root_dir, root)
        for root in _resolved_dangerous_roots()
    ):
        raise ProbeProfileError("probe_profile_must_be_isolated")
    temp_root = Path(tempfile.gettempdir()).resolve()
    if not _path_is_under(root_dir, temp_root):
        raise ProbeProfileError("probe_profile_must_be_temporary")


def api_json(path: str):
    try:
        with urllib.request.urlopen(f"{API}{path}", timeout=2) as response:
            return json.load(response)
    except Exception:
        return None


def resolve_chromedriver(browser_version: str, root: Path = ROOT) -> Path:
    """Keep the probe API stable while using the shared exact-match resolver."""
    return _resolve_chromedriver(browser_version, root)


def configured_target_url() -> str:
    """Return an explicit HTTP(S) target; no provider is built into the probe."""
    target = os.environ.get("PHANTOM_RELAY_BIDI_TARGET_URL", "").strip()
    if not target:
        return ""
    if not target.startswith(("http://", "https://")):
        raise RuntimeError("bidi_target_url_must_be_http")
    return target


def wait_for_registration(previous_client_ids: set[str], timeout: float = 25.0):
    deadline = time.time() + timeout
    last = {"registrations": {}}
    while time.time() < deadline:
        clients = api_json("/browser/clients") or {}
        registrations = clients.get("registrations") or {}
        new_ids = [client_id for client_id in registrations if client_id not in previous_client_ids]
        if new_ids:
            client_id = new_ids[0]
            return client_id, registrations[client_id]
        last = {"registrations": registrations}
        time.sleep(0.5)
    raise RuntimeError(json.dumps({"registration_timeout": last}, ensure_ascii=False))


def wait_for_runtime(driver, previous_client_ids: set[str], timeout: float = 25.0):
    deadline = time.time() + timeout
    last = {"marker": "", "clients": None}
    while time.time() < deadline:
        marker = driver.execute_script(
            "return document.documentElement?.getAttribute('data-phantom-relay-content-instance') || ''"
        )
        clients = api_json("/browser/clients") or {}
        registrations = clients.get("registrations") or {}
        new_ids = [client_id for client_id in registrations if client_id not in previous_client_ids]
        matching = []
        for tab in (clients.get("clients") or {}).values():
            if tab.get("client_id") in new_ids:
                matching.append(tab)
        last = {"marker": marker, "clients": clients}
        if marker and matching:
            return marker, new_ids[0], matching[0]
        time.sleep(0.5)
    raise RuntimeError(json.dumps({"runtime_timeout": last}, ensure_ascii=False))


def main() -> int:
    if not EXT.is_dir() or not (EXT / "manifest.json").is_file():
        print(json.dumps({"ok": False, "stage": "preflight", "error": "extension_missing"}))
        return 2
    if not Path(BROWSER).is_file():
        print(json.dumps({"ok": False, "stage": "preflight", "error": "canary_missing"}))
        return 2

    probe_profile = (
        prepare_probe_profile(PROFILE)
        if os.environ.get("PHANTOM_RELAY_BIDI_PROFILE")
        else create_probe_profile()
    )
    options = Options()
    options.binary_location = BROWSER
    options.add_argument(f"--user-data-dir={probe_profile.user_data_dir}")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-gpu")
    options.add_argument("--new-window")
    options.enable_bidi = True
    options.enable_webextensions = True

    driver = None
    try:
        before = api_json("/browser/clients") or {}
        previous_client_ids = set((before.get("registrations") or {}).keys())
        browser_version = parse_browser_version(
            subprocess.run(
                [BROWSER, "--version"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
        chromedriver = resolve_chromedriver(browser_version)
        driver = webdriver.Chrome(service=Service(str(chromedriver)), options=options)
        installed = driver.webextension.install(path=str(EXT))
        target_url = configured_target_url()
        if target_url:
            # Branded Chrome does not retroactively inject a newly installed MV3
            # content script into an already loaded document. Navigate only
            # after installation so this probe verifies the real page path.
            driver.get(target_url)
            marker, client_id, client = wait_for_runtime(driver, previous_client_ids)
        else:
            marker = ""
            client_id, client = wait_for_registration(previous_client_ids)
        result = {
            "ok": True,
            "stage": "installed",
            "extension_install": installed,
            "title": driver.title,
            "url": driver.current_url,
            "target_url": target_url,
            "browser_version": browser_version,
            "chromedriver": str(chromedriver),
            "profile": str(probe_profile.user_data_dir),
            "content_marker": marker,
            "client_id": client_id,
            "client": client,
        }
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "stage": "install", "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        return 1
    finally:
        if driver is not None:
            driver.quit()
        cleanup_probe_profile(probe_profile)


if __name__ == "__main__":
    raise SystemExit(main())
