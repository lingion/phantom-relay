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

from scripts.chromedriver_resolution import parse_browser_version, resolve_chromedriver

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(os.environ.get(
    "PHANTOM_RELAY_CHROME_BINARY",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
))


def _resolve_dom_chromedriver() -> Path:
    """Resolve the fixture driver against the selected Chromium binary."""
    try:
        output = subprocess.run(
            [str(CHROME), "--version"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        version = parse_browser_version(output)
        return resolve_chromedriver(version, ROOT)
    except (OSError, subprocess.SubprocessError, RuntimeError):
        return Path("/__phantom_relay_chromedriver_missing__")


CHROMEDRIVER = _resolve_dom_chromedriver()


class IsolatedDomCaseError(RuntimeError):
    pass


DOM_NAVIGATION_TIMEOUT_SECONDS = 15
DOM_CAPTURE_TIMEOUT_SECONDS = 135
DOM_FIXTURE_RUNTIME_SCRIPTS = (
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
        "identity_verification": {
            "method": "dom-unique-at-recording",
            "identityKind": "unique-per-message",
        },
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
    identity_verification = {
        "status": "verified",
        "method": "fixture-dom-unique",
        "attributes": list(case["identity_attributes"]),
        **(case.get("identity_verification") or {}),
    }
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
                **identity_verification,
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
  const keyboardRequests = [];
  const keyboardWaiters = new Map();
  let nextKeyboardRequestId = 0;
  const storage = {{
    phantomSelectors: {{'127.0.0.1': recordedSelectors}},
    phantomBrowserClientId: 'isolated-dom-client'
  }};
  const runtime = {{
    lastError: null,
    onMessage: {{ addListener(fn) {{ listeners.push(fn); }} }},
      sendMessage(message, callback) {{
        if (message?.type === 'dispatch_recorded_keyboard') {{
          const requestId = String(++nextKeyboardRequestId);
          keyboardRequests.push({{ requestId, message }});
          return new Promise(resolve => {{
            keyboardWaiters.set(requestId, {{ resolve, callback }});
          }});
        }}
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
    keyboardRequests,
    trace: [],
    capturePromise: null,
    captureResult: null,
    drainKeyboardRequests() {{
      return keyboardRequests.splice(0).map(request => ({{
        requestId: request.requestId,
        message: request.message,
      }}));
    }},
    resolveKeyboardRequest(requestId, value) {{
      const key = String(requestId || '');
      const waiter = keyboardWaiters.get(key);
      if (!waiter) return false;
      keyboardWaiters.delete(key);
      if (typeof waiter.callback === 'function') setTimeout(() => waiter.callback(value), 0);
      waiter.resolve(value);
      return true;
    }},
    startCapture(message) {{
      this.dispatch(message);
      const observe = () => {{
        const promise = this.capturePromise;
        if (promise && typeof promise.then === 'function') {{
          promise.then(value => {{ this.captureResult = value; }}, error => {{
            this.captureResult = {{ success: false, error: error?.message || String(error) }};
          }});
          return;
        }}
        setTimeout(observe, 10);
      }};
      observe();
      return {{ started: true }};
    }},
    dispatch(message) {{
      return new Promise(resolve => {{
        let settled = false;
        const finish = value => {{ if (!settled) {{ settled = true; resolve(value); }} }};
        for (const listener of listeners) {{
          const returned = listener(message, {{}}, finish);
          if (returned !== true && returned !== undefined) finish(returned);
        }}
        // auto_capture is intentionally a one-way runtime action. Its result
        // is exposed through capturePromise below instead of sendResponse.
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


_CDP_KEY_MODIFIERS = {
    "Alt": 1,
    "Control": 2,
    "Meta": 4,
    "Shift": 8,
}


def _cdp_key_modifiers(modifiers: Any) -> int:
    mask = 0
    for item in modifiers or []:
        mask |= _CDP_KEY_MODIFIERS.get(str(item), 0)
    return mask


def _cdp_virtual_key_code(key: str) -> int:
    values = {
        "Enter": 13,
        "Tab": 9,
        "Escape": 27,
        "Backspace": 8,
        "Delete": 46,
    }
    normalized = str(key or "")
    if normalized in values:
        return values[normalized]
    if len(normalized) == 1 and normalized.isascii() and normalized.isalnum():
        return ord(normalized.upper())
    return 0


def _cdp_key_text(key: str, modifiers: int) -> str:
    if modifiers & ~_CDP_KEY_MODIFIERS["Shift"]:
        return ""
    normalized = str(key or "")
    if normalized == "Enter":
        return "\r"
    if len(normalized) == 1 and normalized.isascii() and normalized.isalnum():
        return normalized
    return ""


def _dispatch_fixture_keyboard(driver, request: dict[str, Any]) -> dict[str, Any]:
    message = request.get("message") or {}
    key = str(message.get("key") or "Enter")
    code = str(message.get("code") or key)
    modifiers = _cdp_key_modifiers(message.get("modifiers"))
    virtual_key_code = _cdp_virtual_key_code(key)
    key_text = _cdp_key_text(key, modifiers)
    base = {
        "key": key,
        "code": code,
        "modifiers": modifiers,
        "windowsVirtualKeyCode": virtual_key_code,
        "nativeVirtualKeyCode": virtual_key_code,
    }
    driver.execute_cdp_cmd(
        "Input.dispatchKeyEvent",
        {
            **base,
            "type": "keyDown" if key_text else "rawKeyDown",
            "text": key_text,
            "unmodifiedText": key_text,
        },
    )
    driver.execute_cdp_cmd(
        "Input.dispatchKeyEvent",
        {**base, "type": "keyUp"},
    )
    return {
        "ok": True,
        "status": "dispatched",
        "method": "cdp-input",
        "trusted": True,
        "key": key,
        "code": code,
        "modifiers": modifiers,
        "textSemantic": bool(key_text),
    }


def _run_capture_with_cdp_bridge(driver, message: str, timeout_seconds: float) -> dict[str, Any]:
    driver.execute_script(
        """
        window.__phantomRelayDomTest.dispatch({
          action: 'auto_capture',
          message: arguments[0],
          job_id: '',
          conversation_id: '',
          tab_id: null,
          claim_token: '',
          capture_timeout_ms: 120000
        });
        """,
        message,
    )
    deadline = time.monotonic() + timeout_seconds
    handled: set[str] = set()
    while time.monotonic() < deadline:
        requests = driver.execute_script(
            "return window.__phantomRelayDomTest.drainKeyboardRequests();"
        ) or []
        for request in requests:
            request_id = str(request.get("requestId") or "")
            if not request_id or request_id in handled:
                continue
            handled.add(request_id)
            try:
                result = _dispatch_fixture_keyboard(driver, request)
            except Exception as error:
                result = {
                    "ok": False,
                    "status": "unknown",
                    "method": "cdp-input",
                    "trusted": False,
                    "error": "fixture_keyboard_dispatch_failed",
                    "detail": f"{type(error).__name__}:{error}",
                }
            driver.execute_script(
                "return window.__phantomRelayDomTest.resolveKeyboardRequest(arguments[0], arguments[1]);",
                request_id,
                result,
            )
        result = driver.execute_script(
            "return window.__phantomRelayDomTest.captureResult;"
        )
        if isinstance(result, dict):
            return result
        time.sleep(0.05)
    raise IsolatedDomCaseError("dom_capture_poll_timeout")


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
            # auto_capture enforces a 120 s lower bound for real model pages;
            # the WebDriver script channel must outlive that bound so a slow or
            # stalled fixture returns its structured result and trace.
            driver.set_script_timeout(DOM_CAPTURE_TIMEOUT_SECONDS)
            driver.get(f"{fixture.origin}/{case['fixture']}")

            _inject(driver, _chrome_runtime_stub(profile))
            # content.js captures helper globals at startup. Keep its
            # provider-neutral response qualifier in the fixture runtime;
            # omitting it silently activates the legacy fallback branch.
            for script_name in DOM_FIXTURE_RUNTIME_SCRIPTS:
                _inject(driver, (ROOT / "extension" / script_name).read_text(encoding="utf-8"))

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
                result = _run_capture_with_cdp_bridge(
                    driver,
                    case["message"],
                    DOM_CAPTURE_TIMEOUT_SECONDS,
                )
                if isinstance(result, dict):
                    result = {**result, "elapsed_ms": round((time.monotonic() - started_at) * 1000)}
            except Exception as exc:
                diagnostics = driver.execute_script("""
                  return {
                    body: document.body.innerText,
                      inputText: document.querySelector('[contenteditable="true"]')?.textContent || '',
                      textareaValue: document.querySelector('textarea')?.value || '',
                      inputValue: document.querySelector('input[type="text"], input:not([type])')?.value || '',
                      sendState: (() => {
                        const el = document.querySelector('#send, [data-role="send"], button');
                        return el ? { disabled: !!el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), text: el.innerText || el.textContent || '' } : null;
                      })(),
                    messages: Array.from(document.querySelectorAll('[data-message-id]')).map(el => ({
                      id: el.getAttribute('data-message-id'),
                      role: el.getAttribute('data-role'),
                      text: el.innerText || el.textContent || '',
                      streaming: el.getAttribute('data-streaming'),
                    })),
                      listenerCount: window.__phantomRelayDomTest?.listeners?.length || 0,
                      trace: window.__phantomRelayDomTest?.trace || [],
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
            identity_keys = driver.execute_script(
                """
                const attributes = arguments[0];
                const selectors = attributes.map(name => `[${CSS.escape(name)}]`).join(',');
                if (!selectors) return [];
                return Array.from(document.querySelectorAll(selectors)).map(element => {
                  for (const attribute of attributes) {
                    const value = String(element.getAttribute(attribute) || '').trim();
                    if (value) return `attribute:${attribute}=${value}`;
                  }
                  return '';
                }).filter(Boolean);
                """,
                case["identity_attributes"],
            )
            return {
                **result,
                "profile_health": profile_health["profile_health"],
                "identity_keys": identity_keys,
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
            import shutil
            shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    print(json.dumps(run_case(), ensure_ascii=False))
