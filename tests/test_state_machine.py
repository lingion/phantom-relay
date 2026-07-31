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


def test_recovery_actions_are_explicit():
    assert recovery_action(JobState.CLAIMED, "lease_expired", claim_attempt=1) == "requeue"
    assert recovery_action(JobState.CLAIMED, "lease_expired", claim_attempt=5) == "fail_max_claim_attempts"
    assert recovery_action(JobState.SUBMITTED, "browser_disconnected") == "fail_submission_unknown"
    assert recovery_action(JobState.WAITING_RESPONSE, "timeout") == "fail_timeout"


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
