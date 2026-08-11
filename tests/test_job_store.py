import threading

import pytest

from server.job_store import DurableJobStore


def _job(job_id, status="queued", **extra):
    value = {
        "id": job_id,
        "conversation_id": f"conversation-{job_id}",
        "conversation_bound": True,
        "message": f"request-{job_id}",
        "messages": [{"role": "user", "content": f"request-{job_id}"}],
        "domain": "example.test",
        "model": "fixture-model",
        "request_meta": {"idempotency_key": f"idem-{job_id}"},
        "new_tab": False,
        "target_url": "https://example.test/chat",
        "close_previous": False,
        "status": status,
        "state_reason": status,
        "reservation_tab_id": None,
        "tab_id": 17 if status == "claimed" else None,
        "client_id": "client-1" if status == "claimed" else "",
        "queued_at": 100.0,
        "claimed_at": 101.0 if status == "claimed" else None,
        "lease_expires_at": 401.0 if status == "claimed" else None,
        "last_worker_seen": 102.0 if status == "claimed" else None,
        "claim_attempt": 1 if status == "claimed" else 0,
        "created_at": "2026-08-03T00:00:00",
        "updated_at": "2026-08-03T00:01:00",
        "result": {"assistant": "answer"} if status == "completed" else None,
        "error": "browser_timeout" if status == "failed" else None,
        "stream_snapshot": "partial answer",
    }
    value.update(extra)
    return value


def test_round_trip_preserves_job_states_results_errors_and_stream_snapshot(tmp_path):
    store = DurableJobStore(tmp_path / "jobs.sqlite3")
    jobs = {
        "queued": _job("queued"),
        "claimed": _job("claimed", status="claimed"),
        "failed": _job("failed", status="failed"),
        "completed": _job("completed", status="completed"),
    }
    deltas = {
        "claimed": [{"text": "partial answer", "delta": "partial answer", "streaming": True}],
    }
    bindings = {
        ("conversation-claimed", "example.test"): {
            "conversation_id": "conversation-claimed",
            "domain": "example.test",
            "tab_id": 17,
            "profile": "chrome-extension",
            "last_seen": 102.0,
        },
    }
    idempotency = {
        "idem-claimed": {
            "key": "idem-claimed",
            "fingerprint": "fingerprint-1",
            "status": "processing",
            "job_id": "claimed",
            "event": threading.Event(),
            "response": None,
            "created_at": 100.0,
            "updated_at": 102.0,
        },
    }

    store.save_snapshot(
        jobs,
        ["queued", "claimed"],
        deltas=deltas,
        bindings=bindings,
        idempotency=idempotency,
    )
    restored = store.load_snapshot()

    assert set(restored.jobs) == set(jobs)
    assert restored.jobs["queued"]["status"] == "queued"
    assert restored.jobs["claimed"]["status"] == "claimed"
    assert restored.jobs["failed"]["error"] == "browser_timeout"
    assert restored.jobs["completed"]["result"] == {"assistant": "answer"}
    assert restored.jobs["claimed"]["stream_snapshot"] == "partial answer"
    assert restored.deltas == deltas
    assert restored.bindings[0]["conversation_id"] == "conversation-claimed"
    assert restored.bindings[0]["binding"]["tab_id"] == 17
    assert restored.idempotency["idem-claimed"]["fingerprint"] == "fingerprint-1"
    assert "event" not in restored.idempotency["idem-claimed"]
    assert restored.queue == ["queued", "claimed"]


def test_persistence_excludes_claim_tokens_credentials_and_runtime_objects(tmp_path):
    store = DurableJobStore(tmp_path / "jobs.sqlite3")
    job = _job(
        "sensitive",
        claim_token="claim-secret",
        event=threading.Event(),
        ready_event=threading.Event(),
        page_trace={"assistant": "must not be stored as trace"},
        request_meta={
            "idempotency_key": "safe-replay-key",
            "claim_token": "nested-claim-secret",
            "Authorization": "Bearer should-not-persist",
            "Cookie": "session=should-not-persist",
            "nested": {"api_key": "should-not-persist"},
            "tools": [{"type": "function", "function": {"name": "search"}}],
        },
    )

    store.save_snapshot({"sensitive": job}, ["sensitive"])
    restored = store.load_snapshot()
    persisted = restored.jobs["sensitive"]

    assert "claim_token" not in persisted
    assert "event" not in persisted
    assert "ready_event" not in persisted
    assert "page_trace" not in persisted
    assert persisted["request_meta"] == {
        "idempotency_key": "safe-replay-key",
        "nested": {},
        "tools": [{"type": "function", "function": {"name": "search"}}],
    }


def test_queue_order_is_preserved_and_duplicate_or_unknown_ids_are_removed(tmp_path):
    store = DurableJobStore(tmp_path / "jobs.sqlite3")
    jobs = {"first": _job("first"), "second": _job("second")}

    store.save_snapshot(jobs, ["second", "first", "second", "missing", "first"])
    restored = store.load_snapshot()

    assert restored.queue == ["second", "first"]


def test_snapshot_write_is_atomic_from_the_reader_contract(tmp_path):
    store = DurableJobStore(tmp_path / "jobs.sqlite3")
    first = {"job": _job("job", status="queued")}
    second = {"job": _job("job", status="completed")}

    store.save_snapshot(first, ["job"])
    store.save_snapshot(second, [])

    restored = store.load_snapshot()
    assert restored.jobs["job"]["status"] == "completed"
    assert restored.queue == []


def test_missing_store_loads_empty_snapshot(tmp_path):
    restored = DurableJobStore(tmp_path / "missing.sqlite3").load_snapshot()

    assert restored.jobs == {}
    assert restored.queue == []
    assert restored.deltas == {}
