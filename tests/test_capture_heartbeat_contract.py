import time

from server import api_server as api


def _reset_browser_state(monkeypatch):
    monkeypatch.setattr(api, "_persist_browser_state_locked", lambda: None)
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_READY.clear()
    api.BROWSER_BINDINGS.clear()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()


def _ready_body(job=None):
    return {
        "client_id": "client-capture-heartbeat-contract",
        "runtime_session_id": "runtime-capture-heartbeat-contract",
        "domain": "fixture-capture-heartbeat.test",
        "tab_id": 701,
        "conversation_id": job["conversation_id"] if job else "",
        "job_id": job["id"] if job else "",
        "claim_token": job["claim_token"] if job else "",
        "url": "https://fixture-capture-heartbeat.test/chat",
        "source": "content-ready",
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "capabilities": {"can_execute": True, "can_observe": True},
    }


def test_capture_heartbeat_renews_the_exact_claim_and_returns_claim_valid(monkeypatch):
    _reset_browser_state(monkeypatch)
    client = api.app.test_client()

    client.post("/browser/heartbeat", json=_ready_body())
    job = api.new_browser_job(
        "hello",
        domain="fixture-capture-heartbeat.test",
        model="fixture-model",
        conversation_id="fixture-conversation",
    )
    claimed = api.claim_browser_job(
        "fixture-capture-heartbeat.test",
        701,
        conversation_id=job["conversation_id"],
        client_id="client-capture-heartbeat-contract",
    )
    assert claimed["id"] == job["id"]
    previous_expiry = job["lease_expires_at"]
    job["lease_expires_at"] = time.time() + 1

    response = client.post("/browser/heartbeat", json=_ready_body(job))

    assert response.status_code == 200
    assert response.get_json()["claim_valid"] is True
    assert job["lease_expires_at"] > previous_expiry


def test_capture_heartbeat_rejects_a_stale_claim_token_without_renewing(monkeypatch):
    _reset_browser_state(monkeypatch)
    client = api.app.test_client()

    client.post("/browser/heartbeat", json=_ready_body())
    job = api.new_browser_job(
        "hello",
        domain="fixture-capture-heartbeat.test",
        model="fixture-model",
        conversation_id="fixture-conversation-2",
    )
    claimed = api.claim_browser_job(
        "fixture-capture-heartbeat.test",
        701,
        conversation_id=job["conversation_id"],
        client_id="client-capture-heartbeat-contract",
    )
    assert claimed["id"] == job["id"]
    job["lease_expires_at"] = time.time() + 1
    before = job["lease_expires_at"]
    stale = _ready_body(job)
    stale["claim_token"] = "stale-token"

    response = client.post("/browser/heartbeat", json=stale)

    assert response.status_code == 200
    assert response.get_json()["claim_valid"] is False
    assert job["lease_expires_at"] == before
