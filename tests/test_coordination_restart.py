import importlib
import threading
import time

from server.job_store import DurableJobStore


def _api():
    return importlib.import_module("server.api_server")


def _clear(api):
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()
    api.BROWSER_DELTAS.clear()
    api.BROWSER_BINDINGS.clear()
    api.BROWSER_CLIENTS.clear()
    api.IDEMPOTENCY.clear()


def test_restore_unbinds_old_tab_but_preserves_conversation_binding(tmp_path, monkeypatch):
    api = _api()
    store = DurableJobStore(tmp_path / "coordination.sqlite3")
    monkeypatch.setattr(api, "JOB_STORE", store)
    _clear(api)

    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        conversation_id="conversation-1",
        request_meta={"idempotency_key": "request-1"},
    )
    api.BROWSER_BINDINGS[("conversation-1", "example.test")] = {
        "conversation_id": "conversation-1",
        "domain": "example.test",
        "tab_id": 17,
        "profile": "chrome-extension",
        "last_seen": time.time(),
    }
    api.IDEMPOTENCY["request-1"] = {
        "key": "request-1",
        "fingerprint": "fingerprint-1",
        "status": "processing",
        "job_id": job["id"],
        "event": threading.Event(),
        "response": None,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    with api.BROWSER_LOCK:
        api._persist_browser_state_locked()

    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()
    api.BROWSER_BINDINGS.clear()
    api.IDEMPOTENCY.clear()
    api.restore_browser_state()

    binding = api.BROWSER_BINDINGS[("conversation-1", "example.test")]
    assert binding["tab_id"] is None
    assert binding["conversation_id"] == "conversation-1"
    assert binding["last_seen"] > 0
    restored_idempotency = api.IDEMPOTENCY["request-1"]
    assert restored_idempotency["status"] == "failed"
    assert restored_idempotency["job_id"] == job["id"]
    assert isinstance(restored_idempotency["event"], threading.Event)
    assert restored_idempotency["event"].is_set()


def test_restore_replays_completed_idempotency_and_discards_orphan_processing(tmp_path, monkeypatch):
    api = _api()
    store = DurableJobStore(tmp_path / "coordination.sqlite3")
    monkeypatch.setattr(api, "JOB_STORE", store)
    _clear(api)
    response = {"id": "chatcmpl-recovered", "choices": [{"message": {"content": "ok"}}]}
    store.save_snapshot(
        {},
        [],
        idempotency={
            "completed": {
                "key": "completed",
                "fingerprint": "fp-completed",
                "status": "completed",
                "job_id": None,
                "response": response,
                "created_at": time.time(),
                "updated_at": time.time(),
            },
            "orphan": {
                "key": "orphan",
                "fingerprint": "fp-orphan",
                "status": "processing",
                "job_id": "missing-job",
                "created_at": time.time(),
                "updated_at": time.time(),
            },
        },
    )

    api.restore_browser_state()

    replay, owner, conflict = api.claim_idempotency("completed", "fp-completed")
    assert owner is False and conflict is False
    assert api.idempotency_response(replay) == response
    assert replay["event"].is_set()
    assert "orphan" not in api.IDEMPOTENCY


def test_restore_marks_terminal_job_with_missing_idempotency_response_as_incomplete(tmp_path, monkeypatch):
    api = _api()
    store = DurableJobStore(tmp_path / "coordination.sqlite3")
    monkeypatch.setattr(api, "JOB_STORE", store)
    _clear(api)
    job = {
        "id": "completed-job",
        "conversation_id": "conversation-1",
        "message": "hello",
        "messages": [{"role": "user", "content": "hello"}],
        "domain": "example.test",
        "model": "fixture-model",
        "request_meta": {"idempotency_key": "incomplete"},
        "status": "completed",
        "result": {"assistant": "answer"},
    }
    store.save_snapshot(
        {job["id"]: job},
        [],
        idempotency={
            "incomplete": {
                "key": "incomplete",
                "fingerprint": "fp-incomplete",
                "status": "processing",
                "job_id": job["id"],
                "created_at": time.time(),
                "updated_at": time.time(),
            },
        },
    )

    api.restore_browser_state()

    record = api.IDEMPOTENCY["incomplete"]
    assert record["status"] == "failed"
    assert record["error"]["error"]["code"] == "server_restart_incomplete"
    assert record["event"].is_set()


def test_restarted_queued_job_cannot_be_claimed_by_a_new_tab(tmp_path, monkeypatch):
    api = _api()
    store = DurableJobStore(tmp_path / "coordination.sqlite3")
    monkeypatch.setattr(api, "JOB_STORE", store)
    _clear(api)
    job = api.new_browser_job(
        "hello", domain="example.test", model="fixture-model",
        conversation_id="conversation-1",
    )
    store.save_snapshot(
        api.BROWSER_JOBS,
        api.BROWSER_QUEUE,
        bindings={
            ("conversation-1", "example.test"): {
                "conversation_id": "conversation-1",
                "domain": "example.test",
                "tab_id": 17,
                "last_seen": time.time(),
            },
        },
    )
    api.restore_browser_state()
    api.BROWSER_CLIENTS["18"] = {
        "tab_id": 18,
        "domain": "example.test",
        "client_id": "client-18",
        "last_seen": time.time(),
        "ready": True,
        "source": "content-ready",
        "capabilities": {"can_observe": True, "can_execute": True},
    }

    claimed = api.claim_browser_job(
        "example.test", 18, "conversation-1", "client-18"
    )

    assert claimed is None
    assert api.BROWSER_JOBS[job["id"]]["status"] == "failed"
