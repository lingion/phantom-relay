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
    api._BROWSER_WAKE_LAST = {}
    if hasattr(api, "_BROWSER_WAKE_PENDING"):
        api._BROWSER_WAKE_PENDING.clear()


def test_wake_cooldown_is_scoped_per_domain(monkeypatch):
    _reset_browser_state()
    popen_calls = []
    monkeypatch.setattr(api, "BROWSER_WAKE_COMMAND", "")
    monkeypatch.setattr(api, "BROWSER_HOST_CONFIG", str(ROOT / "missing-browser-host.conf"))
    monkeypatch.setattr(api.sys, "platform", "darwin")
    monkeypatch.setattr(
        api.subprocess,
        "Popen",
        lambda args, **kwargs: popen_calls.append((args, kwargs)),
    )

    assert api.wake_browser_host("https://a.example/chat") is True
    assert api.wake_browser_host("https://b.example/chat") is True
    assert api.wake_browser_host("https://a.example/other") is False
    assert [call[0][-1] for call in popen_calls] == [
        "https://a.example/chat",
        "https://b.example/chat",
    ]


def test_content_ready_heartbeat_clears_its_domain_pending_wake(monkeypatch):
    _reset_browser_state()
    monkeypatch.setattr(api, "_persist_browser_state_locked", lambda: None)
    api._BROWSER_WAKE_PENDING["a.example"] = {
        "target_url": "https://a.example/chat",
        "requested_at": time.time(),
    }

    assert api.mark_browser_ready(
        {
            "domain": "a.example",
            "tab_id": 7,
            "client_id": "client-a",
            "runtime_session_id": "runtime-a",
            "ready": True,
            "input_ready": True,
            "send_ready": True,
            "content_script_version": "2026-08-13.02",
            "source": "content-ready",
            "url": "https://a.example/chat",
            "capabilities": {"can_execute": True, "can_observe": True},
        }
    ) is True

    assert "a.example" not in api._BROWSER_WAKE_PENDING


def test_unclaimed_job_watchdog_forces_one_wake_after_recent_ready_lies(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "_UNCLAIMED_WAKE_GRACE", 0.01, raising=False)
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )

    ready_checks = iter((True, False))
    monkeypatch.setattr(
        api,
        "browser_extension_recently_ready",
        lambda _domain="": next(ready_checks, False),
    )

    api.schedule_unclaimed_job_wake(job["id"])
    time.sleep(0.05)

    assert wake_calls == ["https://a.example/chat"]
    assert api.BROWSER_JOBS[job["id"]]["unclaimed_wake_attempted"] is True


def test_unclaimed_job_watchdog_does_not_wake_after_claim(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "_UNCLAIMED_WAKE_GRACE", 0.01, raising=False)
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )
    job["status"] = "claimed"

    api.schedule_unclaimed_job_wake(job["id"])
    time.sleep(0.05)

    assert wake_calls == []


def test_unclaimed_job_watchdog_does_not_reopen_while_ready_heartbeats_continue(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "_UNCLAIMED_WAKE_GRACE", 0.01, raising=False)
    monkeypatch.setattr(api, "_UNCLAIMED_WAKE_MAX_WAIT", 0.04, raising=False)
    monkeypatch.setattr(api, "browser_extension_recently_ready", lambda _domain="": True)
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )

    api.schedule_unclaimed_job_wake(job["id"])
    time.sleep(0.08)

    assert wake_calls == []
    assert not api.BROWSER_JOBS[job["id"]].get("unclaimed_wake_attempted")


def test_activation_watchdog_is_scheduled_only_when_recent_ready_suppressed_initial_wake(monkeypatch):
    _reset_browser_state()
    scheduled = []
    monkeypatch.setattr(api, "request_browser_wake", lambda **_kwargs: False)
    monkeypatch.setattr(api, "browser_extension_recently_ready", lambda _domain="": True)
    monkeypatch.setattr(api, "schedule_unclaimed_job_wake", lambda job_id: scheduled.append(job_id) or True)
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )

    api.activate_browser_for_job(job)

    assert scheduled == [job["id"]]


def test_activation_does_not_schedule_watchdog_after_initial_wake(monkeypatch):
    _reset_browser_state()
    scheduled = []
    monkeypatch.setattr(api, "request_browser_wake", lambda **_kwargs: True)
    monkeypatch.setattr(api, "browser_extension_recently_ready", lambda _domain="": False)
    monkeypatch.setattr(api, "schedule_unclaimed_job_wake", lambda job_id: scheduled.append(job_id) or True)
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )

    api.activate_browser_for_job(job)

    assert scheduled == []


def test_initial_wake_schedules_one_stalled_page_recovery(monkeypatch):
    _reset_browser_state()
    scheduled = []
    monkeypatch.setattr(api, "request_browser_wake", lambda **_kwargs: True)
    monkeypatch.setattr(api, "browser_extension_recently_ready", lambda _domain="": False)
    monkeypatch.setattr(
        api,
        "schedule_stalled_browser_wake",
        lambda job_id: scheduled.append(job_id) or True,
        raising=False,
    )
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )

    api.activate_browser_for_job(job)

    assert scheduled == [job["id"]]


def test_stalled_page_recovery_reopens_once_after_initial_lease(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "_BROWSER_WAKE_LEASE_TTL", 0.01, raising=False)
    monkeypatch.setattr(api, "_BROWSER_WAKE_COOLDOWN", 0.01, raising=False)
    monkeypatch.setattr(api, "_UNCLAIMED_WAKE_GRACE", 0.005, raising=False)
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )

    api.schedule_stalled_browser_wake(job["id"])
    time.sleep(0.06)

    assert wake_calls == ["https://a.example/chat"]
    assert api.BROWSER_JOBS[job["id"]]["stalled_wake_attempted"] is True


def test_stalled_page_recovery_stops_after_job_claim(monkeypatch):
    _reset_browser_state()
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "_BROWSER_WAKE_LEASE_TTL", 0.02, raising=False)
    monkeypatch.setattr(api, "_UNCLAIMED_WAKE_GRACE", 0.005, raising=False)
    job = api.new_browser_job(
        "hello",
        domain="a.example",
        model="a",
        target_url="https://a.example/chat",
    )
    job["status"] = "claimed"

    api.schedule_stalled_browser_wake(job["id"])
    time.sleep(0.06)

    assert wake_calls == []
    assert not api.BROWSER_JOBS[job["id"]].get("stalled_wake_attempted")


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


def test_default_queue_timeout_allows_slow_browser_start_within_request_deadline():
    _reset_browser_state()
    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        target_url="https://example.test/chat",
        request_meta={"capture_timeout_ms": 300_000},
    )
    job["queued_at"] = time.time() - 65

    api.reap_expired_browser_jobs()

    assert api.BROWSER_JOBS[job["id"]]["status"] == "queued"
    assert job["id"] in api.BROWSER_QUEUE


def test_browser_job_persists_request_deadline_from_capture_timeout():
    _reset_browser_state()
    before = time.time()

    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        request_meta={"capture_timeout_ms": 12_000},
    )

    assert before + 12 <= job["request_deadline_at"] <= time.time() + 12


def test_claim_and_heartbeat_lease_cannot_outlive_request_deadline(monkeypatch):
    _reset_browser_state()
    monkeypatch.setattr(api, "_persist_browser_state_locked", lambda: None)
    api.BROWSER_CLIENTS["7"] = {
        "domain": "example.test",
        "tab_id": 7,
        "client_id": "client-7",
        "last_seen": time.time(),
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "source": "content-ready",
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        request_meta={"capture_timeout_ms": 30_000},
    )
    deadline = job["request_deadline_at"]

    claimed = api.claim_browser_job(
        "example.test", 7, job["conversation_id"], "client-7"
    )
    assert claimed is not None
    assert claimed["lease_expires_at"] <= deadline

    assert api.renew_browser_claim({
        "job_id": job["id"],
        "claim_token": claimed["claim_token"],
        "tab_id": 7,
        "client_id": "client-7",
        "conversation_id": job["conversation_id"],
        "domain": "example.test",
    }) is True
    assert api.BROWSER_JOBS[job["id"]]["lease_expires_at"] <= deadline


def test_request_deadline_reaps_claim_even_when_heartbeat_lease_is_still_live(monkeypatch):
    _reset_browser_state()
    monkeypatch.setattr(api, "_persist_browser_state_locked", lambda: None)
    idem, owner, conflict = api.claim_idempotency("deadline-request", "fingerprint")
    assert owner is True and conflict is False
    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        request_meta={
            "idempotency_key": "deadline-request",
            "capture_timeout_ms": 30_000,
        },
    )
    api.bind_idempotency_job("deadline-request", job["id"])
    job.update(
        status="claimed",
        state_reason="claimed",
        tab_id=7,
        client_id="client-7",
        request_deadline_at=time.time() - 1,
        lease_expires_at=time.time() + 300,
    )
    waiter = api.BROWSER_EVENTS[job["id"]]

    api.reap_expired_browser_jobs()

    terminal = api.BROWSER_JOBS[job["id"]]
    assert terminal["status"] == "failed"
    assert terminal["state_reason"] == "browser_timeout"
    assert terminal["error"] == "browser_timeout"
    assert terminal["lease_expires_at"] is None
    assert job["id"] not in api.BROWSER_QUEUE
    assert waiter.is_set()
    assert idem["status"] == "failed"
    assert idem["event"].is_set()


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
        "state": "ready",
        "source": "content-ready",
        "url": "https://example.test/chat",
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
        "state": "ready",
        "source": "content-ready",
        "url": "https://example.test/chat",
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


def test_bound_ready_client_is_reused_within_recent_heartbeat_window(monkeypatch):
    _reset_browser_state()
    api.BROWSER_CLIENTS["9"] = {
        "client_id": "client-9",
        "domain": "example.test",
        "tab_id": 9,
        "last_seen": time.time() - api._BROWSER_WAKE_RECENT_WINDOW / 2,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "state": "ready",
        "source": "content-ready",
        "url": "https://example.test/chat",
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    api.BROWSER_BINDINGS[("default_model_example.test", "example.test")] = {
        "conversation_id": "default_model_example.test",
        "domain": "example.test",
        "tab_id": 9,
        "profile": "chrome-extension",
        "last_seen": time.time() - 20,
    }
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)

    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "reuse-bound-ready",
            "model": "model",
            "domain": "example.test",
            "target_url": "https://example.test/chat",
        },
    )

    assert response.status_code == 202
    assert wake_calls == []


def test_bound_ready_client_is_woken_after_recent_heartbeat_expires(monkeypatch):
    _reset_browser_state()
    stale_ready_at = time.time() - api._BROWSER_WAKE_RECENT_WINDOW - 1
    api.BROWSER_CLIENTS["9"] = {
        "client_id": "client-9",
        "domain": "example.test",
        "tab_id": 9,
        "last_seen": stale_ready_at,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "state": "ready",
        "source": "content-ready",
        "url": "https://example.test/chat",
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    api.BROWSER_BINDINGS[("default_model_example.test", "example.test")] = {
        "conversation_id": "default_model_example.test",
        "domain": "example.test",
        "tab_id": 9,
        "profile": "chrome-extension",
        "last_seen": stale_ready_at,
    }
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)

    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "wake-after-stale-bound-ready",
            "model": "model",
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
        "tab_id": 1,
        "last_seen": time.time(),
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "state": "ready",
        "source": "content-ready",
        "url": "https://wenxin.baidu.com/search/one",
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


def test_registered_same_domain_tab_cannot_suppress_request_path_wake(monkeypatch):
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
    ) is True
    assert wake_calls == ["https://wenxin.baidu.com/search/one"]


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


def test_page_trace_presence_cannot_suppress_request_path_wake(monkeypatch, tmp_path):
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
    ) is True
    assert wake_calls == ["https://wenxin.baidu.com/search/one"]


def test_page_trace_does_not_refresh_a_stale_content_ready_execution_lease(monkeypatch, tmp_path):
    _reset_browser_state()
    monkeypatch.setattr(api, "TRACE_FILE", str(tmp_path / "trace.jsonl"))
    stale_last_seen = time.time() - 20
    api.BROWSER_CLIENTS["42"] = {
        "domain": "wenxin.baidu.com",
        "tab_id": 42,
        "last_seen": stale_last_seen,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "state": "ready",
        "source": "content-ready",
        "url": "https://wenxin.baidu.com/search/one",
        "capabilities": {"can_execute": True, "can_observe": True},
    }

    response = api.app.test_client().post(
        "/trace",
        json={
            "domain": "wenxin.baidu.com",
            "tabId": 42,
            "entry": {"kind": "response_monitor", "url": "https://wenxin.baidu.com/search/one"},
        },
    )

    assert response.status_code == 200
    assert api.BROWSER_CLIENTS["42"]["last_seen"] == stale_last_seen
    assert api.BROWSER_CLIENTS["42"]["page_last_seen"] >= stale_last_seen
    assert api.browser_extension_recently_ready("wenxin.baidu.com") is False


def test_ready_skip_uses_the_exact_target_url_hostname(monkeypatch):
    _reset_browser_state()
    api.BROWSER_CLIENTS["7"] = {
        "domain": "wrong.example",
        "tab_id": 7,
        "last_seen": time.time(),
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "state": "ready",
        "source": "content-ready",
        "url": "https://wrong.example/chat",
        "capabilities": {"can_execute": True, "can_observe": True},
    }
    wake_calls = []
    monkeypatch.setattr(api, "wake_browser_host", lambda target_url="": wake_calls.append(target_url) or True)
    monkeypatch.setattr(api, "AUTO_WAKE_BROWSER", True)

    assert api.request_browser_wake(
        domain="wrong.example",
        target_url="https://target.example/chat",
    ) is True
    assert wake_calls == ["https://target.example/chat"]


def test_only_complete_content_ready_records_can_suppress_wake():
    _reset_browser_state()
    base = {
        "domain": "example.test",
        "tab_id": 7,
        "last_seen": time.time(),
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "state": "ready",
        "source": "content-ready",
        "url": "https://example.test/chat",
        "capabilities": {"can_execute": True, "can_observe": True},
    }

    invalid_records = (
        dict(base, source="browser-register"),
        dict(base, state="registered"),
        dict(base, tab_id=None),
        dict(base, url="https://other.example/chat"),
        dict(base, last_seen="not-a-timestamp"),
        dict(base, last_seen=time.time() + 60),
        dict(base, capabilities="not-an-object"),
        dict(base, capabilities={"can_execute": True, "can_observe": False}),
    )
    for record in invalid_records:
        api.BROWSER_CLIENTS.clear()
        api.BROWSER_CLIENTS["7"] = record
        assert api.browser_extension_recently_ready("example.test") is False

    api.BROWSER_CLIENTS["7"] = base
    assert api.browser_extension_recently_ready("example.test") is True


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
    monkeypatch.setattr(api, "TRACE_FILE", str(tmp_path / "trace.jsonl"))

    api.trace_api_event("first", {"value": 1})
    api.trace_api_event("second", {"value": 2})

    # tail() decodes every stored event independently; a missing or
    # interleaved event would break the expected sequence.
    entries = api.trace_store().tail(limit=10)
    assert [entry["kind"] for entry in entries] == ["first", "second"]
    assert [entry["value"] for entry in entries] == [1, 2]
    assert (tmp_path / "trace.sqlite3").exists()


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
