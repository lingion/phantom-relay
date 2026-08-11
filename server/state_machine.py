"""Explicit lifecycle rules for browser relay jobs and browser clients.

This module is deliberately side-effect free. The API layer owns persistence,
leases, events, and HTTP responses; this module only answers whether a state
change is valid and what state/recovery action it implies.
"""

from __future__ import annotations

from enum import Enum
from typing import Final


class JobState(str, Enum):
    CREATED = "created"
    QUEUED = "queued"
    CLAIMED = "claimed"
    SUBMITTED = "submitted"
    WAITING_RESPONSE = "waiting_response"
    STREAMING = "streaming"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class BrowserClientState(str, Enum):
    NEW = "new"
    REGISTERED = "registered"
    READY = "ready"
    STALE = "stale"
    DISCONNECTED = "disconnected"
    REPLACED = "replaced"


class InvalidTransition(ValueError):
    """Raised when an event cannot be applied to the current state."""

    def __init__(self, state: Enum, event: str):
        self.state = state
        self.event = event
        super().__init__(f"Invalid transition: state={state.value!r}, event={event!r}")


MAX_CLAIM_ATTEMPTS: Final[int] = 5


_JOB_TRANSITIONS: Final[dict[JobState, dict[str, JobState]]] = {
    JobState.CREATED: {
        "enqueue": JobState.QUEUED,
        "cancel": JobState.CANCELLED,
        "fail": JobState.FAILED,
    },
    JobState.QUEUED: {
        "claim": JobState.CLAIMED,
        "fail": JobState.FAILED,
        "cancel": JobState.CANCELLED,
        "expire": JobState.EXPIRED,
    },
    JobState.CLAIMED: {
        "submission_confirmed": JobState.SUBMITTED,
        # The browser can submit a complete snapshot without an intermediate
        # submission-confirmation event. Treat that as a valid fast path.
        "complete": JobState.COMPLETED,
        "fail": JobState.FAILED,
        "cancel": JobState.CANCELLED,
    },
    JobState.SUBMITTED: {
        "response_started": JobState.WAITING_RESPONSE,
        "complete": JobState.COMPLETED,
        "browser_disconnected": JobState.FAILED,
        "timeout": JobState.FAILED,
        "cancel": JobState.CANCELLED,
    },
    JobState.WAITING_RESPONSE: {
        "response_progress": JobState.STREAMING,
        "complete": JobState.COMPLETED,
        "browser_disconnected": JobState.FAILED,
        "timeout": JobState.FAILED,
        "cancel": JobState.CANCELLED,
    },
    JobState.STREAMING: {
        "response_progress": JobState.STREAMING,
        "complete": JobState.COMPLETED,
        "browser_disconnected": JobState.FAILED,
        "timeout": JobState.FAILED,
        "cancel": JobState.CANCELLED,
    },
    JobState.COMPLETED: {"complete": JobState.COMPLETED},
    JobState.FAILED: {"fail": JobState.FAILED, "retry": JobState.QUEUED},
    JobState.CANCELLED: {"cancel": JobState.CANCELLED},
    JobState.EXPIRED: {},
}


_CLIENT_TRANSITIONS: Final[dict[BrowserClientState, dict[str, BrowserClientState]]] = {
    BrowserClientState.NEW: {"register": BrowserClientState.REGISTERED},
    BrowserClientState.REGISTERED: {
        "ready": BrowserClientState.READY,
        "heartbeat": BrowserClientState.REGISTERED,
        "disconnect": BrowserClientState.DISCONNECTED,
        "replace": BrowserClientState.REPLACED,
    },
    BrowserClientState.READY: {
        "heartbeat": BrowserClientState.READY,
        "heartbeat_timeout": BrowserClientState.STALE,
        "disconnect": BrowserClientState.DISCONNECTED,
        "replace": BrowserClientState.REPLACED,
    },
    BrowserClientState.STALE: {
        "heartbeat": BrowserClientState.READY,
        "disconnect": BrowserClientState.DISCONNECTED,
        "expire": BrowserClientState.DISCONNECTED,
        "replace": BrowserClientState.REPLACED,
    },
    BrowserClientState.DISCONNECTED: {
        "register": BrowserClientState.REGISTERED,
    },
    BrowserClientState.REPLACED: {},
}


def _state_value(state: Enum | str, enum_type: type[Enum]) -> Enum:
    if isinstance(state, enum_type):
        return state
    try:
        return enum_type(state)
    except ValueError as exc:
        raise InvalidTransition(enum_type(str(state)), "invalid_state") from exc


def can_transition(state: JobState | BrowserClientState | str, event: str) -> bool:
    """Return whether *event* is allowed for a job or browser-client state."""
    if isinstance(state, JobState) or str(state) in {item.value for item in JobState}:
        state = _state_value(state, JobState)
        return event in _JOB_TRANSITIONS[state]
    if isinstance(state, BrowserClientState) or str(state) in {item.value for item in BrowserClientState}:
        state = _state_value(state, BrowserClientState)
        return event in _CLIENT_TRANSITIONS[state]
    return False


def next_job_state(
    state: JobState | str,
    event: str,
    *,
    claim_attempt: int = 0,
    max_claim_attempts: int = MAX_CLAIM_ATTEMPTS,
) -> JobState:
    """Return the next job state, including lease-expiry recovery."""
    current = _state_value(state, JobState)
    if event in {"lease_expired", "browser_stale"} and current is JobState.CLAIMED:
        return (
            JobState.FAILED
            if int(claim_attempt) >= int(max_claim_attempts)
            else JobState.QUEUED
        )
    target = _JOB_TRANSITIONS[current].get(event)
    if target is None:
        raise InvalidTransition(current, event)
    return target


def next_browser_client_state(
    state: BrowserClientState | str,
    event: str,
) -> BrowserClientState:
    """Return the next browser-client lifecycle state."""
    current = _state_value(state, BrowserClientState)
    target = _CLIENT_TRANSITIONS[current].get(event)
    if target is None:
        raise InvalidTransition(current, event)
    return target


def recovery_action(
    state: JobState | str,
    event: str,
    *,
    claim_attempt: int = 0,
    max_claim_attempts: int = MAX_CLAIM_ATTEMPTS,
) -> str:
    """Return the side-effect action the API layer should perform."""
    current = _state_value(state, JobState)
    if event in {"lease_expired", "browser_stale"} and current is JobState.CLAIMED:
        return (
            "fail_max_claim_attempts"
            if int(claim_attempt) >= int(max_claim_attempts)
            else "requeue"
        )
    if event == "browser_disconnected" and current is JobState.SUBMITTED:
        return "fail_submission_unknown"
    if event == "timeout":
        return "fail_timeout"
    if event == "cancel":
        return "release_resources"
    return "none"
