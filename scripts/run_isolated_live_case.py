#!/usr/bin/env python3
"""Run a parameterized Phantom Relay browser case in an isolated profile.

The default mode is a read-only preflight. A real browser is launched only
when ``--run`` is supplied, and that mode requires an explicit Chromium binary
and an explicit user-data directory outside the project and known shared
browser locations. The harness never reads browser storage or credentials.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.chromedriver_resolution import parse_browser_version, resolve_chromedriver

ROOT = Path(__file__).resolve().parents[1]


class HarnessError(ValueError):
    pass


@dataclass
class HarnessConfig:
    api_url: str
    domain: str
    profile_path: Path
    profile_id: str
    model: str
    browser_profile_dir: Path
    cdp_port: int
    extension_dir: Path
    chrome_binary: Path | None
    chromedriver: Path | None
    run: bool
    skip_api_check: bool


def free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_is_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def _path_is_under(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_browser_profile_dir(value: Path) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise HarnessError("browser_profile_must_be_absolute")
    candidate = candidate.resolve()
    if candidate == Path("/") or candidate == ROOT or _path_is_under(candidate, ROOT):
        raise HarnessError("browser_profile_must_be_isolated")

    home = Path.home()
    known_shared = {
        home / "Library/Application Support/Google/Chrome",
        home / "Library/Application Support/Google/Chrome Canary",
        home / "Library/Application Support/Chromium",
        home / ".config/google-chrome",
        home / ".config/chromium",
    }
    if any(candidate == shared or _path_is_under(candidate, shared) for shared in known_shared):
        raise HarnessError("browser_profile_must_be_isolated")
    if candidate.exists() and not candidate.is_dir():
        raise HarnessError("browser_profile_dir_not_directory")
    return candidate


def _read_profile(path: Path, profile_id: str) -> dict[str, Any]:
    profile_path = Path(path).expanduser().resolve()
    if not profile_path.is_file():
        raise HarnessError("profile_file_missing")
    try:
        with profile_path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except Exception as exc:
        raise HarnessError(f"profile_json_invalid:{type(exc).__name__}") from exc
    if isinstance(value, dict) and isinstance(value.get("profiles"), dict):
        profiles = value["profiles"]
        selected_id = str(profile_id or "").strip()
        if not selected_id:
            if len(profiles) != 1:
                raise HarnessError("profile_id_required_for_registry_document")
            selected_id = next(iter(profiles))
        value = profiles.get(selected_id)
    if not isinstance(value, dict):
        raise HarnessError("profile_object_required")
    return value


def _validate_profile(profile: dict[str, Any], domain: str) -> tuple[str, str]:
    expected_domain = str(domain or "").strip().lower()
    profile_domain = str(profile.get("domain") or "").strip().lower()
    if not expected_domain or profile_domain != expected_domain:
        raise HarnessError("profile_domain_mismatch")
    if not str(profile.get("profileId") or "").strip():
        raise HarnessError("profile_id_missing")
    origin = str(profile.get("origin") or "").strip()
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme not in {"http", "https"} or parsed.hostname != expected_domain:
        raise HarnessError("profile_origin_mismatch")
    response = profile.get("response") if isinstance(profile.get("response"), dict) else {}
    identity = response.get("identity") if isinstance(response.get("identity"), dict) else {}
    identity_attributes = identity.get("attributes") if isinstance(identity.get("attributes"), list) else []
    if not profile.get("input") or not profile.get("send") or not (response.get("selector") or response.get("containerSelector")):
        raise HarnessError("profile_incomplete")
    if not identity_attributes and not str(identity.get("path") or "").strip():
        raise HarnessError("response_contract_missing")
    return profile_domain, origin


def _check_api(api_url: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(api_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HarnessError("api_url_must_be_local")
    url = api_url.rstrip("/") + "/health"
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            payload = json.load(response)
        if not isinstance(payload, dict) or payload.get("status") != "ok":
            raise HarnessError("api_health_invalid")
        return {"reachable": True, "health": payload}
    except HarnessError:
        raise
    except Exception as exc:
        raise HarnessError(f"api_health_unreachable:{type(exc).__name__}") from exc


def _resolve_runtime_chromedriver(
    chrome_binary: Path,
    configured: Path | None,
) -> tuple[Path, str]:
    """Resolve the driver only after reading the selected browser version."""
    try:
        version_output = subprocess.run(
            [str(chrome_binary), "--version"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        browser_version = parse_browser_version(version_output)
        env = {"PHANTOM_RELAY_CHROMEDRIVER": str(configured)} if configured else None
        return resolve_chromedriver(browser_version, ROOT, env=env), browser_version
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        raise HarnessError(f"chromedriver_resolution_failed:{type(exc).__name__}:{exc}") from exc


def preflight(config: HarnessConfig) -> dict[str, Any]:
    if not str(config.model or "").strip():
        raise HarnessError("model_required")
    extension_dir = Path(config.extension_dir).expanduser().resolve()
    if not (extension_dir / "manifest.json").is_file():
        raise HarnessError("extension_manifest_missing")
    browser_profile_dir = validate_browser_profile_dir(config.browser_profile_dir)
    profile = _read_profile(config.profile_path, config.profile_id)
    domain, target_url = _validate_profile(profile, config.domain)

    if config.cdp_port < 0 or config.cdp_port > 65535:
        raise HarnessError("cdp_port_invalid")
    cdp_port = config.cdp_port or free_local_port()
    if port_is_open(cdp_port):
        raise HarnessError(f"cdp_port_already_in_use:{cdp_port}")

    chrome_binary = Path(config.chrome_binary).expanduser().resolve() if config.chrome_binary else None
    chromedriver = Path(config.chromedriver).expanduser().resolve() if config.chromedriver else None
    browser_version = None
    if config.run:
        if chrome_binary is None:
            raise HarnessError("chrome_binary_required")
        if not chrome_binary.is_file() or not os.access(chrome_binary, os.X_OK):
            raise HarnessError("chrome_binary_not_executable")
        chromedriver, browser_version = _resolve_runtime_chromedriver(chrome_binary, chromedriver)

    api = {"reachable": False, "skipped": True}
    if not config.skip_api_check:
        api = _check_api(config.api_url)

    return {
        "ok": True,
        "mode": "run" if config.run else "dry-run",
        "api_url": config.api_url,
        "api": api,
        "domain": domain,
        "target_url": target_url,
        "model": str(config.model).strip(),
        "profile_id": str(profile.get("profileId") or "").strip(),
        "profile_path": str(Path(config.profile_path).expanduser().resolve()),
        "browser_profile_dir": str(browser_profile_dir),
        "cdp_port": cdp_port,
        "extension_dir": str(extension_dir),
        "chrome_binary": str(chrome_binary) if chrome_binary else None,
        "chromedriver": str(chromedriver) if chromedriver else None,
        "browser_version": browser_version,
    }


def build_browser_command(result: dict[str, Any]) -> list[str]:
    """Build the isolated browser command with explicit extension/CDP gates."""
    extension_dir = Path(result["extension_dir"])
    return [
        str(result["chrome_binary"]),
        f"--user-data-dir={result['browser_profile_dir']}",
        f"--remote-debugging-port={result['cdp_port']}",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-allow-origins=http://127.0.0.1:{result['cdp_port']}",
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=CalculateNativeWinOcclusion",
        "--disable-backgrounding-occluded-windows",
        "--new-window",
        result["target_url"],
    ]


def run_browser(config: HarnessConfig, result: dict[str, Any]) -> int:
    browser_profile_dir = Path(result["browser_profile_dir"])
    browser_profile_dir.mkdir(parents=True, exist_ok=True)
    command = build_browser_command(result)
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
    except Exception as exc:
        raise HarnessError(f"selenium_unavailable:{type(exc).__name__}") from exc

    process = subprocess.Popen(command)
    driver = None
    print(json.dumps({"event": "isolated_browser_started", "pid": process.pid, **result}, ensure_ascii=False), flush=True)

    stop = False

    def request_stop(_signum, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        deadline = time.time() + 20
        while time.time() < deadline and not port_is_open(int(result["cdp_port"])):
            if process.poll() is not None:
                raise HarnessError(f"browser_exited:{process.returncode}")
            time.sleep(0.2)
        if not port_is_open(int(result["cdp_port"])):
            raise HarnessError("browser_debug_port_not_ready")

        options = Options()
        options.debugger_address = f"127.0.0.1:{result['cdp_port']}"
        options.enable_bidi = True
        options.enable_webextensions = True
        options.set_capability("unhandledPromptBehavior", "accept")
        driver = webdriver.Chrome(service=Service(str(result["chromedriver"])), options=options)
        installed = driver.webextension.install(path=str(result["extension_dir"]))
        print(json.dumps({"event": "extension_loaded", "install": installed}, ensure_ascii=False), flush=True)
        try:
            driver.get(result["target_url"])
        except Exception as exc:
            print(json.dumps({
                "event": "navigation_error",
                "url": result["target_url"],
                "error": type(exc).__name__,
                "message": str(exc)[:300],
            }, ensure_ascii=False), flush=True)
        try:
            probe = driver.execute_script(
                "return {marker: document.documentElement?.getAttribute('data-phantom-relay-content-instance') || '', url: location.href}"
            )
            print(json.dumps({"event": "target_opened", "page_probe": probe}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"event": "target_probe_failed", "error": str(exc)[:300]}, ensure_ascii=False), flush=True)
        while not stop and process.poll() is None:
            time.sleep(0.5)
        return int(process.returncode or 0)
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def parse_args(argv: list[str] | None = None) -> HarnessConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default="http://127.0.0.1:8765")
    parser.add_argument("--domain", required=True)
    parser.add_argument("--profile", required=True, dest="profile_path", type=Path)
    parser.add_argument("--profile-id", default="")
    parser.add_argument("--model", required=True)
    parser.add_argument("--browser-profile-dir", required=True, type=Path)
    parser.add_argument("--cdp-port", default=0, type=int)
    parser.add_argument("--extension-dir", default=ROOT / "extension", type=Path)
    parser.add_argument("--chrome-binary", type=Path)
    parser.add_argument("--chromedriver", type=Path)
    parser.add_argument("--run", action="store_true", help="Launch the explicitly supplied isolated Chromium binary")
    parser.add_argument("--skip-api-check", action="store_true")
    args = parser.parse_args(argv)
    return HarnessConfig(
        api_url=args.api_url,
        domain=args.domain,
        profile_path=args.profile_path,
        profile_id=args.profile_id,
        model=args.model,
        browser_profile_dir=args.browser_profile_dir,
        cdp_port=args.cdp_port,
        extension_dir=args.extension_dir,
        chrome_binary=args.chrome_binary,
        chromedriver=args.chromedriver,
        run=args.run,
        skip_api_check=args.skip_api_check,
    )


def main(argv: list[str] | None = None) -> int:
    try:
        config = parse_args(argv)
        result = preflight(config)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if not config.run:
            return 0
        return run_browser(config, result)
    except HarnessError as exc:
        print(json.dumps({"ok": False, "stage": "preflight", "error": str(exc)}, ensure_ascii=False), flush=True)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
