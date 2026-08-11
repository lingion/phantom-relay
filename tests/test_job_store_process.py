import json
import os
import subprocess
import sys
import textwrap


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(source, store_path):
    environment = dict(os.environ)
    environment["PYTHONPATH"] = ROOT
    completed = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(source), str(store_path)],
        cwd=ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_job_state_survives_two_independent_api_processes(tmp_path):
    store_path = tmp_path / "process-restart.sqlite3"
    written = _run(
        """
        import json
        import sys
        from server import api_server as api

        api.configure_browser_job_store(sys.argv[1], restore=False)
        job = api.new_browser_job(
            "hello", domain="example.test", model="fixture-model",
            conversation_id="conversation-process",
        )
        api.BROWSER_CLIENTS["17"] = {
            "tab_id": 17, "domain": "example.test",
            "client_id": "client-process", "last_seen": api.time.time(),
            "ready": True, "source": "content-ready",
            "capabilities": {"can_observe": True, "can_execute": True},
        }
        claimed = api.claim_browser_job(
            "example.test", 17, "conversation-process", "client-process"
        )
        api.append_browser_delta({
            "job_id": claimed["id"], "claim_token": claimed["claim_token"],
            "tab_id": 17, "client_id": "client-process",
            "conversation_id": "conversation-process", "domain": "example.test",
            "text": "partial", "streaming": True,
        })
        print(json.dumps({"job_id": job["id"], "status": claimed["status"]}))
        """,
        store_path,
    )
    restored = _run(
        """
        import json
        import sys
        from server import api_server as api

        api.configure_browser_job_store(sys.argv[1], restore=True)
        job_id = next(iter(api.BROWSER_JOBS))
        job = api.BROWSER_JOBS[job_id]
        print(json.dumps({
            "job_id": job_id, "status": job["status"],
            "reason": job["state_reason"], "tab_id": job["tab_id"],
            "delta": api.BROWSER_DELTAS[job_id][0]["text"],
            "queue": list(api.BROWSER_QUEUE),
            "has_event": job_id in api.BROWSER_EVENTS,
            "has_claim_token": bool(job.get("claim_token")),
        }))
        """,
        store_path,
    )

    assert written == {"job_id": restored["job_id"], "status": "claimed"}
    assert restored["status"] == "failed"
    assert restored["reason"] == "server_restart_incomplete"
    assert restored["tab_id"] is None
    assert restored["delta"] == "partial"
    assert restored["queue"] == []
    assert restored["has_event"] is False
    assert restored["has_claim_token"] is True


def test_coordination_state_survives_two_independent_api_processes(tmp_path):
    store_path = tmp_path / "coordination-process-restart.sqlite3"
    written = _run(
        """
        import json
        import sys
        import threading
        from server import api_server as api

        api.configure_browser_job_store(sys.argv[1], restore=False)
        job = api.new_browser_job(
            "hello", domain="example.test", model="fixture-model",
            conversation_id="conversation-process",
            request_meta={"idempotency_key": "request-process"},
        )
        api.BROWSER_BINDINGS[("conversation-process", "example.test")] = {
            "conversation_id": "conversation-process",
            "domain": "example.test", "tab_id": 17,
            "last_seen": api.time.time(),
        }
        api.IDEMPOTENCY["request-process"] = {
            "key": "request-process", "fingerprint": "fp-process",
            "status": "processing", "job_id": job["id"],
            "event": threading.Event(), "response": None,
            "created_at": api.time.time(), "updated_at": api.time.time(),
        }
        with api.BROWSER_LOCK:
            api._persist_browser_state_locked()
        print(json.dumps({"job_id": job["id"]}))
        """,
        store_path,
    )
    restored = _run(
        """
        import json
        import sys
        from server import api_server as api

        api.configure_browser_job_store(sys.argv[1], restore=True)
        binding = api.BROWSER_BINDINGS[("conversation-process", "example.test")]
        record = api.IDEMPOTENCY["request-process"]
        print(json.dumps({
            "job_id": record["job_id"], "status": record["status"],
            "binding_tab_id": binding["tab_id"],
            "event_set": record["event"].is_set(),
        }))
        """,
        store_path,
    )

    assert restored == {
        "job_id": written["job_id"],
        "status": "failed",
        "binding_tab_id": None,
        "event_set": True,
    }
