#!/usr/bin/env python3
"""Verify the recorded profile lifecycle across reloads in isolated Chromium.

The case uses only the repository-local generic chat fixture. Browser storage
is carried through a page refresh with ``window.name``; the temporary JSON
registry is re-read to model a backend registry restart. No real site, shared
browser profile, cookies, page text, or credentials are involved.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from scripts.run_isolated_dom_case import (
    CHROME,
    CHROMEDRIVER,
    DOM_CAPTURE_TIMEOUT_SECONDS,
    DOM_FIXTURE_RUNTIME_SCRIPTS,
    DOM_NAVIGATION_TIMEOUT_SECONDS,
    DOM_CASES,
    IsolatedDomCaseError,
    _FixtureServer,
    _run_capture_with_cdp_bridge,
    _terminate_profile_processes,
    build_driver_options,
    _inject,
    build_fixture_profile,
)

ROOT = Path(__file__).resolve().parents[1]


def _runtime_stub(profile: dict[str, Any]) -> str:
    encoded = json.dumps({
        "active": profile,
        "pending": None,
        "serverProfile": profile,
        "backendState": "verified",
    }, ensure_ascii=False, separators=(",", ":"))
    return f"""
(() => {{
  const initial = {encoded};
  let state = initial;
  try {{
    const persisted = JSON.parse(window.name || 'null');
    if (persisted && persisted.active && persisted.serverProfile) state = persisted;
  }} catch (_) {{}}
  const persist = () => {{ window.name = JSON.stringify(state); }};
  const selectorsFor = profile => ({{
    input: profile.input,
    send: profile.send,
    response: profile.response?.selector || null,
    profile
  }});
  const listeners = [];
  const runtime = {{
    lastError: null,
    onMessage: {{ addListener(fn) {{ listeners.push(fn); }} }},
    sendMessage(message, callback) {{
      let value = {{ ok: true }};
      if (message?.type === 'get_server_selectors') value = {{ selectors: selectorsFor(state.serverProfile) }};
      if (message?.type === 'page_ready') value = {{ ok: true, ready: {{ ready: true, input_ready: true, send_ready: true }} }};
      if (typeof callback === 'function') setTimeout(() => callback(value), 0);
      return Promise.resolve(value);
    }}
  }};
  const local = {{
    get(keys, callback) {{
      const output = {{}};
      for (const key of (Array.isArray(keys) ? keys : Object.keys(keys || {{}}))) {{
        if (key === 'phantomSelectors') output[key] = {{ '127.0.0.1': selectorsFor(state.serverProfile) }};
        else if (key === 'phantomProfiles') output[key] = {{ active: state.active, pending: state.pending }};
      }}
      callback(output);
      return Promise.resolve(output);
    }},
    set(value) {{
      if (value?.phantomSelectors?.['127.0.0.1']?.profile) state.serverProfile = value.phantomSelectors['127.0.0.1'].profile;
      persist();
      return Promise.resolve();
    }}
  }};
  const chromeObject = window.chrome || {{}};
  try {{ chromeObject.runtime = runtime; chromeObject.storage = {{ local }}; }} catch (_) {{
    Object.defineProperty(chromeObject, 'runtime', {{ value: runtime, configurable: true }});
    Object.defineProperty(chromeObject, 'storage', {{ value: {{ local }}, configurable: true }});
  }}
  window.chrome = chromeObject;
  window.__phantomRelayDomTest = {{
    listeners,
    capturePromise: null,
    captureResult: null,
    drainKeyboardRequests() {{ return []; }},
    resolveKeyboardRequest() {{ return false; }},
    dispatch(message) {{
      return new Promise(resolve => {{
        let settled = false;
        const finish = value => {{ if (!settled) {{ settled = true; resolve(value); }} }};
        for (const listener of listeners) {{
          const returned = listener(message, {{}}, finish);
          if (returned !== true && returned !== undefined) finish(returned);
        }}
        if (message?.action === 'auto_capture') {{
          finish({{ started: true }});
          const observeCapture = () => {{
            const promise = window.__phantomRelayDomTest.capturePromise;
            if (promise && typeof promise.then === 'function') {{
              promise.then(value => {{
                window.__phantomRelayDomTest.captureResult = value;
              }}, error => {{
                window.__phantomRelayDomTest.captureResult = {{
                  success: false,
                  error: error?.message || String(error),
                }};
              }});
              return;
            }}
            setTimeout(observeCapture, 10);
          }};
          observeCapture();
        }}
        setTimeout(() => finish({{ error: 'dom_test_message_timeout' }}), 30000);
      }});
    }},
    lifecycleState() {{ return JSON.parse(window.name || '{{}}'); }},
    stagePending(profile) {{ state.pending = profile; persist(); }},
    promotePending() {{
      if (state.pending?.response?.selector === '[data-no-such-response]') return false;
      state.active = state.pending; state.serverProfile = state.active; state.pending = null; persist(); return true;
    }},
    useServerProfile(profile) {{ state.serverProfile = profile; persist(); }}
  }};
  persist();
}})();
"""


def _write_registry(path: Path, profile: dict[str, Any], revision: int, state: str) -> None:
    path.write_text(json.dumps({
        "version": 1,
        "profiles": {
            profile["profileId"]: {
                "profile": profile,
                "lifecycle": {"revision": revision, "state": state},
            }
        },
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_registry(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _dispatch(driver, message: dict[str, Any]) -> dict[str, Any]:
    result = driver.execute_async_script("""
      const message = arguments[0];
      const done = arguments[arguments.length - 1];
      window.__phantomRelayDomTest.dispatch(message).then(done);
    """, message)
    return result if isinstance(result, dict) else {"error": "invalid_dom_result"}


def _inject_runtime(driver, profile: dict[str, Any]) -> None:
    _inject(driver, _runtime_stub(profile))
    for name in DOM_FIXTURE_RUNTIME_SCRIPTS:
        _inject(driver, (ROOT / "extension" / name).read_text(encoding="utf-8"))
    deadline = time.time() + 5
    while time.time() < deadline:
        if driver.execute_script("return Boolean(window.__phantomRelayDomTest?.listeners?.length)"):
            return
        time.sleep(0.05)
    raise IsolatedDomCaseError("content_runtime_listener_missing")


def _wait_health(driver, expected_state: str | None = None) -> dict[str, Any]:
    deadline = time.time() + 5
    last = {}
    while time.time() < deadline:
        last = _dispatch(driver, {"action": "get_profile_health"})
        state = last.get("profile_health", {}).get("state")
        if expected_state is None or state == expected_state:
            return last
        time.sleep(0.05)
    return last


def _capture(driver, message: str) -> dict[str, Any]:
    return _run_capture_with_cdp_bridge(driver, message, DOM_CAPTURE_TIMEOUT_SECONDS)


def run_profile_lifecycle_case(case_name: str = "interactive") -> dict[str, Any]:
    if case_name == "interactive-broken-response":
        case_name = "interactive"
    if case_name not in DOM_CASES:
        raise IsolatedDomCaseError(f"unknown_dom_case:{case_name}")
    if not CHROME.is_file() or not os.access(CHROME, os.X_OK):
        raise IsolatedDomCaseError("chrome_binary_missing")
    if not CHROMEDRIVER.is_file() or not os.access(CHROMEDRIVER, os.X_OK):
        raise IsolatedDomCaseError("chromedriver_missing")
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
    except Exception as exc:  # pragma: no cover - environment-dependent
        raise IsolatedDomCaseError(f"selenium_unavailable:{type(exc).__name__}") from exc

    fixture_case = DOM_CASES[case_name]
    message = fixture_case["message"] if "message" in fixture_case else "hello from isolated fixture"
    keep_profile = os.environ.get("PHANTOM_RELAY_DOM_KEEP_PROFILE") == "1"
    profile_dir = Path(tempfile.mkdtemp(prefix="phantom-relay-lifecycle-", dir="/tmp"))
    registry_dir = Path(tempfile.mkdtemp(prefix="phantom-relay-registry-", dir="/tmp"))
    driver = None
    service = None
    try:
        with _FixtureServer() as fixture:
            profile = build_fixture_profile(fixture.origin, case_name)
            registry_path = registry_dir / "profile_registry.json"
            _write_registry(registry_path, profile, 1, "verified")
            options = build_driver_options(profile_dir)
            service = Service(str(CHROMEDRIVER))
            driver = webdriver.Chrome(service=service, options=options)
            driver.set_page_load_timeout(DOM_NAVIGATION_TIMEOUT_SECONDS)
            driver.get(f"{fixture.origin}/{fixture_case['fixture']}")
            _inject_runtime(driver, profile)

            initial_health = _wait_health(driver, "verified")
            if initial_health.get("profile_health", {}).get("state") != "verified":
                raise IsolatedDomCaseError(json.dumps({"initial_health": initial_health}, ensure_ascii=False))
            first_capture = _capture(driver, message)
            if not first_capture.get("success"):
                raise IsolatedDomCaseError(json.dumps({"initial_capture": first_capture}, ensure_ascii=False))

            # Runtime reload + page refresh: window.name restores the active
            # profile and the new content runtime re-reads the same server copy.
            before_restart = _read_registry(registry_path)
            driver.refresh()
            time.sleep(0.2)
            _inject_runtime(driver, profile)
            after_restart = _read_registry(registry_path)
            if after_restart["profiles"][profile["profileId"]]["lifecycle"]["revision"] != before_restart["profiles"][profile["profileId"]]["lifecycle"]["revision"]:
                raise IsolatedDomCaseError("profile_revision_changed_on_restart")
            reloaded_health = _wait_health(driver, "verified")
            second_capture = _capture(driver, message)
            if not second_capture.get("success"):
                raise IsolatedDomCaseError(json.dumps({"reload_capture": second_capture}, ensure_ascii=False))

            # Stage a broken pending profile. Promotion is deliberately rejected
            # and active remains the last-known-good profile.
            broken = copy.deepcopy(profile)
            broken["response"]["selector"] = "[data-no-such-response]"
            driver.execute_script("window.__phantomRelayDomTest.stagePending(arguments[0])", broken)
            promoted = driver.execute_script("return window.__phantomRelayDomTest.promotePending()")
            if promoted is not False:
                raise IsolatedDomCaseError("broken_profile_promoted")
            driver.execute_script("window.__phantomRelayDomTest.useServerProfile(arguments[0])", broken)
            driver.refresh()
            time.sleep(0.2)
            _inject_runtime(driver, profile)
            started = time.monotonic()
            broken_health = _wait_health(driver, "invalid")
            elapsed_ms = round((time.monotonic() - started) * 1000)
            broken_report = broken_health.get("profile_health", {})
            if broken_report.get("state") != "invalid" or "profile_response_unavailable" not in broken_report.get("reason_codes", []):
                raise IsolatedDomCaseError(json.dumps({"broken_health": broken_health}, ensure_ascii=False))

            # Restore the active last-known-good profile and verify recovery.
            driver.execute_script("window.__phantomRelayDomTest.useServerProfile(arguments[0])", profile)
            driver.refresh()
            time.sleep(0.2)
            _inject_runtime(driver, profile)
            restored_health = _wait_health(driver, "verified")
            if restored_health.get("profile_health", {}).get("state") != "verified":
                raise IsolatedDomCaseError(json.dumps({"restored_health": restored_health}, ensure_ascii=False))

            return {
                "profile_id": profile["profileId"],
                "revision_before": 1,
                "revision_after_reload": after_restart["profiles"][profile["profileId"]]["lifecycle"]["revision"],
                "state_after_reload": reloaded_health["profile_health"]["state"],
                "capture": {"success": True, "assistant": second_capture.get("assistant", "")},
                "broken_profile_error": {
                    "code": broken_report["reason_codes"][0],
                    "recoverable": True,
                    "elapsed_ms": elapsed_ms,
                },
            }
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
        if service is not None:
            try:
                service.stop()
            except Exception:
                pass
        _terminate_profile_processes(profile_dir)
        if not keep_profile:
            shutil.rmtree(profile_dir, ignore_errors=True)
        shutil.rmtree(registry_dir, ignore_errors=True)


if __name__ == "__main__":
    print(json.dumps(run_profile_lifecycle_case(), ensure_ascii=False))
