import time

import pytest

from server.browser_client import (
    BrowserClientContractError,
    client_status_payload,
    eligible_tabs,
    normalize_registration,
)


def registration_payload():
    return {
        "client_id": "client-install-1",
        "runtime_session_id": "runtime-test",
        "extension_version": "2.5.1",
        "browser": {"name": "Chrome", "version": "140"},
        "profile_id": "profile-a",
        "tabs": [
            {
                "tab_id": 10,
                "url": "https://chat.deepseek.com/",
                "domain": "chat.deepseek.com",
                "ready": True,
                "input_ready": True,
                "send_ready": True,
                "conversation_id": "conv-1",
                "capabilities": {"can_execute": True, "can_observe": True},
            },
            {
                "tab_id": 11,
                "url": "https://example.com/",
                "domain": "example.com",
                "ready": False,
                "input_ready": False,
                "send_ready": False,
                "capabilities": {"can_execute": False, "can_observe": False},
            },
        ],
    }


def test_registration_requires_stable_client_identity():
    with pytest.raises(BrowserClientContractError):
        normalize_registration({"tabs": []})


def test_registration_normalizes_client_and_tab_fields():
    registration = normalize_registration(registration_payload(), now=100.0)

    assert registration.client_id == "client-install-1"
    assert registration.extension_version == "2.5.1"
    assert registration.browser["name"] == "Chrome"
    assert registration.last_seen == 100.0
    assert registration.runtime_session_id == "runtime-test"
    assert registration.tabs[0]["tab_id"] == 10
    assert registration.tabs[0]["domain"] == "chat.deepseek.com"


def test_registration_cannot_grant_extension_a_tab_activation_owner():
    payload = registration_payload()
    payload["tabs"][0]["capabilities"].update({
        "can_create_tab": True,
        "can_close_tab": True,
    })

    registration = normalize_registration(payload, now=100.0)

    assert registration.tabs[0]["capabilities"]["can_create_tab"] is False
    assert registration.tabs[0]["capabilities"]["can_close_tab"] is False


def test_registration_rejects_invalid_tabs():
    payload = registration_payload()
    payload["tabs"] = [{"tab_id": "not-an-int", "domain": "example.com"}]
    with pytest.raises(BrowserClientContractError):
        normalize_registration(payload)


def test_eligible_tabs_require_fresh_ready_and_executable_tab():
    registration = normalize_registration(registration_payload(), now=100.0)
    tabs = eligible_tabs(registration, "chat.deepseek.com", now=110.0, ttl=45.0)
    assert [tab["tab_id"] for tab in tabs] == [10]

    stale = normalize_registration(registration_payload(), now=100.0)
    tabs = eligible_tabs(stale, "chat.deepseek.com", now=146.0, ttl=45.0)
    assert tabs == []


def test_status_payload_is_safe_and_serializable():
    registration = normalize_registration(registration_payload(), now=100.0)
    payload = client_status_payload(registration, now=110.0, ttl=45.0)

    assert payload["client_id"] == "client-install-1"
    assert payload["state"] == "ready"
    assert payload["fresh"] is True
    assert payload["tabs"][0]["tab_id"] == 10
    assert "cookies" not in payload
    assert "conversation_text" not in payload


def test_register_endpoint_accepts_contract_and_indexes_tabs():
    import importlib.util
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("phantom_register_api", root / "server" / "api_server.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_REGISTRATIONS.clear()

    response = api.app.test_client().post("/browser/register", json=registration_payload())
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["client"]["client_id"] == "client-install-1"
    assert api.BROWSER_CLIENTS["10"]["client_id"] == "client-install-1"
    assert api.BROWSER_CLIENTS["10"]["state"] == "ready"

    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    assert claimed["id"] == job["id"]

    other_job = api.new_browser_job("hello again", domain="chat.deepseek.com", model="m")
    assert api.claim_browser_job(
        "chat.deepseek.com", 10, other_job["conversation_id"], client_id="other-client"
    ) is None


def test_negative_heartbeat_clears_previous_execution_readiness():
    api = _load_register_api("phantom_register_api_negative_heartbeat")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    assert api.BROWSER_CLIENTS["10"]["ready"] is True

    response = client.post("/browser/heartbeat", json={
        "client_id": "client-install-1",
        "runtime_session_id": "runtime-test",
        "domain": "chat.deepseek.com",
        "tab_id": 10,
        "url": "https://chat.deepseek.com/",
        "source": "content-ready",
        "ready": False,
        "input_ready": False,
        "send_ready": False,
        "capabilities": {
            "can_observe": False,
            "can_execute": False,
            "can_stream": True,
            "can_snapshot": False,
        },
    })

    assert response.status_code == 200
    indexed = api.BROWSER_CLIENTS["10"]
    assert indexed["ready"] is False
    assert indexed["input_ready"] is False
    assert indexed["send_ready"] is False
    assert indexed["capabilities"]["can_execute"] is False
    assert indexed["capabilities"]["can_observe"] is False
    assert "10" not in api.BROWSER_READY


def test_fresh_contract_registration_blocks_legacy_poll_without_client_id():
    api = _load_register_api("phantom_register_api_legacy_poll_gate")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200

    # This is the shape emitted by an older background worker: it has a live
    # tab record but no stable browser-client identity.
    api.BROWSER_CLIENTS["99"] = {
        "tab_id": 99,
        "client_id": "",
        "domain": "chat.deepseek.com",
        "last_seen": __import__("time").time(),
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "source": "content-ready",
        "capabilities": {"can_observe": True, "can_execute": True},
    }
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")

    assert api.claim_browser_job(
        "chat.deepseek.com", 99, job["conversation_id"]
    ) is None
    assert job["status"] == "queued"


def test_claim_rejects_registered_tab_without_execution_or_observation_capability():
    api = _load_register_api("phantom_register_api_capability_gate")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    api.BROWSER_CLIENTS["10"]["capabilities"]["can_execute"] = False
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")

    assert api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    ) is None
    assert job["status"] == "queued"


def test_register_endpoint_rejects_malformed_payload():
    import importlib.util
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("phantom_register_api_invalid", root / "server" / "api_server.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)

    response = api.app.test_client().post("/browser/register", json={"tabs": []})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_browser_registration"


def _load_register_api(module_name):
    import importlib.util
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(module_name, root / "server" / "api_server.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_REGISTRATIONS.clear()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_BINDINGS.clear()
    return api


def test_registration_refresh_does_not_downgrade_fresh_content_ready_claim():
    api = _load_register_api("phantom_register_api_refresh")
    client = api.app.test_client()

    first = client.post("/browser/register", json=registration_payload())
    assert first.status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    assert claimed["id"] == job["id"]
    api.mark_browser_ready({
        "client_id": "client-install-1",
        "runtime_session_id": "runtime-test",
        "domain": "chat.deepseek.com",
        "tab_id": 10,
        "conversation_id": job["conversation_id"],
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "source": "content-ready",
        "capabilities": {"can_execute": True, "can_observe": True},
    })

    refreshed = registration_payload()
    refreshed["tabs"][0]["ready"] = False
    refreshed["tabs"][0]["input_ready"] = False
    refreshed["tabs"][0]["send_ready"] = False
    refreshed["tabs"][0]["capabilities"] = {"can_execute": False, "can_observe": False}
    response = client.post("/browser/register", json=refreshed)

    assert response.status_code == 200
    indexed = api.BROWSER_CLIENTS["10"]
    assert indexed["source"] == "content-ready"
    assert indexed["ready"] is True
    assert indexed["input_ready"] is True
    assert indexed["send_ready"] is True
    assert indexed["conversation_id"] == job["conversation_id"]


def test_same_domain_ready_tabs_are_not_elected_by_numeric_tab_id():
    api = _load_register_api("phantom_register_api_multi_tab_ready")

    api.mark_browser_ready({
        "client_id": "client-install-1",
        "runtime_session_id": "runtime-test",
        "domain": "chat.deepseek.com",
        "tab_id": 900,
        "url": "https://chat.deepseek.com/recorded",
        "source": "content-ready",
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "capabilities": {"can_execute": True, "can_observe": True},
    })
    api.mark_browser_ready({
        "client_id": "client-install-1",
        "runtime_session_id": "runtime-test",
        "domain": "chat.deepseek.com",
        "tab_id": 100,
        "url": "https://chat.deepseek.com/other-recorded",
        "source": "content-ready",
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "capabilities": {"can_execute": True, "can_observe": True},
    })

    assert api.BROWSER_CLIENTS["900"]["ready"] is True
    assert api.BROWSER_CLIENTS["100"]["ready"] is True
    assert set(api.BROWSER_READY) == {"900", "100"}


def test_navigation_inventory_does_not_requeue_active_claim():
    api = _load_register_api("phantom_register_api_navigation_claim")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    assert claimed["id"] == job["id"]

    # A page navigation can invalidate the old content heartbeat before the
    # next content script is ready. The service worker still reports the
    # claimed tab in its inventory, so the active lease must survive this gap.
    api.BROWSER_CLIENTS["10"]["last_seen"] = __import__("time").time() - api.CLIENT_TTL - 1
    navigating = registration_payload()
    navigating["tabs"][0]["url"] = "https://chat.deepseek.com/conversation/next"
    response = client.post("/browser/register", json=navigating)

    assert response.status_code == 200
    assert job["status"] == "claimed"
    assert job["tab_id"] == 10
    token = client.get("/browser/result-token", query_string={
        "job_id": job["id"],
        "tab_id": 10,
        "domain": "chat.deepseek.com",
        "conversation_id": job["conversation_id"],
        "client_id": "client-install-1",
    })
    assert token.status_code == 200
    assert token.get_json()["claim_token"] == claimed["claim_token"]


def test_active_claim_lease_survives_stale_client_inventory():
    api = _load_register_api("phantom_register_api_claim_lease")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200

    job = api.new_browser_job("long response", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    assert claimed["id"] == job["id"]

    # A captured page can miss a readiness heartbeat while its signed job lease
    # is still valid. The lease is the execution ownership boundary; a stale
    # inventory record must not requeue the live job prematurely.
    api.BROWSER_CLIENTS["10"]["last_seen"] = time.time() - api.CLIENT_TTL - 1
    api.purge_stale_browser_state()

    assert job["status"] == "claimed"
    token = client.get("/browser/result-token", query_string={
        "job_id": job["id"],
        "tab_id": 10,
        "domain": "chat.deepseek.com",
        "conversation_id": job["conversation_id"],
        "client_id": "client-install-1",
    })
    assert token.status_code == 200
    assert token.get_json()["claim_token"] == claimed["claim_token"]


def test_newer_same_domain_ready_tab_does_not_evict_active_claim():
    api = _load_register_api("phantom_register_api_same_domain_claim")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    assert claimed["id"] == job["id"]

    api.mark_browser_ready({
        "client_id": "client-install-1",
        "domain": "chat.deepseek.com",
        "tab_id": 20,
        "url": "https://chat.deepseek.com/",
        "source": "content-ready",
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        "capabilities": {"can_execute": True, "can_observe": True},
    })
    api.purge_stale_browser_state()

    assert job["status"] == "claimed"
    assert api.BROWSER_CLIENTS["10"]["ready"] is True
    assert api.BROWSER_CLIENTS["10"]["state"] != api.BrowserClientState.STALE.value
    assert api.BROWSER_BINDINGS[(job["conversation_id"], "chat.deepseek.com")]["tab_id"] == 10


def test_registration_refresh_removes_tabs_that_disappeared_for_same_client():
    api = _load_register_api("phantom_register_api_inventory")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    reduced = registration_payload()
    reduced["tabs"] = reduced["tabs"][:1]

    response = client.post("/browser/register", json=reduced)

    assert response.status_code == 200
    assert "10" in api.BROWSER_CLIENTS
    assert "11" not in api.BROWSER_CLIENTS


def test_disappeared_claimed_tab_waits_for_lease_expiry_before_requeue():
    api = _load_register_api("phantom_register_api_disconnect_recovery")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    assert claimed["id"] == job["id"]

    reduced = registration_payload()
    reduced["tabs"] = reduced["tabs"][1:]
    response = client.post("/browser/register", json=reduced)

    assert response.status_code == 200
    # Registration inventory can briefly omit a tab while the content script
    # is navigating or the service worker is refreshing. A still-valid job
    # lease remains the execution ownership boundary, so the result token
    # must not be invalidated by this transient inventory change.
    assert job["status"] == "claimed"
    assert job["id"] not in api.BROWSER_QUEUE

    # Requeue is allowed once the signed execution lease really expires.
    job["lease_expires_at"] = time.time() - 1
    api.purge_stale_browser_state()

    assert job["status"] == "queued"
    assert job["state_reason"] == "requeue"
    assert job["id"] in api.BROWSER_QUEUE


def test_result_rejects_registered_client_identity_mismatch():
    api = _load_register_api("phantom_register_api_result_identity")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )

    rejected = client.post("/browser/result", json={
        "client_id": "other-client",
        "job_id": job["id"],
        "claim_token": claimed["claim_token"],
        "success": True,
        "assistant": "wrong actor",
        "conversation_id": job["conversation_id"],
        "tab_id": 10,
        "domain": "chat.deepseek.com",
    })

    assert rejected.status_code == 409
    assert rejected.get_json()["error"]["message"] == "client_id_mismatch"


def test_result_token_rejects_wrong_client_identity():
    api = _load_register_api("phantom_register_api_token_identity")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    query = {
        "job_id": job["id"],
        "tab_id": 10,
        "domain": "chat.deepseek.com",
        "conversation_id": job["conversation_id"],
    }

    accepted = client.get("/browser/result-token", query_string={**query, "client_id": "client-install-1"})
    rejected = client.get("/browser/result-token", query_string={**query, "client_id": "other-client"})

    assert accepted.status_code == 200
    assert accepted.get_json()["claim_token"] == claimed["claim_token"]
    assert rejected.status_code == 409


def test_result_completes_claimed_job_on_fast_snapshot_path():
    api = _load_register_api("phantom_register_api_fast_result")
    client = api.app.test_client()
    assert client.post("/browser/register", json=registration_payload()).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )

    response = client.post("/browser/result", json={
        "client_id": "client-install-1",
        "job_id": job["id"],
        "claim_token": claimed["claim_token"],
        "success": True,
        "assistant": "done",
        "conversation_id": job["conversation_id"],
        "tab_id": 10,
        "domain": "chat.deepseek.com",
    })

    assert response.status_code == 200
    assert api.BROWSER_JOBS[job["id"]]["status"] == "completed"


def test_registration_does_not_copy_another_client_conversation_for_same_tab_id():
    api = _load_register_api("phantom_register_api_tab_collision")
    client = api.app.test_client()
    first = registration_payload()
    first["client_id"] = "client-a"
    assert client.post("/browser/register", json=first).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-a"
    )
    assert claimed["id"] == job["id"]

    second = registration_payload()
    second["client_id"] = "client-b"
    response = client.post("/browser/register", json=second)

    assert response.status_code == 200
    assert api.BROWSER_CLIENTS["10"]["client_id"] == "client-b"
    assert api.BROWSER_CLIENTS["10"]["conversation_id"] != job["conversation_id"]


def test_new_runtime_session_replaces_old_inventory_and_requeues_claim():
    api = _load_register_api("phantom_register_api_runtime_generation")
    client = api.app.test_client()
    first = registration_payload()
    first["runtime_session_id"] = "runtime-old"
    assert client.post("/browser/register", json=first).status_code == 200
    job = api.new_browser_job("hello", domain="chat.deepseek.com", model="m")
    claimed = api.claim_browser_job(
        "chat.deepseek.com", 10, job["conversation_id"], client_id="client-install-1"
    )
    assert claimed["id"] == job["id"]

    second = registration_payload()
    second["runtime_session_id"] = "runtime-new"
    second["tabs"] = []
    response = client.post("/browser/register", json=second)

    assert response.status_code == 200
    assert job["status"] == "queued"
    assert job["tab_id"] is None
    assert api.BROWSER_CLIENTS == {}


def test_old_legacy_registration_cannot_reclaim_after_new_runtime_session():
    api = _load_register_api("phantom_register_api_runtime_legacy_rejection")
    client = api.app.test_client()
    current = registration_payload()
    current["runtime_session_id"] = "runtime-new"
    assert client.post("/browser/register", json=current).status_code == 200

    stale = registration_payload()
    stale.pop("runtime_session_id")
    response = client.post("/browser/register", json=stale)

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "browser_runtime_required"
