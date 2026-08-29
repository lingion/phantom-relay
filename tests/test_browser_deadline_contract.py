import importlib.util
import pathlib
import threading
import time

import pytest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_api_module():
    spec = importlib.util.spec_from_file_location(
        "phantom_api_browser_deadline_contract",
        ROOT / "server" / "api_server.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load_api_module()


@pytest.fixture(autouse=True)
def _reset_browser_state(monkeypatch):
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_EVENTS.clear()
    api.BROWSER_DELTAS.clear()
    api.IDEMPOTENCY.clear()
    monkeypatch.setattr(api, "_persist_browser_state_locked", lambda: None)
    monkeypatch.setattr(api, "trace_api_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(api, "activate_browser_for_job", lambda _job: None)


def _expired_claimed_job(request_key):
    record, owner, conflict = api.claim_idempotency(request_key, "fingerprint")
    assert owner is True and conflict is False
    job = api.new_browser_job(
        "deadline prompt",
        domain="fixture.example",
        model="fixture-model",
        conversation_id="deadline-conversation",
        request_meta={
            "idempotency_key": request_key,
            "capture_timeout_ms": 30_000,
        },
    )
    api.bind_idempotency_job(request_key, job["id"])
    job.update(
        status="claimed",
        state_reason="claimed",
        tab_id=17,
        client_id="client-17",
        request_deadline_at=time.time() - 1,
        lease_expires_at=time.time() + 300,
    )
    payload = {
        "job_id": job["id"],
        "claim_token": job["claim_token"],
        "client_id": "client-17",
        "conversation_id": job["conversation_id"],
        "tab_id": 17,
        "domain": "fixture.example",
    }
    return job, record, payload


def test_late_delta_is_rejected_without_publishing_stream_content():
    job, record, payload = _expired_claimed_job("late-delta")

    response = api.app.test_client().post(
        "/browser/delta",
        json={**payload, "text": "late stream content", "streaming": True},
    )

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "request_deadline_expired"
    terminal = api.BROWSER_JOBS[job["id"]]
    assert terminal["status"] == "failed"
    assert terminal["state_reason"] == "browser_timeout"
    assert terminal["result"] is None
    assert api.BROWSER_DELTAS[job["id"]] == []
    assert record["status"] == "failed"
    assert record["event"].is_set()


def test_late_result_cannot_complete_job_or_idempotency_record(monkeypatch):
    job, record, payload = _expired_claimed_job("late-result")
    saved = []
    monkeypatch.setattr(api, "save_conversation", lambda *args, **kwargs: saved.append((args, kwargs)))

    response = api.app.test_client().post(
        "/browser/result",
        json={**payload, "success": True, "assistant": "late answer", "key": "late-node"},
    )

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "request_deadline_expired"
    terminal = api.BROWSER_JOBS[job["id"]]
    assert terminal["status"] == "failed"
    assert terminal["state_reason"] == "browser_timeout"
    assert terminal["result"] is None
    assert record["status"] == "failed"
    assert record.get("response") is None
    assert saved == []


def test_expired_empty_delta_is_terminalized_before_empty_payload_is_ignored():
    job, record, payload = _expired_claimed_job("late-empty-delta")

    response = api.app.test_client().post(
        "/browser/delta",
        json={**payload, "text": "", "streaming": True},
    )

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "request_deadline_expired"
    terminal = api.BROWSER_JOBS[job["id"]]
    assert terminal["status"] == "failed"
    assert terminal["state_reason"] == "browser_timeout"
    assert api.BROWSER_DELTAS[job["id"]] == []
    assert record["status"] == "failed"
    assert record["event"].is_set()


def test_expired_result_is_terminalized_before_tool_call_validation():
    job, record, payload = _expired_claimed_job("late-invalid-tool")

    response = api.app.test_client().post(
        "/browser/result",
        json={
            **payload,
            "success": True,
            "assistant": "late answer",
            "tool_call": {"tool": "not-allowed", "parameters": {}},
        },
    )

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "request_deadline_expired"
    terminal = api.BROWSER_JOBS[job["id"]]
    assert terminal["status"] == "failed"
    assert terminal["result"] is None
    assert record["status"] == "failed"
    assert record["event"].is_set()


def test_concurrent_identical_results_apply_success_side_effects_once(monkeypatch):
    job, _record, payload = _expired_claimed_job("concurrent-result")
    job["request_deadline_at"] = time.time() + 30
    validation_barrier = threading.Barrier(2)
    saved = []
    original_validate = api.validate_tool_call_for_job

    def synchronized_validate(actor_job, tool_call):
        validation_barrier.wait(timeout=2)
        return original_validate(actor_job, tool_call)

    monkeypatch.setattr(api, "validate_tool_call_for_job", synchronized_validate)
    monkeypatch.setattr(api, "save_conversation", lambda *args, **kwargs: saved.append((args, kwargs)))
    responses = []

    def submit_result():
        response = api.app.test_client().post(
            "/browser/result",
            json={**payload, "success": True, "assistant": "one answer", "key": "one-key"},
        )
        responses.append((response.status_code, response.get_json()))

    threads = [threading.Thread(target=submit_result) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)

    assert all(not thread.is_alive() for thread in threads)
    assert sorted(status for status, _payload in responses) == [200, 200]
    assert sum(bool(body.get("idempotent")) for _status, body in responses) == 1
    deadline = time.time() + 1
    while time.time() < deadline and len(saved) < 1:
        time.sleep(0.01)
    assert len(saved) == 1
    assert api.BROWSER_JOBS[job["id"]]["status"] == "completed"


@pytest.mark.parametrize(
    "request_meta",
    [
        pytest.param([], id="non-object-request-meta"),
        pytest.param({"capture_timeout_ms": "nan"}, id="nan-string"),
        pytest.param({"capture_timeout_ms": "Infinity"}, id="infinity-string"),
        pytest.param({"capture_timeout_ms": 0}, id="zero"),
        pytest.param({"capture_timeout_ms": -1}, id="negative"),
        pytest.param({"capture_timeout_ms": 900_001}, id="above-maximum"),
    ],
)
def test_browser_submit_rejects_invalid_capture_timeout_without_creating_job(request_meta):
    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "must not enqueue",
            "domain": "fixture.example",
            "target_url": "https://fixture.example/chat",
            "request_meta": request_meta,
        },
    )

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "capture_timeout_invalid"
    assert api.BROWSER_JOBS == {}
    assert api.BROWSER_QUEUE == []


def test_browser_submit_allows_omitted_capture_timeout():
    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "ordinary direct submission",
            "domain": "fixture.example",
            "target_url": "https://fixture.example/chat",
        },
    )

    assert response.status_code == 202
    job = response.get_json()
    assert job["request_deadline_at"] is None
    assert api.BROWSER_QUEUE == [job["id"]]


def test_browser_submit_rejects_an_oversized_integer_timeout_without_500():
    response = api.app.test_client().post(
        "/browser/submit",
        json={
            "message": "must not enqueue",
            "domain": "fixture.example",
            "target_url": "https://fixture.example/chat",
            "request_meta": {"capture_timeout_ms": 10 ** 400},
        },
    )

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "capture_timeout_invalid"
    assert api.BROWSER_JOBS == {}
    assert api.BROWSER_QUEUE == []


def test_finite_deadline_is_reaped_without_follow_up_request(monkeypatch):
    monkeypatch.setattr(api, "_BROWSER_REAPER_INTERVAL", 0.01, raising=False)
    api.start_browser_job_reaper()
    try:
        job = api.new_browser_job(
            "background expiry",
            domain="fixture.example",
            model="fixture-model",
            request_meta={"capture_timeout_ms": 1},
        )
        deadline = time.time() + 1.0
        while time.time() < deadline and api.BROWSER_JOBS[job["id"]]["status"] != "failed":
            time.sleep(0.01)
        assert api.BROWSER_JOBS[job["id"]]["status"] == "failed"
        assert api.BROWSER_JOBS[job["id"]]["state_reason"] == "browser_timeout"
        assert job["id"] not in api.BROWSER_QUEUE
    finally:
        api.stop_browser_job_reaper()
