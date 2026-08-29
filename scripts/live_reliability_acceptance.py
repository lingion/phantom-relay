#!/usr/bin/env python3
"""Provider-neutral live reliability acceptance for Phantom Relay.

All product actions go through ``curl -> /v1/chat/completions``. Browser
process inspection and shutdown are test setup/evidence only; this harness
never types into, clicks, navigates, or posts a synthetic browser result.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import os
import plistlib
import random
import re
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote, urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_API = "http://127.0.0.1:8765"
DEFAULT_TRACE = ROOT / "server" / "page-trace.jsonl"
DEFAULT_RESULTS = ROOT / "tests" / "live-results"
DEFAULT_TIMEOUT_SECONDS = 300
READY_POLL_SECONDS = 0.25
WAKE_RECENT_WINDOW_SECONDS = 8.0
RELIABILITY_PHASES = frozenset(
    {
        "cold",
        "crash_prepare",
        "crash",
        "context_pair",
        "context_switchback",
        "context_three_distinct",
    }
)
COVERAGE_ONLY_PHASES = frozenset({"warm", "alias_route", "context_seed"})


class AcceptanceError(RuntimeError):
    """Raised when the acceptance environment or contract is invalid."""


@dataclass(frozen=True)
class RecordedModel:
    domain: str
    model_id: str
    aliases: tuple[str, ...]
    target_url: str
    profile_id: str
    profile_revision: int


@dataclass(frozen=True)
class AcceptanceCase:
    case_id: str
    phase: str
    sequence: tuple[str, ...]
    target_model: str
    target_domain: str
    messages: tuple[dict[str, str], ...]
    expected: str
    allowed_context_markers: tuple[str, ...] = ()
    forbidden_markers: tuple[str, ...] = ()
    shutdown_mode: str = "none"
    prerequisite_case_id: str | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def compact_id(value: str, limit: int = 22) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").upper()
    return value[:limit] or "MODEL"


def rendering_stable_marker(prefix: str, *parts: object) -> str:
    marker_prefix = re.sub(r"[^A-Za-z0-9]+", "", str(prefix or "")).upper()
    if not marker_prefix:
        raise ValueError("marker prefix must contain an ASCII letter or digit")
    payload = "\x1f".join(str(part) for part in parts)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest().upper()[:16]
    return f"{marker_prefix}{digest}"


def run_command(
    args: list[str],
    *,
    timeout: float | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=check,
    )


def curl_json(
    api: str,
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 10,
) -> tuple[int, Any, str]:
    command = [
        "curl",
        "-sS",
        "--max-time",
        str(timeout),
        "--write-out",
        "\n__PHANTOM_HTTP_STATUS__:%{http_code}\n",
    ]
    if method != "GET":
        command.extend(["-X", method])
    if body is not None:
        command.extend(
            [
                "-H",
                "Content-Type: application/json",
                "-d",
                json.dumps(body, ensure_ascii=False, separators=(",", ":")),
            ]
        )
    command.append(api.rstrip("/") + path)
    completed = run_command(command, timeout=timeout + 5)
    raw = completed.stdout
    marker = "\n__PHANTOM_HTTP_STATUS__:"
    if marker not in raw:
        raise AcceptanceError(
            f"curl failed for {path}: rc={completed.returncode} stderr={completed.stderr.strip()}"
        )
    payload, status_text = raw.rsplit(marker, 1)
    status = int(status_text.strip())
    try:
        decoded = json.loads(payload) if payload.strip() else None
    except json.JSONDecodeError:
        decoded = None
    return status, decoded, payload


def profile_is_executable(profile: Any) -> bool:
    if not isinstance(profile, dict):
        return False
    response = profile.get("response") if isinstance(profile.get("response"), dict) else {}
    identity = (
        response.get("identityVerification")
        if isinstance(response.get("identityVerification"), dict)
        else {}
    )
    lifecycle = profile.get("lifecycle") if isinstance(profile.get("lifecycle"), dict) else {}
    return bool(
        profile.get("profileId")
        and profile.get("domain")
        and profile.get("input")
        and profile.get("send")
        and response.get("selector")
        and identity.get("status") == "verified"
        and lifecycle.get("state") not in {"invalid", "degraded"}
    )


def build_recorded_model_inventory(
    routes: Iterable[dict[str, Any]],
    aliases: dict[str, str] | None,
    profiles_by_domain: dict[str, Any],
) -> tuple[list[RecordedModel], list[dict[str, Any]]]:
    """Build the executable model inventory from registry semantics.

    One recorded browser domain is one independently executable webpage model.
    Additional route IDs for that domain are aliases because they share the
    same target profile, browser lifecycle, and response-capture boundary.
    """
    alias_map = {
        str(key).strip(): str(value).strip()
        for key, value in (aliases or {}).items()
        if str(key).strip() and str(value).strip()
    }
    alias_keys = set(alias_map)
    route_by_id: dict[str, dict[str, Any]] = {}
    routes_by_domain: dict[str, list[dict[str, Any]]] = {}
    for raw in routes:
        if not isinstance(raw, dict):
            continue
        model_id = str(raw.get("id") or "").strip()
        domain = str(raw.get("domain") or "").strip().lower()
        target_url = str(raw.get("url") or "").strip()
        if not model_id or not domain:
            continue
        route = {"id": model_id, "domain": domain, "url": target_url}
        route_by_id[model_id] = route
        routes_by_domain.setdefault(domain, []).append(route)

    models: list[RecordedModel] = []
    blockers: list[dict[str, Any]] = []
    alias_targets = set(alias_map.values())
    for domain, domain_routes in routes_by_domain.items():
        canonical_candidates = [
            route for route in domain_routes if route["id"] not in alias_keys
        ]
        if not canonical_candidates:
            continue

        for item in domain_routes:
            model_id = item["id"]
            target_url = item["url"]
            parsed = urlparse(target_url)
            if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() != domain:
                raise AcceptanceError(
                    f"recorded route target mismatch: model={model_id} domain={domain} url={target_url}"
                )

        profile = profiles_by_domain.get(domain)
        explicit_domain_aliases = {
            alias
            for alias, target in alias_map.items()
            if (route_by_id.get(target) or {}).get("domain") == domain
        }
        if not profile_is_executable(profile):
            blockers.append(
                {
                    "domain": domain,
                    "model_ids": sorted(
                        {route["id"] for route in domain_routes}
                        | explicit_domain_aliases
                    ),
                    "reason": "executable_recorded_profile_missing",
                }
            )
            continue

        canonical = next(
            (route for route in canonical_candidates if route["id"] == domain),
            None,
        ) or next(
            (route for route in canonical_candidates if route["id"] in alias_targets),
            canonical_candidates[0],
        )
        route_aliases = {route["id"] for route in domain_routes}
        route_aliases.discard(canonical["id"])
        lifecycle = profile.get("lifecycle") if isinstance(profile.get("lifecycle"), dict) else {}
        models.append(
            RecordedModel(
                domain=domain,
                model_id=canonical["id"],
                aliases=tuple(sorted(route_aliases | explicit_domain_aliases)),
                target_url=canonical["url"],
                profile_id=str(profile.get("profileId") or ""),
                profile_revision=int(lifecycle.get("revision") or 0),
            )
        )

    for alias, target in sorted(alias_map.items()):
        if target not in route_by_id or target in alias_keys:
            blockers.append(
                {
                    "alias": alias,
                    "target": target,
                    "reason": "alias_target_missing_or_not_canonical",
                }
            )
    return models, blockers


def discover_recorded_models(api: str) -> tuple[list[RecordedModel], dict[str, Any]]:
    health_status, health, _ = curl_json(api, "/health")
    if health_status != 200 or not isinstance(health, dict) or health.get("status") != "ok":
        raise AcceptanceError(f"API health check failed: status={health_status} body={health}")
    if health.get("browser_activation_owner") != "api":
        raise AcceptanceError("browser activation owner must be api")
    if health.get("browser_auto_wake") is not True:
        raise AcceptanceError("browser auto wake must be enabled")

    status, admin, _ = curl_json(api, "/admin/api/models")
    if status != 200 or not isinstance(admin, dict):
        raise AcceptanceError(f"model inventory failed: status={status} body={admin}")
    routes = admin.get("models") if isinstance(admin.get("models"), list) else []

    aliases = admin.get("aliases") if isinstance(admin.get("aliases"), dict) else {}
    routes_by_domain: dict[str, list[dict[str, Any]]] = {}
    for route in routes:
        if not isinstance(route, dict):
            continue
        domain = str(route.get("domain") or "").strip().lower()
        model_id = str(route.get("id") or "").strip()
        target_url = str(route.get("url") or "").strip()
        if domain and model_id:
            routes_by_domain.setdefault(domain, []).append(
                {"id": model_id, "url": target_url}
            )

    profiles_by_domain: dict[str, Any] = {}
    for domain, domain_routes in sorted(routes_by_domain.items()):
        selector_status, selectors, _ = curl_json(
            api, f"/browser/selectors?domain={quote(domain, safe='')}"
        )
        profile = (
            selectors.get("selectors", {}).get("profile")
            if selector_status == 200 and isinstance(selectors, dict)
            else None
        )
        profiles_by_domain[domain] = profile

    models, missing_profiles = build_recorded_model_inventory(
        routes,
        aliases,
        profiles_by_domain,
    )

    inventory = {
        "health": health,
        "public_route_count": len(routes),
        "recorded_model_count": len(models),
        "recorded_domain_count": len({model.domain for model in models}),
        "recorded_models": [asdict(model) for model in models],
        "advertised_without_executable_profile": missing_profiles,
    }
    if not models:
        raise AcceptanceError("no executable user-recorded models were discovered")
    return models, inventory


def adjacent_distinct_triples(models: Iterable[str]) -> list[tuple[str, str, str]]:
    values = tuple(models)
    return [
        (first, second, third)
        for first in values
        for second in values
        if second != first
        for third in values
        if third != second
    ]


def matrix_counts(
    model_count: int,
    startup_repeats: int,
    path_repeats: int,
    alias_checks: int = 0,
) -> dict[str, int]:
    pairs = model_count * (model_count - 1)
    switchbacks = pairs
    all_distinct_triples = model_count * (model_count - 1) * max(0, model_count - 2)
    triples = model_count * (model_count - 1) * (model_count - 1)
    context_nodes = model_count + pairs + triples
    return {
        "models": model_count,
        "startup_repeats_per_model": startup_repeats,
        "path_repeats_per_directed_path": path_repeats,
        "warm_qualification_requests": model_count,
        "alias_route_requests": alias_checks,
        "hard_cold_requests": model_count * startup_repeats,
        "immediate_crash_prepare_requests": model_count * startup_repeats,
        "immediate_crash_recovery_requests": model_count * startup_repeats,
        "directed_pair_paths": pairs,
        "switchback_paths": switchbacks,
        "all_distinct_triple_paths": all_distinct_triples,
        "adjacent_distinct_triple_paths": triples,
        "context_requests_per_path_repeat": context_nodes,
        "context_seed_requests": model_count * path_repeats,
        "directed_pair_requests": pairs * path_repeats,
        "adjacent_distinct_triple_requests": triples * path_repeats,
        "context_requests": context_nodes * path_repeats,
        "qualification_requests": (
            model_count + alias_checks + 3 * model_count * startup_repeats
        ),
        "full_requests": (
            model_count
            + alias_checks
            + 3 * model_count * startup_repeats
            + context_nodes * path_repeats
        ),
    }


def binomial_tail(successes: int, trials: int, probability: float) -> float:
    return sum(
        math.comb(trials, observed)
        * probability**observed
        * (1.0 - probability) ** (trials - observed)
        for observed in range(successes, trials + 1)
    )


def clopper_pearson_lower(successes: int, trials: int, confidence: float = 0.95) -> float:
    if trials <= 0 or successes <= 0:
        return 0.0
    if successes > trials:
        raise ValueError("successes cannot exceed trials")
    alpha = 1.0 - confidence
    low, high = 0.0, 1.0
    for _ in range(80):
        middle = (low + high) / 2.0
        if binomial_tail(successes, trials, middle) < alpha:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0


def minimum_perfect_trials(threshold: float, confidence: float) -> int:
    if not 0 < threshold <= 1 or not 0 < confidence < 1:
        raise ValueError("threshold and confidence must be between 0 and 1")
    trials = 1
    while clopper_pearson_lower(trials, trials, confidence) < threshold:
        trials += 1
    return trials


def normalize_answer(value: str) -> str:
    text = str(value or "").strip()
    fenced = re.fullmatch(r"```(?:text)?\s*([^`]+?)\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    text = text.strip("`\u2018\u2019\u201c\u201d\"'").strip()
    return text.rstrip(".。!！").strip()


def marker_oracle(
    answer: str,
    expected: str,
    *,
    forbidden_markers: Iterable[str] = (),
) -> tuple[bool, str, list[str]]:
    normalized = normalize_answer(answer)
    stale = sorted(
        {
            marker
            for marker in forbidden_markers
            if marker and marker != expected and marker in normalized
        }
    )
    if stale:
        return False, "historical_or_prompt_marker_returned", stale
    if expected not in normalized:
        return False, "current_marker_missing", []
    if normalized.count(expected) != 1:
        return False, "current_marker_ambiguous", []
    return True, "current_marker_present_once", []


def request_challenge_markers(messages: Iterable[dict[str, str]]) -> set[str]:
    markers: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        markers.update(re.findall(r"REQ_[A-Za-z0-9_]+", str(message.get("content") or "")))
    return markers


def read_jsonl_from(path: Path, offset: int) -> tuple[list[dict[str, Any]], int]:
    if not path.exists():
        return [], offset
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        handle.seek(offset)
        for line in handle:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                events.append(item)
        return events, handle.tell()


def trace_offset(path: Path) -> int:
    return path.stat().st_size if path.exists() else 0


def event_job_id(event: dict[str, Any]) -> str:
    details = event.get("details") if isinstance(event.get("details"), dict) else {}
    return str(event.get("job_id") or details.get("jobId") or details.get("job_id") or "")


def trace_evidence(events: list[dict[str, Any]], job_id: str, domain: str) -> dict[str, Any]:
    job_events = [event for event in events if event_job_id(event) == job_id]
    attempts = [event for event in job_events if event.get("message") == "browser_capture_message_attempt"]
    dispatched = [event for event in job_events if event.get("message") == "browser_capture_message_dispatched"]
    wake_events = [
        event
        for event in events
        if str(event.get("kind") or "").startswith("browser_wake_")
        and (
            str(event.get("domain") or "").lower() == domain
            or (urlparse(str(event.get("target_url") or "")).hostname or "").lower() == domain
        )
    ]
    return {
        "attempt_count": len(attempts),
        "dispatched_count": len(dispatched),
        "wake_events": [
            {
                key: event.get(key)
                for key in ("kind", "mode", "domain", "target_url", "wake_event_id", "time")
                if key in event
            }
            for event in wake_events
        ],
    }


def boundary_outcomes(
    *,
    outcome: str,
    wake_ok: bool | None = None,
    content_ready_ok: bool | None = None,
    send_ok: bool | None = None,
    response_ok: bool | None = None,
    cleanup_ok: bool | None = None,
) -> dict[str, str]:
    values = {
        "wake": wake_ok,
        "content_ready": content_ready_ok,
        "send": send_ok,
        "response": response_ok,
        "cleanup": cleanup_ok,
    }
    if outcome == "UNPROVEN":
        return {key: "UNPROVEN" for key in values}
    return {
        key: "PASS" if value is True else "FAIL" if value is False else "NOT_APPLICABLE"
        for key, value in values.items()
    }


def status_snapshot(api: str) -> dict[str, Any]:
    status, payload, _ = curl_json(api, "/browser/status", timeout=5)
    if status != 200 or not isinstance(payload, dict):
        raise AcceptanceError(f"browser status failed: status={status} body={payload}")
    return payload


def ready_client(
    snapshot: dict[str, Any],
    domain: str,
    *,
    min_last_seen: float | None = None,
    expected_background_version: str = "",
    expected_content_script_version: str = "",
    expected_client_id: str = "",
    tab_id: int | str | None = None,
) -> dict[str, Any] | None:
    clients = snapshot.get("clients") if isinstance(snapshot.get("clients"), dict) else {}
    for client in clients.values():
        if not isinstance(client, dict):
            continue
        capabilities = client.get("capabilities") if isinstance(client.get("capabilities"), dict) else {}
        if (
            str(client.get("domain") or "").lower() == domain
            and (
                not expected_background_version
                or str(client.get("background_version") or "") == expected_background_version
            )
            and (
                not expected_content_script_version
                or str(client.get("content_script_version") or "") == expected_content_script_version
            )
            and (
                not expected_client_id
                or str(client.get("client_id") or "") == expected_client_id
            )
            and (tab_id is None or str(client.get("tab_id")) == str(tab_id))
            and client.get("source") == "content-ready"
            and client.get("state") == "ready"
            and client.get("ready") is True
            and client.get("input_ready") is True
            and client.get("send_ready") is True
            and bool(str(client.get("runtime_session_id") or "").strip())
            and capabilities.get("can_execute") is True
            and capabilities.get("can_observe") is True
            and (
                min_last_seen is None
                or float(client.get("last_seen") or 0) >= min_last_seen
            )
        ):
            return client
    return None


def runtime_session_ids(snapshot: dict[str, Any], domain: str) -> set[str]:
    clients = snapshot.get("clients") if isinstance(snapshot.get("clients"), dict) else {}
    expected_domain = str(domain or "").strip().lower()
    return {
        runtime_session_id
        for client in clients.values()
        if isinstance(client, dict)
        and str(client.get("domain") or "").strip().lower() == expected_domain
        if (runtime_session_id := str(client.get("runtime_session_id") or "").strip())
    }


def runtime_evidence_ok(
    client: dict[str, Any] | None,
    terminal_job: dict[str, Any] | None,
    *,
    expected_client_id: str,
    expected_background_version: str,
    expected_content_script_version: str,
    preexisting_runtime_session_ids: Iterable[str] = (),
    require_new_runtime: bool = False,
) -> bool:
    if not isinstance(client, dict) or not isinstance(terminal_job, dict):
        return False
    client_id = str(client.get("client_id") or "").strip()
    terminal_client_id = str(terminal_job.get("client_id") or "").strip()
    expected_client_id = str(expected_client_id or "").strip()
    runtime_session_id = str(client.get("runtime_session_id") or "").strip()
    client_tab_id = client.get("tab_id")
    terminal_tab_id = terminal_job.get("tab_id")
    if not expected_client_id or not runtime_session_id:
        return False
    if client_id != expected_client_id or terminal_client_id != expected_client_id:
        return False
    if client_tab_id is None or terminal_tab_id is None or str(client_tab_id) != str(terminal_tab_id):
        return False
    if str(client.get("background_version") or "") != expected_background_version:
        return False
    if str(client.get("content_script_version") or "") != expected_content_script_version:
        return False
    if require_new_runtime and runtime_session_id in {
        str(item or "").strip() for item in preexisting_runtime_session_ids
    }:
        return False
    return True


def current_background_version() -> str:
    """Read the build identity that a live worker must advertise."""
    source = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    match = re.search(
        r"__phantomRelayBackgroundVersion\s*=\s*['\"]([^'\"]+)['\"]",
        source,
    )
    if not match:
        raise AcceptanceError("current_extension_background_version_missing")
    return match.group(1)


def current_content_script_version() -> str:
    """Read the content build identity expected from the actual page runtime."""
    source = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
    match = re.search(
        r"const\s+CONTENT_SCRIPT_VERSION\s*=\s*['\"]([^'\"]+)['\"]",
        source,
    )
    if not match:
        raise AcceptanceError("current_extension_content_script_version_missing")
    return match.group(1)


def wait_for_idle(api: str, timeout: float = 20) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = status_snapshot(api)
        if not last.get("jobs") and int(last.get("queue_depth") or 0) == 0:
            return last
        time.sleep(READY_POLL_SECONDS)
    raise AcceptanceError(f"browser queue did not become idle: {last.get('jobs')}")


def resolve_browser_app(bundle_id: str) -> tuple[Path, Path]:
    query = f"kMDItemCFBundleIdentifier == '{bundle_id}'"
    found = run_command(["mdfind", query], timeout=10)
    candidates = [Path(line.strip()) for line in found.stdout.splitlines() if line.strip().endswith(".app")]
    if not candidates:
        raise AcceptanceError(f"browser application not found for bundle id {bundle_id}")
    app = sorted(candidates, key=lambda path: ("/Applications/" not in str(path), len(str(path))))[0]
    with (app / "Contents" / "Info.plist").open("rb") as handle:
        info = plistlib.load(handle)
    executable = str(info.get("CFBundleExecutable") or "").strip()
    binary = app / "Contents" / "MacOS" / executable
    if not executable or not binary.exists():
        raise AcceptanceError(f"browser executable missing for {app}")
    return app, binary


def browser_pids(binary: Path) -> list[int]:
    completed = run_command(["pgrep", "-f", str(binary)], timeout=5)
    if completed.returncode not in {0, 1}:
        raise AcceptanceError(f"unable to inspect browser process: {completed.stderr.strip()}")
    return [int(line) for line in completed.stdout.splitlines() if line.strip().isdigit()]


def quit_browser(
    bundle_id: str,
    binary: Path,
    timeout: float = 20,
    *,
    require_running: bool = False,
) -> dict[str, Any]:
    before = browser_pids(binary)
    if require_running and not before:
        raise AcceptanceError("immediate crash precondition failed: browser was not running")
    if before:
        script = f'tell application id "{bundle_id}" to quit'
        completed = run_command(["osascript", "-e", script], timeout=10)
        if completed.returncode != 0:
            raise AcceptanceError(f"browser quit failed: {completed.stderr.strip()}")
    deadline = time.monotonic() + timeout
    remaining = before
    while time.monotonic() < deadline:
        remaining = browser_pids(binary)
        if not remaining:
            return {"pids_before": before, "pids_after": [], "quit": True}
        time.sleep(0.25)
    raise AcceptanceError(f"browser did not exit within {timeout}s: pids={remaining}")


def wait_until_no_recent_ready_clients(
    api: str,
    timeout: float = 30,
    recent_window: float = WAKE_RECENT_WINDOW_SECONDS,
) -> float:
    started = time.monotonic()
    deadline = started + timeout
    while time.monotonic() < deadline:
        snapshot = status_snapshot(api)
        clients = snapshot.get("clients") if isinstance(snapshot.get("clients"), dict) else {}
        now = time.time()
        if not any(
            isinstance(value, dict)
            and value.get("ready") is True
            and value.get("source") == "content-ready"
            and now - float(value.get("last_seen") or 0) < recent_window
            for value in clients.values()
        ):
            return time.monotonic() - started
        time.sleep(READY_POLL_SECONDS)
    raise AcceptanceError("request-path ready window did not expire after browser shutdown")


def request_command(
    api: str,
    case: AcceptanceCase,
    *,
    idempotency_key: str,
    timeout: int,
) -> list[str]:
    body = {
        "model": case.target_model,
        "messages": list(case.messages),
        "stream": False,
        "timeout": timeout,
        "phantom_relay": {
            "context_id": f"acceptance-{case.case_id}",
            "new_context": True,
        },
    }
    return [
        "curl",
        "-sS",
        "--max-time",
        str(timeout + 20),
        "--write-out",
        "\n__PHANTOM_HTTP_STATUS__:%{http_code}\n",
        "-H",
        "Content-Type: application/json",
        "-H",
        f"Idempotency-Key: {idempotency_key}",
        api.rstrip("/") + "/v1/chat/completions",
        "-d",
        json.dumps(body, ensure_ascii=False, separators=(",", ":")),
    ]


def parse_chat_response(raw: str) -> tuple[int, dict[str, Any] | None, str]:
    marker = "\n__PHANTOM_HTTP_STATUS__:"
    if marker not in raw:
        return 0, None, raw
    body_text, status_text = raw.rsplit(marker, 1)
    try:
        status = int(status_text.strip())
    except ValueError:
        status = 0
    try:
        body = json.loads(body_text)
    except json.JSONDecodeError:
        body = None
    return status, body, body_text


def response_content(body: dict[str, Any] | None) -> str:
    if not isinstance(body, dict):
        return ""
    choices = body.get("choices") if isinstance(body.get("choices"), list) else []
    if not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message") if isinstance(choices[0].get("message"), dict) else {}
    return str(message.get("content") or "")


def new_job_id(before: dict[str, Any], current: dict[str, Any]) -> str | None:
    before_ids = set((before.get("jobs") or {})) | set((before.get("terminal_jobs") or {}))
    current_ids = set((current.get("jobs") or {})) | set((current.get("terminal_jobs") or {}))
    created = sorted(current_ids - before_ids)
    return created[0] if len(created) == 1 else None


def run_live_case(
    case: AcceptanceCase,
    *,
    api: str,
    trace_path: Path,
    browser_bundle_id: str | None,
    browser_binary: Path | None,
    timeout: int,
    historical_markers: Iterable[str] = (),
) -> dict[str, Any]:
    wait_for_idle(api)
    setup: dict[str, Any] = {"shutdown_mode": case.shutdown_mode}
    if case.shutdown_mode != "none":
        if not browser_bundle_id or browser_binary is None:
            raise AcceptanceError("cold/crash cases require --browser-bundle-id")
        setup.update(
            quit_browser(
                browser_bundle_id,
                browser_binary,
                require_running=case.shutdown_mode == "immediate",
            )
        )
        if case.shutdown_mode == "expired":
            setup["ready_window_expiry_wait_seconds"] = round(
                wait_until_no_recent_ready_clients(api), 3
            )

    before = status_snapshot(api)
    preexisting_runtime_session_ids = runtime_session_ids(before, case.target_domain)
    offset = trace_offset(trace_path)
    idempotency_key = f"live-acceptance-{case.case_id}-{uuid.uuid4().hex}"
    command = request_command(
        api,
        case,
        idempotency_key=idempotency_key,
        timeout=timeout,
    )
    started_wall = time.time()
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    job_id: str | None = None
    first_ready_seconds: float | None = None
    first_browser_pid_seconds: float | None = None
    observed_client: dict[str, Any] | None = None
    claimed_tab_id: int | str | None = None
    claimed_client_id = ""
    expected_background_version = current_background_version()
    expected_content_script_version = current_content_script_version()
    latest = before
    while process.poll() is None:
        try:
            latest = status_snapshot(api)
            job_id = job_id or new_job_id(before, latest)
            current_job = (latest.get("jobs") or {}).get(job_id or "")
            if isinstance(current_job, dict) and current_job.get("status") == "claimed":
                current_client_id = str(current_job.get("client_id") or "").strip()
                current_tab_id = current_job.get("tab_id")
                if not claimed_client_id and current_client_id and current_tab_id is not None:
                    claimed_client_id = current_client_id
                    claimed_tab_id = current_tab_id
            if claimed_client_id and claimed_tab_id is not None:
                client = ready_client(
                    latest,
                    case.target_domain,
                    min_last_seen=started_wall if case.shutdown_mode != "none" else None,
                    expected_background_version=expected_background_version,
                    expected_content_script_version=expected_content_script_version,
                    expected_client_id=claimed_client_id,
                    tab_id=claimed_tab_id,
                )
                if client and first_ready_seconds is None:
                    first_ready_seconds = time.monotonic() - started
                    observed_client = client
            if browser_binary is not None and first_browser_pid_seconds is None:
                if browser_pids(browser_binary):
                    first_browser_pid_seconds = time.monotonic() - started
        except (AcceptanceError, subprocess.TimeoutExpired):
            pass
        time.sleep(READY_POLL_SECONDS)
    stdout, stderr = process.communicate()
    elapsed = time.monotonic() - started
    latest = status_snapshot(api)
    job_id = job_id or new_job_id(before, latest)
    status, body, raw_body = parse_chat_response(stdout)
    answer = response_content(body)

    trace_deadline = time.monotonic() + 3
    events: list[dict[str, Any]] = []
    while time.monotonic() < trace_deadline:
        events, _ = read_jsonl_from(trace_path, offset)
        evidence = trace_evidence(events, job_id or "", case.target_domain)
        if evidence["attempt_count"] and evidence["dispatched_count"]:
            break
        time.sleep(0.2)
    evidence = trace_evidence(events, job_id or "", case.target_domain)
    final = wait_for_idle(api, timeout=10)
    terminal = (final.get("terminal_jobs") or {}).get(job_id or "", {})
    if not claimed_client_id and isinstance(terminal, dict):
        claimed_client_id = str(terminal.get("client_id") or "").strip()
        claimed_tab_id = terminal.get("tab_id")
    terminal_client = ready_client(
        final,
        case.target_domain,
        expected_background_version=expected_background_version,
        expected_content_script_version=expected_content_script_version,
        expected_client_id=claimed_client_id,
        tab_id=terminal.get("tab_id") if isinstance(terminal, dict) else None,
    )
    if terminal_client is not None:
        observed_client = terminal_client

    forbidden = set(case.forbidden_markers)
    forbidden.update(case.allowed_context_markers)
    forbidden.update(historical_markers)
    forbidden.update(request_challenge_markers(case.messages))
    marker_ok, oracle_reason, stale_markers = marker_oracle(
        answer,
        case.expected,
        forbidden_markers=forbidden,
    )
    exactly_once = evidence["attempt_count"] == 1 and evidence["dispatched_count"] == 1
    runtime_ok = runtime_evidence_ok(
        observed_client,
        terminal,
        expected_client_id=claimed_client_id,
        expected_background_version=expected_background_version,
        expected_content_script_version=expected_content_script_version,
        preexisting_runtime_session_ids=preexisting_runtime_session_ids,
        require_new_runtime=case.shutdown_mode != "none",
    )
    cold_wake_ok = True
    if case.shutdown_mode != "none":
        wake_kinds = {event.get("kind") for event in evidence["wake_events"]}
        cold_wake_ok = bool(
            "browser_wake_requested" in wake_kinds
            and first_browser_pid_seconds is not None
            and first_ready_seconds is not None
        )
    response_ok = bool(
        process.returncode == 0
        and status == 200
        and marker_ok
        and not stale_markers
        and job_id
        and terminal.get("status") == "completed"
        and runtime_ok
    )
    cleanup_ok = not final.get("jobs") and int(final.get("queue_depth") or 0) == 0
    passed = bool(response_ok and exactly_once and cold_wake_ok and cleanup_ok)
    failure_class = None
    if not passed:
        error = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
        if terminal.get("error"):
            failure_class = str(terminal.get("error"))
        elif not runtime_ok:
            failure_class = "stale_extension_runtime"
        elif stale_markers:
            failure_class = "wrong_or_stale_response"
        elif not marker_ok:
            failure_class = "response_oracle_failed"
        elif not exactly_once:
            failure_class = "send_exactly_once_failed"
        elif not cold_wake_ok:
            failure_class = "browser_cold_wake_failed"
        elif error.get("code"):
            failure_class = str(error.get("code"))
        elif process.returncode != 0:
            failure_class = "curl_process_failed"
        else:
            failure_class = "acceptance_invariant_failed"

    return {
        "case_id": case.case_id,
        "phase": case.phase,
        "sequence": list(case.sequence),
        "target_model": case.target_model,
        "target_domain": case.target_domain,
        "expected": case.expected,
        "started_at": datetime.fromtimestamp(started_wall, timezone.utc).isoformat(),
        "elapsed_seconds": round(elapsed, 3),
        "idempotency_key": idempotency_key,
        "job_id": job_id,
        "http_status": status,
        "curl_returncode": process.returncode,
        "curl_stderr": stderr.strip(),
        "response_content": answer,
        "raw_body": raw_body[:4000],
        "oracle_reason": oracle_reason,
        "stale_context_markers": stale_markers,
        "terminal_job": terminal,
        "trace_evidence": evidence,
        "setup": setup,
        "first_browser_pid_seconds": (
            round(first_browser_pid_seconds, 3)
            if first_browser_pid_seconds is not None
            else None
        ),
        "first_ready_seconds": round(first_ready_seconds, 3) if first_ready_seconds is not None else None,
        "ready_client": observed_client,
        "claimed_client_id": claimed_client_id,
        "claimed_tab_id": claimed_tab_id,
        "preexisting_runtime_session_ids": sorted(preexisting_runtime_session_ids),
        "expected_background_version": expected_background_version,
        "expected_content_script_version": expected_content_script_version,
        "runtime_evidence_ok": runtime_ok,
        "queue_empty": not final.get("jobs") and int(final.get("queue_depth") or 0) == 0,
        "outcome": "PASS" if passed else "FAIL",
        "boundary_outcomes": boundary_outcomes(
            outcome="PASS" if passed else "FAIL",
            wake_ok=cold_wake_ok if case.shutdown_mode != "none" else None,
            content_ready_ok=first_ready_seconds is not None,
            send_ok=exactly_once,
            response_ok=response_ok,
            cleanup_ok=cleanup_ok,
        ),
        "passed": passed,
        "failure_class": failure_class,
    }


def single_case(
    model: RecordedModel,
    *,
    phase: str,
    run_id: str,
    index: int,
    shutdown_mode: str = "none",
) -> AcceptanceCase:
    marker = rendering_stable_marker("ACK", phase, run_id, model.domain, index)
    prompt = (
        "这是纯字符串处理任务。不需要联网搜索，不要引用资料，不要调用工具，不要解释。"
        "请原样复制下面这一行，逐字符保留全部内容，不能转换、不能修改、不能省略。"
        f"只回复这一行的完整内容：{marker}"
    )
    return AcceptanceCase(
        case_id=f"{phase}-{compact_id(model.domain).lower()}-{index:03d}",
        phase=phase,
        sequence=(model.model_id,),
        target_model=model.model_id,
        target_domain=model.domain,
        messages=({"role": "user", "content": prompt},),
        expected=marker,
        shutdown_mode=shutdown_mode,
    )


def transformed_marker(source: str, old_prefix: str, new_prefix: str) -> str:
    if not source.startswith(old_prefix):
        raise ValueError(f"source marker does not begin with {old_prefix}: {source}")
    return new_prefix + source[len(old_prefix) :]


def extract_unique_context_marker(answer: str, prefix: str) -> str:
    matches = sorted(set(re.findall(rf"{re.escape(prefix)}[A-Za-z0-9_]+", str(answer or ""))))
    if len(matches) != 1:
        raise ValueError(
            f"expected exactly one {prefix} context marker, found {len(matches)}"
        )
    return matches[0]


def context_case(
    target: RecordedModel,
    *,
    phase: str,
    case_id: str,
    sequence: tuple[str, ...],
    prior_messages: list[dict[str, str]],
    source_answer: str,
    source_prefix: str,
    target_prefix: str,
) -> AcceptanceCase:
    source_marker = extract_unique_context_marker(source_answer, source_prefix)
    expected = transformed_marker(source_marker, source_prefix, target_prefix)
    instruction = (
        "这是纯字符串处理任务。不需要联网搜索，不要引用资料，不要调用工具，不要解释。"
        "逐字符复制上一条 assistant 消息中的输入标记，唯一允许的改动是把开头的 "
        f"{source_prefix} 替换为 {target_prefix}，后缀必须原样保留。"
        f"不能只回复 {target_prefix}，不能省略后缀。只回复转换后的完整标记，不要加标点。"
    )
    messages = list(prior_messages)
    messages.append({"role": "assistant", "content": source_answer})
    messages.append({"role": "user", "content": instruction})
    context_markers = tuple(
        marker
        for message in messages
        if message.get("role") == "assistant"
        for marker in re.findall(r"(?:CTXA|CTXB|CTXC)[A-Za-z0-9_]+", message.get("content") or "")
    )
    return AcceptanceCase(
        case_id=case_id,
        phase=phase,
        sequence=sequence,
        target_model=target.model_id,
        target_domain=target.domain,
        messages=tuple(messages),
        expected=expected,
        allowed_context_markers=context_markers,
    )


def append_jsonl(path: Path, item: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def unproven_result(
    case: AcceptanceCase,
    *,
    reason: str,
    prerequisite: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "case_id": case.case_id,
        "phase": case.phase,
        "sequence": list(case.sequence),
        "target_model": case.target_model,
        "target_domain": case.target_domain,
        "expected": case.expected,
        "started_at": utc_now(),
        "outcome": "UNPROVEN",
        "passed": False,
        "failure_class": None,
        "unproven_reason": reason,
        "prerequisite_case_id": case.prerequisite_case_id,
        "prerequisite": prerequisite,
        "boundary_outcomes": boundary_outcomes(outcome="UNPROVEN"),
    }


def summarize(
    results: list[dict[str, Any]],
    confidence: float,
    threshold: float,
    *,
    inventory_blockers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    by_model: dict[str, list[dict[str, Any]]] = {}
    by_phase: dict[str, list[dict[str, Any]]] = {}
    by_model_phase: dict[str, list[dict[str, Any]]] = {}
    by_path: dict[str, list[dict[str, Any]]] = {}
    for result in results:
        model = str(result.get("target_domain") or result.get("target_model") or "")
        phase = str(result.get("phase") or "")
        sequence_values = result.get("sequence") if isinstance(result.get("sequence"), list) else []
        sequence = " -> ".join(str(value) for value in sequence_values)
        if model:
            by_model.setdefault(model, []).append(result)
        if phase:
            by_phase.setdefault(phase, []).append(result)
        if model and phase:
            by_model_phase.setdefault(f"{model}::{phase}", []).append(result)
        if sequence and len(sequence_values) >= 2:
            by_path.setdefault(sequence, []).append(result)

    def group_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
        scheduled = len(items)
        proven = [item for item in items if str(item.get("outcome") or "") != "UNPROVEN"]
        trials = len(proven)
        unproven = scheduled - trials
        successes = sum(1 for item in proven if item.get("passed") is True)
        observed = successes / trials if trials else 0.0
        lower = clopper_pearson_lower(successes, trials, confidence) if trials else 0.0
        failures: dict[str, int] = {}
        for item in proven:
            if item.get("passed") is not True:
                key = str(item.get("failure_class") or "unknown")
                failures[key] = failures.get(key, 0) + 1
        return {
            "scheduled": scheduled,
            "trials": trials,
            "unproven": unproven,
            "successes": successes,
            "failures": trials - successes,
            "observed_success_rate": round(observed, 6),
            "one_sided_confidence": confidence,
            "clopper_pearson_lower": round(lower, 6),
            "observed_threshold_met": trials > 0 and observed >= threshold,
            "confidence_threshold_met": trials > 0 and lower >= threshold,
            "coverage_complete": scheduled > 0 and unproven == 0,
            "failure_classes": failures,
        }

    critical_failures = [
        item
        for item in results
        if item.get("failure_class") in {"wrong_or_stale_response", "send_exactly_once_failed"}
    ]
    blockers = list(inventory_blockers or [])
    summary = {
        "generated_at": utc_now(),
        "threshold": threshold,
        "confidence": confidence,
        "overall": group_summary(results),
        "by_model": {key: group_summary(value) for key, value in sorted(by_model.items())},
        "by_phase": {key: group_summary(value) for key, value in sorted(by_phase.items())},
        "by_model_phase": {
            key: group_summary(value) for key, value in sorted(by_model_phase.items())
        },
        "by_path": {
            key: group_summary(value) for key, value in sorted(by_path.items())
        },
        "critical_failure_count": len(critical_failures),
        "inventory_blockers": blockers,
    }
    reliability_cells = {
        key: value
        for key, value in summary["by_model_phase"].items()
        if key.rsplit("::", 1)[-1] in RELIABILITY_PHASES
    }
    coverage_cells = {
        key: value
        for key, value in summary["by_model_phase"].items()
        if key.rsplit("::", 1)[-1] in COVERAGE_ONLY_PHASES
    }
    summary["release_gate_passed"] = bool(
        not critical_failures
        and not blockers
        and summary["overall"]["coverage_complete"]
        and reliability_cells
        and all(value["coverage_complete"] for value in reliability_cells.values())
        and all(value["observed_threshold_met"] for value in reliability_cells.values())
        and all(value["confidence_threshold_met"] for value in reliability_cells.values())
        and all(value["coverage_complete"] for value in coverage_cells.values())
        and all(value["observed_threshold_met"] for value in coverage_cells.values())
        and summary["by_path"]
        and all(value["coverage_complete"] for value in summary["by_path"].values())
        and all(value["observed_threshold_met"] for value in summary["by_path"].values())
        and all(value["confidence_threshold_met"] for value in summary["by_path"].values())
    )
    return summary


def select_models(models: list[RecordedModel], requested: list[str]) -> list[RecordedModel]:
    if not requested:
        return models
    wanted = {value.strip().lower() for value in requested if value.strip()}
    selected = [
        model
        for model in models
        if model.domain.lower() in wanted
        or model.model_id.lower() in wanted
        or wanted.intersection(alias.lower() for alias in model.aliases)
    ]
    missing = wanted - {
        value.lower()
        for model in selected
        for value in (model.domain, model.model_id, *model.aliases)
    }
    if missing:
        raise AcceptanceError(f"requested models were not discovered: {sorted(missing)}")
    return selected


def run_case_and_record(
    case: AcceptanceCase,
    *,
    args: argparse.Namespace,
    results_path: Path,
    results: list[dict[str, Any]],
    browser_binary: Path | None,
) -> dict[str, Any]:
    print(
        json.dumps(
            {
                "event": "case_start",
                "case_id": case.case_id,
                "phase": case.phase,
                "sequence": case.sequence,
                "target": case.target_model,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    prerequisite = None
    if case.prerequisite_case_id:
        prerequisite = next(
            (
                item
                for item in reversed(results)
                if item.get("case_id") == case.prerequisite_case_id
            ),
            None,
        )
        if not prerequisite or prerequisite.get("outcome") != "PASS":
            result = unproven_result(
                case,
                reason="prerequisite_failed",
                prerequisite=prerequisite,
            )
            results.append(result)
            append_jsonl(results_path, result)
            print(json.dumps({"event": "case_result", **result}, ensure_ascii=False), flush=True)
            return result
    try:
        result = run_live_case(
            case,
            api=args.api,
            trace_path=Path(args.trace),
            browser_bundle_id=args.browser_bundle_id,
            browser_binary=browser_binary,
            timeout=args.timeout,
            historical_markers=(
                str(item.get("expected") or "")
                for item in results
                if item.get("expected")
            ),
        )
    except Exception as exc:
        result = {
            "case_id": case.case_id,
            "phase": case.phase,
            "sequence": list(case.sequence),
            "target_model": case.target_model,
            "target_domain": case.target_domain,
            "expected": case.expected,
            "started_at": utc_now(),
            "outcome": "FAIL",
            "passed": False,
            "failure_class": "test_environment_or_setup_failed",
            "exception": f"{type(exc).__name__}: {exc}",
            "boundary_outcomes": {
                key: "UNPROVEN"
                for key in ("wake", "content_ready", "send", "response", "cleanup")
            },
        }
    results.append(result)
    append_jsonl(results_path, result)
    print(json.dumps({"event": "case_result", **result}, ensure_ascii=False), flush=True)
    return result


def qualification_cases(
    models: list[RecordedModel],
    run_id: str,
    startup_repeats: int,
    seed: int,
) -> list[AcceptanceCase]:
    cases = [
        single_case(model, phase="warm", run_id=run_id, index=1)
        for model in models
    ]
    for model in models:
        for alias_index, alias in enumerate(
            (value for value in model.aliases if value != model.model_id),
            start=1,
        ):
            base = single_case(
                model,
                phase="alias_route",
                run_id=run_id,
                index=alias_index,
            )
            cases.append(
                AcceptanceCase(
                    case_id=f"alias-{compact_id(alias).lower()}-{alias_index:03d}",
                    phase=base.phase,
                    sequence=(alias,),
                    target_model=alias,
                    target_domain=model.domain,
                    messages=base.messages,
                    expected=base.expected,
                )
            )
    rng = random.Random(seed)
    for repeat in range(1, startup_repeats + 1):
        ordered = list(models)
        rng.shuffle(ordered)
        for model in ordered:
            cases.append(
                single_case(
                    model,
                    phase="cold",
                    run_id=run_id,
                    index=repeat,
                    shutdown_mode="expired",
                )
            )
    for repeat in range(1, startup_repeats + 1):
        ordered = list(models)
        rng.shuffle(ordered)
        for model in ordered:
            prepare = single_case(
                model,
                phase="crash_prepare",
                run_id=run_id,
                index=repeat,
            )
            cases.append(prepare)
            crash = single_case(
                model,
                phase="crash",
                run_id=run_id,
                index=repeat,
                shutdown_mode="immediate",
            )
            cases.append(
                AcceptanceCase(
                    **{
                        **asdict(crash),
                        "prerequisite_case_id": prepare.case_id,
                    }
                )
            )
    return cases


def run_context_repeat(
    models: list[RecordedModel],
    *,
    repeat: int,
    run_id: str,
    args: argparse.Namespace,
    results_path: Path,
    results: list[dict[str, Any]],
    browser_binary: Path | None,
) -> bool:
    model_by_id = {model.model_id: model for model in models}
    seeds: dict[str, dict[str, Any]] = {}
    pair_results: dict[tuple[str, str], dict[str, Any]] = {}

    for model in models:
        prefix = "CTXA"
        marker = rendering_stable_marker(
            prefix,
            "context_seed",
            run_id,
            repeat,
            model.domain,
        )
        case = AcceptanceCase(
            case_id=f"context-r{repeat:03d}-seed-{compact_id(model.domain).lower()}",
            phase="context_seed",
            sequence=(model.model_id,),
            target_model=model.model_id,
            target_domain=model.domain,
            messages=(
                {
                    "role": "user",
                    "content": f"请只回复以下验收标记，不要解释、不要加标点：{marker}",
                },
            ),
            expected=marker,
        )
        result = run_case_and_record(
            case,
            args=args,
            results_path=results_path,
            results=results,
            browser_binary=browser_binary,
        )
        seeds[model.model_id] = {"case": case, "result": result}

    pairs = list(itertools.permutations([model.model_id for model in models], 2))
    random.Random(args.seed + repeat * 1009).shuffle(pairs)
    for source_id, target_id in pairs:
        source = seeds[source_id]
        source_case: AcceptanceCase = source["case"]
        target = model_by_id[target_id]
        pair_id = (
            f"context-r{repeat:03d}-pair-{compact_id(source_id).lower()}-"
            f"to-{compact_id(target_id).lower()}"
        )
        source_result = source["result"]
        if source_result.get("outcome") != "PASS":
            pair_case = AcceptanceCase(
                case_id=pair_id,
                phase="context_pair",
                sequence=(source_id, target_id),
                target_model=target.model_id,
                target_domain=target.domain,
                messages=(),
                expected="",
                prerequisite_case_id=source_case.case_id,
            )
            result = unproven_result(
                pair_case,
                reason="context_prefix_failed",
                prerequisite=source_result,
            )
            results.append(result)
            append_jsonl(results_path, result)
            print(json.dumps({"event": "case_result", **result}, ensure_ascii=False), flush=True)
        else:
            source_answer = normalize_answer(str(source_result.get("response_content") or ""))
            pair_case = context_case(
                target,
                phase="context_pair",
                case_id=pair_id,
                sequence=(source_id, target_id),
                prior_messages=[dict(message) for message in source_case.messages],
                source_answer=source_answer,
                source_prefix="CTXA",
                target_prefix="CTXB",
            )
            result = run_case_and_record(
                pair_case,
                args=args,
                results_path=results_path,
                results=results,
                browser_binary=browser_binary,
            )
        pair_results[(source_id, target_id)] = {"case": pair_case, "result": result}

    triples = adjacent_distinct_triples([model.model_id for model in models])
    random.Random(args.seed + repeat * 2017).shuffle(triples)
    for first_id, second_id, third_id in triples:
        prefix = pair_results[(first_id, second_id)]
        pair_case: AcceptanceCase = prefix["case"]
        target = model_by_id[third_id]
        phase = "context_switchback" if first_id == third_id else "context_three_distinct"
        triple_id = (
            f"context-r{repeat:03d}-triple-{compact_id(first_id).lower()}-"
            f"{compact_id(second_id).lower()}-{compact_id(third_id).lower()}"
        )
        prefix_result = prefix["result"]
        if prefix_result.get("outcome") != "PASS":
            triple_case = AcceptanceCase(
                case_id=triple_id,
                phase=phase,
                sequence=(first_id, second_id, third_id),
                target_model=target.model_id,
                target_domain=target.domain,
                messages=(),
                expected="",
                prerequisite_case_id=pair_case.case_id,
            )
            result = unproven_result(
                triple_case,
                reason="context_prefix_failed",
                prerequisite=prefix_result,
            )
            results.append(result)
            append_jsonl(results_path, result)
            print(json.dumps({"event": "case_result", **result}, ensure_ascii=False), flush=True)
        else:
            pair_answer = normalize_answer(str(prefix_result.get("response_content") or ""))
            triple_case = context_case(
                target,
                phase=phase,
                case_id=triple_id,
                sequence=(first_id, second_id, third_id),
                prior_messages=[dict(message) for message in pair_case.messages],
                source_answer=pair_answer,
                source_prefix="CTXB",
                target_prefix="CTXC",
            )
            run_case_and_record(
                triple_case,
                args=args,
                results_path=results_path,
                results=results,
                browser_binary=browser_binary,
            )
    return all(result.get("outcome") == "PASS" for result in results if result.get("phase", "").startswith("context_"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inventory", "plan", "run"))
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--trace", default=str(DEFAULT_TRACE))
    parser.add_argument("--models", nargs="*", default=[])
    parser.add_argument(
        "--evidence-level",
        choices=("coverage", "release"),
        default="coverage",
    )
    parser.add_argument(
        "--startup-repeats",
        "--cold-repeats",
        dest="startup_repeats",
        type=int,
        default=0,
        help="0 means N for coverage or the exact confidence floor for release",
    )
    parser.add_argument(
        "--path-repeats",
        "--context-sweeps",
        dest="path_repeats",
        type=int,
        default=0,
        help="0 means 1 for coverage or the exact confidence floor for release",
    )
    parser.add_argument("--suite", choices=("qualification", "context", "full"), default="full")
    parser.add_argument("--browser-bundle-id")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--seed", type=int, default=5550)
    parser.add_argument("--threshold", type=float, default=0.95)
    parser.add_argument("--confidence", type=float, default=0.95)
    parser.add_argument("--results-root", default=str(DEFAULT_RESULTS))
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument(
        "--continue-qualification-failures",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.startup_repeats < 0 or args.path_repeats < 0:
        raise AcceptanceError("repeat counts cannot be negative")
    if not 0 < args.threshold <= 1 or not 0 < args.confidence < 1:
        raise AcceptanceError("threshold and confidence must be between 0 and 1")

    models, inventory = discover_recorded_models(args.api)
    models = select_models(models, args.models)
    release_floor = minimum_perfect_trials(args.threshold, args.confidence)
    startup_repeats = args.startup_repeats or (
        release_floor if args.evidence_level == "release" else len(models)
    )
    path_repeats = args.path_repeats or (
        release_floor if args.evidence_level == "release" else 1
    )
    if startup_repeats < 1 or path_repeats < 1:
        raise AcceptanceError("repeat counts must be positive")
    alias_checks = sum(
        1 for model in models for alias in model.aliases if alias != model.model_id
    )
    counts = matrix_counts(
        len(models),
        startup_repeats,
        path_repeats,
        alias_checks=alias_checks,
    )

    if args.command == "inventory":
        print(json.dumps(inventory, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    if args.command == "plan":
        print(
            json.dumps(
                {
                    "inventory": inventory,
                    "selected_models": [asdict(model) for model in models],
                    "evidence_level": args.evidence_level,
                    "minimum_perfect_trials": release_floor,
                    "counts": counts,
                    "gates": {
                        "coverage": "every required case passes",
                        "observed_reliability": f"per-model success rate >= {args.threshold:.1%}",
                        "confidence_reliability": (
                            f"one-sided {args.confidence:.1%} Clopper-Pearson lower bound "
                            f">= {args.threshold:.1%}"
                        ),
                        "release_requires": (
                            "--evidence-level release and every model x reliability phase "
                            "and every directed context path meeting the confidence gate"
                        ),
                        "critical_zero_tolerance": [
                            "wrong_or_stale_response",
                            "send_exactly_once_failed",
                        ],
                    },
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    if args.suite in {"qualification", "full"} and not args.browser_bundle_id:
        raise AcceptanceError("qualification/full suites require --browser-bundle-id")

    browser_binary: Path | None = None
    browser_app: Path | None = None
    if args.browser_bundle_id:
        browser_app, browser_binary = resolve_browser_app(args.browser_bundle_id)

    run_id = datetime.now().strftime("%Y%m%dT%H%M%S")
    run_dir = Path(args.results_root) / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    results_path = run_dir / "results.jsonl"
    manifest = {
        "run_id": run_id,
        "started_at": utc_now(),
        "git_head": run_command(["git", "rev-parse", "HEAD"]).stdout.strip(),
        "api": args.api,
        "trace": args.trace,
        "suite": args.suite,
        "evidence_level": args.evidence_level,
        "seed": args.seed,
        "startup_repeats": startup_repeats,
        "path_repeats": path_repeats,
        "minimum_perfect_trials": release_floor,
        "threshold": args.threshold,
        "confidence": args.confidence,
        "browser_bundle_id": args.browser_bundle_id,
        "browser_app": str(browser_app) if browser_app else None,
        "browser_binary": str(browser_binary) if browser_binary else None,
        "inventory": inventory,
        "selected_models": [asdict(model) for model in models],
        "counts": counts,
    }
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"event": "run_start", "run_dir": str(run_dir), **counts}, ensure_ascii=False), flush=True)

    results: list[dict[str, Any]] = []
    interrupted = False
    interruption_reason: str | None = None

    def interrupt_handler(signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt(signal.Signals(signum).name)

    signal.signal(signal.SIGTERM, interrupt_handler)
    signal.signal(signal.SIGINT, interrupt_handler)
    try:
        if args.suite in {"qualification", "full"}:
            cases = qualification_cases(models, run_id, startup_repeats, args.seed)
            for case in cases:
                result = run_case_and_record(
                    case,
                    args=args,
                    results_path=results_path,
                    results=results,
                    browser_binary=browser_binary,
                )
                if result.get("outcome") != "PASS" and args.fail_fast:
                    break

        qualification_results = [
            result
            for result in results
            if result.get("phase") in {"warm", "alias_route", "cold", "crash_prepare", "crash"}
        ]
        qualification_execution_complete = (
            len(qualification_results) == counts["qualification_requests"]
        )
        qualification_passed = bool(
            qualification_execution_complete
            and all(result.get("outcome") == "PASS" for result in qualification_results)
        )

        if args.suite in {"context", "full"}:
            if args.suite == "full" and not qualification_passed:
                append_jsonl(
                    results_path,
                    {
                        "event": "phase_blocked",
                        "phase": "context",
                        "reason": "qualification_failed_or_incomplete",
                        "outcome": "UNPROVEN",
                        "passed": False,
                    },
                )
            else:
                for repeat in range(1, path_repeats + 1):
                    run_context_repeat(
                        models,
                        repeat=repeat,
                        run_id=run_id,
                        args=args,
                        results_path=results_path,
                        results=results,
                        browser_binary=browser_binary,
                    )
    except KeyboardInterrupt as exc:
        interrupted = True
        interruption_reason = str(exc) or "KeyboardInterrupt"
        append_jsonl(
            results_path,
            {
                "event": "run_interrupted",
                "at": utc_now(),
                "reason": interruption_reason,
                "outcome": "UNPROVEN",
            },
        )

    qualification_results = [
        result
        for result in results
        if result.get("phase") in {"warm", "alias_route", "cold", "crash_prepare", "crash"}
    ]
    context_results = [
        result for result in results if str(result.get("phase") or "").startswith("context_")
    ]
    qualification_planned = counts["qualification_requests"] if args.suite in {"qualification", "full"} else 0
    context_planned = counts["context_requests"] if args.suite in {"context", "full"} else 0
    planned_requests = qualification_planned + context_planned
    qualification_execution_complete = len(qualification_results) == qualification_planned
    context_execution_complete = len(context_results) == context_planned
    qualification_passed = bool(
        qualification_execution_complete
        and all(result.get("outcome") == "PASS" for result in qualification_results)
    )
    context_passed = bool(
        context_execution_complete
        and all(result.get("outcome") == "PASS" for result in context_results)
    )
    summary = summarize(
        results,
        args.confidence,
        args.threshold,
        inventory_blockers=inventory["advertised_without_executable_profile"],
    )
    coverage_complete = bool(
        not interrupted
        and len(results) == planned_requests
        and summary["overall"]["coverage_complete"]
    )
    summary.update(
        {
            "run_id": run_id,
            "run_dir": str(run_dir),
            "interrupted": interrupted,
            "interruption_reason": interruption_reason,
            "planned_requests": planned_requests,
            "completed_records": len(results),
            "missing_records": max(0, planned_requests - len(results)),
            "qualification_execution_complete": qualification_execution_complete,
            "qualification_passed": qualification_passed,
            "context_execution_complete": context_execution_complete,
            "context_passed": context_passed,
            "coverage_complete": coverage_complete,
        }
    )
    summary["release_gate_passed"] = bool(
        args.suite == "full"
        and args.evidence_level == "release"
        and coverage_complete
        and qualification_passed
        and context_passed
        and summary["release_gate_passed"]
    )
    (run_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"event": "run_summary", **summary}, ensure_ascii=False), flush=True)
    if interrupted:
        return 130
    return 0 if summary["release_gate_passed"] else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AcceptanceError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"event": "fatal", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(3)
