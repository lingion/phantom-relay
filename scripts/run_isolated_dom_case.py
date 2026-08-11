#!/usr/bin/env python3
"""Execute the recorded profile contract in an isolated Chromium DOM case.

This runner is intentionally opt-in. It serves only a repository-local
generic fixture, creates a fresh temporary Chromium user-data directory, and
injects the extension's browser-side scripts with a minimal in-page Chrome
runtime stub. It does not connect to the shared browser or any real site.
"""

from __future__ import annotations

import functools
import http.server
import json
import os
import signal
import socketserver
import subprocess
import tempfile
import time
from pathlib import Path
from threading import Thread
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(os.environ.get(
    "PHANTOM_RELAY_CHROME_BINARY",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
))
CHROMEDRIVER = Path(os.environ.get(
    "PHANTOM_RELAY_CHROMEDRIVER",
    str(ROOT / ".tools/chromedriver-152.0.7962.0/chromedriver"),
))


class IsolatedDomCaseError(RuntimeError):
    pass


DOM_NAVIGATION_TIMEOUT_SECONDS = 15


def build_driver_options(profile_dir: Path):
    """Build deterministic Selenium options for the isolated fixture browser."""
    from selenium.webdriver.chrome.options import Options

    options = Options()
    options.binary_location = str(CHROME)
    options.page_load_strategy = "eager"
    options.add_argument("--headless=new")
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--window-size=1280,900")
    return options


def _profile_process_ids(profile_dir: Path) -> list[int]:
    marker = f"--user-data-dir={profile_dir}"
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []

    pids = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or marker not in fields[1]:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if pid != os.getpid():
            pids.append(pid)
    return pids


def _terminate_profile_processes(profile_dir: Path) -> None:
    """Reap Chrome children if the test runner was interrupted mid-session."""
    for pid in _profile_process_ids(profile_dir):
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if not _profile_process_ids(profile_dir):
            return
        time.sleep(0.05)

    for pid in _profile_process_ids(profile_dir):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


DOM_CASES: dict[str, dict[str, Any]] = {
    "interactive": {
        "fixture": "interactive-chat.html",
        "message": "hello from isolated fixture",
        "expected_response": "Echo: hello from isolated fixture",
        "profile_id": "recorded-127-0-0-1-v1",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        "response_selector": "[data-role='assistant']",
        "identity_attributes": ["data-message-id"],
    },
    "contenteditable": {
        "fixture": "contenteditable-chat.html",
        "message": "hello from contenteditable fixture",
        "expected_response": "Echo: hello from contenteditable fixture",
        "profile_id": "recorded-127-0-0-1-contenteditable-v1",
        "input": {"selector": "[contenteditable='true']", "kind": "contenteditable"},
        "send": {"kind": "enter", "key": "Enter", "modifiers": []},
        "response_selector": "[data-role='assistant']",
        "identity_attributes": ["data-message-id"],
    },
    "nested": {
        "fixture": "nested-message-chat.html",
        "message": "hello from nested fixture",
        "expected_response": "Echo: hello from nested fixture",
        "profile_id": "recorded-127-0-0-1-nested-v1",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        "response_selector": "[data-message-body]",
        "container_selector": "[data-message-id]",
        "identity_attributes": ["data-message-id"],
    },
    "broad_selector": {
        "fixture": "nested-message-chat.html",
        "message": "hello from broad selector fixture",
        "expected_response": "Echo: hello from broad selector fixture",
        "profile_id": "recorded-127-0-0-1-broad-selector-v1",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        # This intentionally matches multiple nested projections. The stable
        # identity and DOM order must still select only the fresh assistant.
        "response_selector": "div > div",
        "identity_attributes": ["data-message-id"],
    },
    "virtualized": {
        "fixture": "virtualized-chat.html",
        "message": "hello from virtualized fixture",
        "expected_response": "Echo: hello from virtualized fixture",
        "profile_id": "recorded-127-0-0-1-virtualized-v1",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "button", "selector": "#send"},
        "response_selector": "article[data-message-id]",
        "container_selector": "[data-row-key]",
        "identity_attributes": ["data-row-key"],
    },
    "assistant_only_shortcut": {
        "fixture": "assistant-only-shortcut-chat.html",
        "message": "hello from assistant-only shortcut fixture",
        "expected_response": "Echo: hello from assistant-only shortcut fixture",
        "profile_id": "recorded-127-0-0-1-assistant-only-shortcut-v1",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "shortcut", "key": "Enter", "code": "Enter", "modifiers": []},
        "response_selector": ".assistant-answer",
        "container_selector": ".assistant-shell",
        "identity_attributes": ["id"],
    },
    "descendant_identity": {
        "fixture": "descendant-identity-chat.html",
        "message": "hello from descendant identity fixture",
        "expected_response": "Echo: hello from descendant identity fixture",
        "profile_id": "recorded-127-0-0-1-descendant-identity-v1",
        "input": {"selector": "#prompt", "kind": "textarea"},
        "send": {"kind": "enter", "key": "Enter", "modifiers": []},
        "response_selector": "main > div.chat-row:nth-child(2) > p",
        "container_selector": ".chat-row",
        "element_tag": "p",
        "identity_attributes": ["data-message-id"],
    },
}


def build_fixture_profile(origin: str, case_name: str = "interactive") -> dict[str, Any]:
    try:
        case = DOM_CASES[case_name]
    except KeyError as exc:
        raise IsolatedDomCaseError(f"unknown_dom_case:{case_name}") from exc
    parsed_origin = origin.rstrip("/")
    return {
        "profileId": case["profile_id"],
        "origin": parsed_origin,
        "domain": "127.0.0.1",
        "input": dict(case["input"]),
        "send": dict(case["send"]),
        "response": {
            "selector": case["response_selector"],
            **({"containerSelector": case["container_selector"]} if case.get("container_selector") else {}),
            **({"elementTag": case["element_tag"]} if case.get("element_tag") else {}),
            "identity": {"attributes": list(case["identity_attributes"])},
            "identityVerification": {
                "status": "verified",
                "method": "fixture-dom-unique",
                "attributes": list(case["identity_attributes"]),
            },
            "role": {"user": ["user"], "assistant": ["assistant"]},
            "streamingIndicators": [
                {"selector": "[data-streaming='true']", "equals": True},
                {"selector": "[aria-busy='true']", "equals": True},
            ],
            "excludedSelectors": ["[aria-hidden='true']", "[data-action='copy']"],
            "textNormalization": [{"kind": "trim"}, {"kind": "collapse-whitespace"}],
        },
        "capabilities": {"text": True, "streaming": "dom-snapshot"},
    }


def _chrome_runtime_stub(profile: dict[str, Any]) -> str:
    selectors = {
        "input": profile["input"],
        "send": profile["send"],
        "response": profile["response"]["selector"],
        "profile": profile,
    }
    encoded = json.dumps(selectors, ensure_ascii=False)
    return f"""
(() => {{
  const recordedSelectors = {encoded};
  const listeners = [];
  const storage = {{
    phantomSelectors: {{'127.0.0.1': recordedSelectors}},
    phantomBrowserClientId: 'isolated-dom-client'
  }};
  const runtime = {{
    lastError: null,
    onMessage: {{ addListener(fn) {{ listeners.push(fn); }} }},
      sendMessage(message, callback) {{
        let value = {{ ok: true }};
        if (message?.type === 'get_server_selectors') value = {{ selectors: recordedSelectors }};
        if (message?.type === 'page_ready') value = {{ ok: true, ready: {{ ready: true, input_ready: true, send_ready: true }} }};
        if (typeof callback === 'function') setTimeout(() => callback(value), 0);
      return Promise.resolve(value);
    }}
  }};
  const local = {{
    get(keys, callback) {{
      const output = {{}};
      if (Array.isArray(keys)) keys.forEach(key => output[key] = storage[key]);
      else Object.keys(storage).forEach(key => output[key] = storage[key]);
      callback(output);
      return Promise.resolve(output);
    }},
    set(value) {{ Object.assign(storage, value || {{}}); return Promise.resolve(); }}
  }};
  const chromeObject = window.chrome || {{}};
  try {{ chromeObject.runtime = runtime; chromeObject.storage = {{ local }}; }} catch (_) {{
    Object.defineProperty(chromeObject, 'runtime', {{ value: runtime, configurable: true }});
    Object.defineProperty(chromeObject, 'storage', {{ value: {{ local }}, configurable: true }});
  }}
  window.chrome = chromeObject;
  window.__phantomRelayDomTest = {{
    listeners,
    trace: [],
    dispatch(message) {{
      return new Promise(resolve => {{
        let settled = false;
        const finish = value => {{ if (!settled) {{ settled = true; resolve(value); }} }};
        for (const listener of listeners) {{
          const returned = listener(message, {{}}, finish);
          if (returned !== true && returned !== undefined) finish(returned);
        }}
        setTimeout(() => finish({{ error: 'dom_test_message_timeout' }}), 30000);
      }});
    }}
  }};
  const originalSendMessage = runtime.sendMessage;
  runtime.sendMessage = function(message, callback) {{
    if (message?.type === 'page_trace') {{
      window.__phantomRelayDomTest.trace.push({{
        type: 'page_trace',
        kind: message.entry?.kind || '',
        at: Date.now(),
      }});
    }} else if (message?.type === 'capture_progress') {{
      window.__phantomRelayDomTest.trace.push({{
        type: 'capture_progress',
        message: String(message.message || '').slice(0, 80),
        at: Date.now(),
      }});
    }}
    return originalSendMessage.call(this, message, callback);
  }};
}})();
"""


class _FixtureServer:
    def __init__(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(fixture_dir))
        self.server = socketserver.TCPServer(("127.0.0.1", 0), handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, _type, _value, _traceback):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def _inject(driver, source: str) -> None:
    driver.execute_script("(0, eval)(arguments[0]);", source)


def run_case(case_name: str = "interactive") -> dict[str, Any]:
    try:
        case = DOM_CASES[case_name]
    except KeyError as exc:
        raise IsolatedDomCaseError(f"unknown_dom_case:{case_name}") from exc
    fixture_path = ROOT / "tests" / "fixtures" / case["fixture"]
    if not fixture_path.is_file():
        raise IsolatedDomCaseError("fixture_missing")
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

    keep_profile = os.environ.get("PHANTOM_RELAY_DOM_KEEP_PROFILE") == "1"
    profile_dir = Path(tempfile.mkdtemp(prefix="phantom-relay-dom-", dir="/tmp"))
    driver = None
    service = None
    try:
        with _FixtureServer() as fixture:
            profile = build_fixture_profile(fixture.origin, case_name)
            options = build_driver_options(profile_dir)
            service = Service(str(CHROMEDRIVER))
            driver = webdriver.Chrome(service=service, options=options)
            driver.set_page_load_timeout(DOM_NAVIGATION_TIMEOUT_SECONDS)
            driver.get(f"{fixture.origin}/{case['fixture']}")

            _inject(driver, _chrome_runtime_stub(profile))
            _inject(driver, (ROOT / "extension" / "profile_contract.js").read_text(encoding="utf-8"))
            _inject(driver, (ROOT / "extension" / "profile_lifecycle.js").read_text(encoding="utf-8"))
            _inject(driver, (ROOT / "extension" / "profile_health.js").read_text(encoding="utf-8"))
            _inject(driver, (ROOT / "extension" / "capture_lock.js").read_text(encoding="utf-8"))
            _inject(driver, (ROOT / "extension" / "universal_bridge.js").read_text(encoding="utf-8"))
            _inject(driver, (ROOT / "extension" / "content.js").read_text(encoding="utf-8"))

            deadline = time.time() + 5
            while time.time() < deadline:
                if driver.execute_script("return Boolean(window.__phantomRelayDomTest?.listeners?.length)"):
                    break
                time.sleep(0.05)
            else:
                raise IsolatedDomCaseError("content_runtime_listener_missing")

            # Simulate MV3 re-injection while an older content generation owns
            # the DOM lock. The new generation must clear only the stale lock
            # before any capture begins.
            driver.execute_script("""
              document.documentElement.setAttribute('data-phantom-relay-content-instance', 'stale-test-version');
              document.documentElement.setAttribute('data-phantom-relay-capture-lock', '0');
            """)
            _inject(driver, (ROOT / "extension" / "content.js").read_text(encoding="utf-8"))
            if driver.execute_script("return document.documentElement.hasAttribute('data-phantom-relay-capture-lock')"):
                raise IsolatedDomCaseError("stale_capture_lock_not_cleared")

            profile_health = None
            health_deadline = time.time() + 5
            while time.time() < health_deadline:
                profile_health = driver.execute_async_script("""
                  const done = arguments[0];
                  window.__phantomRelayDomTest.dispatch({ action: 'get_profile_health' }).then(done);
                """)
                if profile_health.get("profile_health", {}).get("state") == "verified":
                    break
                time.sleep(0.05)
            if profile_health.get("profile_health", {}).get("state") != "verified":
                raise IsolatedDomCaseError(json.dumps({
                    "profile_health_failed": profile_health,
                }, ensure_ascii=False))

            try:
                started_at = time.monotonic()
                result = driver.execute_async_script("""
                  const message = arguments[0];
                  const done = arguments[arguments.length - 1];
                  window.__phantomRelayDomTest.dispatch({
                    action: 'auto_capture',
                    message,
                    job_id: '',
                    conversation_id: '',
                    tab_id: null,
                    claim_token: ''
                  }).then(done);
                """, case["message"])
                if isinstance(result, dict):
                    result = {**result, "elapsed_ms": round((time.monotonic() - started_at) * 1000)}
            except Exception as exc:
                diagnostics = driver.execute_script("""
                  return {
                    body: document.body.innerText,
                    inputText: document.querySelector('[contenteditable="true"]')?.textContent || '',
                    messages: Array.from(document.querySelectorAll('[data-message-id]')).map(el => ({
                      id: el.getAttribute('data-message-id'),
                      role: el.getAttribute('data-role'),
                      text: el.innerText || el.textContent || '',
                      streaming: el.getAttribute('data-streaming'),
                    })),
                    listenerCount: window.__phantomRelayDomTest?.listeners?.length || 0,
                  };
                """)
                raise IsolatedDomCaseError(json.dumps({
                    "capture_exception": f"{type(exc).__name__}:{exc}",
                    "diagnostics": diagnostics,
                }, ensure_ascii=False)) from exc
            if not isinstance(result, dict) or not result.get("success"):
                selectors = driver.execute_async_script("""
                  const done = arguments[0];
                  window.__phantomRelayDomTest.dispatch({ action: 'get_selectors' }).then(done);
                """)
                raise IsolatedDomCaseError(json.dumps({
                    "capture_failed": result,
                    "selectors": selectors,
                }, ensure_ascii=False))
            if os.environ.get("PHANTOM_RELAY_DOM_TRACE") == "1":
                result = {
                    **result,
                    "trace": driver.execute_script(
                        "return window.__phantomRelayDomTest?.trace || [];"
                    ),
                }
            return {**result, "profile_health": profile_health["profile_health"]}
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
            import shutil
            shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    print(json.dumps(run_case(), ensure_ascii=False))
