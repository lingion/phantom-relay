#!/usr/bin/env python3
"""Persistent Chrome Canary host using WebDriver BiDi extension installation."""
from __future__ import annotations

import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import InvalidSessionIdException, NoSuchWindowException, WebDriverException

try:
    from scripts.chromedriver_resolution import parse_browser_version, resolve_chromedriver
except ModuleNotFoundError:
    from chromedriver_resolution import parse_browser_version, resolve_chromedriver

ROOT = Path(__file__).resolve().parents[1]
EXT = Path(os.environ.get("PHANTOM_RELAY_EXTENSION_DIR", str(ROOT / "extension"))).expanduser().resolve()
BROWSER = os.environ.get(
    "PHANTOM_RELAY_BROWSER_BINARY",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
)
PROFILE = Path(os.environ.get("PHANTOM_RELAY_BROWSER_PROFILE", "/tmp/phantom-relay-canary-profile-v1"))
API = os.environ.get("PHANTOM_RELAY_API", "http://127.0.0.1:8765")
CONFIGURED_TARGET_URL = os.environ.get("PHANTOM_RELAY_BROWSER_TARGET_URL", "").strip()

STOP = False
DRIVER_SESSION_LOST_EXIT = 75


def _truthy(value: object) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def bidi_host_activation_allowed(env: dict[str, str] | None = None) -> bool:
    """Require an explicit opt-in before this test harness can own navigation."""
    values = os.environ if env is None else env
    return _truthy(values.get("PHANTOM_RELAY_ENABLE_BIDI_HOST")) and (
        str(values.get("PHANTOM_RELAY_ACTIVATION_OWNER", "")).strip().lower() == "bidi"
    )


def bidi_navigation_allowed(env: dict[str, str] | None = None) -> bool:
    """Require a second explicit opt-in for the test host to navigate pages."""
    values = os.environ if env is None else env
    return bidi_host_activation_allowed(values) and _truthy(
        values.get("PHANTOM_RELAY_BIDI_NAVIGATION")
    )


def api_activation_owner(api_url: str | None = None) -> str:
    """Read the API's process-wide activation owner before starting Chrome.

    The harness has its own environment, so checking only
    ``PHANTOM_RELAY_ACTIVATION_OWNER`` is insufficient: an API process started
    with the default ``api`` owner can otherwise run beside a harness started
    with ``bidi`` and both will navigate/open browser pages.
    """
    endpoint = f"{str(api_url or API).rstrip('/')}/health"
    try:
        payload = json.load(urllib.request.urlopen(endpoint, timeout=2))
    except Exception:
        return ""
    return str(payload.get("browser_activation_owner") or "").strip().lower()


def bidi_owner_matches_api(api_owner: str) -> bool:
    """Require an explicit shared ``bidi`` owner across both processes."""
    return str(api_owner or "").strip().lower() == "bidi"


def api_still_grants_bidi_ownership(api_url: str | None = None) -> bool:
    """Recheck the cross-process owner so a restarted API cannot race the host."""
    return bidi_owner_matches_api(api_activation_owner(api_url))


def configured_debug_port() -> int:
    """Return an explicit port, or 0 to allocate a free local port."""
    raw = os.environ.get("PHANTOM_RELAY_BROWSER_DEBUG_PORT", "0").strip().lower()
    if raw in {"", "auto", "0"}:
        return 0
    port = int(raw)
    if not 1 <= port <= 65535:
        raise ValueError("PHANTOM_RELAY_BROWSER_DEBUG_PORT must be 1..65535 or auto")
    return port


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


def stop(_signum, _frame):
    global STOP
    STOP = True


def normalize_target_url(value: str | None) -> str:
    candidate = str(value or "").strip()
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    return candidate


def observed_current_url(driver, fallback: str = "") -> str:
    """Read the browser's current web URL instead of trusting a stale cache."""
    try:
        observed = normalize_target_url(getattr(driver, "current_url", ""))
    except Exception:
        observed = ""
    return observed or normalize_target_url(fallback)


def _web_target_candidates(driver, preferred_url: str, handles: list[str]) -> list[tuple[int, int, str, str]]:
    """Read web-target metadata without activating each browser window."""
    execute_cdp_cmd = getattr(driver, "execute_cdp_cmd", None)
    if not callable(execute_cdp_cmd):
        return []
    try:
        payload = execute_cdp_cmd("Target.getTargets", {}) or {}
    except Exception as exc:
        if driver_session_is_lost(exc):
            raise
        return []

    allowed_handles = set(handles)
    preferred = normalize_target_url(preferred_url)
    candidates = []
    for index, target in enumerate(payload.get("targetInfos") or []):
        if not isinstance(target, dict) or target.get("type") != "page":
            continue
        handle = str(target.get("targetId") or "")
        url = normalize_target_url(target.get("url"))
        if not handle or handle not in allowed_handles or not url:
            continue
        score = 0
        if preferred and url == preferred:
            score += 1000
        if preferred and same_target_domain(url, preferred):
            score += 100
        if urlparse(url).path not in {"", "/"}:
            score += 1
        candidates.append((score, -index, handle, url))
    return candidates


def rebind_to_web_window(driver, preferred_url: str = "") -> dict | None:
    """Find and select a live HTTP(S) window after the current handle disappears.

    Chrome can close or replace the window Selenium was attached to while
    leaving other tabs alive (for example during session restore or extension
    installation).  A closed window is recoverable state, not proof that the
    WebDriver session is dead.
    """
    preferred = normalize_target_url(preferred_url)
    try:
        handles = list(driver.window_handles)
    except Exception as exc:
        if driver_session_is_lost(exc):
            raise
        return None

    current_handle = None
    try:
        current_handle = driver.current_window_handle
    except Exception:
        pass

    try:
        current_url = normalize_target_url(getattr(driver, "current_url", ""))
    except Exception as exc:
        if driver_session_is_lost(exc):
            raise
        current_url = ""
    if current_handle in handles and current_url:
        return {"handle": current_handle, "url": current_url}

    candidates = _web_target_candidates(driver, preferred, handles)

    if not candidates:
        return None

    _score, _order, handle, url = max(candidates)
    try:
        driver.switch_to.window(handle)
    except Exception as exc:
        if driver_session_is_lost(exc):
            raise
        return None
    return {"handle": handle, "url": url}


def ensure_web_window(driver, preferred_url: str = "") -> dict | None:
    """Return a usable web window, creating a tab only during initial setup.

    The steady-state host must reuse an existing tab. Creating a new tab after
    a transient ``about:blank`` observation turns a page load into a tab storm
    and lets the host compete with the API wake owner.
    """
    return _ensure_web_window(driver, preferred_url, create_if_missing=True)


def _ensure_web_window(driver, preferred_url: str = "", *, create_if_missing: bool = True) -> dict | None:
    """Find a live web tab, optionally reusing the current blank tab."""
    recovered = rebind_to_web_window(driver, preferred_url)
    if recovered:
        return recovered
    try:
        handle = driver.current_window_handle
        current = {
            "handle": handle,
            "url": observed_current_url(driver),
        }
        if not create_if_missing or not normalize_target_url(preferred_url):
            return current
    except Exception as exc:
        if driver_session_is_lost(exc):
            raise
        return None
    try:
        driver.switch_to.new_window("tab")
        handle = driver.current_window_handle
        return {
            "handle": handle,
            "url": observed_current_url(driver),
        }
    except Exception as exc:
        if driver_session_is_lost(exc):
            raise
        return None


def should_navigate_to_target(current_url: str, wanted_url: str) -> bool:
    """Navigate only across origins, or from a blank tab to a real target.

    A provider page can redirect, change route, or remain unready while its
    recorded profile is being repaired. Replaying the same-origin navigation
    on every poll reloads the page and is the direct source of visible
    ``about:blank``/provider oscillation.
    """
    current = normalize_target_url(current_url)
    wanted = normalize_target_url(wanted_url)
    if not wanted:
        return False
    if not current:
        return True
    if same_target_domain(current, wanted):
        return False
    return current != wanted


def initial_navigation_needed(current_url: str, wanted_url: str) -> bool:
    """Decide whether attach must perform the one initial navigation."""
    return should_navigate_to_target(current_url, wanted_url)


def should_suppress_blank_navigation_retry(
    current_url: str,
    wanted_url: str,
    last_navigation_target: str,
) -> bool:
    """Stop retrying a target while its previous navigation is still blank.

    A failed or slow navigation is not evidence that another ``driver.get`` is
    needed. Repeating it can make the browser visibly oscillate between the
    initial blank document and the same target page. The host is test-only, so
    it fails closed and waits for an observed HTTP(S) page or a restart.
    """
    current = normalize_target_url(current_url)
    wanted = normalize_target_url(wanted_url)
    attempted = normalize_target_url(last_navigation_target)
    return not current and bool(wanted) and attempted == wanted


def select_target_url(status: dict | None, pending: dict | None, fallback: str = "", configured: str = "") -> str:
    """Select a server-owned target URL without knowing any provider names."""
    status_jobs = (status or {}).get("jobs") or {}
    if isinstance(status_jobs, dict):
        candidates = list(status_jobs.values())
    elif isinstance(status_jobs, list):
        candidates = list(status_jobs)
    else:
        candidates = []
    for status in ("claimed", "queued"):
        for job in candidates:
            if isinstance(job, dict) and job.get("status") == status:
                target = normalize_target_url(job.get("target_url"))
                if target:
                    return target

    pending_jobs = (pending or {}).get("jobs") or []
    if isinstance(pending_jobs, list):
        for job in pending_jobs:
            if isinstance(job, dict):
                target = normalize_target_url(job.get("target_url"))
                if target:
                    return target

    for candidate in (fallback, configured):
        target = normalize_target_url(candidate)
        if target:
            return target
    return ""


def target_url(default_url: str | None = None) -> str:
    status = {}
    pending = {}
    try:
        status = json.load(urllib.request.urlopen(f"{API}/browser/status", timeout=2))
        pending = json.load(urllib.request.urlopen(f"{API}/browser/pending-domains", timeout=2))
    except Exception:
        pass
    return select_target_url(status, pending, fallback=default_url or "", configured=CONFIGURED_TARGET_URL)


def wait_for_target_url(poll_interval: float = 1.0) -> str:
    """Wait for a queued server target before creating a visible browser."""
    while not STOP:
        target = target_url()
        if target:
            return target
        time.sleep(poll_interval)
    return ""


def ready_client_for_domain(status: dict | None, domain: str) -> bool:
    """Keep an already-ready same-domain page on its user-owned URL."""
    wanted = str(domain or "").strip().lower()
    if not wanted:
        return False
    clients = (status or {}).get("clients") or {}
    if not isinstance(clients, dict):
        return False
    return any(
        isinstance(client, dict)
        and str(client.get("domain") or "").strip().lower() == wanted
        and client.get("ready") is True
        and client.get("input_ready") is True
        and client.get("send_ready") is True
        for client in clients.values()
    )


def same_target_domain(left: str, right: str) -> bool:
    """Compare navigation targets by hostname, ignoring path/query state."""
    left_host = (urlparse(normalize_target_url(left)).hostname or "").lower()
    right_host = (urlparse(normalize_target_url(right)).hostname or "").lower()
    return bool(left_host and right_host and left_host == right_host)


def build_chrome_args(profile: Path, debug_port: int, initial_url: str = "") -> list[str]:
    """Build a deterministic host command that keeps automated pages observable."""
    args = [
        BROWSER,
        f"--user-data-dir={profile}",
        f"--remote-debugging-port={debug_port}",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-allow-origins=http://127.0.0.1:{debug_port}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-features=CalculateNativeWinOcclusion",
        "--disable-backgrounding-occluded-windows",
        "--enable-unsafe-extension-debugging",
        "--new-window",
    ]
    if initial_url:
        args.append(initial_url)
    return args


def attach_webdriver(debug_port: int, driver_path: Path):
    """Attach a fresh WebDriver session to the host-owned Chrome instance."""
    options = Options()
    options.debugger_address = f"127.0.0.1:{debug_port}"
    options.enable_bidi = True
    options.enable_webextensions = True
    options.set_capability("unhandledPromptBehavior", "accept")
    return webdriver.Chrome(service=Service(str(driver_path)), options=options)


def browser_process_is_reconnectable(chrome, debug_port: int) -> bool:
    """A dead driver can be rebound while the host-owned Chrome is reachable."""
    return bool(
        chrome is not None
        and chrome.poll() is None
        and port_is_open(debug_port)
    )


def driver_session_is_lost(error: BaseException) -> bool:
    """Identify errors that make the current WebDriver object unusable."""
    if isinstance(error, InvalidSessionIdException):
        return True
    if not isinstance(error, WebDriverException):
        return False
    message = str(error).lower()
    return any(marker in message for marker in (
        "invalid session id",
        "session deleted",
        "chrome not reachable",
        "disconnected: not connected to devtools",
    ))


def main() -> int:
    if not bidi_navigation_allowed():
        print(json.dumps({
            "ok": False,
            "stage": "activation_owner",
            "error": "bidi_host_disabled",
            "required": "PHANTOM_RELAY_ENABLE_BIDI_HOST=1 PHANTOM_RELAY_ACTIVATION_OWNER=bidi PHANTOM_RELAY_BIDI_NAVIGATION=1",
        }), flush=True)
        return 0
    shared_owner = api_activation_owner()
    if not bidi_owner_matches_api(shared_owner):
        print(json.dumps({
            "ok": False,
            "stage": "activation_owner",
            "error": "bidi_api_owner_conflict" if shared_owner else "bidi_api_owner_unknown",
            "api_owner": shared_owner or None,
            "required": "start the API with PHANTOM_RELAY_ACTIVATION_OWNER=bidi for harness navigation",
        }, ensure_ascii=False), flush=True)
        return 3
    if not EXT.is_dir() or not Path(BROWSER).is_file():
        print(json.dumps({"ok": False, "stage": "preflight", "extension": str(EXT), "browser": str(BROWSER)}), flush=True)
        return 2
    try:
        browser_version = parse_browser_version(
            subprocess.run(
                [BROWSER, "--version"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
        driver_path = resolve_chromedriver(browser_version, ROOT)
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        print(json.dumps({
            "ok": False,
            "stage": "preflight",
            "browser": str(BROWSER),
            "error": type(exc).__name__,
            "message": str(exc),
        }, ensure_ascii=False), flush=True)
        return 2

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    options = Options()
    options.binary_location = BROWSER
    options.add_argument(f"--user-data-dir={PROFILE}")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-crash-reporter")
    options.add_argument("--disable-infobars")
    options.add_argument("--disable-session-crashed-bubble")
    options.add_argument("--hide-crash-restore-bubble")
    options.enable_bidi = True
    options.enable_webextensions = True
    options.add_argument("--enable-unsafe-extension-debugging")

    driver = None
    chrome = None
    lock_handle = None
    requested_port = configured_debug_port()
    debug_port = requested_port or free_local_port()
    try:
        PROFILE.parent.mkdir(parents=True, exist_ok=True)
        lock_path = PROFILE.parent / f"{PROFILE.name}.host.lock"
        lock_handle = open(lock_path, "a+")
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"ok": False, "stage": "host", "error": "host_already_running", "profile": str(PROFILE)}, ensure_ascii=False), flush=True)
            return 0
        # Launch Chrome ourselves so ChromeDriver cannot inject --use-mock-keychain.
        initial_url = wait_for_target_url()
        if not initial_url:
            return 0
        if port_is_open(debug_port):
            raise RuntimeError(f"chrome_debug_port_already_in_use:{debug_port}")
        chrome_args = build_chrome_args(PROFILE, debug_port, initial_url)
        chrome = subprocess.Popen(chrome_args)
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", debug_port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("chrome_debug_port_not_ready")
        driver = attach_webdriver(debug_port, driver_path)
        try:
            alert = driver.switch_to.alert
            alert.accept()
            time.sleep(0.5)
        except Exception:
            pass
        previous_extension_id = os.environ.get(
            "PHANTOM_RELAY_EXTENSION_ID",
            "jdnglmjikhickphemoinoinihjjpbdfo",
        ).strip()
        if previous_extension_id:
            try:
                uninstall_result = driver.webextension.uninstall(previous_extension_id)
                print(json.dumps({"event": "extension_uninstalled", "result": uninstall_result}, ensure_ascii=False), flush=True)
            except Exception as exc:
                print(json.dumps({"event": "extension_uninstall_skipped", "error": str(exc)[:300]}, ensure_ascii=False), flush=True)
        installed = driver.webextension.install(path=str(EXT))
        print(json.dumps({"event": "extension_loaded", "profile": str(PROFILE), "keychain": "system", "debug_port": debug_port, "install": installed}, ensure_ascii=False), flush=True)
        # Dismiss any crash-recovery / restore-pages alert that Chrome may show
        try:
            alert = driver.switch_to.alert
            alert.accept()
        except Exception:
            pass
        url = initial_url
        initial_context = ensure_web_window(driver, url)
        if initial_context is None:
            raise RuntimeError("browser_window_unavailable")
        initial_current_url = normalize_target_url(initial_context.get("url", ""))
        if initial_navigation_needed(initial_current_url, url):
            try:
                driver.get(url)
            except Exception as exc:
                try:
                    alert = driver.switch_to.alert
                    alert.accept()
                except Exception:
                    pass
                # A target may keep network requests open indefinitely. The DOM
                # and extension can still become ready after an eager navigation.
                print(json.dumps({"event": "navigation_timeout", "url": url, "error": type(exc).__name__, "message": str(exc)[:300]}, ensure_ascii=False), flush=True)
        time.sleep(8)
        context = ensure_web_window(driver, url)
        if context is None:
            raise RuntimeError("browser_window_unavailable")
        marker = driver.execute_script("return {marker: document.documentElement?.getAttribute('data-phantom-relay-content-instance') || '', title: document.title, url: location.href}")
        print(json.dumps({"event": "target_opened", "url": observed_current_url(driver, url), "page_probe": marker}, ensure_ascii=False), flush=True)
        # Keep the control state truthful: ``observed_current_url`` may use a
        # fallback for diagnostics, but a real blank document must remain
        # blank so the navigation guard can suppress duplicate retries.
        current_url = normalize_target_url(context.get("url", ""))
        last_navigation_target = url if not current_url else ""
        last_owner_check = 0.0
        while not STOP:
            try:
                now = time.time()
                if now - last_owner_check >= 5.0:
                    last_owner_check = now
                    if not api_still_grants_bidi_ownership():
                        print(json.dumps({
                            "event": "activation_owner_lost",
                            "required": "bidi",
                            "action": "stop_host",
                        }, ensure_ascii=False), flush=True)
                        return 3
                context = _ensure_web_window(driver, current_url, create_if_missing=False)
                if context is None:
                    print(json.dumps({
                        "event": "browser_window_unavailable",
                        "preferred": current_url,
                    }, ensure_ascii=False), flush=True)
                    time.sleep(1)
                    continue
                current_url = normalize_target_url(context.get("url", ""))
                wanted = target_url(current_url)
                if should_navigate_to_target(current_url, wanted):
                    if should_suppress_blank_navigation_retry(
                        current_url,
                        wanted,
                        last_navigation_target,
                    ):
                        print(json.dumps({
                            "event": "target_navigation_suppressed_blank_retry",
                            "current": current_url or "about:blank",
                            "requested": wanted,
                            "last_navigation_target": last_navigation_target,
                            "reason": "await_observed_http_page_or_restart",
                        }, ensure_ascii=False), flush=True)
                        time.sleep(1)
                        continue
                    current_domain = urlparse(current_url).hostname or ""
                    if current_url and same_target_domain(current_url, wanted):
                        print(json.dumps({
                            "event": "target_switch_skipped_same_domain_page",
                            "current": current_url,
                            "requested": wanted,
                            "domain": current_domain,
                            "reason": "wait_for_page_readiness",
                        }, ensure_ascii=False), flush=True)
                        time.sleep(1)
                        continue
                    print(json.dumps({"event": "target_switch", "from": current_url, "to": wanted}, ensure_ascii=False), flush=True)
                    context = _ensure_web_window(driver, wanted, create_if_missing=False)
                    if context is None:
                        print(json.dumps({
                            "event": "browser_window_unavailable",
                            "preferred": wanted,
                        }, ensure_ascii=False), flush=True)
                        time.sleep(1)
                        continue
                    last_navigation_target = wanted
                    driver.get(wanted)
                    current_url = wanted
                    time.sleep(8)
                    marker = driver.execute_script("return {marker: document.documentElement?.getAttribute('data-phantom-relay-content-instance') || '', title: document.title, url: location.href}")
                    print(json.dumps({"event": "target_opened", "url": observed_current_url(driver, wanted), "page_probe": marker}, ensure_ascii=False), flush=True)
                    observed = normalize_target_url(getattr(driver, "current_url", ""))
                    if observed:
                        current_url = observed
                        last_navigation_target = ""
                    else:
                        current_url = ""
            except Exception as exc:
                if driver_session_is_lost(exc):
                    if browser_process_is_reconnectable(chrome, debug_port):
                        old_driver = driver
                        try:
                            driver = attach_webdriver(debug_port, driver_path)
                            try:
                                old_driver.quit()
                            except Exception:
                                pass
                            print(json.dumps({
                                "event": "driver_session_reconnected",
                                "debug_port": debug_port,
                                "preferred": current_url,
                            }, ensure_ascii=False), flush=True)
                            continue
                        except Exception as reconnect_error:
                            try:
                                driver.quit()
                            except Exception:
                                pass
                            print(json.dumps({
                                "event": "driver_reconnect_failed",
                                "debug_port": debug_port,
                                "error": type(reconnect_error).__name__,
                                "message": str(reconnect_error)[:300],
                            }, ensure_ascii=False), flush=True)
                    print(json.dumps({
                        "event": "driver_session_lost",
                        "url": current_url,
                        "error": type(exc).__name__,
                        "message": str(exc)[:300],
                        "restart_exit_code": DRIVER_SESSION_LOST_EXIT,
                    }, ensure_ascii=False), flush=True)
                    return DRIVER_SESSION_LOST_EXIT
                print(json.dumps({
                    "event": "host_loop_error",
                    "url": current_url,
                    "error": type(exc).__name__,
                    "message": str(exc)[:300],
                }, ensure_ascii=False), flush=True)
            time.sleep(1)
        return 0
    except Exception as exc:
        if driver_session_is_lost(exc):
            print(json.dumps({
                "ok": False,
                "stage": "driver_session_lost",
                "error": type(exc).__name__,
                "message": str(exc)[:300],
                "restart_exit_code": DRIVER_SESSION_LOST_EXIT,
            }, ensure_ascii=False), flush=True)
            return DRIVER_SESSION_LOST_EXIT
        print(json.dumps({"ok": False, "stage": "host", "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), flush=True)
        return 1
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
        if chrome is not None and chrome.poll() is None:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
        if lock_handle is not None:
            lock_handle.close()


if __name__ == "__main__":
    raise SystemExit(main())
