import pytest

from server.state_machine import (
    BrowserClientState,
    JobState,
    InvalidTransition,
    can_transition,
    next_job_state,
    next_browser_client_state,
    recovery_action,
)


def _load_api_module():
    import importlib.util
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("phantom_state_api", root / "server" / "api_server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_job_happy_path_is_explicit():
    states = [JobState.CREATED]
    for event in (
        "enqueue",
        "claim",
        "submission_confirmed",
        "response_started",
        "response_progress",
        "complete",
    ):
        states.append(next_job_state(states[-1], event))

    assert states == [
        JobState.CREATED,
        JobState.QUEUED,
        JobState.CLAIMED,
        JobState.SUBMITTED,
        JobState.WAITING_RESPONSE,
        JobState.STREAMING,
        JobState.COMPLETED,
    ]


def test_job_can_complete_without_observed_streaming():
    assert next_job_state(JobState.WAITING_RESPONSE, "complete") is JobState.COMPLETED
    assert next_job_state(JobState.SUBMITTED, "complete") is JobState.COMPLETED
    assert next_job_state(JobState.CLAIMED, "complete") is JobState.COMPLETED


@pytest.mark.parametrize(
    ("state", "event"),
    [
        (JobState.CREATED, "complete"),
        (JobState.QUEUED, "complete"),
        (JobState.CLAIMED, "response_progress"),
        (JobState.COMPLETED, "retry"),
        (JobState.FAILED, "complete"),
        (JobState.CANCELLED, "claim"),
    ],
)
def test_invalid_job_transitions_are_rejected(state, event):
    with pytest.raises(InvalidTransition):
        next_job_state(state, event)


def test_terminal_job_transitions_are_idempotent_for_same_terminal_state():
    assert next_job_state(JobState.COMPLETED, "complete") is JobState.COMPLETED
    assert next_job_state(JobState.FAILED, "fail") is JobState.FAILED
    assert next_job_state(JobState.CANCELLED, "cancel") is JobState.CANCELLED


def test_expired_claim_is_requeued_until_retry_limit():
    assert next_job_state(JobState.CLAIMED, "lease_expired", claim_attempt=1) is JobState.QUEUED
    assert next_job_state(JobState.CLAIMED, "lease_expired", claim_attempt=5) is JobState.FAILED
    assert next_job_state(JobState.CLAIMED, "browser_stale", claim_attempt=1) is JobState.QUEUED


def test_recovery_actions_are_explicit():
    assert recovery_action(JobState.CLAIMED, "lease_expired", claim_attempt=1) == "requeue"
    assert recovery_action(JobState.CLAIMED, "lease_expired", claim_attempt=5) == "fail_max_claim_attempts"
    assert recovery_action(JobState.SUBMITTED, "browser_disconnected") == "fail_submission_unknown"
    assert recovery_action(JobState.WAITING_RESPONSE, "timeout") == "fail_timeout"
    assert recovery_action(JobState.CLAIMED, "browser_stale") == "requeue"


def test_browser_client_lifecycle_is_separate_from_job_state():
    assert next_browser_client_state(BrowserClientState.NEW, "register") is BrowserClientState.REGISTERED
    assert next_browser_client_state(BrowserClientState.REGISTERED, "ready") is BrowserClientState.READY
    assert next_browser_client_state(BrowserClientState.READY, "heartbeat") is BrowserClientState.READY
    assert next_browser_client_state(BrowserClientState.READY, "heartbeat_timeout") is BrowserClientState.STALE
    assert next_browser_client_state(BrowserClientState.STALE, "heartbeat") is BrowserClientState.READY
    assert next_browser_client_state(BrowserClientState.STALE, "disconnect") is BrowserClientState.DISCONNECTED


def test_can_transition_is_safe_for_unknown_events():
    assert can_transition(JobState.QUEUED, "claim") is True
    assert can_transition(JobState.QUEUED, "made_up_event") is False
    assert can_transition(BrowserClientState.READY, "made_up_event") is False


def test_api_new_job_and_claim_use_explicit_states():
    api = _load_api_module()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS.clear()

    job = api.new_browser_job("hello", domain="example.com", model="m")
    assert job["status"] == JobState.QUEUED.value
    assert job["state_reason"] == "enqueued"

    api.BROWSER_CLIENTS["7"] = {
        "tab_id": 7,
        "domain": "example.com",
        "last_seen": __import__("time").time(),
        "ready": True,
        "source": "content-ready",
        "capabilities": {"can_observe": True, "can_execute": True},
    }
    claimed = api.claim_browser_job("example.com", 7, job["conversation_id"])
    assert claimed["status"] == JobState.CLAIMED.value
    assert claimed["state_reason"] == "claimed"


def test_api_lease_expiry_requeues_then_fails_at_limit():
    api = _load_api_module()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_BINDINGS.clear()
    job = api.new_browser_job("hello", domain="example.com", model="m")
    job.update(status=JobState.CLAIMED.value, tab_id=7, lease_expires_at=1, claim_attempt=1)

    api.reap_expired_browser_jobs()
    assert job["status"] == JobState.QUEUED.value
    assert job["state_reason"] == "requeue"
    assert job["id"] in api.BROWSER_QUEUE

    api.BROWSER_QUEUE.clear()
    job.update(status=JobState.CLAIMED.value, tab_id=7, lease_expires_at=1, claim_attempt=5)
    api.reap_expired_browser_jobs()
    assert job["status"] == JobState.FAILED.value
    assert job["state_reason"] == "fail_max_claim_attempts"


def test_api_reset_uses_failure_transition_and_unblocks_waiters():
    api = _load_api_module()
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()
    job = api.new_browser_job("hello", domain="example.com", model="m")
    api.BROWSER_EVENTS[job["id"]].clear()

    response = api.app.test_client().post("/browser/reset")
    assert response.status_code == 200
    assert job["status"] == JobState.FAILED.value
    assert job["state_reason"] == "failed"
    assert job["error"] == "reset"
    assert job["id"] not in api.BROWSER_QUEUE
