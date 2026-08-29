"""Browser-client registration contract.

The extension and backend exchange this shape at the browser boundary. The
module is pure: it validates and normalizes payloads, but does not persist
clients, touch Chrome, or perform network I/O.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from server.state_machine import BrowserClientState


class BrowserClientContractError(ValueError):
    """Raised when an external browser registration is malformed."""


@dataclass(frozen=True)
class BrowserClientRegistration:
    client_id: str
    runtime_session_id: str
    extension_version: str
    browser: dict[str, str]
    profile_id: str
    tabs: tuple[dict[str, Any], ...]
    last_seen: float


def _required_text(payload: dict[str, Any], field: str, *, max_length: int = 128) -> str:
    value = str(payload.get(field) or "").strip()
    if not value:
        raise BrowserClientContractError(f"{field}_required")
    if len(value) > max_length:
        raise BrowserClientContractError(f"{field}_too_long")
    return value


def _normalize_tab(raw: Any, now: float) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise BrowserClientContractError("tab_must_be_object")
    tab_id = raw.get("tab_id")
    if isinstance(tab_id, bool):
        raise BrowserClientContractError("tab_id_invalid")
    try:
        tab_id = int(tab_id)
    except (TypeError, ValueError) as exc:
        raise BrowserClientContractError("tab_id_invalid") from exc
    if tab_id < 0:
        raise BrowserClientContractError("tab_id_invalid")

    domain = str(raw.get("domain") or "").strip().lower()
    url = str(raw.get("url") or "").strip()
    capabilities = raw.get("capabilities")
    if not isinstance(capabilities, dict):
        capabilities = {}
    normalized_capabilities = {
        key: bool(capabilities.get(key, False))
        for key in (
            "can_execute",
            "can_observe",
            "can_stream",
            "can_create_tab",
            "can_close_tab",
            "can_snapshot",
        )
    }
    # Registration is an inventory/reuse contract. Provider-tab activation is
    # owned by the request-path wake coordinator, never by the extension's
    # polling worker. Force this boundary even when an older extension build
    # still sends the obsolete true value.
    normalized_capabilities["can_create_tab"] = False
    normalized_capabilities["can_close_tab"] = False
    last_seen = raw.get("last_seen", now)
    try:
        last_seen = float(last_seen)
    except (TypeError, ValueError) as exc:
        raise BrowserClientContractError("tab_last_seen_invalid") from exc

    content_script_version = str(raw.get("content_script_version") or "").strip()[:64]
    ready = bool(raw.get("ready"))
    input_ready = bool(raw.get("input_ready"))
    send_ready = bool(raw.get("send_ready"))
    # A registration may still describe an open page when the service worker
    # has not yet revalidated its content runtime. It must not advertise that
    # page as executable until the page itself identifies its build.
    if ready or input_ready or send_ready:
        if not content_script_version:
            ready = False
            input_ready = False
            send_ready = False
            normalized_capabilities["can_execute"] = False
            normalized_capabilities["can_observe"] = False
    state = (
        BrowserClientState.READY.value
        if ready and input_ready and send_ready
        else BrowserClientState.REGISTERED.value
    )
    return {
        "tab_id": tab_id,
        "url": url,
        "domain": domain,
        "ready": ready,
        "input_ready": input_ready,
        "send_ready": send_ready,
        "content_script_version": content_script_version,
        "conversation_id": str(raw.get("conversation_id") or ""),
        "capabilities": normalized_capabilities,
        "last_seen": last_seen,
        "state": state,
    }


def normalize_registration(
    payload: Any,
    *,
    now: float | None = None,
) -> BrowserClientRegistration:
    """Validate and normalize an extension registration payload."""
    if not isinstance(payload, dict):
        raise BrowserClientContractError("registration_must_be_object")
    observed_at = time.time() if now is None else float(now)
    client_id = _required_text(payload, "client_id")
    # New extension workers send a fresh runtime session on every startup.
    # Keep a deterministic legacy value for older callers so the pure contract
    # remains backwards-compatible while the API can still reject an old
    # worker after a newer generation has taken ownership.
    runtime_session_id = str(payload.get("runtime_session_id") or f"legacy:{client_id}").strip()
    if not runtime_session_id:
        raise BrowserClientContractError("runtime_session_id_required")
    if len(runtime_session_id) > 128:
        raise BrowserClientContractError("runtime_session_id_too_long")
    extension_version = _required_text(payload, "extension_version", max_length=64)
    browser = payload.get("browser")
    if not isinstance(browser, dict):
        browser = {}
    normalized_browser = {
        "name": str(browser.get("name") or "unknown")[:64],
        "version": str(browser.get("version") or "unknown")[:64],
    }
    profile_id = str(payload.get("profile_id") or "").strip()[:128]
    raw_tabs = payload.get("tabs", [])
    if not isinstance(raw_tabs, list):
        raise BrowserClientContractError("tabs_must_be_array")
    if len(raw_tabs) > 100:
        raise BrowserClientContractError("too_many_tabs")
    tabs = tuple(_normalize_tab(raw, observed_at) for raw in raw_tabs)
    return BrowserClientRegistration(
        client_id=client_id,
        runtime_session_id=runtime_session_id,
        extension_version=extension_version,
        browser=normalized_browser,
        profile_id=profile_id,
        tabs=tabs,
        last_seen=observed_at,
    )


def eligible_tabs(
    registration: BrowserClientRegistration,
    domain: str = "",
    *,
    now: float | None = None,
    ttl: float = 45.0,
) -> list[dict[str, Any]]:
    """Return fresh, ready, executable and observable tabs for a domain."""
    current = time.time() if now is None else float(now)
    requested_domain = str(domain or "").strip().lower()
    result = []
    for tab in registration.tabs:
        if requested_domain and tab["domain"] != requested_domain:
            continue
        if current - float(tab["last_seen"]) >= ttl:
            continue
        if tab["state"] != BrowserClientState.READY.value:
            continue
        capabilities = tab["capabilities"]
        if not capabilities.get("can_execute") or not capabilities.get("can_observe"):
            continue
        result.append(dict(tab))
    return sorted(result, key=lambda item: item["tab_id"])


def client_status_payload(
    registration: BrowserClientRegistration,
    *,
    now: float | None = None,
    ttl: float = 45.0,
) -> dict[str, Any]:
    """Return a safe status view without cookies or conversation contents."""
    current = time.time() if now is None else float(now)
    fresh = current - registration.last_seen < ttl
    ready_tabs = eligible_tabs(registration, now=current, ttl=ttl)
    state = BrowserClientState.READY.value if ready_tabs else (
        BrowserClientState.STALE.value if not fresh else BrowserClientState.REGISTERED.value
    )
    return {
        "client_id": registration.client_id,
        "runtime_session_id": registration.runtime_session_id,
        "extension_version": registration.extension_version,
        "browser": dict(registration.browser),
        "profile_id": registration.profile_id,
        "last_seen": registration.last_seen,
        "fresh": fresh,
        "state": state,
        "tabs": [
            {
                "tab_id": tab["tab_id"],
                "domain": tab["domain"],
                "url": tab["url"],
                "state": tab["state"],
                "ready": tab["ready"],
                "input_ready": tab["input_ready"],
                "send_ready": tab["send_ready"],
                "content_script_version": tab["content_script_version"],
                "capabilities": dict(tab["capabilities"]),
                "last_seen": tab["last_seen"],
            }
            for tab in registration.tabs
        ],
    }
