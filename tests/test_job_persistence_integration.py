import importlib
import time

from server.job_store import DurableJobStore


def _api():
    return importlib.import_module("server.api_server")


def _reset(api):
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()
    api.BROWSER_DELTAS.clear()
    api.BROWSER_BINDINGS.clear()
    api.BROWSER_CLIENTS.clear()


def _client(api, tab_id=17, domain="example.test"):
    api.BROWSER_CLIENTS[str(tab_id)] = {
        "tab_id": tab_id,
        "domain": domain,
        "client_id": "client-1",
        "last_seen": time.time(),
        "ready": True,
        "source": "content-ready",
        "capabilities": {"can_observe": True, "can_execute": True},
    }


def test_job_lifecycle_writes_durable_queue_claim_delta_and_result(tmp_path, monkeypatch):
    api = _api()
    store = DurableJobStore(tmp_path / "jobs.sqlite3")
    monkeypatch.setattr(api, "JOB_STORE", store)
    _reset(api)

    job = api.new_browser_job(
        "hello",
        domain="example.test",
        model="fixture-model",
        conversation_id="conversation-1",
    )
    assert store.load_snapshot().queue == [job["id"]]

    _client(api)
    claimed = api.claim_browser_job(
        "example.test", 17, conversation_id="conversation-1", client_id="client-1"
    )
    assert claimed["status"] == "claimed"
    persisted_claim = store.load_snapshot().jobs[job["id"]]
    assert persisted_claim["status"] == "claimed"
    assert "claim_token" not in persisted_claim

    assert api.append_browser_delta({
        "job_id": job["id"],
        "claim_token": job["claim_token"],
        "tab_id": 17,
        "client_id": "client-1",
        "conversation_id": "conversation-1",
        "domain": "example.test",
        "text": "partial answer",
        "streaming": True,
    }) is True
    persisted_delta = store.load_snapshot()
    assert persisted_delta.jobs[job["id"]]["stream_snapshot"] == "partial answer"
    assert persisted_delta.deltas[job["id"]][0]["text"] == "partial answer"

    finished = api.finish_browser_job(
        job["id"], "completed", result={"assistant": "final answer"}
    )
    assert finished["status"] == "completed"
    persisted_final = store.load_snapshot()
    assert persisted_final.queue == []
    assert persisted_final.jobs[job["id"]]["result"] == {"assistant": "final answer"}


def test_restore_fails_old_claim_instead_of_requeueing_it(tmp_path, monkeypatch):
    api = _api()
    store = DurableJobStore(tmp_path / "jobs.sqlite3")
    monkeypatch.setattr(api, "JOB_STORE", store)
    _reset(api)

    job = {
        "id": "job-after-restart",
        "conversation_id": "conversation-1",
        "conversation_bound": True,
        "message": "hello",
        "messages": [{"role": "user", "content": "hello"}],
        "domain": "example.test",
        "model": "fixture-model",
        "request_meta": {},
        "new_tab": False,
        "target_url": "https://example.test/chat",
        "status": "claimed",
        "state_reason": "claimed",
        "tab_id": 17,
        "client_id": "old-client",
        "claimed_at": 100.0,
        "lease_expires_at": 400.0,
        "last_worker_seen": 101.0,
        "claim_attempt": 1,
        "created_at": "2026-08-03T00:00:00",
        "updated_at": "2026-08-03T00:01:00",
        "result": None,
        "error": None,
        "stream_snapshot": "partial",
        "claim_token": "old-token-must-not-return",
    }
    store.save_snapshot({job["id"]: job}, [], deltas={job["id"]: [{"text": "partial"}]})

    api.restore_browser_state()

    restored = api.BROWSER_JOBS[job["id"]]
    assert restored["status"] == "failed"
    assert restored["state_reason"] == "server_restart_incomplete"
    assert restored["tab_id"] is None
    assert restored["client_id"] == ""
    assert restored["claim_token"]
    assert restored["claim_token"] != "old-token-must-not-return"
    assert api.BROWSER_QUEUE == []
    assert job["id"] not in api.BROWSER_EVENTS
    assert api.BROWSER_DELTAS[job["id"]] == [{"text": "partial"}]

    persisted = store.load_snapshot().jobs[job["id"]]
    assert persisted["status"] == "failed"
    assert persisted["tab_id"] is None
    assert "claim_token" not in persisted


def test_restore_fails_old_queued_job_instead_of_replaying_it(tmp_path, monkeypatch):
    api = _api()
    store = DurableJobStore(tmp_path / "queued-jobs.sqlite3")
    monkeypatch.setattr(api, "JOB_STORE", store)
    _reset(api)

    job = {
        "id": "queued-before-restart",
        "conversation_id": "conversation-1",
        "message": "hello",
        "messages": [{"role": "user", "content": "hello"}],
        "domain": "example.test",
        "model": "fixture-model",
        "request_meta": {},
        "status": "queued",
        "state_reason": "enqueued",
        "target_url": "https://example.test/chat",
        "result": None,
        "error": None,
        "claim_attempt": 0,
    }
    store.save_snapshot({job["id"]: job}, [job["id"]])

    api.restore_browser_state()

    restored = api.BROWSER_JOBS[job["id"]]
    assert restored["status"] == "failed"
    assert restored["state_reason"] == "server_restart_incomplete"
    assert restored["error"] == "server_restart_incomplete"
    assert api.BROWSER_QUEUE == []
    assert job["id"] not in api.BROWSER_EVENTS
