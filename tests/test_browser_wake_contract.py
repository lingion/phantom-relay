import importlib.util
import pathlib
import threading
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_api_module():
    spec = importlib.util.spec_from_file_location(
        "phantom_api_browser_wake_contract",
        ROOT / "server" / "api_server.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load_api_module()


def _reset_browser_state():
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_READY.clear()
    api.BROWSER_EVENTS.clear()
    api._BROWSER_WAKE_LAST = 0.0
    if hasattr(api, "_BROWSER_WAKE_PENDING"):
        api._BROWSER_WAKE_PENDING.clear()


def test_api_wake_is_blocked_when_another_activation_owner_is_selected(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)
    monkeypatch.setattr(api, "BROWSER_ACTIVATION_OWNER", "bidi")
    api.BROWSER_JOBS["job-owner-conflict"] = {"status": "queued", "domain": "wenxin.baidu.com"}

    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/",
    ) is False
    assert wake_calls == []


def test_expired_browser_inventory_and_registration_are_removed(monkeypatch):
    _reset_browser_state()
    monkeypatch.setattr(api, "_persist_browser_state_locked", lambda: None)
    expired_at = time.time() - api.CLIENT_TTL - 1
    api.BROWSER_CLIENTS["10"] = {
        "client_id": "stale-client",
        "runtime_session_id": "runtime-stale",
        "tab_id": 10,
        "domain": "wenxin.baidu.com",
        "last_seen": expired_at,
        "ready": False,
        "state": "stale",
    }
    api.BROWSER_REGISTRATIONS["stale-client"] = api.normalize_registration({
        "client_id": "stale-client",
        "runtime_session_id": "runtime-stale",
        "extension_version": "2.5.7",
        "browser": {"name": "Chrome", "version": "153"},
        "tabs": [],
    }, now=expired_at)

    api.purge_stale_browser_state()

    assert "10" not in api.BROWSER_CLIENTS
    assert "stale-client" not in api.BROWSER_REGISTRATIONS


def test_legacy_browser_registration_is_rejected_by_default():
    _reset_browser_state()
    response = api.app.test_client().post(
        "/browser/register",
        json={
            "client_id": "legacy-client",
            "extension_version": "2.5.7",
            "browser": {"name": "Chromium", "version": "unknown"},
            "tabs": [],
        },
    )

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "browser_runtime_required"


def test_direct_browser_submit_wakes_host_immediately_when_no_ready_client(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)

    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "wake-now",
            "domain": "example.test",
            "target_url": "https://example.test/chat",
        },
    )

    assert response.status_code == 202
    assert wake_calls == ["https://example.test/chat"]


def test_direct_browser_submit_rejects_known_route_without_executable_profile(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    recorded_route = api._build_model_route(
        {
            "id": "recorded-model",
            "name": "Recorded Model",
            "owned_by": "user",
            "api": "browser",
            "capabilities": {},
        },
        domain="custom.example",
        url="https://custom.example/workspace/chat",
        selectors={},
    )
    monkeypatch.setattr(api, "_routes", {recorded_route.id: recorded_route})
    monkeypatch.setattr(api, "_aliases", {})
    monkeypatch.setattr(api, "request_browser_wake", lambda **kwargs: wake_calls.append(kwargs))
    monkeypatch.setattr(api, "route_has_executable_profile", lambda route: False)

    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "must-not-queue",
            "model": "recorded-model",
            "domain": "custom.example",
        },
    )

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "profile_incomplete"
    assert wake_calls == []
    assert api.BROWSER_JOBS == {}


def test_reap_expired_queued_job_fails_instead_of_remaining_visible_to_extension(monkeypatch):
    _reset_browser_state()
    monkeypatch.setattr(api, "BROWSER_QUEUE_TIMEOUT", 5.0, raising=False)
    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        target_url="https://example.test/chat",
    )
    job["queued_at"] = time.time() - 10

    api.reap_expired_browser_jobs()

    assert api.BROWSER_JOBS[job["id"]]["status"] == "failed"
    assert api.BROWSER_JOBS[job["id"]]["state_reason"] == "browser_queue_timeout"
    assert api.BROWSER_JOBS[job["id"]]["error"] == "browser_queue_timeout"
    assert api.BROWSER_QUEUE == []


def test_pending_domains_reaps_expired_queued_job(monkeypatch):
    _reset_browser_state()
    monkeypatch.setattr(api, "BROWSER_QUEUE_TIMEOUT", 5.0, raising=False)
    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        target_url="https://example.test/chat",
    )
    job["queued_at"] = time.time() - 10

    response = api.app.test_client().get("/browser/pending-domains")

    assert response.status_code == 200
    assert response.get_json()["jobs"] == []
    assert api.BROWSER_JOBS[job["id"]]["status"] == "failed"


def test_ready_same_domain_client_does_not_start_a_second_browser(monkeypatch):
    _reset_browser_state()
    api.BROWSER_CLIENTS["tab-7"] = {
        "domain": "example.test",
        "tab_id": 7,
        "last_seen": time.time(),
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)

    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "reuse-ready",
            "domain": "example.test",
            "target_url": "https://example.test/chat",
        },
    )

    assert response.status_code == 202
    assert wake_calls == []


def test_recently_stale_ready_client_is_woken_before_its_long_lease_expires(monkeypatch):
    _reset_browser_state()
    api.BROWSER_CLIENTS["tab-8"] = {
        "domain": "example.test",
        "tab_id": 8,
        "last_seen": time.time() - 20,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)

    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "wake-stale-client",
            "domain": "example.test",
            "target_url": "https://example.test/chat",
        },
    )

    assert response.status_code == 202
    assert wake_calls == ["https://example.test/chat"]


def test_same_domain_pending_job_is_woken_only_once_until_ready(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)
    api.BROWSER_JOBS["job-1"] = {"status": "queued", "domain": "wenxin.baidu.com"}

    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/search/one",
    ) is True
    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/search/one",
    ) is False
    assert wake_calls == ["https://wenxin.baidu.com/search/one"]


def test_pending_wake_lease_survives_job_completion_until_page_registers(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)
    api.BROWSER_JOBS["job-1"] = {"status": "queued", "domain": "recorded.example"}

    assert api.request_browser_wake(
        domain="recorded.example",
        target_url="https://recorded.example/chat",
    ) is True

    api.BROWSER_JOBS["job-1"]["status"] = "failed"
    api.BROWSER_JOBS["job-2"] = {"status": "queued", "domain": "recorded.example"}

    assert api.request_browser_wake(
        domain="recorded.example",
        target_url="https://recorded.example/chat",
    ) is False
    assert wake_calls == ["https://recorded.example/chat"]


def test_pending_wake_lease_survives_without_a_live_job_until_ttl(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)
    monkeypatch.setattr(api, "_BROWSER_WAKE_LEASE_TTL", 5.0, raising=False)

    api.BROWSER_JOBS["job-1"] = {"status": "queued", "domain": "recorded.example"}
    assert api.request_browser_wake(
        domain="recorded.example",
        target_url="https://recorded.example/chat",
    ) is True

    api.BROWSER_JOBS["job-1"]["status"] = "failed"
    assert api.request_browser_wake(
        domain="recorded.example",
        target_url="https://recorded.example/chat",
    ) is False
    assert wake_calls == ["https://recorded.example/chat"]

    api._BROWSER_WAKE_PENDING["recorded.example"]["requested_at"] = time.time() - 10
    api.BROWSER_JOBS["job-2"] = {"status": "queued", "domain": "recorded.example"}
    assert api.request_browser_wake(
        domain="recorded.example",
        target_url="https://recorded.example/chat",
    ) is True
    assert wake_calls == [
        "https://recorded.example/chat",
        "https://recorded.example/chat",
    ]


def test_ready_client_releases_pending_wake_for_the_next_job(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)
    api.BROWSER_JOBS["job-1"] = {"status": "queued", "domain": "wenxin.baidu.com"}

    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/search/one",
    ) is True

    api.BROWSER_CLIENTS["tab-1"] = {
        "domain": "wenxin.baidu.com",
        "last_seen": time.time(),
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/search/one",
    ) is False

    api.BROWSER_CLIENTS.clear()
    api.BROWSER_JOBS["job-1"]["status"] = "completed"
    api.BROWSER_JOBS["job-2"] = {"status": "queued", "domain": "wenxin.baidu.com"}
    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/search/two",
    ) is True
    assert wake_calls == [
        "https://wenxin.baidu.com/search/one",
        "https://wenxin.baidu.com/search/two",
    ]


def test_live_registered_same_domain_tab_does_not_open_another_browser(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)
    api.BROWSER_CLIENTS["tab-2"] = {
        "domain": "wenxin.baidu.com",
        "last_seen": time.time(),
        "ready": False,
        "input_ready": False,
        "send_ready": False,
        "state": "registered",
        "capabilities": {"can_create_tab": True, "can_stream": True},
    }
    api.BROWSER_JOBS["job-1"] = {"status": "queued", "domain": "wenxin.baidu.com"}

    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/search/one",
    ) is False
    assert wake_calls == []


def test_wake_browser_host_uses_default_browser_with_job_target_when_no_command(monkeypatch):
    _reset_browser_state()
    calls = []
    monkeypatch.setattr(api, "BROWSER_WAKE_COMMAND", "")
    monkeypatch.setattr(api, "BROWSER_HOST_CONFIG", str(ROOT / "missing-browser-host.conf"))
    monkeypatch.setenv("PHANTOM_RELAY_BROWSER_BUNDLE_ID", "")
    monkeypatch.setattr(api.sys, "platform", "darwin")
    monkeypatch.setattr(api.subprocess, "Popen", lambda args, **kwargs: calls.append((args, kwargs)))

    assert api.wake_browser_host("https://example.test/chat") is True
    assert calls[0][0] == ["open", "-g", "https://example.test/chat"]


def test_wake_browser_host_never_creates_about_blank_without_a_target(monkeypatch):
    _reset_browser_state()
    calls = []
    monkeypatch.setattr(api, "BROWSER_WAKE_COMMAND", "")
    monkeypatch.setattr(api, "BROWSER_HOST_CONFIG", str(ROOT / "missing-browser-host.conf"))
    monkeypatch.setenv("PHANTOM_RELAY_BROWSER_BUNDLE_ID", "")
    monkeypatch.setattr(api, "webbrowser", type("Browser", (), {"open_new_tab": lambda _url: calls.append(_url) or True})())

    assert api.wake_browser_host("") is False
    assert calls == []


def test_page_trace_keeps_an_incomplete_live_page_from_triggering_another_wake(monkeypatch, tmp_path):
    _reset_browser_state()
    monkeypatch.setattr(api, "TRACE_FILE", str(tmp_path / "trace.jsonl"))
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)

    response = api.app.test_client().post(
        "/trace",
        json={
            "domain": "wenxin.baidu.com",
            "tabId": 42,
            "entry": {"kind": "recorded_selectors_loaded", "url": "https://wenxin.baidu.com/"},
        },
    )
    assert response.status_code == 200
    api.BROWSER_JOBS["job-1"] = {"status": "queued", "domain": "wenxin.baidu.com"}

    assert api.request_browser_wake(
        domain="wenxin.baidu.com",
        target_url="https://wenxin.baidu.com/search/one",
    ) is False
    assert wake_calls == []


def test_configured_bundle_wake_does_not_raise_browser_to_the_foreground(monkeypatch):
    _reset_browser_state()
    calls = []
    monkeypatch.setattr(api, "BROWSER_WAKE_COMMAND", "")
    monkeypatch.setattr(api, "BROWSER_HOST_CONFIG", str(ROOT / "browser-host.conf"))
    monkeypatch.setenv("PHANTOM_RELAY_BROWSER_BUNDLE_ID", "com.example.TestBrowser")
    monkeypatch.setattr(api.subprocess, "Popen", lambda args, **kwargs: calls.append((args, kwargs)))

    assert api.wake_browser_host("https://example.test/chat") is True
    assert calls[0][0] == ["open", "-g", "-b", "com.example.TestBrowser", "https://example.test/chat"]


def test_concurrent_wake_calls_reserve_one_activation_slot(monkeypatch):
    _reset_browser_state()
    calls = []
    entered = threading.Event()
    release = threading.Event()

    monkeypatch.setattr(api, "BROWSER_WAKE_COMMAND", "")
    monkeypatch.setattr(api, "BROWSER_HOST_CONFIG", str(ROOT / "missing-browser-host.conf"))
    monkeypatch.setenv("PHANTOM_RELAY_BROWSER_BUNDLE_ID", "")
    monkeypatch.setattr(api.sys, "platform", "darwin")

    def fake_popen(args, **kwargs):
        calls.append(args)
        entered.set()
        release.wait(timeout=1)

    monkeypatch.setattr(api.subprocess, "Popen", fake_popen)
    results = []

    def invoke():
        results.append(api.wake_browser_host("https://example.test/chat"))

    first = threading.Thread(target=invoke)
    second = threading.Thread(target=invoke)
    first.start()
    assert entered.wait(timeout=1)
    second.start()
    second.join(timeout=1)
    release.set()
    first.join(timeout=1)

    assert len(calls) == 1
    assert sorted(results) == [False, True]


def test_api_trace_events_are_individually_parseable(monkeypatch, tmp_path):
    _reset_browser_state()
    trace_path = tmp_path / "trace.jsonl"
    monkeypatch.setattr(api, "TRACE_FILE", str(trace_path))

    api.trace_api_event("first", {"value": 1})
    api.trace_api_event("second", {"value": 2})

    rows = [__import__("json").loads(line) for line in trace_path.read_text().splitlines()]
    assert [row["kind"] for row in rows] == ["first", "second"]


def test_openai_chat_request_wakes_browser_before_waiting_for_result(monkeypatch):
    _reset_browser_state()
    monkeypatch.setattr(api, "route_has_executable_profile", lambda route: True)
    recorded_route = api._build_model_route(
        {
            "id": "recorded-model",
            "name": "Recorded Model",
            "owned_by": "user",
            "api": "browser",
            "capabilities": {},
        },
        domain="recorded.example",
        url="https://recorded.example/chat/session-1",
        selectors={},
    )
    monkeypatch.setattr(api, "_routes", {recorded_route.id: recorded_route})
    monkeypatch.setattr(api, "_aliases", {})
    wake_calls = []
    monkeypatch.setattr(
        api,
        "request_browser_wake",
        lambda domain="", target_url="": wake_calls.append((domain, target_url)) or True,
    )

    real_new_browser_job = api.new_browser_job

    def completed_job(*args, **kwargs):
        job = real_new_browser_job(*args, **kwargs)
        job["status"] = "completed"
        job["result"] = {"assistant": "already-completed-fixture"}
        api.BROWSER_EVENTS[job["id"]].set()
        return job

    monkeypatch.setattr(api, "new_browser_job", completed_job)
    response = api.app.test_client().post(
        "/v1/chat/completions",
        json={
            "model": "recorded-model",
            "messages": [{"role": "user", "content": "wake-main-path"}],
        },
    )

    assert response.status_code == 200
    assert wake_calls == [("recorded.example", "https://recorded.example/chat/session-1")]
