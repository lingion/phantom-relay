#!/usr/bin/env python3
"""Phantom Relay API v3 — protocol-based gateway, backend drives Chrome, extension executes."""
import json, time, os, hashlib, threading, uuid, subprocess, sys, dataclasses, shutil, tempfile, webbrowser
from copy import deepcopy
from flask import Flask, request, jsonify, send_file, Response
from urllib.parse import urlparse, unquote
from datetime import datetime

from server.protocol import (
    ModelRoute, ModelCapabilities, Message, ToolDefinition,
    ParsedToolCall, OpenAIResponse, ModelNotFoundError,
    resolve_model, messages_to_text, inject_tool_defs,
    extract_tool_calls, text_to_openai_response,
    text_to_sse_chunk, build_sse_done, build_sse_error,
    build_openai_error, build_model_list, estimate_tokens,
)
from server.state_machine import (
    BrowserClientState,
    InvalidTransition,
    JobState,
    MAX_CLAIM_ATTEMPTS,
    next_browser_client_state,
    next_job_state,
    recovery_action,
)
from server.browser_client import (
    BrowserClientContractError,
    client_status_payload,
    normalize_registration,
)
from server.registry import (
    RegistryContractError,
    profile_checksum,
    validate_profile_envelope,
    normalize_model_registry,
    normalize_profile_registry,
    normalize_user_bindings,
    resolve_binding,
    _profile_is_executable as registry_profile_is_executable,
)
from server.job_store import DurableJobStore

PORT = 8765
BIND_HOST = os.environ.get("PHANTOM_RELAY_BIND_HOST", "127.0.0.1")
DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE   = os.path.join(DIR, "conversations.json")
STATS_FILE  = os.path.join(DIR, "stats.json")
TRACE_FILE  = os.path.join(DIR, "page-trace.jsonl")
ROUTES_FILE = os.path.join(DIR, "model_routes.json")
SELECTOR_TEMPLATES_FILE = os.path.join(DIR, "selector_templates.json")
LEGACY_BINDINGS_FILE = os.path.join(DIR, "user_bindings.json")
REGISTRY_DIR = os.environ.get("PHANTOM_RELAY_REGISTRY_DIR", "").strip()
MODEL_REGISTRY_FILE = os.path.join(REGISTRY_DIR, "model_registry.json") if REGISTRY_DIR else ""
PROFILE_REGISTRY_FILE = os.path.join(REGISTRY_DIR, "profile_registry.json") if REGISTRY_DIR else ""
USER_BINDINGS_FILE = os.path.join(REGISTRY_DIR, "user_bindings.json") if REGISTRY_DIR else ""
EXT_DIR     = os.path.join(os.path.dirname(DIR), "extension")
CONTENT_JS  = os.path.join(EXT_DIR, "content.js")
os.chdir(DIR)  # Ensure we're in server/ for relative imports

app = Flask(__name__)

BROWSER_LOCK    = threading.RLock()
BROWSER_JOBS    = {}
BROWSER_QUEUE   = []
BROWSER_CLIENTS = {}
BROWSER_REGISTRATIONS = {}
BROWSER_READY   = {}
BROWSER_READY_EVENTS = {}
BROWSER_EVENTS  = {}
BROWSER_DELTAS  = {}
BROWSER_BINDINGS = {}  # (conversation_id, domain) -> tab ownership binding
JOB_STORE = None  # Enabled by the real server entrypoint or an explicit test.
CONVERSATION_LOCK = threading.Lock()
_CORRUPT_DATA_BACKUP = None
IDEMPOTENCY = {}
IDEMPOTENCY_TTL = 24 * 60 * 60
POLL_LAST       = {}
POLL_MIN_INTERVAL = 0.25
CLIENT_TTL      = 45.0
_BROWSER_WAKE_LOCK = threading.Lock()
_BROWSER_WAKE_LAST = 0.0
_BROWSER_WAKE_PENDING_LOCK = threading.Lock()
_BROWSER_WAKE_PENDING = {}
BROWSER_HOST_CONFIG = os.environ.get("PHANTOM_RELAY_BROWSER_CONFIG", os.path.join(os.path.dirname(DIR), "browser-host.conf"))
BROWSER_WAKE_COMMAND = os.environ.get("PHANTOM_RELAY_BROWSER_WAKE_COMMAND", "")
_AUTO_WAKE_VALUE = os.environ.get("PHANTOM_RELAY_AUTO_WAKE_BROWSER", "1").strip().lower()
# Browser activation is part of the request path.  Keep an explicit opt-out for
# headless/test deployments, but do not make ordinary users start a second
# helper process just to turn the feature on.
AUTO_WAKE_BROWSER = _AUTO_WAKE_VALUE not in {"0", "false", "no", "off"}
# Legacy workers have no generation identity and can resurrect stale tab
# inventory after an extension reload. Keep compatibility only as an explicit
# migration escape hatch; the product path fails closed by default.
_ALLOW_LEGACY_RUNTIME_VALUE = os.environ.get("PHANTOM_RELAY_ALLOW_LEGACY_RUNTIME", "0").strip().lower()
ALLOW_LEGACY_BROWSER_RUNTIME = _ALLOW_LEGACY_RUNTIME_VALUE in {"1", "true", "yes", "on"}
# Exactly one component may activate a browser for a running API instance.
# ``api`` is the product path; ``bidi`` is an explicit test-harness mode.  The
# value is intentionally process-scoped so a test harness cannot silently
# become a second production navigation owner.
BROWSER_ACTIVATION_OWNER = os.environ.get("PHANTOM_RELAY_ACTIVATION_OWNER", "api").strip().lower() or "api"
_BROWSER_WAKE_COOLDOWN = 15.0
_BROWSER_WAKE_RECENT_WINDOW = 8.0
try:
    _BROWSER_WAKE_LEASE_TTL = max(
        _BROWSER_WAKE_COOLDOWN,
        float(os.environ.get("PHANTOM_RELAY_BROWSER_WAKE_LEASE_TTL", "45")),
    )
except (TypeError, ValueError):
    _BROWSER_WAKE_LEASE_TTL = 45.0
_BROWSER_STREAM_POLL_INTERVAL = 0.1
_BROWSER_STREAM_HEARTBEAT_INTERVAL = 15.0
try:
    BROWSER_QUEUE_TIMEOUT = max(
        15.0,
        float(os.environ.get("PHANTOM_RELAY_BROWSER_QUEUE_TIMEOUT", "60")),
    )
except (TypeError, ValueError):
    BROWSER_QUEUE_TIMEOUT = 60.0


def runtime_session_allowed(runtime_session_id):
    value = str(runtime_session_id or "").strip()
    if not value:
        return False
    return ALLOW_LEGACY_BROWSER_RUNTIME or not value.startswith("legacy:")


def evict_browser_client_runtime_locked(client_id):
    """Remove inventory left by a worker that cannot prove its generation."""
    wanted = str(client_id or "").strip()
    for key, client in list(BROWSER_CLIENTS.items()):
        if str(client.get("client_id") or "") == wanted:
            BROWSER_CLIENTS.pop(key, None)
            BROWSER_READY.pop(key, None)
    for job in BROWSER_JOBS.values():
        if str(job.get("client_id") or "") == wanted:
            _requeue_claimed_job_for_runtime_replacement_locked(job)

MODEL_LIST_CREATED_TS = 1  # Stable Unix epoch for /v1/models; the real freshness is in the route entries.

_registry_profile_registry = {"version": 1, "profiles": {}}
_registry_user_bindings = {"version": 1, "bindings": {}}
_registry_route_profile_ids = {}
_pending_domain_bindings = {}


def _persist_browser_state_locked():
    """Persist the job snapshot while the caller holds BROWSER_LOCK."""
    if JOB_STORE is None:
        return
    JOB_STORE.save_snapshot(
        BROWSER_JOBS,
        BROWSER_QUEUE,
        deltas=BROWSER_DELTAS,
        bindings=BROWSER_BINDINGS,
        idempotency=IDEMPOTENCY,
    )


def restore_browser_state():
    """Restore durable jobs and discard leases owned by the old server process.

    A browser tab from a previous process has no valid live lease after a
    restart.  Keeping the job identity but re-queueing it lets the current
    extension claim it again without accepting a late result from the old tab.
    """
    if JOB_STORE is None:
        return
    snapshot = JOB_STORE.load_snapshot()
    with BROWSER_LOCK:
        BROWSER_JOBS.clear()
        BROWSER_QUEUE.clear()
        BROWSER_EVENTS.clear()
        BROWSER_DELTAS.clear()
        BROWSER_BINDINGS.clear()
        IDEMPOTENCY.clear()
        restored_queue = []
        for job_id, raw_job in snapshot.jobs.items():
            job = dict(raw_job)
            status = str(job.get("status") or "")
            if status in {JobState.CLAIMED.value, JobState.QUEUED.value}:
                job.update(
                    status=JobState.FAILED.value,
                    state_reason="server_restart_incomplete",
                    tab_id=None,
                    client_id="",
                    reservation_tab_id=None,
                    claimed_at=None,
                    lease_expires_at=None,
                    last_worker_seen=None,
                    claim_token=uuid.uuid4().hex,
                    error="server_restart_incomplete",
                    updated_at=datetime.now().isoformat(),
                )
                status = JobState.FAILED.value
            BROWSER_JOBS[job_id] = job
            BROWSER_DELTAS[job_id] = list(snapshot.deltas.get(job_id, []))
            if status == JobState.QUEUED.value:
                BROWSER_EVENTS[job_id] = threading.Event()

        for job_id in snapshot.queue:
            if job_id in BROWSER_JOBS and BROWSER_JOBS[job_id].get("status") == JobState.QUEUED.value:
                if job_id not in restored_queue:
                    restored_queue.append(job_id)
        for job_id, job in BROWSER_JOBS.items():
            if job.get("status") == JobState.QUEUED.value and job_id not in restored_queue:
                restored_queue.append(job_id)
        BROWSER_QUEUE.extend(restored_queue)

        for entry in snapshot.bindings:
            if not isinstance(entry, dict):
                continue
            conversation_id = str(entry.get("conversation_id") or "")
            domain = str(entry.get("domain") or "").strip().lower()
            binding = entry.get("binding") if isinstance(entry.get("binding"), dict) else {}
            if not conversation_id or not domain:
                continue
            binding = dict(binding)
            binding.update(
                conversation_id=conversation_id,
                domain=domain,
                tab_id=None,
                last_seen=time.time(),
            )
            BROWSER_BINDINGS[(conversation_id, domain)] = binding

        for key, raw_record in snapshot.idempotency.items():
            if not isinstance(raw_record, dict):
                continue
            record = dict(raw_record)
            status = str(record.get("status") or "")
            job_id = str(record.get("job_id") or "")
            if status == "processing":
                if not job_id:
                    request_matches = [
                        candidate_id
                        for candidate_id, candidate in BROWSER_JOBS.items()
                        if str((candidate.get("request_meta") or {}).get("idempotency_key") or "") == str(key)
                    ]
                    job_id = request_matches[0] if len(request_matches) == 1 else ""
                    record["job_id"] = job_id or None
                if not job_id or job_id not in BROWSER_JOBS:
                    continue
                if BROWSER_JOBS[job_id].get("status") in {"completed", "failed", "cancelled"}:
                    record["status"] = "failed"
                    record["error"] = openai_error(
                        "Request state was incomplete when the server restarted",
                        "server_error",
                        code="server_restart_incomplete",
                    )
            record["key"] = str(key)
            record["event"] = threading.Event()
            if record.get("status") in {"completed", "failed", "cancelled"}:
                record["event"].set()
            IDEMPOTENCY[str(key)] = record
        _persist_browser_state_locked()


def configure_browser_job_store(path=None, *, restore=True):
    """Enable durable jobs for a server process and optionally restore them."""
    global JOB_STORE
    selected = str(path or os.environ.get("PHANTOM_RELAY_JOB_STORE") or os.path.join(DIR, "browser_jobs.sqlite3"))
    JOB_STORE = DurableJobStore(selected)
    if restore:
        restore_browser_state()
    return JOB_STORE


def _read_json_document(path, default):
    if not path or not os.path.exists(path):
        return deepcopy(default)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else deepcopy(default)
    except Exception as exc:
        print(f"registry_read_failed path={path!r} error={exc!r}", file=sys.stderr)
        return deepcopy(default)


def _write_json_atomic(path, value):
    if not path:
        return
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".phantom-relay-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _profile_domain(profile):
    return str((profile or {}).get("domain") or "").strip().lower()


def _profile_is_executable(profile):
    return registry_profile_is_executable(profile)


def _profile_selector_payload(profile):
    if not _profile_is_executable(profile):
        return {}
    response = profile.get("response") or {}
    return {
        "input": deepcopy(profile.get("input")),
        "send": deepcopy(profile.get("send")),
        "response": deepcopy(response.get("selector") or response.get("containerSelector")),
        "profile": deepcopy(profile),
    }


def _sanitize_legacy_selector_template(value):
    """Keep legacy recording fields while removing a non-executable profile."""
    if not isinstance(value, dict):
        return {}
    clean = deepcopy(value)
    profile = clean.get("profile")
    if profile is not None and not _profile_is_executable(profile):
        clean.pop("profile", None)
    return clean


def _profile_revision_for_domain(domain):
    normalized_domain = str(domain or "").strip().lower()
    if not normalized_domain:
        return 0
    profile = _profiles_by_domain(_registry_profile_registry).get(normalized_domain)
    lifecycle = profile.get("lifecycle") if isinstance(profile, dict) else None
    try:
        revision = int((lifecycle or {}).get("revision") or 0)
    except (TypeError, ValueError):
        revision = 0
    return revision if revision > 0 else 0


def _profiles_by_domain(profile_registry):
    result = {}
    profiles = profile_registry.get("profiles", {}) if isinstance(profile_registry, dict) else {}
    for profile in profiles.values() if isinstance(profiles, dict) else []:
        if _profile_is_executable(profile):
            domain = _profile_domain(profile)
            if domain:
                result[domain] = profile
    return result


def _seed_legacy_profile_registry_from_templates(templates):
    """Index persisted executable profiles without making selectors authoritative."""
    global _registry_profile_registry
    if REGISTRY_DIR:
        return _registry_profile_registry
    profiles = {}
    for template in templates.values() if isinstance(templates, dict) else []:
        profile = template.get("profile") if isinstance(template, dict) else None
        profile_id = str((profile or {}).get("profileId") or "").strip()
        if profile_id and _profile_is_executable(profile):
            migrated = deepcopy(profile)
            lifecycle = deepcopy(migrated.get("lifecycle")) if isinstance(migrated.get("lifecycle"), dict) else {}
            try:
                revision = max(1, int(lifecycle.get("revision") or migrated.get("revision") or 1))
            except (TypeError, ValueError):
                revision = 1
            try:
                schema_version = max(2, int(lifecycle.get("schemaVersion") or 2))
            except (TypeError, ValueError):
                schema_version = 2
            lifecycle.update({
                "schemaVersion": schema_version,
                "revision": revision,
                "checksum": profile_checksum(migrated),
                "source": str(lifecycle.get("source") or "legacy-recording"),
                "state": str(lifecycle.get("state") or "synced"),
            })
            migrated["lifecycle"] = lifecycle
            profiles[profile_id] = migrated
    _registry_profile_registry = normalize_profile_registry({"version": 1, "profiles": profiles})
    return _registry_profile_registry


def _authoritative_selector_template(domain, value):
    clean = _sanitize_legacy_selector_template(value)
    profile = _profiles_by_domain(_registry_profile_registry).get(
        str(domain or "").strip().lower()
    )
    if not profile:
        return clean
    return _sanitize_legacy_selector_template({
        **clean,
        **_profile_selector_payload(profile),
    })


def _persist_user_bindings():
    global _registry_user_bindings
    _registry_user_bindings = normalize_user_bindings(_registry_user_bindings)
    _write_json_atomic(USER_BINDINGS_FILE, _registry_user_bindings)


def _bind_model_to_profile(model_id, profile_id):
    global _registry_user_bindings
    key = str(model_id or "").strip().lower()
    profile_key = str(profile_id or "").strip()
    if not key or not profile_key:
        return False
    bindings = deepcopy(_registry_user_bindings.get("bindings", {}))
    bindings[key] = {**(bindings.get(key) if isinstance(bindings.get(key), dict) else {}), "profile_id": profile_key, "source": "recorded-profile"}
    _registry_user_bindings = normalize_user_bindings({"version": _registry_user_bindings.get("version", 1), "bindings": bindings})
    _persist_user_bindings()
    return True


def _load_separated_model_config():
    global _registry_profile_registry, _registry_user_bindings, _registry_route_profile_ids
    try:
        model_registry = normalize_model_registry(_read_json_document(MODEL_REGISTRY_FILE, {"models": [], "aliases": {}, "settings": {}}))
        _registry_profile_registry = normalize_profile_registry(_read_json_document(PROFILE_REGISTRY_FILE, {"profiles": {}}))
        _registry_user_bindings = normalize_user_bindings(_read_json_document(USER_BINDINGS_FILE, {"bindings": {}}))
    except RegistryContractError as exc:
        print(f"registry_contract_failed code={exc.code} detail={exc}", file=sys.stderr)
        _registry_profile_registry = {"version": 1, "profiles": {}}
        _registry_user_bindings = {"version": 1, "bindings": {}}
        _registry_route_profile_ids = {}
        return {}, {}, {}

    routes = {}
    _registry_route_profile_ids = {}
    profiles = _registry_profile_registry.get("profiles", {})
    for model_data in model_registry.get("models", []):
        model_id = str(model_data.get("id") or "").strip()
        if not model_id:
            continue
        binding = resolve_binding(model_id, model_registry, _registry_user_bindings) or {}
        profile_id = str(binding.get("profile_id") or "").strip()
        profile = profiles.get(profile_id) if isinstance(profiles, dict) else None
        executable = profile if _profile_is_executable(profile) else None
        _registry_route_profile_ids[model_id] = profile_id
        routes[model_id] = _build_model_route(
            model_data,
            domain=_profile_domain(executable),
            url=str((executable or {}).get("origin") or "").strip(),
            selectors={},
        )
    return routes, model_registry.get("aliases", {}), model_registry.get("settings", {})

# ═══ Model Config Loading (new) ═══

def _build_model_route(model_data, *, domain=None, url=None, selectors=None):
    provider = model_data.get("provider") if isinstance(model_data.get("provider"), dict) else {}
    caps_data = model_data.get("capabilities", {}) if isinstance(model_data.get("capabilities"), dict) else {}
    caps = ModelCapabilities(
        supports_tool_calling=caps_data.get('supports_tool_calling', False),
        supports_streaming=caps_data.get('supports_streaming', True),
        supports_vision=caps_data.get('supports_vision', False),
        supports_file_upload=caps_data.get('supports_file_upload', True),
        supports_developer_role=caps_data.get('supports_developer_role', False),
        supports_reasoning_effort=caps_data.get('supports_reasoning_effort', False),
        supports_usage_in_streaming=caps_data.get('supports_usage_in_streaming', False),
        supports_strict_mode=caps_data.get('supports_strict_mode', False),
        supports_store=caps_data.get('supports_store', False),
        requires_tool_result_name=caps_data.get('requires_tool_result_name', False),
        requires_assistant_after_tool_result=caps_data.get('requires_assistant_after_tool_result', False),
        requires_thinking_as_text=caps_data.get('requires_thinking_as_text', False),
        thinking_format=caps_data.get('thinking_format'),
        max_tokens_field=caps_data.get('max_tokens_field', 'max_tokens'),
        context_window=caps_data.get('context_window', 32000),
        max_output_tokens=caps_data.get('max_output_tokens', 4096),
        max_input_chars=caps_data.get('max_input_chars', 8000),
        input_modalities=caps_data.get('input_modalities', ['text']),
        output_modalities=caps_data.get('output_modalities', ['text']),
        reasoning=caps_data.get('reasoning', False),
    )
    cost_data = model_data.get('cost', {}) if isinstance(model_data.get('cost'), dict) else {}
    route_domain = provider.get('domain', '') if domain is None else domain
    route_url = provider.get('url', '') if url is None else url
    return ModelRoute(
        id=model_data.get('id', ''),
        name=model_data.get('name', ''),
        owned_by=model_data.get('owned_by', ''),
        domain=route_domain,
        url=route_url,
        api=model_data.get('api', 'browser'),
        capabilities=caps,
        selectors=selectors if selectors is not None else model_data.get('selectors', {}),
        cost={
            'input_per_million_tokens': cost_data.get('input_per_million_tokens', 0),
            'output_per_million_tokens': cost_data.get('output_per_million_tokens', 0),
            'cache_read_per_million_tokens': cost_data.get('cache_read_per_million_tokens', 0),
            'cache_write_per_million_tokens': cost_data.get('cache_write_per_million_tokens', 0),
        },
        created=model_data.get('created', 1700000000),
    )


def _normalize_legacy_binding(model_id, raw):
    """Normalize a user-owned model/domain binding without page data."""
    name = str(model_id or "").strip().lower()
    if not name:
        return None
    if isinstance(raw, str):
        candidate = raw.strip()
    elif isinstance(raw, dict):
        candidate = str(raw.get("target_url") or raw.get("url") or raw.get("domain") or "").strip()
    else:
        return None
    if not candidate:
        return None
    parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
    domain = str(parsed.hostname or "").strip().lower().rstrip(".")
    if parsed.scheme not in ("http", "https") or not domain:
        return None
    target_url = candidate if "://" in candidate else f"https://{domain}/"
    target = urlparse(target_url)
    if str(target.hostname or "").strip().lower().rstrip(".") != domain:
        return None
    return {"domain": domain, "target_url": target_url}


def _legacy_target_priority(binding):
    """Prefer an explicitly recorded application path over an origin root."""
    target = urlparse(str((binding or {}).get("target_url") or ""))
    return 1 if str(target.path or "/").rstrip("/") else 0


def _canonicalize_legacy_bindings(bindings):
    """Give all aliases of one origin the same recorded navigation target."""
    canonical_by_domain = {}
    for model_id, binding in bindings.items():
        domain = str(binding.get("domain") or "").strip().lower()
        if not domain:
            continue
        current = canonical_by_domain.get(domain)
        if current is None or _legacy_target_priority(binding) > _legacy_target_priority(current):
            canonical_by_domain[domain] = binding

    return {
        model_id: {
            "domain": str(binding.get("domain") or "").strip().lower(),
            "target_url": str(
                canonical_by_domain.get(binding.get("domain"), binding).get("target_url") or ""
            ),
        }
        for model_id, binding in bindings.items()
    }


def _load_legacy_user_bindings(path=None):
    """Load persisted user aliases for the non-separated registry runtime."""
    source_path = path or LEGACY_BINDINGS_FILE
    if REGISTRY_DIR or not os.path.exists(source_path):
        return {}
    try:
        with open(source_path, "r", encoding="utf-8") as f:
            document = json.load(f)
    except (OSError, ValueError, TypeError):
        return {}
    raw_bindings = document.get("bindings") if isinstance(document, dict) else document
    if not isinstance(raw_bindings, dict):
        return {}
    bindings = {
        name: binding
        for model_id, raw in raw_bindings.items()
        if (binding := _normalize_legacy_binding(model_id, raw)) is not None
        for name in [str(model_id).strip().lower()]
    }
    canonical = _canonicalize_legacy_bindings(bindings)
    # Keep the durable legacy document aligned with the runtime view. Without
    # this write-back, an extension restart can resend an older root-origin
    # alias and recreate the same-domain route split that canonicalization just
    # repaired in memory.
    if canonical != bindings and source_path == LEGACY_BINDINGS_FILE:
        try:
            _write_json_atomic(source_path, {
                "version": int(document.get("version") or 1) if isinstance(document, dict) else 1,
                "bindings": canonical,
            })
        except (OSError, TypeError, ValueError):
            pass
    return canonical


def _apply_legacy_user_bindings(routes, aliases):
    """Overlay user bindings onto static metadata using generic browser defaults."""
    for model_id, binding in _load_legacy_user_bindings().items():
        base = routes.get(model_id)
        if base is not None:
            routes[model_id] = dataclasses.replace(
                base, domain=binding["domain"], url=binding["target_url"], selectors={}
            )
            continue
        routes[model_id] = _build_model_route(
            {
                "id": model_id,
                "name": model_id,
                "owned_by": "user",
                "api": "browser",
                "capabilities": {},
            },
            domain=binding["domain"],
            url=binding["target_url"],
            selectors={},
        )
    return routes, aliases


def load_model_config(config_path=None):
    """Load model routes and aliases from model_routes.json."""
    if config_path is None and REGISTRY_DIR:
        return _load_separated_model_config()
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), 'model_routes.json')
    
    with open(config_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    routes = {}
    models_data = data.get('models', [])
    # Defensive: handle corrupted models field (Python repr string → actual list)
    if isinstance(models_data, str):
        try:
            import ast
            models_data = ast.literal_eval(models_data)
        except (ValueError, SyntaxError):
            print("load_model_config: models field is corrupted string, using empty list", file=sys.stderr)
            models_data = []
    if not isinstance(models_data, list):
        print(f"load_model_config: models field is not a list (type={type(models_data).__name__}), using empty list", file=sys.stderr)
        models_data = []
    for model_data in models_data:
        route = _build_model_route(model_data)
        routes[model_data['id']] = route
    
    aliases = data.get('aliases', {})
    settings = data.get('settings', {})
    routes, aliases = _apply_legacy_user_bindings(routes, aliases)
    return routes, aliases, settings


def read_model_config_raw(config_path=None):
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), 'model_routes.json')
    with open(config_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
    if not isinstance(data.get('models'), list):
        data['models'] = []
    if not isinstance(data.get('aliases'), dict):
        data['aliases'] = {}
    if not isinstance(data.get('settings'), dict):
        data['settings'] = {}
    return data


def write_model_config_raw(data, config_path=None):
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), 'model_routes.json')
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def reload_model_config_globals():
    global _routes, _aliases, _settings, selector_templates
    _routes, _aliases, _settings = load_model_config()
    if 'selector_templates' in globals():
        selector_templates = load_selector_templates()

# Load config at import time
_routes, _aliases, _settings = load_model_config()

# Compatibility snapshot for callers/tests
model_routes = {}


# ═══ Existing browser infrastructure functions ═══

def _browser_host_config_value(name):
    if not os.path.exists(BROWSER_HOST_CONFIG):
        return ""
    try:
        with open(BROWSER_HOST_CONFIG, encoding="utf-8") as config:
            for raw_line in config:
                line = raw_line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        return ""
    return ""


def wake_browser_host(target_url=""):
    """Wake the configured or default user browser for a queued job.

    A configured command remains the escape hatch for managed installations.
    Without one, opening the job target through the OS default browser keeps
    the browser profile and the user's installed extension under user control.
    """
    global _BROWSER_WAKE_LAST
    target_url = str(target_url or "").strip()
    if BROWSER_ACTIVATION_OWNER != "api":
        trace_api_event("browser_wake_skipped", {
            "mode": "activation_owner_conflict",
            "owner": BROWSER_ACTIVATION_OWNER,
            "target_url": target_url,
        })
        return False
    parsed_target = urlparse(target_url)
    if parsed_target.scheme not in {"http", "https"} or not parsed_target.hostname:
        trace_api_event("browser_wake_skipped", {"mode": "invalid_target_url"})
        return False
    # Reserve the wake slot before spawning the OS opener. The old ordering
    # allowed concurrent request threads to pass the cooldown check together,
    # producing duplicate browser activations and visible about:blank races.
    wake_event_id = f"wake_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    with _BROWSER_WAKE_LOCK:
        now = time.time()
        if now - _BROWSER_WAKE_LAST < _BROWSER_WAKE_COOLDOWN:
            trace_api_event("browser_wake_coalesced", {
                "target_url": target_url,
                "wake_event_id": wake_event_id,
                "reason": "cooldown",
            })
            return False
        _BROWSER_WAKE_LAST = now
    command = BROWSER_WAKE_COMMAND.strip() or _browser_host_config_value("wake_command")
    try:
        if command:
            env=dict(os.environ)
            env["PHANTOM_RELAY_API"] = f"http://{BIND_HOST}:{PORT}"
            if target_url:
                env["PHANTOM_RELAY_BROWSER_TARGET_URL"] = target_url
            subprocess.Popen(command, shell=True, cwd=os.path.dirname(DIR), env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            trace_api_event("browser_wake_requested", {
                "mode": "command",
                "target_url": target_url,
                "wake_event_id": wake_event_id,
                "activation_owner": "api",
            })
            return True
        bundle_id = (
            os.environ.get("PHANTOM_RELAY_BROWSER_BUNDLE_ID", "").strip()
            or _browser_host_config_value("bundle_id")
        )
        if bundle_id:
            args = ["open", "-g", "-b", bundle_id, target_url]
            subprocess.Popen(args, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            trace_api_event("browser_wake_requested", {
                "mode": "bundle",
                "target_url": target_url,
                "wake_event_id": wake_event_id,
                "activation_owner": "api",
            })
            return True
        # ``webbrowser.open_new_tab`` is foregrounding and is therefore not a
        # safe wake primitive: on macOS it can expose an intermediate
        # ``about:blank`` tab and steal the user's current model page.  Keep
        # the user's browser/profile boundary, but ask LaunchServices to open
        # the target in the background.
        if sys.platform == "darwin":
            subprocess.Popen(
                ["open", "-g", target_url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            trace_api_event("browser_wake_requested", {
                "mode": "default_browser_background",
                "target_url": target_url,
                "wake_event_id": wake_event_id,
                "activation_owner": "api",
            })
            return True
        opened = bool(webbrowser.open_new_tab(target_url))
        if opened:
            trace_api_event("browser_wake_requested", {
                "mode": "default_browser",
                "target_url": target_url,
                "wake_event_id": wake_event_id,
                "activation_owner": "api",
            })
            return True
        trace_api_event("browser_wake_failed", {"error":"default_browser_open_failed"})
        return False
    except Exception as exc:
        with _BROWSER_WAKE_LOCK:
            _BROWSER_WAKE_LAST = 0.0
        trace_api_event("browser_wake_failed", {
            "error": type(exc).__name__,
            "target_url": target_url,
            "wake_event_id": wake_event_id,
            "activation_owner": "api",
        })
        return False


def request_browser_wake(domain="", target_url=""):
    """Wake once per domain lease until the extension becomes ready or the lease expires.

    The OS browser opener is not an idempotent operation: calling it again can
    create another tab and briefly expose ``about:blank`` while the target
    navigates. A request retry therefore must not be treated as permission to
    open the same route again. The pending marker is deliberately keyed by
    hostname, because provider-neutral routes may use different conversation
    paths under the same site origin. The lease intentionally outlives a
    failed queue job for a bounded interval because the browser may still be
    navigating after the caller has stopped waiting.
    """
    key = str(domain or "").strip().lower()
    if not key:
        key = str(urlparse(str(target_url or "")).hostname or "").strip().lower()
    if browser_extension_recently_ready(domain):
        with _BROWSER_WAKE_PENDING_LOCK:
            _BROWSER_WAKE_PENDING.pop(key, None)
        trace_api_event("browser_wake_skipped", {"mode": "ready_extension", "domain": domain})
        return False
    if browser_extension_recently_present(domain):
        with _BROWSER_WAKE_PENDING_LOCK:
            _BROWSER_WAKE_PENDING.pop(key, None)
        trace_api_event("browser_wake_skipped", {"mode": "registered_extension", "domain": domain})
        return False
    if BROWSER_ACTIVATION_OWNER != "api":
        trace_api_event("browser_wake_skipped", {
            "mode": "activation_owner_conflict",
            "owner": BROWSER_ACTIVATION_OWNER,
            "domain": domain,
        })
        return False
    if not AUTO_WAKE_BROWSER:
        trace_api_event("browser_wake_skipped", {"mode": "disabled", "domain": domain})
        return False
    with _BROWSER_WAKE_PENDING_LOCK:
        now = time.time()
        pending = _BROWSER_WAKE_PENDING.get(key)
        if pending:
            requested_at = float(pending.get("requested_at") or 0)
            if now - requested_at < _BROWSER_WAKE_LEASE_TTL:
                trace_api_event("browser_wake_coalesced", {
                    "mode": "pending_lease",
                    "domain": key,
                    "target_url": str(target_url or ""),
                    "pending_target_url": str(pending.get("target_url") or ""),
                    "lease_age_seconds": round(max(0.0, now - requested_at), 3),
                })
                return False
            _BROWSER_WAKE_PENDING.pop(key, None)
            trace_api_event("browser_wake_lease_expired", {
                "domain": key,
                "target_url": str(target_url or ""),
            })
        opened = wake_browser_host(target_url)
        if opened and key:
            _BROWSER_WAKE_PENDING[key] = {
                "target_url": str(target_url or ""),
                "requested_at": now,
            }
        return opened

def request_fingerprint(model, messages, request_meta):
    payload = json.dumps({"model": model, "messages": messages,
                          "request_meta": request_meta}, ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def relay_context_options(body):
    raw = body.get("phantom_relay")
    return dict(raw) if isinstance(raw, dict) else {}

def default_conversation_id(model, domain):
    return f"default_{normalize_route_key(model)}_{str(domain or '').strip().lower()}"


CONVERSATION_ID_MAX_LENGTH = 256
_CONVERSATION_ID_KEYS = ("conversation_id", "session_id", "conversation")


def resolve_conversation_id(body, model, domain):
    """Resolve a metadata-only browser conversation ownership key.

    Explicit client identity wins over the deterministic local default. The
    value is never inferred from message/page content and is bounded before it
    can enter BROWSER_BINDINGS.
    """
    request_body = body if isinstance(body, dict) else {}
    relay_scope = request_body.get("phantom_relay")
    sources = (request_body, relay_scope if isinstance(relay_scope, dict) else {})
    for source in sources:
        for key in _CONVERSATION_ID_KEYS:
            if key not in source:
                continue
            raw = source.get(key)
            if not isinstance(raw, str):
                raise ValueError("conversation_id_invalid")
            value = raw.strip()
            if not value or len(value) > CONVERSATION_ID_MAX_LENGTH:
                raise ValueError("conversation_id_invalid")
            return value
    if model or domain:
        return default_conversation_id(model, domain)
    return ""

def idempotency_key(body):
    value = request.headers.get("Idempotency-Key") or body.get("idempotency_key") or body.get("request_id")
    return str(value or "").strip()

def claim_idempotency(key, fingerprint):
    if not key:
        return None, True, False
    with BROWSER_LOCK:
        now = time.time()
        removed_stale = False
        for stale_key, stale in list(IDEMPOTENCY.items()):
            if now - stale.get("updated_at", stale.get("created_at", now)) > IDEMPOTENCY_TTL:
                IDEMPOTENCY.pop(stale_key, None)
                removed_stale = True
        if removed_stale:
            _persist_browser_state_locked()
        current = IDEMPOTENCY.get(key)
        if current:
            if current["fingerprint"] != fingerprint:
                return current, False, True
            return current, False, False
        record = {"key": key, "fingerprint": fingerprint, "status": "processing",
                  "job_id": None, "event": threading.Event(), "response": None,
                  "created_at": time.time(), "updated_at": time.time()}
        IDEMPOTENCY[key] = record
        _persist_browser_state_locked()
        return record, True, False

def complete_idempotency(key, response):
    if not key:
        return
    with BROWSER_LOCK:
        record = IDEMPOTENCY.get(key)
        if not record:
            return
        record["status"] = "completed"
        record["response"] = response
        record["updated_at"] = time.time()
        record["event"].set()
        _persist_browser_state_locked()

def fail_idempotency(key, error, terminal=False):
    if not key:
        return
    with BROWSER_LOCK:
        record = IDEMPOTENCY.get(key)
        if not record:
            return
        record["status"] = "failed" if terminal else "processing"
        record["error"] = error
        record["updated_at"] = time.time()
        if terminal:
            record["event"].set()
        _persist_browser_state_locked()


def bind_idempotency_job(key, job_id):
    if not key:
        return
    with BROWSER_LOCK:
        record = IDEMPOTENCY.get(key)
        if not record:
            return
        record["job_id"] = str(job_id or "") or None
        record["updated_at"] = time.time()
        _persist_browser_state_locked()

def idempotency_response(record):
    response = record.get("response") if record else None
    return dict(response) if isinstance(response, dict) else None

def browser_process_running():
    return True

def openai_error(message, error_type, *, code=None, param=None):
    error = {"message": str(message or "Unknown error"), "type": str(error_type or "server_error")}
    if code is not None: error["code"] = code
    if param is not None: error["param"] = param
    return {"error": error}

def browser_unavailable_response(model, detail="No registered Phantom Relay browser extension is available"):
    return {"error": {"message": str(detail), "type": "browser_unavailable", "model": model, "retryable": True}}

def browser_extension_available(domain=""):
    now = time.time()
    wanted = str(domain or "").strip().lower()
    with BROWSER_LOCK:
        return any(
            now - float(client.get("last_seen") or 0) <= CLIENT_TTL
            and (not wanted or str(client.get("domain") or "").strip().lower() == wanted)
            and client.get("ready")
            and (client.get("capabilities") or {}).get("can_execute") is True
            and (client.get("capabilities") or {}).get("can_observe") is True
            for client in BROWSER_CLIENTS.values()
        )


def browser_extension_recently_ready(domain="", window=_BROWSER_WAKE_RECENT_WINDOW):
    """Return true only for a client that sent a very recent ready heartbeat.

    CLIENT_TTL protects an in-flight lease and is intentionally longer than the
    request-path activation window. A browser that stopped heartbeating can be
    within the lease while its process is already gone; new requests must wake
    it instead of trusting that stale lease record.
    """
    now = time.time()
    wanted = str(domain or "").strip().lower()
    with BROWSER_LOCK:
        return any(
            now - float(client.get("last_seen") or 0) <= float(window)
            and (not wanted or str(client.get("domain") or "").strip().lower() == wanted)
            and client.get("ready")
            and client.get("input_ready")
            and client.get("send_ready")
            and (client.get("capabilities") or {}).get("can_execute") is True
            and (client.get("capabilities") or {}).get("can_observe") is True
            for client in BROWSER_CLIENTS.values()
        )


def browser_extension_recently_present(domain="", window=CLIENT_TTL):
    """Return true when a live extension tab already owns this origin.

    A registered-but-not-ready page is still a stronger signal than opening a
    second browser tab. In particular, an incomplete profile cannot be
    repaired by navigating another tab to the same site; the request must fail
    closed and ask the user to re-record instead of creating a foreground tab
    storm.
    """
    now = time.time()
    wanted = str(domain or "").strip().lower()
    live_states = {
        BrowserClientState.REGISTERED.value,
        BrowserClientState.READY.value,
        BrowserClientState.STALE.value,
    }
    with BROWSER_LOCK:
        return any(
            now - float(client.get("last_seen") or 0) <= float(window)
            and (not wanted or str(client.get("domain") or "").strip().lower() == wanted)
            and str(client.get("state") or "").strip().lower() in live_states
            for client in BROWSER_CLIENTS.values()
        )


def mark_browser_page_presence(domain="", tab_id=None, url=""):
    """Refresh a non-executable page presence lease from content traces.

    A page with an incomplete recorded profile still exists and must not cause
    the API to open another foreground browser tab on the next request.  The
    content script already emits page traces while its worker readiness lease
    may be unavailable, so use that signal only to retain presence; never
    promote it to executable readiness.
    """
    key = str(tab_id or "").strip()
    wanted = str(domain or "").strip().lower()
    if not key or not wanted:
        return False
    with BROWSER_LOCK:
        previous = dict(BROWSER_CLIENTS.get(key) or {})
        ready = bool(previous.get("ready")) and bool(previous.get("input_ready")) and bool(previous.get("send_ready"))
        capabilities = dict(previous.get("capabilities") or {})
        if not ready:
            capabilities.update({
                "can_execute": False,
                "can_observe": False,
                "can_snapshot": False,
                "can_create_tab": False,
                "can_stream": True,
            })
        BROWSER_CLIENTS[key] = dict(
            previous,
            domain=wanted,
            tab_id=tab_id,
            url=str(url or previous.get("url") or ""),
            last_seen=time.time(),
            heartbeat=True,
            ready=ready,
            input_ready=bool(previous.get("input_ready")) if ready else False,
            send_ready=bool(previous.get("send_ready")) if ready else False,
            state=BrowserClientState.READY.value if ready else BrowserClientState.REGISTERED.value,
            source=previous.get("source") or "page-trace",
            capabilities=capabilities,
        )
    return True


def route_has_executable_profile(route):
    """Return whether a browser route has a complete user-owned profile."""
    if not route or str(getattr(route, "api", "browser") or "browser").lower() != "browser":
        return True
    domain = str(getattr(route, "domain", "") or "").strip().lower()
    if not domain:
        return False
    if REGISTRY_DIR:
        return _profiles_by_domain(_registry_profile_registry).get(domain) is not None
    template = selector_templates.get(domain) if isinstance(selector_templates, dict) else None
    profile = template.get("profile") if isinstance(template, dict) else None
    return _profile_is_executable(profile)

def load_routes():
    global model_routes
    if REGISTRY_DIR:
        model_routes = {
            model_id: {
                "domain": route.domain,
                "target_url": route.url,
                "profile_id": _registry_route_profile_ids.get(model_id, ""),
            }
            for model_id, route in _routes.items()
        }
        return model_routes
    model_routes = {
        model_id: {
            "domain": route.domain,
            "target_url": route.url,
            "profile_id": "",
        }
        for model_id, route in _routes.items()
        if route.domain or route.url
    }
    return model_routes

model_routes = load_routes()

def save_routes(routes):
    """Persist user-owned model/domain bindings for the legacy runtime."""
    if REGISTRY_DIR:
        return
    bindings = _load_legacy_user_bindings()
    for model_id, raw in (routes.items() if isinstance(routes, dict) else []):
        binding = _normalize_legacy_binding(model_id, raw)
        if binding:
            bindings[str(model_id).strip().lower()] = binding
    _write_json_atomic(LEGACY_BINDINGS_FILE, {"version": 1, "bindings": bindings})
    global _routes, _aliases, _settings
    _routes, _aliases, _settings = load_model_config()

def normalize_route_key(value):
    return str(value or '').strip().lower()

def normalize_route_value(model, raw):
    name = normalize_route_key(model)
    if isinstance(raw, str):
        domain = route_hostname(raw)
        return {
            'provider_id': name, 'adapter_id': 'generic-browser',
            'domain': domain, 'target_url': f'https://{domain}/' if domain else '',
            'capabilities': {'browser_required': True, 'streaming': 'snapshot',
                             'tools': False, 'vision': False, 'reasoning': 'unknown',
                             'server_side_conversation': False}
        }
    if not isinstance(raw, dict):
        return None
    target = raw.get('target') if isinstance(raw.get('target'), dict) else {}
    domain = route_hostname(raw.get('domain') or target.get('domain') or raw.get('url') or target.get('url'))
    if not domain:
        return None
    caps = raw.get('capabilities') if isinstance(raw.get('capabilities'), dict) else {}
    return {
        **raw,
        'provider_id': str(raw.get('provider_id') or raw.get('provider') or name),
        'adapter_id': str(raw.get('adapter_id') or 'generic-browser'),
        'domain': domain,
        'target_url': str(raw.get('target_url') or target.get('url') or f'https://{domain}/'),
        'capabilities': {
            'browser_required': bool(caps.get('browser_required', True)),
            'streaming': str(caps.get('streaming') or 'snapshot'),
            'tools': bool(caps.get('tools', False)),
            'vision': bool(caps.get('vision', False)),
            'reasoning': str(caps.get('reasoning') or 'unknown'),
            'server_side_conversation': bool(caps.get('server_side_conversation', False)),
            'network_capture': bool(caps.get('network_capture', False)),
        }
    }

def normalize_route_registry(routes):
    out = {}
    for model, raw in (routes.items() if isinstance(routes, dict) else []):
        key = normalize_route_key(model)
        value = normalize_route_value(key, raw)
        if key and value:
            out[key] = value
    return out

def resolve_model_route(model):
    key = normalize_route_key(model)
    routes = normalize_route_registry(load_routes())
    return routes.get(key)

def load_selector_templates():
    if REGISTRY_DIR:
        return {
            domain: _profile_selector_payload(profile)
            for domain, profile in _profiles_by_domain(_registry_profile_registry).items()
        }
    if os.path.exists(SELECTOR_TEMPLATES_FILE):
        try:
            with open(SELECTOR_TEMPLATES_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
            return {
                str(domain).strip().lower(): _sanitize_legacy_selector_template(template)
                for domain, template in raw.items()
                if str(domain).strip() and isinstance(template, dict)
            } if isinstance(raw, dict) else {}
        except Exception:
            return {}
    return {}

def save_selector_templates(value):
    if REGISTRY_DIR:
        # Registry profiles are written only through /browser/profiles.
        return
    with open(SELECTOR_TEMPLATES_FILE, "w", encoding="utf-8") as f:
        safe = {
            str(domain).strip().lower(): _sanitize_legacy_selector_template(template)
            for domain, template in (value.items() if isinstance(value, dict) else [])
            if str(domain).strip() and isinstance(template, dict)
        }
        json.dump(safe, f, ensure_ascii=False, indent=2)

def merge_recorded_selector_template(existing, incoming):
    current = dict(existing) if isinstance(existing, dict) else {}
    proposed = incoming if isinstance(incoming, dict) else {}
    for role in ("input", "send", "response", "profile"):
        value = proposed.get(role)
        if value is not None and value != "" and value is not False:
            current[role] = value
    return current

def merge_selector_templates(existing, incoming):
    result = dict(existing) if isinstance(existing, dict) else {}
    for domain, template in (incoming.items() if isinstance(incoming, dict) else []):
        key = str(domain or "").strip().lower()
        if not key or not isinstance(template, dict):
            continue
        result[key] = _sanitize_legacy_selector_template(
            merge_recorded_selector_template(
                _sanitize_legacy_selector_template(result.get(key)),
                _sanitize_legacy_selector_template(template),
            )
        )
    return result


def _incoming_route_domain(raw):
    if isinstance(raw, str):
        return route_hostname(raw).strip().lower()
    if isinstance(raw, dict):
        target = raw.get("target") if isinstance(raw.get("target"), dict) else {}
        return route_hostname(raw.get("domain") or raw.get("target_url") or target.get("domain") or target.get("url")).strip().lower()
    return ""


def _sync_separated_bindings(incoming):
    changed = 0
    profiles = _profiles_by_domain(_registry_profile_registry)
    for model_id, raw in (incoming.items() if isinstance(incoming, dict) else []):
        model_key = str(model_id or "").strip().lower()
        domain = _incoming_route_domain(raw)
        if not model_key or not domain:
            continue
        profile = profiles.get(domain)
        if profile:
            if _bind_model_to_profile(model_key, profile.get("profileId")):
                changed += 1
        else:
            # The popup can sync the model/domain association immediately
            # after input/send recording, before response recording creates the
            # executable profile. Keep that intent in memory only; the
            # separated binding document never stores a raw domain.
            _pending_domain_bindings[model_key] = domain
    return changed


def _resolve_pending_domain_bindings(profile):
    """Bind pending model intents only after their recorded profile exists."""
    profile_id = str((profile or {}).get("profileId") or "").strip()
    domain = _profile_domain(profile)
    if not profile_id or not domain:
        return 0
    changed = 0
    for model_id, pending_domain in list(_pending_domain_bindings.items()):
        if pending_domain != domain:
            continue
        if _bind_model_to_profile(model_id, profile_id):
            _pending_domain_bindings.pop(model_id, None)
            changed += 1
    return changed

selector_templates = load_selector_templates()
_seed_legacy_profile_registry_from_templates(selector_templates)

def route_hostname(route):
    value = str(route or '').strip()
    if value.startswith(('http://','https://')):
        return urlparse(value).hostname or ''
    return value


def normalize_browser_target_url(value, expected_domain=''):
    """Validate a browser navigation target without provider-specific rules."""
    target = str(value or '').strip()
    parsed = urlparse(target)
    hostname = str(parsed.hostname or '').strip().lower().rstrip('.')
    expected = str(expected_domain or '').strip().lower().rstrip('.')
    if parsed.scheme not in ('http', 'https') or not hostname:
        raise ValueError('target_url_invalid')
    if expected and hostname != expected:
        raise ValueError('target_url_domain_mismatch')
    return target


def resolve_browser_target_url(body, model='', domain=''):
    """Resolve an explicit, route-provided, or domain-root browser target."""
    request_body = body if isinstance(body, dict) else {}
    candidate = request_body.get('target_url')
    if not candidate:
        candidate = route_entry(model).get('target_url')
    if not candidate and domain:
        candidate = f'https://{domain}/'
    if not candidate:
        return ''
    return normalize_browser_target_url(candidate, expected_domain=domain)

def route_entry(model):
    name = (model or '').strip().lower()
    try:
        resolved = resolve_model(name, _routes, _aliases)
    except ModelNotFoundError:
        resolved = None
    if resolved is not None:
        return {
            'model': resolved.id,
            'provider_id': resolved.id,
            'domain': route_hostname(resolved.domain or resolved.url),
            'target_url': str(resolved.url or ''),
            'adapter_id': 'generic-browser',
            'capabilities': dataclasses.asdict(resolved.capabilities),
        }
    raw = resolve_model_route(name)
    if raw:
        return {
            'model': name,
            'provider_id': str(raw.get('provider_id') or raw.get('provider') or name),
            'domain': route_hostname(raw.get('domain') or raw.get('url')),
            'target_url': str(raw.get('target_url') or raw.get('url') or ''),
            'adapter_id': str(raw.get('adapter_id') or 'generic-browser'),
            'capabilities': dict(raw.get('capabilities') or {}),
        }
    domain = route_hostname(name)
    if not domain or ('.' not in domain and ':' not in domain):
        domain = ''
    return {
        'model': name, 'provider_id': name, 'domain': domain,
        'target_url': f'https://{domain}/' if domain else '',
        'adapter_id': 'generic-browser',
        'capabilities': {
            'browser_required': True, 'streaming': 'snapshot', 'tools': False,
            'vision': False, 'reasoning': 'unknown', 'server_side_conversation': False,
        },
    }


def known_browser_route(model):
    """Resolve a registered browser model without inventing a route.

    Direct browser submissions are also a product entrypoint (the extension's
    auto-capture action). Keep its readiness gate aligned with chat completion,
    but preserve the low-level custom-domain fixture path when no model route
    is registered.
    """
    model_name = str(model or '').strip()
    if not model_name:
        return None
    try:
        return resolve_model(model_name, _routes, _aliases)
    except ModelNotFoundError:
        return None


def route_capabilities(model):
    return route_entry(model).get('capabilities', {})

def resolve_domain(model):
    return route_entry(model).get('domain', '')


# Compatibility helpers for the pre-protocol API surface. The current chat
# endpoint uses server.protocol directly, but local audit tools and older
# integrations still import these names. Keep them as a thin adapter instead
# of maintaining a second message representation.
def normalize_messages(raw_messages):
    if not isinstance(raw_messages, list):
        return []
    normalized = []
    for raw in raw_messages:
        if not isinstance(raw, dict):
            continue
        role = str(raw.get("role") or "user").strip().lower()
        if not role:
            role = "user"
        content = raw.get("content", "")
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    parts.append(str(part.get("text") or ""))
                elif isinstance(part, str):
                    parts.append(part)
            content = "\n".join(parts)
        elif content is None:
            content = ""
        else:
            content = str(content)
        tool_calls = raw.get("tool_calls")
        if not content.strip() and not isinstance(tool_calls, list):
            continue
        normalized.append(Message(
            role=role,
            content=content,
            name=raw.get("name"),
            tool_call_id=raw.get("tool_call_id"),
            tool_calls=tool_calls if isinstance(tool_calls, list) else None,
        ))
    return normalized


def _format_compat_prompt_message(message):
    msg = message if isinstance(message, Message) else normalize_messages([message])[0]
    content = msg.content or ""
    if msg.role == "system":
        return f"系统：{content}"
    if msg.role == "developer":
        return f"开发者：{content}"
    if msg.role == "user":
        return f"用户：{content}"
    if msg.role == "tool":
        return f"工具结果（{msg.tool_call_id or 'unknown'}）：\n{content}"
    if msg.role == "assistant" and msg.tool_calls:
        calls = []
        for call in msg.tool_calls:
            function = call.get("function") or {}
            calls.append(json.dumps({
                "id": call.get("id", ""),
                "name": function.get("name", ""),
                "arguments": function.get("arguments", "{}"),
            }, ensure_ascii=False))
        prefix = "助手工具调用：" + "\n".join(calls)
        return f"{prefix}\n{content}" if content.strip() else prefix
    return f"助手：{content}"


def browser_prompt(messages, tools=None, tool_choice="auto"):
    """Render the legacy browser prompt shape for older local callers."""
    normalized = messages if all(isinstance(item, Message) for item in messages or []) else normalize_messages(messages)
    if not normalized:
        return ""
    last_user = max((index for index, message in enumerate(normalized) if message.role == "user"), default=-1)
    current = normalized[last_user] if last_user >= 0 else None
    history = (normalized[:last_user] + normalized[last_user + 1:]) if last_user >= 0 else normalized
    current_text = (current.content or "") if current is not None else ""
    should_inject_tools = bool(
        tools
        and current is not None
        and tool_choice != "none"
        and any(keyword in current_text.lower() for keyword in ("搜索", "查询", "查", "search", "weather"))
    )

    if not history and current is not None and not should_inject_tools:
        return current_text

    sections = []
    if history:
        sections.append("以下是对话上下文" if current is not None else "以下是工具续轮上下文")
        sections.extend(_format_compat_prompt_message(message) for message in history)
    if current is not None:
        sections.append(f"【当前用户问题】\n{current.content or ''}")

    result = "\n\n".join(section for section in sections if section)
    if should_inject_tools:
            tool_defs = [
                item if isinstance(item, ToolDefinition) else ToolDefinition(
                    type=item.get("type", "function"),
                    function=item.get("function") or {},
                )
                for item in tools
            ]
            result += inject_tool_defs(tool_defs, True)
    return result

def launch_chrome():
    return False

def open_target_page(target_url):
    return False

def normalize_browser_capabilities(body):
    raw = body.get("capabilities")
    if not isinstance(raw, dict):
        raw = {}
    transport = str(body.get("transport") or raw.get("transport") or body.get("source") or "unknown").strip().lower()
    legacy_background = transport == "background-poll" and "capabilities" not in body
    capabilities = {
        "transport": transport,
        "can_observe": bool(raw.get("can_observe", body.get("ready", True) if legacy_background else body.get("ready", False))),
        "can_execute": bool(raw.get("can_execute", (body.get("input_ready", True) and body.get("send_ready", True)) if legacy_background else (body.get("input_ready", False) and body.get("send_ready", False)))),
        "can_stream": bool(raw.get("can_stream", True)),
        "can_create_tab": bool(raw.get("can_create_tab", False)),
        "can_close_tab": bool(raw.get("can_close_tab", False)),
        "can_snapshot": bool(raw.get("can_snapshot", body.get("ready", False))),
    }
    # The installed extension is an executor/reuser, never a browser-tab
    # activation owner. Do not trust an older extension instance that still
    # advertises can_create_tab=true after a reload.
    if transport in {"chrome-extension", "browser-register", "content-ready"}:
        capabilities["can_create_tab"] = False
        capabilities["can_close_tab"] = False
    return capabilities

def merge_browser_capabilities(previous, incoming):
    old = previous if isinstance(previous, dict) else {}
    new = incoming if isinstance(incoming, dict) else {}
    merged = dict(new)
    # Capabilities describe the current transport, not a historical union of
    # what an older extension instance once claimed. The automatic execution
    # worker is forbidden from creating provider tabs, so stale true values
    # must not survive an extension reload.
    merged["can_create_tab"] = bool(new.get("can_create_tab", False))
    merged["can_close_tab"] = bool(new.get("can_close_tab", False))
    for key in ("can_observe", "can_execute", "can_stream", "can_create_tab", "can_close_tab", "can_snapshot"):
        if key in {"can_create_tab", "can_close_tab"}:
            continue
        merged[key] = bool(old.get(key, False) or new.get(key, False))
    if old.get("transport") and not merged.get("transport"):
        merged["transport"] = old["transport"]
    return merged

def mark_browser_ready(body):
    key=str(body.get("tab_id") or body.get("domain") or "unknown")
    incoming_domain = str(body.get("domain") or "").strip().lower()
    incoming_tab_id = body.get("tab_id")
    incoming_ready = bool(body.get("ready") and body.get("input_ready") and body.get("send_ready"))
    incoming_client_id = str(body.get("client_id") or "").strip()
    incoming_runtime_session_id = str(body.get("runtime_session_id") or f"legacy:{incoming_client_id}").strip()
    if not runtime_session_allowed(incoming_runtime_session_id):
        trace_api_event("browser_runtime_rejected", {
            "operation": "heartbeat",
            "client_id": incoming_client_id,
            "received_runtime_session_id": incoming_runtime_session_id,
            "reason": "runtime_session_required",
        })
        return False
    with BROWSER_LOCK:
        registration = BROWSER_REGISTRATIONS.get(incoming_client_id)
        expected_runtime_session_id = str(getattr(registration, "runtime_session_id", "") or "")
        if expected_runtime_session_id and expected_runtime_session_id != incoming_runtime_session_id:
            trace_api_event("browser_runtime_rejected", {
                "operation": "heartbeat",
                "client_id": incoming_client_id,
                "expected_runtime_session_id": expected_runtime_session_id,
                "received_runtime_session_id": incoming_runtime_session_id,
                "tab_id": incoming_tab_id,
                "domain": incoming_domain,
            })
            return False
        # A Chrome tab id is an allocation detail, not user intent, recency, or
        # recorded-profile identity. Keep every fresh ready tab independently;
        # the extension chooses the exact execution tab after probing response
        # and identity health, and the poll carries that exact tab id to the
        # server. Cross-tab numeric arbitration here caused a newly allocated
        # page to revoke the user's existing recorded page.
        previous = BROWSER_CLIENTS.get(key) or {}
        previous_state = str(previous.get("state") or BrowserClientState.NEW.value)
        if body.get("ready") and body.get("input_ready") and body.get("send_ready"):
            client_event = "ready" if previous_state in {
                BrowserClientState.NEW.value,
                BrowserClientState.REGISTERED.value,
                BrowserClientState.STALE.value,
                BrowserClientState.DISCONNECTED.value,
            } else "heartbeat"
        else:
            client_event = "heartbeat" if previous_state != BrowserClientState.NEW.value else "register"
        try:
            client_state = next_browser_client_state(previous_state, client_event).value
        except InvalidTransition:
            client_state = BrowserClientState.REGISTERED.value
        info=dict(domain=body.get("domain", ""), tab_id=body.get("tab_id"),
                  client_id=incoming_client_id or previous.get("client_id", ""),
                  runtime_session_id=incoming_runtime_session_id,
                  last_seen=time.time(), ready=bool(body.get("ready")),
                  input_ready=bool(body.get("input_ready")),
                  send_ready=bool(body.get("send_ready")),
                  state=client_state,
                  capabilities=merge_browser_capabilities(previous.get("capabilities"), normalize_browser_capabilities(body)),
                  url=body.get("url", ""), source=body.get("source", ""),
                  background_version=body.get("background_version", ""))
        BROWSER_CLIENTS[key]=info
        conversation_id = str(body.get("conversation_id") or "")
        domain = str(body.get("domain") or "").strip().lower()
        if conversation_id and body.get("tab_id") is not None:
            BROWSER_BINDINGS[(conversation_id, domain)] = {
                "conversation_id": conversation_id, "domain": domain,
                "tab_id": body.get("tab_id"), "profile": body.get("profile") or "chrome-extension",
                "last_seen": time.time(),
            }
        if info["ready"] and info["input_ready"] and info["send_ready"]:
            BROWSER_READY[key]=info
            ev=BROWSER_READY_EVENTS.get(key)
            if ev: ev.set()
        # A ready heartbeat from the exact claimed tab is also a lease
        # heartbeat.  Keep the server-side execution lease alive while the
        # content script is waiting for a long or indefinitely-open stream.
        # This is provider-neutral and does not trust page text or network
        # payloads as ownership evidence.
        active_job = _active_claim_for_tab(incoming_tab_id) if incoming_tab_id is not None else None
        if active_job and str(active_job.get("domain") or "").strip().lower() == domain:
            expected_conversation = str(active_job.get("conversation_id") or "")
            if not conversation_id or conversation_id == expected_conversation:
                active_job["last_worker_seen"] = time.time()
                active_job["lease_expires_at"] = time.time() + 300.0
                active_job["updated_at"] = datetime.now().isoformat()
        _persist_browser_state_locked()
    return True


def _requeue_claimed_job_for_runtime_replacement_locked(job):
    """Invalidate a claim owned by an old extension worker generation."""
    if job.get("status") != JobState.CLAIMED.value:
        return
    current_attempt = int(job.get("claim_attempt", 0))
    next_state = next_job_state(
        job.get("status", JobState.CLAIMED.value),
        "browser_stale",
        claim_attempt=current_attempt,
        max_claim_attempts=MAX_CLAIM_ATTEMPTS,
    )
    job["status"] = next_state.value
    job["state_reason"] = "runtime_session_replaced"
    job["tab_id"] = None
    job["client_id"] = ""
    job["reservation_tab_id"] = None
    job["claim_token"] = uuid.uuid4().hex
    job["lease_expires_at"] = None
    job["last_worker_seen"] = None
    job["updated_at"] = datetime.now().isoformat()
    if next_state is JobState.QUEUED and job.get("id") not in BROWSER_QUEUE:
        BROWSER_QUEUE.append(job.get("id"))

def conversation_binding(conversation_id, domain):
    key = (str(conversation_id or ""), str(domain or "").strip().lower())
    with BROWSER_LOCK:
        binding = BROWSER_BINDINGS.get(key)
        if not binding:
            return None
        if time.time() - binding.get("last_seen", 0) >= CLIENT_TTL:
            BROWSER_BINDINGS.pop(key, None)
            _persist_browser_state_locked()
            return None
        return dict(binding)

def purge_stale_browser_state():
    now = time.time()
    cutoff = now - CLIENT_TTL
    with BROWSER_LOCK:
        for key, value in list(BROWSER_CLIENTS.items()):
            if value.get("last_seen", 0) < cutoff:
                tab_id = value.get("tab_id")
                active_job = _active_claim_for_tab(tab_id) if tab_id is not None else None
                lease_expires_at = float(active_job.get("lease_expires_at") or 0) if active_job else 0
                if active_job and lease_expires_at > now:
                    # Keep only the inventory needed to finish an already-owned
                    # leased job. A stale idle tab is not a browser resource;
                    # retaining it makes old workers look live and lets a later
                    # wake decision race an unrelated browser instance.
                    value["state"] = BrowserClientState.STALE.value
                    value["ready"] = False
                    BROWSER_READY.pop(key, None)
                else:
                    BROWSER_CLIENTS.pop(key, None)
                    BROWSER_READY.pop(key, None)
        for key, value in list(BROWSER_READY.items()):
            if value.get("last_seen", 0) < cutoff:
                BROWSER_READY.pop(key, None)
        live_tabs = {
            int(value.get("tab_id")) for value in BROWSER_CLIENTS.values()
            if value.get("tab_id") is not None
            and value.get("last_seen", 0) >= cutoff
            and value.get("ready")
            and value.get("source") == "content-ready"
            and (value.get("capabilities") or {}).get("can_execute") is True
        }
        # A claimed tab can briefly report only the service-worker inventory
        # during a same-tab navigation. That record is intentionally not
        # content-ready yet, but the existing claim lease and exact
        # tab/client/domain ownership still prove that this is the same
        # execution slot. Let the content script re-establish readiness before
        # treating the claim as lost; a removed tab still disappears from
        # BROWSER_CLIENTS and is re-queued below.
        for job in BROWSER_JOBS.values():
            if job.get("status") != JobState.CLAIMED.value or job.get("tab_id") is None:
                continue
            try:
                tab_id = int(job.get("tab_id"))
            except (TypeError, ValueError):
                continue
            lease_expires_at = job.get("lease_expires_at")
            if lease_expires_at and float(lease_expires_at) > now:
                # The signed job lease is the execution ownership boundary.
                # A readiness inventory can briefly go stale while the page
                # is generating a long response; re-queueing here would make
                # the still-valid result token unusable. Lease expiry remains
                # the recovery boundary for a genuinely lost browser.
                live_tabs.add(tab_id)
                continue
            if lease_expires_at:
                continue
            client = BROWSER_CLIENTS.get(str(job.get("tab_id")))
            if not client or now - float(client.get("last_seen", 0) or 0) >= CLIENT_TTL:
                continue
            if str(client.get("domain") or "").strip().lower() != str(job.get("domain") or "").strip().lower():
                continue
            job_client_id = str(job.get("client_id") or "")
            client_id = str(client.get("client_id") or "")
            if job_client_id and client_id != job_client_id:
                continue
            live_tabs.add(tab_id)
        for key, binding in list(BROWSER_BINDINGS.items()):
            tab_id = binding.get("tab_id")
            if tab_id is not None and int(tab_id) not in live_tabs:
                BROWSER_BINDINGS.pop(key, None)
        for job in BROWSER_JOBS.values():
            if job.get("status") != "claimed":
                continue
            tab_id = job.get("tab_id")
            if tab_id is not None and int(tab_id) not in live_tabs:
                current_attempt = int(job.get("claim_attempt", 0))
                next_state = next_job_state(
                    job.get("status", JobState.CLAIMED.value),
                    "browser_stale",
                    claim_attempt=current_attempt,
                    max_claim_attempts=MAX_CLAIM_ATTEMPTS,
                )
                job["status"] = next_state.value
                job["state_reason"] = recovery_action(
                    JobState.CLAIMED,
                    "browser_stale",
                    claim_attempt=current_attempt,
                    max_claim_attempts=MAX_CLAIM_ATTEMPTS,
                )
                job["tab_id"] = None
                job["reservation_tab_id"] = None
                job["claim_token"] = uuid.uuid4().hex
                job["lease_expires_at"] = None
                job["last_worker_seen"] = None
                job["updated_at"] = datetime.now().isoformat()
                if next_state is JobState.QUEUED and job.get("id") not in BROWSER_QUEUE:
                    BROWSER_QUEUE.append(job.get("id"))
        # Registrations are runtime-generation records, not durable user
        # configuration. Drop expired registrations after their idle tab
        # inventory has been removed, while preserving a generation that still
        # owns a valid claim lease.
        for client_id, registration in list(BROWSER_REGISTRATIONS.items()):
            if now - float(getattr(registration, "last_seen", 0) or 0) < CLIENT_TTL:
                continue
            has_live_claim = any(
                str(job.get("client_id") or "") == str(client_id)
                and job.get("status") == JobState.CLAIMED.value
                and float(job.get("lease_expires_at") or 0) > now
                for job in BROWSER_JOBS.values()
            )
            if not has_live_claim:
                BROWSER_REGISTRATIONS.pop(client_id, None)
        _persist_browser_state_locked()


def _active_claim_for_tab(tab_id):
    """Return the current claimed job for a tab, if any.

    Browser registration is an inventory signal, not a replacement for the
    content script's readiness heartbeat. The active job is kept separate so a
    periodic inventory refresh cannot lose the conversation ownership record.
    """
    for job in BROWSER_JOBS.values():
        if job.get("status") == JobState.CLAIMED.value and str(job.get("tab_id")) == str(tab_id):
            return job
    return None

def invalidate_browser_ready(domain):
    with BROWSER_LOCK:
        for key, info in list(BROWSER_READY.items()):
            if info.get("domain") == domain:
                BROWSER_READY.pop(key, None)

def wait_for_browser_ready(domain, timeout):
    deadline=time.time()+timeout
    while time.time()<deadline:
        with BROWSER_LOCK:
            for key, info in BROWSER_READY.items():
                if (info.get("domain")==domain and info.get("ready")
                        and info.get("input_ready") and info.get("send_ready")
                        and time.time()-info.get("last_seen",0)<CLIENT_TTL):
                    return key
        time.sleep(0.1)
    return None

def browser_status_snapshot():
    purge_stale_browser_state()
    with BROWSER_LOCK:
        clients = {}
        for key, value in BROWSER_CLIENTS.items():
            clients[str(key)] = {
                field: value.get(field)
                for field in (
                    "state", "domain", "tab_id", "last_seen", "ready", "input_ready",
                    "send_ready", "capabilities", "url", "source", "heartbeat",
                    "client_id", "extension_version", "profile_id", "background_version",
                    "runtime_session_id",
                )
                if field in value
            }
        jobs = {
            jid: {"id": job.get("id"), "status": job.get("status"),
                  "domain": job.get("domain"), "conversation_id": job.get("conversation_id"),
                  "tab_id": job.get("tab_id"), "client_id": job.get("client_id"),
                  "model": job.get("model"), "target_url": job.get("target_url")}
            for jid, job in BROWSER_JOBS.items()
            if job.get("status") in ("queued", "claimed")
        }
        terminal_jobs = {
            jid: {"id": job.get("id"), "status": job.get("status"),
                  "domain": job.get("domain"), "conversation_id": job.get("conversation_id"),
                  "tab_id": job.get("tab_id"), "model": job.get("model"),
                  "target_url": job.get("target_url"),
                  "state_reason": job.get("state_reason"),
                  "error": job.get("error")}
            for jid, job in BROWSER_JOBS.items()
            if job.get("status") in ("completed", "failed", "cancelled")
        }
        bindings = {f"{key[0]}::{key[1]}": {
            "conversation_id": value.get("conversation_id"), "domain": value.get("domain"),
            "tab_id": value.get("tab_id"), "profile": value.get("profile"),
            "last_seen": value.get("last_seen")
        } for key, value in BROWSER_BINDINGS.items()}
    return {
        "clients": clients,
        "jobs": jobs,
        "terminal_jobs": terminal_jobs,
        "bindings": bindings,
        "queue_depth": len(BROWSER_QUEUE),
    }

def new_browser_job(message, domain="", model="", new_tab=False, target_url="", messages=None, request_meta=None, conversation_id=None, tab_id=None):
    jid = f"job_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}"
    conversation_id = str(conversation_id or f"conv_{uuid.uuid4().hex}")
    job = dict(id=jid, conversation_id=conversation_id, conversation_bound=bool(conversation_id and not conversation_id.startswith("conv_")),
               message=message, messages=messages or [{"role":"user","content":message}],
               domain=domain, model=model, request_meta=request_meta or {},
               new_tab=bool(new_tab), target_url=target_url,
               close_previous=False, status=JobState.QUEUED.value, tab_id=tab_id,
               state_reason="enqueued",
               reservation_tab_id=None, queued_at=time.time(), claimed_at=None,
               lease_expires_at=None, last_worker_seen=None,
               claim_token=uuid.uuid4().hex, claim_attempt=0,
               created_at=datetime.now().isoformat(), updated_at=datetime.now().isoformat(),
               result=None, error=None, stream_snapshot="")
    with BROWSER_LOCK:
        BROWSER_JOBS[jid] = job; BROWSER_QUEUE.append(jid)
        BROWSER_EVENTS[jid] = threading.Event()
        BROWSER_DELTAS[jid] = []
        _persist_browser_state_locked()
    return job

def normalize_stream_snapshot(value):
    import re
    footer = re.compile(r'^本回答由\s*AI\s*生成[，,。]?内容仅供参考[，,。]?请仔细甄别[。！!]?$')
    out = []
    for raw in str(value or '').replace('\\r\\n', '\\n').replace('\\r', '\\n').split('\\n'):
        line = raw.replace('\\u00a0', ' ').replace('\\u200b', '').strip()
        if not line:
            out.append('')
            continue
        compact = re.sub(r'\\s+', ' ', line).strip()
        if footer.match(compact):
            continue
        if re.match(r'^(?:正在)?(?:思考|深度思考|推理|分析)(?:中|\\.\\.\\.|…)?$', compact, re.I):
            continue
        if re.match(r'^(?:正在)?(?:阅读|读取|浏览|查看)(?:中|\\.\\.\\.|…)?$', compact, re.I):
            continue
        if re.match(r'^(?:正在)?(?:搜索|检索|查找)(?:几篇文章|一些文章|资料|网页)?(?:中|\\.\\.\\.|…)?$', compact, re.I):
            continue
        if re.match(r'^(?:thinking|reasoning|searching|browsing|reading|loading)(?:\\.\\.\\.|…)?$', compact, re.I):
            continue
        out.append(line)
    while out and not out[0].strip(): out.pop(0)
    while out and not out[-1].strip(): out.pop()
    return '\\n'.join(out)

def stream_snapshot_delta(previous, incoming):
    previous = str(previous or '')
    incoming = str(incoming or '')
    if not incoming or incoming == previous or previous.startswith(incoming):
        return ''
    if not previous or incoming.startswith(previous):
        return incoming[len(previous):]

    # A page can reflow the same generated text from an inline stream into
    # paragraph/newline markup when generation settles. Compare the semantic
    # character sequence before falling back to a full replacement; otherwise
    # the final reflow is emitted as a duplicate answer.
    compact_previous = ''.join(char for char in previous if not char.isspace())
    compact_incoming = ''.join(char for char in incoming if not char.isspace())
    if compact_previous and compact_incoming.startswith(compact_previous):
        if compact_previous == compact_incoming:
            return ''
        seen = 0
        cursor = 0
        for index, char in enumerate(incoming):
            if not char.isspace():
                seen += 1
            if seen == len(compact_previous):
                cursor = index + 1
                break
        suffix = incoming[cursor:]
        return suffix if suffix.strip() else ''

    max_len = min(len(previous), len(incoming))
    for n in range(max_len, 0, -1):
        if previous[-n:] == incoming[:n]:
            return incoming[n:]
    return incoming

def validate_job_actor(body, require_claimed=True):
    jid = str(body.get("job_id") or "")
    with BROWSER_LOCK:
        job = BROWSER_JOBS.get(jid)
        if not job:
            return None, "job_not_found"
        if require_claimed and job.get("status") != "claimed":
            return None, "job_not_claimed"
        supplied_token = str(body.get("claim_token") or "")
        expected_token = str(job.get("claim_token") or "")
        if not supplied_token or supplied_token != expected_token:
            return None, "claim_token_invalid"
        if body.get("tab_id") is None or str(body.get("tab_id")) != str(job.get("tab_id")):
            return None, "tab_id_mismatch"
        for field in ("conversation_id", "domain"):
            expected = str(job.get(field) or "").strip().lower()
            actual = str(body.get(field) or "").strip().lower()
            if actual != expected:
                return None, f"{field}_mismatch"
        expected_client = str(job.get("client_id") or "")
        actual_client = str(body.get("client_id") or "")
        if actual_client and expected_client and actual_client != expected_client:
            return None, "client_id_mismatch"
        return dict(job), None

def terminal_browser_result_replay(job, body):
    """Accept only an exact replay of a previously completed browser result."""
    if not job or job.get("status") != JobState.COMPLETED.value or not bool(body.get("success")):
        return False
    if str(body.get("claim_token") or "") != str(job.get("claim_token") or ""):
        return False
    if str(body.get("tab_id")) != str(job.get("tab_id")):
        return False
    if str(body.get("conversation_id") or "") != str(job.get("conversation_id") or ""):
        return False
    if str(body.get("domain") or "").strip().lower() != str(job.get("domain") or "").strip().lower():
        return False
    expected_client = str(job.get("client_id") or "")
    actual_client = str(body.get("client_id") or "")
    if expected_client and actual_client and expected_client != actual_client:
        return False
    stored = job.get("result") or {}
    for field in ("assistant", "key", "tool_call"):
        if body.get(field) != stored.get(field):
            return False
    return True

def append_browser_delta(body):
    _, error = validate_job_actor(body)
    if error:
        trace_api_event("browser_delta_rejected", {
            "job_id": body.get("job_id"),
            "error": error,
            "tab_id": body.get("tab_id"),
            "domain": body.get("domain", ""),
        })
        return False
    jid = str(body.get("job_id") or "")
    text = normalize_stream_snapshot(body.get("text") or "")
    if not jid or not text:
        trace_api_event("browser_delta_ignored", {
            "job_id": jid,
            "reason": "empty_snapshot",
            "text_length": len(text),
        })
        return False
    with BROWSER_LOCK:
        job = BROWSER_JOBS.get(jid)
        if not job or job.get("status") not in ("queued", "claimed"):
            trace_api_event("browser_delta_rejected", {
                "job_id": jid,
                "error": "job_not_active",
                "status": (job or {}).get("status") if job else "missing",
            })
            return False
        job["last_worker_seen"] = time.time()
        job["lease_expires_at"] = time.time() + 300.0
        events = BROWSER_DELTAS.setdefault(jid, [])
        previous = str(job.get("stream_snapshot") or "")
        delta = stream_snapshot_delta(previous, text)
        if not delta and text != previous:
            if len(text) > len(previous):
                delta = text
        job["stream_snapshot"] = text
        item = {"key": body.get("key") or "", "text": text,
                "delta": delta, "streaming": bool(body.get("streaming")),
                "completion_reason": body.get("completion_reason") or "",
                "time": time.time()}
        if delta or not events:
            events.append(item)
            if len(events) > 500:
                del events[:-500]
        _persist_browser_state_locked()
        trace_api_event("browser_delta_accepted", {
            "job_id": jid,
            "tab_id": job.get("tab_id"),
            "domain": job.get("domain", ""),
            "snapshot_length": len(text),
            "delta_length": len(delta),
            "streaming": bool(body.get("streaming")),
            "completion_reason": body.get("completion_reason") or "",
            "event_count": len(events),
        })
        return True

def browser_json(job): return dict(job) if job else None

def tool_names_for_request(job):
    tools = (job.get('request_meta') or {}).get('tools') or []
    names = set()
    for item in tools:
        fn = item.get('function') if isinstance(item, dict) and item.get('type') == 'function' else item
        if isinstance(fn, dict) and fn.get('name'):
            names.add(str(fn['name']))
    return names

def validate_tool_call_for_job(job, tool_call):
    if not isinstance(tool_call, dict):
        return None if tool_call is None else 'tool_call_invalid'
    if not str(tool_call.get('tool', '')).strip():
        return 'tool_name_missing'
    name = str(tool_call.get('tool'))
    allowed = tool_names_for_request(job)
    if not allowed or name not in allowed:
        return 'tool_name_not_allowed'
    args = tool_call.get('parameters')
    if not isinstance(args, dict):
        return 'tool_parameters_invalid'
    return None

def openai_assistant_message(result):
    result = result or {}
    tool = result.get("tool_call")
    if isinstance(tool, dict) and tool.get("tool"):
        name = str(tool.get("tool"))
        arguments = tool.get("parameters") if isinstance(tool.get("parameters"), dict) else {}
        return {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": f"call_{uuid.uuid4().hex[:12]}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))},
            }],
        }
    return {"role": "assistant", "content": str(result.get("assistant") or "")}

def openai_stream_error(stream_base, message, error_type):
    return dict(stream_base, error={"message": str(message), "type": str(error_type)})

def openai_stream_chunks(response_payload, stream_base):
    choices = response_payload.get("choices") or []
    message = ((choices[0] if choices else {}) or {}).get("message") or {}
    chunks = [dict(stream_base, choices=[{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}])]
    tool_calls = message.get("tool_calls") or []
    if tool_calls:
        stream_calls = []
        for index, call in enumerate(tool_calls):
            item = dict(call)
            item["index"] = index
            stream_calls.append(item)
        chunks.append(dict(stream_base, choices=[{"index": 0, "delta": {"tool_calls": stream_calls}, "finish_reason": None}]))
        finish_reason = "tool_calls"
    else:
        chunks.append(dict(stream_base, choices=[{"index": 0, "delta": {"content": message.get("content") or ""}, "finish_reason": None}]))
        finish_reason = "stop"
    chunks.append(dict(stream_base, choices=[{"index": 0, "delta": {}, "finish_reason": finish_reason}]))
    return chunks


def build_browser_response_payload(job, route, tool_choice="auto"):
    """Build the final OpenAI response from a completed recorded-browser job."""
    result_data = (job or {}).get("result") or {}
    result_text = str(result_data.get("assistant") or "")

    tool_calls = []
    structured_tool = result_data.get("tool_call") if tool_choice != "none" else None
    if isinstance(structured_tool, dict) and structured_tool.get("tool"):
        tool_calls = [ParsedToolCall(
            id=f"call_{uuid.uuid4().hex[:24]}",
            type="function",
            function_name=str(structured_tool.get("tool") or ""),
            arguments=json.dumps(
                structured_tool.get("parameters") or {},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )]
    elif tool_choice != "none":
        tool_calls = extract_tool_calls(result_text)

    if tool_calls:
        response = text_to_openai_response(
            text="", model=route.id, tool_calls=tool_calls,
            stream=False, finish_reason="tool_calls",
        )
    else:
        response = text_to_openai_response(
            text=result_text, model=route.id,
            stream=False, finish_reason="stop",
        )
    return dataclasses.asdict(response), result_text


def iter_live_browser_sse(job, route, request_key="", full_prompt="", tool_choice="auto", timeout_sec=240.0):
    """Yield caller-facing SSE as recorded DOM snapshots arrive.

    The extension posts full snapshots, not provider token events. The server
    computes the provider-neutral suffix at this boundary and keeps the HTTP
    stream open until the signed terminal browser result arrives.
    """
    job_id = str((job or {}).get("id") or "")
    response_id = f"chatcmpl-{job_id or uuid.uuid4().hex[:12]}"
    stream_base = {
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": route.id,
    }

    def generate():
        emitted_snapshot = ""
        event_index = 0
        deadline = time.monotonic() + max(15.0, float(timeout_sec or 0))
        last_heartbeat = time.monotonic()

        yield text_to_sse_chunk(
            delta_role="assistant",
            model=stream_base["model"],
            response_id=response_id,
            created=stream_base["created"],
        )

        while True:
            with BROWSER_LOCK:
                current = BROWSER_JOBS.get(job_id)
                events = list(BROWSER_DELTAS.get(job_id, []))
                status = str(current.get("status") or "") if current else "missing"
                result = deepcopy(current.get("result") or {}) if current else {}
                error = str(current.get("error") or "browser_error") if current else "job_not_found"

            for item in events[event_index:]:
                event_index += 1
                snapshot = normalize_stream_snapshot(item.get("text") or "")
                delta = stream_snapshot_delta(emitted_snapshot, snapshot) if snapshot else ""
                if not delta and not emitted_snapshot:
                    delta = str(item.get("delta") or "")
                if delta:
                    yield text_to_sse_chunk(
                        delta_content=delta,
                        model=stream_base["model"],
                        response_id=response_id,
                        created=stream_base["created"],
                    )
                if snapshot:
                    emitted_snapshot = snapshot

            if status == JobState.COMPLETED.value:
                result_text = normalize_stream_snapshot(result.get("assistant") or "")
                final_delta = stream_snapshot_delta(emitted_snapshot, result_text)
                if final_delta:
                    yield text_to_sse_chunk(
                        delta_content=final_delta,
                        model=stream_base["model"],
                        response_id=response_id,
                        created=stream_base["created"],
                    )
                response_dict, _ = build_browser_response_payload(
                    {"result": result}, route, tool_choice
                )
                if request_key:
                    complete_idempotency(request_key, response_dict)
                finish_reason = (response_dict.get("choices") or [{}])[0].get("finish_reason") or "stop"
                yield text_to_sse_chunk(
                    model=stream_base["model"],
                    finish_reason=finish_reason,
                    response_id=response_id,
                    created=stream_base["created"],
                )
                yield build_sse_done()
                return

            if status in {JobState.FAILED.value, JobState.CANCELLED.value, "missing"}:
                if request_key:
                    fail_idempotency(
                        request_key,
                        openai_error(error, "server_error", code="browser_error"),
                        terminal=True,
                    )
                yield build_sse_error(error, "server_error")
                yield build_sse_done()
                return

            now = time.monotonic()
            if now >= deadline:
                timeout_error = "Request timed out while waiting for browser response"
                finish_browser_job(job_id, "failed", error="browser_timeout")
                if request_key:
                    fail_idempotency(
                        request_key,
                        openai_error(timeout_error, "server_error", code="timeout"),
                        terminal=True,
                    )
                yield build_sse_error(timeout_error, "server_error")
                yield build_sse_done()
                return

            if now - last_heartbeat >= _BROWSER_STREAM_HEARTBEAT_INTERVAL:
                last_heartbeat = now
                yield ": heartbeat\n\n"
            time.sleep(_BROWSER_STREAM_POLL_INTERVAL)

    return generate()

def reap_expired_browser_jobs():
    now = time.time()
    with BROWSER_LOCK:
        for job in BROWSER_JOBS.values():
            if job.get("status") == JobState.QUEUED.value:
                queued_at = float(job.get("queued_at") or 0)
                if queued_at and now - queued_at >= BROWSER_QUEUE_TIMEOUT:
                    job["status"] = JobState.FAILED.value
                    job["state_reason"] = "browser_queue_timeout"
                    job["error"] = "browser_queue_timeout"
                    job["lease_expires_at"] = None
                    job["updated_at"] = datetime.now().isoformat()
                    if job.get("id") in BROWSER_QUEUE:
                        BROWSER_QUEUE.remove(job.get("id"))
                    event = BROWSER_EVENTS.pop(job.get("id"), None)
                    if event:
                        event.set()
                    trace_api_event("browser_job_expired", {
                        "job_id": job.get("id"),
                        "domain": job.get("domain"),
                        "reason": "browser_queue_timeout",
                    })
                    continue
            if job.get("status") != "claimed":
                continue
            if not job.get("lease_expires_at"):
                job["lease_expires_at"] = now + 300.0
                job["updated_at"] = datetime.now().isoformat()
                continue
            if job["lease_expires_at"] > now:
                continue
            current_attempt = int(job.get("claim_attempt", 0))
            next_state = next_job_state(
                job.get("status", JobState.CLAIMED.value),
                "lease_expired",
                claim_attempt=current_attempt,
                max_claim_attempts=MAX_CLAIM_ATTEMPTS,
            )
            job["status"] = next_state.value
            job["state_reason"] = recovery_action(
                JobState.CLAIMED,
                "lease_expired",
                claim_attempt=current_attempt,
                max_claim_attempts=MAX_CLAIM_ATTEMPTS,
            )
            old_tab_id = job.get("tab_id")
            job["tab_id"] = None
            job["reservation_tab_id"] = None
            job["claim_token"] = uuid.uuid4().hex
            job["claim_attempt"] = current_attempt + 1
            if next_state is JobState.FAILED:
                job["error"] = "max_claim_attempts_exceeded"
                job["lease_expires_at"] = None
                job["updated_at"] = datetime.now().isoformat()
                continue
            job["lease_expires_at"] = None
            job["last_worker_seen"] = None
            job["updated_at"] = datetime.now().isoformat()
            binding_key = (str(job.get("conversation_id") or ""), str(job.get("domain") or "").strip().lower())
            binding = BROWSER_BINDINGS.get(binding_key)
            if binding and binding.get("tab_id") == old_tab_id:
                BROWSER_BINDINGS.pop(binding_key, None)
            if next_state is JobState.QUEUED and job.get("id") not in BROWSER_QUEUE:
                BROWSER_QUEUE.append(job.get("id"))

        _persist_browser_state_locked()

def _fresh_contract_client_for_domain(domain):
    """Return whether a current registration owns the requested domain.

    A registration is the stable identity boundary for the extension. Once a
    current contract client is present for a domain, an identity-less legacy
    poll must not be allowed to race it for the same queued job.
    """
    wanted = str(domain or "").strip().lower()
    now = time.time()
    for registration in BROWSER_REGISTRATIONS.values():
        last_seen = float(getattr(registration, "last_seen", 0) or 0)
        if now - last_seen >= CLIENT_TTL:
            continue
        if any(str(tab.get("domain") or "").strip().lower() == wanted
               for tab in getattr(registration, "tabs", ())):
            return True
    return False


def claim_browser_job(domain=None, tab_id=None, conversation_id=None, client_id=None):
    with BROWSER_LOCK:
        client = BROWSER_CLIENTS.get(str(tab_id)) if tab_id is not None else None
        if tab_id is not None and client is None:
            return None
        if tab_id is not None and not str(client_id or "").strip() and _fresh_contract_client_for_domain(domain):
            # Do not let an old extension instance with no stable identity
            # steal a job from the current registration contract.
            return None
        if client_id and client and str(client.get("client_id") or "") != str(client_id):
            return None
        if tab_id is not None and client and time.time() - float(client.get("last_seen", 0) or 0) >= CLIENT_TTL:
            return None
        caps = (client or {}).get("capabilities")
        if tab_id is not None and client and caps is not None:
            # Registration and content-ready heartbeats are the server's
            # eligibility contract. A tab that cannot both execute and observe
            # must not consume a job; the extension will refresh its heartbeat
            # after re-injecting the content bridge when it becomes usable.
            if caps.get("can_execute") is not True or caps.get("can_observe") is not True:
                return None
            if client.get("ready") is False and str(client.get("source") or "").lower() != "content-ready":
                return None
        for jid in list(BROWSER_QUEUE):
            job = BROWSER_JOBS.get(jid)
            if not job or job["status"] != "queued":
                if jid in BROWSER_QUEUE: BROWSER_QUEUE.remove(jid)
                continue
            if job.get("domain") and domain and job["domain"] != domain: continue
            if job.get("domain") and not domain: continue
            expected_conversation = str(job.get("conversation_id") or "")
            if job.get("conversation_bound") and expected_conversation and str(conversation_id or "") != expected_conversation and not job.get("new_tab"):
                continue
            if job.get("tab_id") and tab_id and job["tab_id"] != tab_id: continue
            binding_key = (str(job.get("conversation_id") or conversation_id or ""), str(job.get("domain") or domain or "").strip().lower())
            binding = BROWSER_BINDINGS.get(binding_key)
            if binding and time.time() - binding.get("last_seen", 0) >= CLIENT_TTL:
                BROWSER_BINDINGS.pop(binding_key, None)
                binding = None
            if binding and binding.get("tab_id") is not None and binding.get("tab_id") != tab_id:
                continue
            if tab_id and any(
                other.get("status") == "claimed" and other.get("tab_id") == tab_id
                for other in BROWSER_JOBS.values()
                if other.get("id") != jid
            ):
                continue
            BROWSER_QUEUE.remove(jid)
            try:
                job["status"] = next_job_state(job.get("status", JobState.QUEUED.value), "claim").value
            except InvalidTransition:
                continue
            job["state_reason"] = "claimed"
            job["claimed_at"] = time.time()
            job["last_worker_seen"] = time.time()
            job["lease_expires_at"] = time.time() + 300.0
            job["claim_token"] = uuid.uuid4().hex
            job["reservation_tab_id"] = tab_id or job.get("reservation_tab_id")
            job["tab_id"] = tab_id or job.get("tab_id")
            job["client_id"] = str(client.get("client_id") or client_id or "") if client else str(client_id or "")
            job["claim_attempt"] = int(job.get("claim_attempt", 0)) + 1
            BROWSER_BINDINGS[binding_key] = {
                "conversation_id": job["conversation_id"],
                "domain": job.get("domain") or domain or "",
                "tab_id": job.get("tab_id"),
                "profile": "chrome-extension",
                "last_seen": time.time(),
            }
            job["updated_at"] = datetime.now().isoformat()
            client_record = dict(client or {})
            client_record.update(
                domain=domain or client_record.get("domain", ""),
                tab_id=tab_id,
                conversation_id=job["conversation_id"],
                last_seen=time.time(),
                ready=True,
                # A successful poll is the execution authority boundary. A
                # registration inventory may have arrived immediately before
                # the claim and carries source=browser-register; retaining that
                # source lets the next stale-state sweep mistake this live tab
                # for an inventory-only record and requeue its active job.
                source="content-ready",
                capabilities=client_record.get("capabilities", {}),
            )
            BROWSER_CLIENTS[str(tab_id or "unknown")] = client_record
            _persist_browser_state_locked()
            return browser_json(job)
    return None

def finish_browser_job(jid,status,result=None,error=None):
    target_events = {"completed": "complete", "failed": "fail", "cancelled": "cancelled"}
    with BROWSER_LOCK:
        job=BROWSER_JOBS.get(jid)
        if not job: return None
        current = job.get("status")
        event = target_events.get(status)
        if event is None:
            return browser_json(job)
        if event == "cancelled":
            event = "cancel"
        try:
            next_state = next_job_state(current, event)
        except (InvalidTransition, ValueError):
            return browser_json(job)
        if next_state.value != status:
            return browser_json(job)
        job["status"] = next_state.value
        job["state_reason"] = status
        job["result"]=result; job["error"]=error
        job["lease_expires_at"] = None
        job["last_worker_seen"] = time.time()
        job["updated_at"]=datetime.now().isoformat()
        ev=BROWSER_EVENTS.pop(jid, None)
        if ev: ev.set()
        _persist_browser_state_locked()
        return browser_json(job)

def load_data():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE,"r",encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            # Preserve the unreadable artifact before allowing the service to
            # continue with a clean in-memory store. The next save replaces
            # the primary file atomically, so a partial write cannot recur.
            global _CORRUPT_DATA_BACKUP
            if _CORRUPT_DATA_BACKUP is None:
                backup = f"{DATA_FILE}.corrupt-{int(time.time())}.bak"
                try:
                    shutil.copy2(DATA_FILE, backup)
                    _CORRUPT_DATA_BACKUP = backup
                except OSError:
                    _CORRUPT_DATA_BACKUP = ""
            trace_api_event("conversation_data_corrupt", {
                "error": type(exc).__name__,
                "backup": _CORRUPT_DATA_BACKUP,
            })
    return {"conversations":[],"models":[]}

def save_data(data):
    directory = os.path.dirname(DATA_FILE) or "."
    temporary = os.path.join(
        directory,
        f".{os.path.basename(DATA_FILE)}.{os.getpid()}.{threading.get_ident()}.tmp",
    )
    try:
        with open(temporary, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, DATA_FILE)
    finally:
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass

def save_conversation(user,assistant,model="",source="api",conversation_id="", job_id="", completion_reason=""):
    with CONVERSATION_LOCK:
        return _save_conversation_locked(user,assistant,model,source,conversation_id,job_id,completion_reason)

def _save_conversation_locked(user,assistant,model="",source="api",conversation_id="", job_id="", completion_reason=""):
    data=load_data()
    conversations=data.setdefault("conversations",[])
    conv=dict(user=user,assistant=assistant,model=model,source=source,
              conversation_id=conversation_id or None, job_id=job_id or None,
              completion_reason=completion_reason or None,
              timestamp=datetime.now().isoformat(),id=f"conv_{int(time.time()*1000)}_{len(conversations)}")
    conversations.append(conv)
    if model and model not in data.setdefault("models",[]): data["models"].append(model)
    save_data(data)
    return conv

def message_content(value):
    if isinstance(value, str): return value
    if isinstance(value, list):
        parts=[]
        for part in value:
            if isinstance(part, str): parts.append(part)
            elif isinstance(part, dict) and part.get("type") in (None, "text"):
                if part.get("text") is not None: parts.append(str(part["text"]))
        return "".join(parts)
    return "" if value is None else str(value)

def approx_tokens(text):
    cn=sum(1 for c in text if '\\u4e00'<=c<='\\u9fff')
    return int(cn/1.5+(len(text)-cn)/4)

def trace_api_event(kind, data):
    try:
        with open(TRACE_FILE, 'a', encoding='utf-8') as f:
            f.write(json.dumps({"source":"api", "kind":kind, "time":time.time(), **data}, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ═══ Flask Routes — Existing browser endpoints (preserved) ═══

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "service": "phantom-relay-api",
        "browser_activation_owner": BROWSER_ACTIVATION_OWNER,
        "browser_auto_wake": AUTO_WAKE_BROWSER,
    })


@app.route('/model-routes', methods=['GET'])
def get_model_routes():
    return jsonify({"routes":load_routes()})


@app.route('/v1/capabilities', methods=['GET'])
def get_capabilities():
    return jsonify({
        "object": "capabilities",
        "protocol": "openai-chat-completions-compatible",
        "supported": {
            "model": True, "messages": True, "stream": True,
            "temperature": "accepted_passthrough", "top_p": "accepted_passthrough",
            "max_tokens": "accepted_passthrough", "max_completion_tokens": "accepted_passthrough",
            "stop": "accepted_passthrough", "frequency_penalty": "accepted_passthrough",
            "presence_penalty": "accepted_passthrough", "user": "accepted_passthrough",
            "tools": "capability_gated", "tool_choice": "capability_gated",
            "phantom_relay": "optional_extension_namespace",
            "stream_options": "not_implemented", "response_format": "text_only",
            "n": "not_implemented", "seed": "not_implemented",
            "logprobs": "not_implemented", "top_logprobs": "not_implemented",
            "modalities": "not_implemented", "audio": "not_implemented",
            "reasoning_effort": "not_implemented", "service_tier": "not_implemented",
            "prediction": "not_implemented", "metadata": "not_implemented",
        },
        "response": {"json": True, "sse": True, "usage": True,
                     "tool_calls": True, "reasoning_content": False,
                     "citations": False},
        "notes": [
            "stream=true emits browser snapshot deltas, not provider token boundaries",
            "accepted_passthrough fields are recorded for routing/audit but may not alter webpage behavior",
            "unsupported fields return an explicit unsupported_capability error where applicable"
        ]
    })


@app.route('/browser/status', methods=['GET', 'POST'])
def browser_status():
    reap_expired_browser_jobs()
    return jsonify(browser_status_snapshot())


@app.route('/browser/reset', methods=['GET', 'POST'])
def browser_reset():
    with BROWSER_LOCK:
        job_ids = [
            jid for jid, job in BROWSER_JOBS.items()
            if job.get("status") in (JobState.QUEUED.value, JobState.CLAIMED.value)
        ]
        BROWSER_QUEUE.clear()
    for jid in job_ids:
        finish_browser_job(jid, "failed", error="reset")
    return jsonify({"ok": True})


def _profile_now():
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


@app.route('/browser/profiles', methods=['POST'])
def browser_profiles_upsert():
    global _registry_profile_registry
    body = request.get_json(force=True) or {}
    incoming_profile = body.get("profile") if isinstance(body, dict) else None
    profile_id = str((incoming_profile or {}).get("profileId") or "").strip()
    existing = (_registry_profile_registry.get("profiles", {}) or {}).get(profile_id) if profile_id else None
    expected_domain = _profile_domain(existing) if isinstance(existing, dict) else None
    try:
        validated = validate_profile_envelope(body, expected_domain=expected_domain or None)
    except RegistryContractError as exc:
        status = 422 if exc.code == "profile_domain_mismatch" else 400
        return jsonify(openai_error(str(exc), "invalid_request_error", code=exc.code)), status

    profiles = deepcopy(_registry_profile_registry.get("profiles", {}))
    current = profiles.get(validated["profile_id"])
    current_lifecycle = current.get("lifecycle", {}) if isinstance(current, dict) else {}
    current_revision = int(current_lifecycle.get("revision") or current.get("revision", 0) if isinstance(current, dict) else 0)
    current_checksum = str(current_lifecycle.get("checksum") or current.get("checksum") or "") if isinstance(current, dict) else ""
    if current:
        if validated["revision"] == current_revision and validated["checksum"] != current_checksum:
            return jsonify(openai_error("same revision has a different checksum", "conflict_error", code="profile_conflict")), 409
        if validated["revision"] < current_revision:
            return jsonify(openai_error("profile revision is older than the persisted revision", "conflict_error", code="profile_revision_conflict")), 409
        if validated["revision"] == current_revision:
            bindings_updated = _resolve_pending_domain_bindings(current) if REGISTRY_DIR else 0
            if bindings_updated:
                reload_model_config_globals()
            return jsonify({
                "ok": True,
                "profile_id": validated["profile_id"],
                "revision": current_revision,
                "checksum": current_checksum,
                "state": "synced",
                "bindings_updated": bindings_updated,
            })

    now = _profile_now()
    profile = deepcopy(validated["profile"])
    old_created = current_lifecycle.get("createdAt") if isinstance(current_lifecycle, dict) else None
    profile["lifecycle"] = {
        "schemaVersion": 2,
        "revision": validated["revision"],
        "checksum": validated["checksum"],
        "createdAt": old_created or now,
        "updatedAt": now,
        "lastVerifiedAt": None,
        "source": "user-recorded",
        "state": "synced",
    }
    profile["health"] = None
    profiles[validated["profile_id"]] = profile
    _registry_profile_registry = normalize_profile_registry({
        "version": _registry_profile_registry.get("version", 1),
        "profiles": profiles,
    })
    if REGISTRY_DIR:
        _write_json_atomic(PROFILE_REGISTRY_FILE, _registry_profile_registry)
        bindings_updated = _resolve_pending_domain_bindings(profile)
        reload_model_config_globals()
    else:
        bindings_updated = 0
        domain = _profile_domain(profile)
        if domain:
            selector_templates[domain] = _authoritative_selector_template(
                domain,
                selector_templates.get(domain, {}),
            )
            save_selector_templates(selector_templates)
    return jsonify({
        "ok": True,
        "profile_id": validated["profile_id"],
        "revision": validated["revision"],
        "checksum": validated["checksum"],
        "state": "synced",
        "bindings_updated": bindings_updated,
    })


@app.route('/browser/profiles/<profile_id>', methods=['GET'])
def browser_profile_get(profile_id):
    profile_key = str(profile_id or "").strip()
    profile = (_registry_profile_registry.get("profiles", {}) or {}).get(profile_key)
    if not isinstance(profile, dict):
        return jsonify(openai_error("profile was not found", "not_found_error", code="profile_missing")), 404
    payload = deepcopy(profile)
    lifecycle = payload.pop("lifecycle", {}) if isinstance(payload.get("lifecycle"), dict) else {}
    return jsonify({
        "ok": True,
        "profile_id": profile_key,
        "profile": payload,
        "revision": lifecycle.get("revision", 0),
        "checksum": lifecycle.get("checksum", ""),
        "state": lifecycle.get("state", "synced"),
        "lastVerifiedAt": lifecycle.get("lastVerifiedAt"),
        "health": deepcopy(profile.get("health")),
    })


@app.route('/browser/profiles/health', methods=['POST'])
def browser_profile_health():
    global _registry_profile_registry
    body = request.get_json(force=True) or {}
    profile_id = str(body.get("profile_id") or "").strip()
    profile = (_registry_profile_registry.get("profiles", {}) or {}).get(profile_id)
    if not isinstance(profile, dict):
        return jsonify(openai_error("profile was not found", "not_found_error", code="profile_missing")), 404
    lifecycle = profile.get("lifecycle") if isinstance(profile.get("lifecycle"), dict) else {}
    revision = int(body.get("revision") or 0)
    if revision != int(lifecycle.get("revision") or 0):
        return jsonify(openai_error("health report revision does not match profile", "conflict_error", code="profile_revision_conflict")), 409
    state = str(body.get("state") or "").strip()
    if state not in {"verified", "degraded", "invalid"}:
        return jsonify(openai_error("health state is invalid", "invalid_request_error", code="profile_health_invalid")), 400
    checks = body.get("checks") if isinstance(body.get("checks"), dict) else {}
    reason_codes = body.get("reason_codes") if isinstance(body.get("reason_codes"), list) else []
    if any(not isinstance(key, str) or key not in {"input", "send", "response", "identity", "streaming"} for key in checks):
        return jsonify(openai_error("health checks contain an unsupported field", "invalid_request_error", code="profile_health_invalid")), 400
    if any(not isinstance(code, str) or not code.strip() for code in reason_codes):
        return jsonify(openai_error("reason_codes must contain strings", "invalid_request_error", code="profile_health_invalid")), 400
    now = _profile_now()
    updated = deepcopy(profile)
    updated["health"] = {
        "profile_id": profile_id,
        "revision": revision,
        "state": state,
        "checks": {key: str(value) for key, value in checks.items()},
        "reason_codes": list(dict.fromkeys(reason_codes)),
    }
    updated["lifecycle"] = {
        **lifecycle,
        "updatedAt": now,
        "state": state,
        "lastVerifiedAt": now if state == "verified" else lifecycle.get("lastVerifiedAt"),
    }
    profiles = deepcopy(_registry_profile_registry.get("profiles", {}))
    profiles[profile_id] = updated
    _registry_profile_registry = normalize_profile_registry({
        "version": _registry_profile_registry.get("version", 1),
        "profiles": profiles,
    })
    if REGISTRY_DIR:
        _write_json_atomic(PROFILE_REGISTRY_FILE, _registry_profile_registry)
    return jsonify({"ok": True, "profile_id": profile_id, "revision": revision, "state": state})


@app.route('/browser/selectors', methods=['GET', 'POST'])
def browser_selectors():
    global selector_templates
    if request.method == 'POST':
        body = request.get_json(force=True)
        domain = str(body.get("domain") or "").strip().lower()
        if not domain:
            return jsonify(openai_error("domain empty", "invalid_request_error")), 400
        if body.get("selectors") is not None:
            incoming = body.get("selectors")
            if not isinstance(incoming, dict):
                return jsonify(openai_error("selectors must be object", "invalid_request_error")), 400
            clean = {r: incoming.get(r) for r in ("input","send","response","profile") if incoming.get(r) not in (None, "", False)}
            if REGISTRY_DIR and isinstance(clean.get("profile"), dict):
                profile_domain = _profile_domain(clean["profile"])
                if profile_domain and profile_domain != domain:
                    return jsonify(openai_error("profile domain does not match request domain", "invalid_request_error", code="profile_domain_mismatch")), 400
                existing_profile = _profiles_by_domain(_registry_profile_registry).get(domain)
                try:
                    validated = validate_profile_envelope({
                        "profile": clean["profile"],
                        "revision": (clean["profile"].get("lifecycle") or {}).get("revision", 1),
                        "checksum": (clean["profile"].get("lifecycle") or {}).get("checksum") or profile_checksum(clean["profile"]),
                    }, expected_domain=_profile_domain(existing_profile) if existing_profile else None)
                    clean["profile"] = validated["profile"]
                except RegistryContractError as exc:
                    return jsonify(openai_error(str(exc), "invalid_request_error", code=exc.code)), 400
            selector_templates[domain] = _authoritative_selector_template(
                domain,
                merge_recorded_selector_template(
                    _sanitize_legacy_selector_template(selector_templates.get(domain)),
                    _sanitize_legacy_selector_template(clean),
                ),
            )
            save_selector_templates(selector_templates)
            return jsonify({
                "ok": True,
                "domain": domain,
                "selectors": _authoritative_selector_template(domain, selector_templates[domain]),
                "profile_revision": _profile_revision_for_domain(domain),
            })
        selectors = _authoritative_selector_template(domain, selector_templates.get(domain, {}))
        return jsonify({
            "domain": domain,
            "selectors": selectors,
            "profile_revision": _profile_revision_for_domain(domain),
        })
    else:
        domain = request.args.get("domain", "").strip().lower()
        selectors = _authoritative_selector_template(domain, selector_templates.get(domain, {}))
        return jsonify({
            "domain": domain,
            "selectors": selectors,
            "profile_revision": _profile_revision_for_domain(domain),
        })


@app.route('/browser/pending-domains', methods=['GET'])
def browser_pending_domains():
    reap_expired_browser_jobs()
    with BROWSER_LOCK:
        pending = []
        claimed_tab_ids = []
        for jid, live_job in BROWSER_JOBS.items():
            if live_job.get("status") == "claimed" and live_job.get("tab_id") is not None:
                claimed_tab_ids.append(int(live_job["tab_id"]))
        for jid in BROWSER_QUEUE:
            job = BROWSER_JOBS.get(jid)
            if job and job.get("status") == "queued" and job.get("domain"):
                binding = BROWSER_BINDINGS.get((str(job.get("conversation_id") or ""), str(job.get("domain") or "").strip().lower()))
                pending.append({"id":job.get("id"),"domain":job["domain"],"conversation_id":job.get("conversation_id"),
                                "target_url":job.get("target_url"),"new_tab":bool(job.get("new_tab")),
                                "reservation_tab_id":job.get("reservation_tab_id"),
                                "bound_tab_id":binding.get("tab_id") if binding else None,
                                "claim_attempt":job.get("claim_attempt", 0),"status":job.get("status")})
    return jsonify({"jobs":pending,"domains":list(dict.fromkeys(x["domain"] for x in pending)),"claimed_tab_ids":claimed_tab_ids})


@app.route('/browser/register', methods=['POST'])
def browser_register():
    """Register one extension instance and index its current tabs."""
    body = request.get_json(force=True)
    try:
        registration = normalize_registration(body)
    except (BrowserClientContractError, TypeError, ValueError) as exc:
        return jsonify(openai_error(str(exc), "invalid_request_error",
                                    code="invalid_browser_registration")), 400

    if not runtime_session_allowed(registration.runtime_session_id):
        with BROWSER_LOCK:
            evict_browser_client_runtime_locked(registration.client_id)
        trace_api_event("browser_runtime_rejected", {
            "operation": "register",
            "client_id": registration.client_id,
            "received_runtime_session_id": registration.runtime_session_id,
            "reason": "runtime_session_required",
        })
        return jsonify(openai_error(
            "browser runtime session is required",
            "conflict_error",
            code="browser_runtime_required",
        )), 409

    with BROWSER_LOCK:
        now = time.time()
        previous_registration = BROWSER_REGISTRATIONS.get(registration.client_id)
        previous_runtime_session_id = str(
            getattr(previous_registration, "runtime_session_id", "") or ""
        )
        if (
            previous_runtime_session_id
            and previous_runtime_session_id != registration.runtime_session_id
            and registration.runtime_session_id.startswith("legacy:")
        ):
            trace_api_event("browser_runtime_rejected", {
                "operation": "register",
                "client_id": registration.client_id,
                "expected_runtime_session_id": previous_runtime_session_id,
                "received_runtime_session_id": registration.runtime_session_id,
                "reason": "older_legacy_worker",
            })
            return jsonify(openai_error(
                "browser runtime session is stale",
                "conflict_error",
                code="browser_runtime_stale",
            )), 409
        if (
            previous_runtime_session_id
            and previous_runtime_session_id != registration.runtime_session_id
        ):
            trace_api_event("browser_runtime_replaced", {
                "client_id": registration.client_id,
                "previous_runtime_session_id": previous_runtime_session_id,
                "runtime_session_id": registration.runtime_session_id,
            })
            for key, previous in list(BROWSER_CLIENTS.items()):
                if str(previous.get("client_id") or "") == registration.client_id:
                    BROWSER_CLIENTS.pop(key, None)
                    BROWSER_READY.pop(key, None)
            for job in BROWSER_JOBS.values():
                if str(job.get("client_id") or "") == registration.client_id:
                    _requeue_claimed_job_for_runtime_replacement_locked(job)
        BROWSER_REGISTRATIONS[registration.client_id] = registration
        incoming_tab_ids = {str(tab["tab_id"]) for tab in registration.tabs}
        for key, previous in list(BROWSER_CLIENTS.items()):
            if (str(previous.get("client_id") or "") == registration.client_id
                    and str(key) not in incoming_tab_ids):
                BROWSER_CLIENTS.pop(key, None)
                BROWSER_READY.pop(key, None)

        for tab in registration.tabs:
            key = str(tab["tab_id"])
            previous = BROWSER_CLIENTS.get(key) or {}
            active_job = _active_claim_for_tab(tab["tab_id"])
            if active_job and str(active_job.get("client_id") or "") not in {"", registration.client_id}:
                # A tab id is only locally unique to a browser profile. Never
                # copy another registered client's conversation ownership into
                # this registration when two clients share numeric tab ids.
                active_job = None
            previous_is_fresh_content_ready = bool(
                previous
                and str(previous.get("client_id") or "") == registration.client_id
                and str(previous.get("domain") or "").strip().lower() == tab["domain"]
                and str(previous.get("source") or "") == "content-ready"
                and previous.get("ready") is True
                and previous.get("input_ready") is True
                and previous.get("send_ready") is True
                and now - float(previous.get("last_seen", 0) or 0) < CLIENT_TTL
            )
            if previous_is_fresh_content_ready:
                # Keep the authoritative content heartbeat and its timestamp.
                # The inventory payload may intentionally report false while
                # the service worker has not yet reconstructed activeClaims.
                info = dict(previous)
                info.update(
                    client_id=registration.client_id,
                    extension_version=registration.extension_version,
                    browser=dict(registration.browser),
                    profile_id=registration.profile_id,
                    url=tab["url"],
                    heartbeat=True,
                )
            else:
                info = dict(
                    previous,
                    client_id=registration.client_id,
                    runtime_session_id=registration.runtime_session_id,
                    extension_version=registration.extension_version,
                    browser=dict(registration.browser),
                    profile_id=registration.profile_id,
                    domain=tab["domain"],
                    tab_id=tab["tab_id"],
                    url=tab["url"],
                    ready=tab["ready"],
                    input_ready=tab["input_ready"],
                    send_ready=tab["send_ready"],
                    state=tab["state"],
                    capabilities=dict(tab["capabilities"]),
                    conversation_id=tab["conversation_id"],
                    last_seen=tab["last_seen"],
                    source="browser-register",
                    heartbeat=True,
                )
            if active_job:
                info["conversation_id"] = active_job.get("conversation_id") or info.get("conversation_id", "")
            BROWSER_CLIENTS[key] = info
            if info["ready"] and info["input_ready"] and info["send_ready"]:
                BROWSER_READY[key] = info
                event = BROWSER_READY_EVENTS.get(key)
                if event:
                    event.set()
            else:
                BROWSER_READY.pop(key, None)

    # Inventory removal is an immediate disconnect signal. Reconcile claimed
    # jobs now instead of waiting for the much longer lease timeout.
    purge_stale_browser_state()

    return jsonify({
        "ok": True,
        "client": client_status_payload(registration),
    })


@app.route('/browser/clients', methods=['GET', 'POST'])
def browser_clients():
    purge_stale_browser_state()
    with BROWSER_LOCK:
        clients = dict(BROWSER_CLIENTS)
        registrations = {
            client_id: client_status_payload(registration)
            for client_id, registration in BROWSER_REGISTRATIONS.items()
        }
    return jsonify({"clients":clients,"registrations":registrations})


@app.route('/browser/result-token', methods=['GET'])
def browser_result_token():
    try:
        jid = str(request.args.get("job_id") or "")
        tab_id = str(request.args.get("tab_id") or "")
        domain = str(request.args.get("domain") or "").strip().lower()
        conversation_id = str(request.args.get("conversation_id") or "")
        client_id = str(request.args.get("client_id") or "").strip()
        with BROWSER_LOCK:
            job = BROWSER_JOBS.get(jid)
            valid = bool(job and job.get("status")=="claimed"
                and str(job.get("tab_id"))==tab_id
                and str(job.get("domain") or "").strip().lower()==domain
                and str(job.get("conversation_id") or "")==conversation_id
                and (not client_id or str(job.get("client_id") or "") == client_id))
            token = str(job.get("claim_token") or "") if valid else ""
        if not token:
            trace_api_event("result_token_unavailable", {
                "job_id": jid,
                "requested_tab_id": tab_id,
                "requested_domain": domain,
                "requested_conversation_id": conversation_id,
                "requested_client_id": client_id,
                "job_status": job.get("status") if job else "missing",
                "job_tab_id": str(job.get("tab_id")) if job else "",
                "job_domain": str(job.get("domain") or "") if job else "",
                "job_conversation_id": str(job.get("conversation_id") or "") if job else "",
                "job_client_id": str(job.get("client_id") or "") if job else "",
                "identity_match": bool(job and str(job.get("tab_id"))==tab_id
                    and str(job.get("domain") or "").strip().lower()==domain
                    and str(job.get("conversation_id") or "")==conversation_id),
            })
            return jsonify(openai_error("result token unavailable", "result_token_unavailable")), 409
        return jsonify({"claim_token":token,"job_id":jid})
    except Exception as exc:
        trace_api_event("result_token_exception", {"error":repr(exc)})
        return jsonify(openai_error("result token lookup failed", "server_error")), 500


@app.route('/trace/tail', methods=['GET'])
def trace_tail():
    limit = int(request.args.get("limit", 20))
    entries = []
    if os.path.exists(TRACE_FILE):
        with open(TRACE_FILE,"r") as f:
            for line in f:
                try: entries.append(json.loads(line))
                except: pass
    return jsonify({"entries":entries[-limit:]})


@app.route('/browser/sync-selectors', methods=['POST'])
def browser_sync_selectors():
    global selector_templates
    body = request.get_json(force=True)
    incoming = body.get("selectors") if isinstance(body.get("selectors"), dict) else body
    selector_templates = merge_selector_templates(selector_templates, incoming)
    save_selector_templates(selector_templates)
    return jsonify({"ok":True,"selectors":selector_templates})


@app.route('/browser/sync-routes', methods=['POST'])
def browser_sync_routes():
    global model_routes
    body = request.get_json(force=True)
    incoming = body.get("routes",{})
    routes = {k: (v if isinstance(v, dict) else str(v)) for k, v in incoming.items()}
    if REGISTRY_DIR:
        changed = _sync_separated_bindings(routes)
        if changed:
            reload_model_config_globals()
        model_routes = load_routes()
        return jsonify({"ok": True, "count": len(routes), "bindings_updated": changed})
    if routes:
        save_routes(routes)
        model_routes = load_routes()
    return jsonify({"ok":True,"count":len(routes)})


@app.route('/trace', methods=['POST'])
def trace_post():
    body = request.get_json(force=True)
    entry = {
        "source":"phantom-relay",
        "domain":body.get("domain", ""),
        "tabId":body.get("tabId"),
        "entry":body.get("entry", body),
    }
    mark_browser_page_presence(
        domain=entry.get("domain") or body.get("domain"),
        tab_id=entry.get("tabId") if entry.get("tabId") is not None else body.get("tabId"),
        url=(entry.get("entry") or {}).get("url") if isinstance(entry.get("entry"), dict) else body.get("url", ""),
    )
    with open(TRACE_FILE,"a",encoding="utf-8") as f:
        f.write(json.dumps(entry,ensure_ascii=False)+"\n")
    return jsonify({"ok":True})


@app.route('/browser/debug', methods=['POST'])
def browser_debug():
    body = request.get_json(force=True)
    entry = {"source":"phantom-relay-background","domain":body.get("domain", ""),
             "tabId":body.get("tabId"),"message":body.get("message", ""),
             "details":body.get("details"),"time":body.get("time", time.time())}
    with open(TRACE_FILE,"a",encoding="utf-8") as f:
        f.write(json.dumps(entry,ensure_ascii=False)+"\n")
    return jsonify({"ok":True})


@app.route('/browser/submit', methods=['POST'])
def browser_submit():
    body = request.get_json(force=True)
    msg = str(body.get("message","")).strip()
    if not msg:
        return jsonify(openai_error("message empty", "invalid_request_error")), 400
    model = str(body.get("model") or "").strip()
    known_route = known_browser_route(model)
    if known_route is not None and not route_has_executable_profile(known_route):
        return jsonify(openai_error(
            f"Model '{known_route.id}' has no executable recorded browser profile",
            "invalid_request_error",
            code="profile_incomplete",
        )), 409
    domain = str(body.get("domain") or "").strip().lower()
    if not domain and model:
        # Direct browser submissions may provide only a model. Resolve the
        # target through the same provider-neutral route registry as chat.
        domain = str(route_entry(model).get("domain") or "").strip().lower()
    try:
        conversation_id = resolve_conversation_id(body, model, domain)
        target_url = resolve_browser_target_url(body, model, domain)
    except ValueError as exc:
        error_code = "conversation_id_invalid" if str(exc) == "conversation_id_invalid" else str(exc)
        return jsonify(openai_error(str(exc), "invalid_request_error", code=error_code)), 400
    job = new_browser_job(msg, domain, model=model, new_tab=body.get("new_tab",False),
                          target_url=target_url,
                          conversation_id=conversation_id or None,
                          messages=body.get("messages"), request_meta=body.get("request_meta"),
                          tab_id=body.get("tab_id"))
    with BROWSER_LOCK:
        job["close_previous"] = bool(body.get("close_previous",False))
        _persist_browser_state_locked()
    request_browser_wake(domain=domain, target_url=target_url)
    return jsonify(job), 202


@app.route('/browser/reserve-tab', methods=['POST'])
def browser_reserve_tab():
    body = request.get_json(force=True)
    jid = str(body.get("job_id") or "")
    owner = str(body.get("owner") or "")
    with BROWSER_LOCK:
        job = BROWSER_JOBS.get(jid)
        if not job or job.get("status") != "queued":
            return jsonify({"reserved":False,"reason":"job_unavailable"}), 409
        marker = str(job.get("reservation_tab_id") or "")
        if marker and marker != f"creating:{owner}":
            return jsonify({"reserved":False,"reservation_tab_id":marker}), 409
        job["reservation_tab_id"] = f"creating:{owner}"
        job["updated_at"] = datetime.now().isoformat()
        _persist_browser_state_locked()
    return jsonify({"reserved":True,"reservation_tab_id":f"creating:{owner}"})


@app.route('/browser/commit-tab', methods=['POST'])
def browser_commit_tab():
    body = request.get_json(force=True)
    jid = str(body.get("job_id") or "")
    owner = str(body.get("owner") or "")
    tab_id = body.get("tab_id")
    if tab_id is None:
        return jsonify({"committed":False,"reason":"tab_id_required"}), 400
    with BROWSER_LOCK:
        job = BROWSER_JOBS.get(jid)
        expected = f"creating:{owner}"
        if not job or job.get("status") != "queued" or str(job.get("reservation_tab_id")) != expected:
            return jsonify({"committed":False,"reason":"reservation_mismatch"}), 409
        job["reservation_tab_id"] = int(tab_id)
        job["updated_at"] = datetime.now().isoformat()
        _persist_browser_state_locked()
    return jsonify({"committed":True,"reservation_tab_id":int(tab_id)})


@app.route('/browser/poll', methods=['POST'])
def browser_poll():
    reap_expired_browser_jobs()
    body = request.get_json(force=True)
    domain = (body.get("domain") or "").strip()
    tab_id = body.get("tab_id")
    if not tab_id:
        return jsonify({"job":None,"ignored":"tab_id_required"})
    poll_key = str(tab_id or domain or "unknown")
    now = time.monotonic()
    last = POLL_LAST.get(poll_key, 0.0)
    if now - last < POLL_MIN_INTERVAL:
        return jsonify({"job":None,"throttled":True})
    POLL_LAST[poll_key] = now
    conversation_id = str(body.get("conversation_id") or "")
    client_id = str(body.get("client_id") or "").strip()
    runtime_session_id = str(body.get("runtime_session_id") or "").strip()
    with BROWSER_LOCK:
        registration = BROWSER_REGISTRATIONS.get(client_id)
        expected_runtime_session_id = str(getattr(registration, "runtime_session_id", "") or "")
    if registration and (
        not runtime_session_allowed(runtime_session_id)
        or runtime_session_id != expected_runtime_session_id
    ):
        trace_api_event("browser_runtime_rejected", {
            "operation": "poll",
            "client_id": client_id,
            "expected_runtime_session_id": expected_runtime_session_id,
            "received_runtime_session_id": runtime_session_id,
            "reason": "runtime_session_mismatch",
            "tab_id": tab_id,
            "domain": domain,
        })
        return jsonify({"job": None, "ignored": "stale_runtime_session"}), 409
    job = claim_browser_job(domain, tab_id, conversation_id=conversation_id, client_id=client_id or None)
    return jsonify({"job": job})


@app.route('/browser/delta', methods=['POST'])
def browser_delta():
    body = request.get_json(force=True)
    return jsonify({"ok":append_browser_delta(body)})


@app.route('/browser/result', methods=['POST'])
def browser_result():
    body = request.get_json(force=True)
    jid = body.get("job_id")
    ok = bool(body.get("success"))
    with BROWSER_LOCK:
        existing_job = BROWSER_JOBS.get(str(jid)) if jid else None
        if terminal_browser_result_replay(existing_job, body):
            trace_api_event("browser_result_replay_accepted", {"job_id": jid})
            return jsonify({"ok": True, "idempotent": True})
    if jid and not str(body.get("claim_token") or ""):
        with BROWSER_LOCK:
            candidate = BROWSER_JOBS.get(str(jid)) or {}
            identity_matches = bool(candidate and candidate.get("status")=="claimed"
                and str(candidate.get("tab_id"))==str(body.get("tab_id"))
                and str(candidate.get("domain") or "").strip().lower()==str(body.get("domain") or "").strip().lower()
                and str(candidate.get("conversation_id") or "")==str(body.get("conversation_id") or ""))
            if not identity_matches:
                # Relaxed recovery: match on tab_id + domain only (SW restart
                # can lose conversation_id tracking). The signalled job is the
                # only claimed one on this tab, so relaxed matching is safe.
                identity_matches = bool(candidate and candidate.get("status")=="claimed"
                    and str(candidate.get("tab_id"))==str(body.get("tab_id"))
                    and str(candidate.get("domain") or "").strip().lower()==str(body.get("domain") or "").strip().lower())
            if identity_matches:
                body["claim_token"] = str(candidate.get("claim_token") or "")
                trace_api_event("browser_result_claim_recovered", {"job_id":jid,"tab_id":body.get("tab_id"),"domain":body.get("domain")})
    elif jid and str(body.get("claim_token") or ""):
        with BROWSER_LOCK:
            candidate = BROWSER_JOBS.get(str(jid)) or {}
            identity_matches = bool(candidate
                and str(candidate.get("claim_token") or "")==str(body.get("claim_token"))
                and str(candidate.get("tab_id"))==str(body.get("tab_id"))
                and str(candidate.get("domain") or "").strip().lower()==str(body.get("domain") or "").strip().lower()
                and str(candidate.get("conversation_id") or "")==str(body.get("conversation_id") or ""))
            if identity_matches and candidate.get("status")=="queued":
                try:
                    candidate["status"] = next_job_state(
                        candidate.get("status", JobState.QUEUED.value), "claim"
                    ).value
                except InvalidTransition:
                    identity_matches = False
                candidate["state_reason"] = "result_claim_recovered"
                _persist_browser_state_locked()
                trace_api_event("browser_result_queued_recovered", {"job_id":jid,"tab_id":body.get("tab_id"),"domain":body.get("domain")})
    actor_job, actor_error = validate_job_actor(body)
    if actor_error:
        trace_api_event("browser_result_rejected", {"job_id": jid, "error": actor_error,
            "status": BROWSER_JOBS.get(str(jid), {}).get("status") if jid else "",
            "body_tab_id": body.get("tab_id"), "body_domain": body.get("domain"),
            "body_conversation_id": body.get("conversation_id"),
            "body_claim_len": len(str(body.get("claim_token") or "")),
            "job_claim_len": len(str(BROWSER_JOBS.get(str(jid), {}).get("claim_token") or ""))})
        code = 409 if actor_error.endswith("mismatch") or actor_error == "claim_token_invalid" else 404
        return jsonify(openai_error(actor_error, "invalid_request_error")), code
    result = {"user": actor_job.get("message", ""), "assistant": body.get("assistant", ""),
              "key": body.get("key"), "tool_call": body.get("tool_call"),
              "conversation_id": actor_job.get("conversation_id"), "tab_id": actor_job.get("tab_id")}
    if not ok:
        result["tool_call"] = None
    tool_error = validate_tool_call_for_job(actor_job, result.get("tool_call"))
    if tool_error:
        return jsonify(openai_error(tool_error, "invalid_request_error")), 400
    if not ok and result.get("tool_call"):
        result["tool_call"] = None
    job = finish_browser_job(jid, "completed" if ok else "failed", result=result if ok else None, error=body.get("error"))
    if not job:
        return jsonify(openai_error("job not found", "not_found_error")), 404
    if ok:
        meta = (job.get("request_meta") or {})
        key = str(meta.get("idempotency_key") or "")
        if key:
            assistant = str(body.get("assistant") or "")
            model_name = str(body.get("model") or job.get("model") or "")
            prompt_text = str(job.get("message") or "")
            pt = approx_tokens(prompt_text); ct = approx_tokens(assistant)
            complete_idempotency(key, {
                "id":f"chatcmpl-{job['id']}","object":"chat.completion","created":int(time.time()),"model":model_name,
                "choices":[{"index":0,"message":openai_assistant_message(result),
                            "finish_reason":"tool_calls" if result.get("tool_call") else "stop"}],
                "usage":{"prompt_tokens":pt,"completion_tokens":ct,"total_tokens":pt+ct+0},
            })
        threading.Thread(
            target=save_conversation,
            args=(actor_job.get("message", ""), body.get("assistant", ""),
                  job.get("model", ""), "browser", actor_job.get("conversation_id", ""),
                  job.get("id", ""), body.get("completion_reason", "")),
            daemon=True,
        ).start()
    return jsonify({"ok":True})


def renew_browser_claim(body):
    """Renew a capture lease only when the heartbeat names its exact claim.

    Legacy readiness heartbeats do not carry a job identity and continue to use
    mark_browser_ready's tab/domain inventory semantics. A capture heartbeat,
    however, must carry job_id and claim_token so a stale page cannot extend a
    different request merely because it still owns the same tab.
    """
    job_id = str(body.get("job_id") or "").strip()
    claim_token = str(body.get("claim_token") or "").strip()
    if not job_id and not claim_token:
        return None
    with BROWSER_LOCK:
        job = BROWSER_JOBS.get(job_id)
        expected_domain = str(job.get("domain") or "").strip().lower() if job else ""
        incoming_domain = str(body.get("domain") or "").strip().lower()
        valid = bool(
            job
            and job.get("status") == JobState.CLAIMED.value
            and claim_token
            and claim_token == str(job.get("claim_token") or "")
            and str(job.get("tab_id")) == str(body.get("tab_id"))
            and expected_domain == incoming_domain
            and (not body.get("client_id") or str(job.get("client_id") or "") == str(body.get("client_id")))
            and (not body.get("conversation_id") or str(job.get("conversation_id") or "") == str(body.get("conversation_id")))
        )
        if not valid:
            trace_api_event("capture_heartbeat_claim_rejected", {
                "job_id": job_id,
                "tab_id": body.get("tab_id"),
                "domain": incoming_domain,
                "job_status": job.get("status") if job else "missing",
            })
            return False
        now = time.time()
        job["last_worker_seen"] = now
        job["lease_expires_at"] = now + 300.0
        job["updated_at"] = datetime.now().isoformat()
        _persist_browser_state_locked()
        return True


@app.route('/browser/launch', methods=['POST'])
def browser_launch():
    return jsonify({"ok":False,"error":{"message":"browser launch is extension-owned","type":"browser_launch_delegated"}}), 409


@app.route('/browser/heartbeat', methods=['POST'])
def browser_heartbeat():
    body = request.get_json(force=True)
    if body.get("ready"):
        claim_valid = renew_browser_claim(body)
        if claim_valid is False:
            return jsonify({"ok": True, "ready": False, "claim_valid": False})
        if mark_browser_ready(body) is False:
            return jsonify({"ok": True, "ready": False, "ignored": "stale_runtime_session"})
        response = {"ok": True, "ready": True}
        if claim_valid is not None:
            response["claim_valid"] = True
        return jsonify(response)
    else:
        with BROWSER_LOCK:
            client_id = str(body.get("client_id") or "").strip()
            runtime_session_id = str(body.get("runtime_session_id") or f"legacy:{client_id}").strip()
            if not runtime_session_allowed(runtime_session_id):
                trace_api_event("browser_runtime_rejected", {
                    "operation": "negative_heartbeat",
                    "client_id": client_id,
                    "received_runtime_session_id": runtime_session_id,
                    "reason": "runtime_session_required",
                    "tab_id": body.get("tab_id"),
                    "domain": body.get("domain", ""),
                })
                return jsonify({"ok": True, "ignored": "stale_runtime_session"})
            registration = BROWSER_REGISTRATIONS.get(client_id)
            expected_runtime_session_id = str(getattr(registration, "runtime_session_id", "") or "")
            if expected_runtime_session_id and expected_runtime_session_id != runtime_session_id:
                trace_api_event("browser_runtime_rejected", {
                    "operation": "negative_heartbeat",
                    "client_id": client_id,
                    "expected_runtime_session_id": expected_runtime_session_id,
                    "received_runtime_session_id": runtime_session_id,
                    "tab_id": body.get("tab_id"),
                    "domain": body.get("domain", ""),
                })
                return jsonify({"ok": True, "ignored": "stale_runtime_session"})
            key = str(body.get("tab_id") or body.get("domain") or "unknown")
            previous = BROWSER_CLIENTS.get(key) or {}
            # A negative heartbeat is an explicit revocation of execution
            # readiness (for example, a recorded profile failed its live
            # identity health check). It must not merge with old capabilities:
            # OR-merging would leave a previously ready tab executable.
            capabilities = normalize_browser_capabilities(body)
            for field in ("can_observe", "can_execute", "can_snapshot"):
                capabilities[field] = False
            BROWSER_CLIENTS[key] = dict(
                previous,
                domain=body.get("domain", ""),
                tab_id=body.get("tab_id"),
                client_id=client_id or previous.get("client_id", ""),
                runtime_session_id=runtime_session_id,
                url=body.get("url", ""),
                last_seen=time.time(),
                heartbeat=True,
                ready=False,
                input_ready=False,
                send_ready=False,
                state=BrowserClientState.STALE.value,
                capabilities=capabilities,
            )
            BROWSER_READY.pop(key, None)
        return jsonify({"ok":True})


@app.route('/browser/ready', methods=['POST'])
def browser_ready():
    body = request.get_json(force=True)
    if mark_browser_ready(body) is False:
        return jsonify({"ok": False, "error": "stale_runtime_session"}), 409
    return jsonify({"ok":True})


# ═══ NEW: /v1/chat/completions — protocol-based handler ═══

@app.route('/v1/chat/completions', methods=['POST'])
def chat_completions():
    try:
        body = request.get_json(force=True)
    except Exception:
        err, code = build_openai_error(
            "Invalid JSON in request body",
            "invalid_request_error", "invalid_json", 400
        )
        return jsonify(err), code
    
    model_id = body.get('model', '')
    if not model_id:
        err, code = build_openai_error(
            "Missing required field: model",
            "invalid_request_error", "missing_field", 400
        )
        return jsonify(err), code
    
    raw_messages = body.get('messages', [])
    if not raw_messages:
        err, code = build_openai_error(
            "Missing required field: messages",
            "invalid_request_error", "missing_field", 400
        )
        return jsonify(err), code
    
    # Resolve model
    try:
        route = resolve_model(model_id, _routes, _aliases)
    except ModelNotFoundError as e:
        err, code = build_openai_error(
            str(e),
            "invalid_request_error", "model_not_found", 404
        )
        return jsonify(err), code

    if not route_has_executable_profile(route):
        err, code = build_openai_error(
            f"Model '{route.id}' has no executable recorded browser profile",
            "invalid_request_error", "profile_incomplete", 409,
        )
        return jsonify(err), code
    
    # Build Message objects from raw messages
    from server.protocol import Message as ProtoMessage
    messages = []
    for m in raw_messages:
        content = m.get('content', '')
        if isinstance(content, list):
            text_parts = [p.get('text', '') for p in content if p.get('type') == 'text']
            content = '\n'.join(text_parts)
        messages.append(ProtoMessage(
            role=m.get('role', 'user'),
            content=str(content) if content else '',
            name=m.get('name'),
            tool_call_id=m.get('tool_call_id'),
            tool_calls=m.get('tool_calls'),
        ))
    
    # Build browser prompt
    browser_text = messages_to_text(messages)
    if not browser_text.strip():
        err, code = build_openai_error(
            "All messages have empty content",
            "invalid_request_error", "empty_messages", 400
        )
        return jsonify(err), code
    
    # Inject tool definitions
    raw_tools = body.get('tools', [])
    if raw_tools and not route.capabilities.supports_tool_calling:
        err, code = build_openai_error(
            f"Model '{route.id}' does not support tool calling",
            "invalid_request_error", "unsupported_tools", 400
        )
        return jsonify(err), code
    tool_choice = body.get('tool_choice', 'auto')
    if tool_choice == 'required' and not raw_tools:
        err, code = build_openai_error(
            "tool_choice='required' but no tools were provided",
            "invalid_request_error", "missing_tools", 400
        )
        return jsonify(err), code
    tools = []
    for t in raw_tools:
        fn = t.get('function', {})
        tools.append(ToolDefinition(type=t.get('type', 'function'), function=fn))
    
    tool_prompt = inject_tool_defs(tools, route.capabilities.supports_tool_calling and tool_choice != 'none')
    full_prompt = browser_text + tool_prompt

    try:
        conversation_id = resolve_conversation_id(body, route.id, route.domain)
    except ValueError as exc:
        err, code = build_openai_error(
            str(exc), "invalid_request_error", "conversation_id_invalid", 400
        )
        return jsonify(err), code

    max_input_chars = int(getattr(route.capabilities, 'max_input_chars', 0) or 0)
    if max_input_chars > 0 and len(full_prompt) > max_input_chars:
        err, code = build_openai_error(
            f"Input exceeds max_input_chars for model '{route.id}': {len(full_prompt)} > {max_input_chars}",
            "invalid_request_error", "input_too_long", 400
        )
        return jsonify(err), code

    request_key = idempotency_key(body)
    request_fp = request_fingerprint(
        model_id,
        raw_messages,
        {
            "tools": raw_tools,
            "tool_choice": body.get("tool_choice", "auto"),
            "stream": bool(body.get("stream", False)),
            "conversation_id": conversation_id,
        },
    )
    idem_record, idem_owner, idem_conflict = claim_idempotency(request_key, request_fp)
    if idem_conflict:
        err, code = build_openai_error(
            "Idempotency-Key was reused with a different request",
            "invalid_request_error", "idempotency_key_conflict", 409,
        )
        return jsonify(err), code

    timeout_ms = _settings.get("request_timeout_ms", 240000)
    if len(full_prompt) > 1200:
        timeout_ms = max(int(timeout_ms), 780000)
    timeout_sec = min(900.0, max(15.0, timeout_ms / 1000))

    if not idem_owner:
        if idem_record.get("status") == "completed":
            cached = idempotency_response(idem_record)
            if cached:
                return jsonify(cached)
        if idem_record.get("status") == "failed":
            cached_error = idem_record.get("error")
            return jsonify(cached_error if isinstance(cached_error, dict) else openai_error(
                "Idempotent request previously failed", "server_error", code="idempotent_request_failed"
            )), 502
        if not idem_record["event"].wait(timeout_sec):
            return jsonify(openai_error("Request timed out", "server_error", code="timeout")), 504
        cached = idempotency_response(idem_record)
        if cached:
            return jsonify(cached)
        return jsonify(openai_error("Idempotent request completed without a response", "server_error")), 502

    stream = body.get('stream', False)
    relay_opts = relay_context_options(body)
    reuse_page = bool(relay_opts.get('reuse_page', True))
    force_new_tab = False
    
    # Create browser job using existing infrastructure
    job = new_browser_job(
        full_prompt,
        domain=route.domain,
        model=route.id,
        new_tab=force_new_tab,
        target_url=route.url,
        conversation_id=conversation_id,
        messages=[{"role":"user","content":full_prompt}],
        request_meta={
            "idempotency_key": request_key,
            "tools": raw_tools,
            "conversation_id": conversation_id,
            "capture_timeout_ms": int(timeout_sec * 1000),
        },
    )
    bind_idempotency_job(request_key, job["id"])
    
    # The request path owns browser activation. A ready same-domain extension is
    # reused; otherwise issue one coalesced OS wake/open for the recorded target
    # so the user's browser can register the page and the extension can claim it.
    # The extension worker itself never creates or navigates provider tabs.
    request_browser_wake(domain=route.domain, target_url=route.url)

    # Start the caller-facing stream immediately. The extension already relays
    # provider-neutral DOM snapshots through /browser/delta while the model is
    # generating; waiting for /browser/result here would turn stream mode into
    # a delayed single-chunk response.
    if bool(stream):
        return Response(
            iter_live_browser_sse(
                job,
                route,
                request_key=request_key,
                full_prompt=full_prompt,
                tool_choice=tool_choice,
                timeout_sec=timeout_sec,
            ),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    
    # Wait for result
    ev = BROWSER_EVENTS.get(job["id"])
    if not ev or not ev.wait(timeout_sec):
        timed_out = finish_browser_job(job["id"], "failed", error="browser_timeout")
        fail_idempotency(request_key, openai_error("Request timed out", "server_error", code="timeout"), terminal=True)
        err, code = build_openai_error("Request timed out", "server_error", "timeout", 504)
        return jsonify(err), code
    
    with BROWSER_LOCK:
        final = browser_json(BROWSER_JOBS.get(job["id"]))
    
    if not final or final["status"] != "completed":
        error_msg = (final or {}).get("error") or "browser_error"
        fail_idempotency(request_key, openai_error(str(error_msg), "server_error", code="browser_error"), terminal=True)
        err, code = build_openai_error(str(error_msg), "server_error", "browser_error", 502)
        return jsonify(err), code
    
    result_data = final.get("result") or {}
    result_text = str(result_data.get("assistant") or "")
    response_dict, result_text = build_browser_response_payload(final, route, tool_choice)
    
    # Save conversation in background
    threading.Thread(
        target=save_conversation,
        args=(full_prompt, result_text, route.id, "api", job.get("conversation_id", ""),
              job["id"], "stop"),
        daemon=True,
    ).start()

    complete_idempotency(request_key, response_dict)
    
    return jsonify(response_dict)


@app.errorhandler(404)
def not_found(e):
    err, code = build_openai_error("Unknown endpoint", "not_found_error", "not_found", 404)
    return jsonify(err), code


# ═══ CORS preflight ═══

@app.after_request
def after_request(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Idempotency-Key'
    return response


# ═══ NEW: /v1/models, /admin routes ═══

@app.route('/v1/models', methods=['GET'])
def list_models():
    return jsonify(build_model_list(_routes))


@app.route('/admin/api/models', methods=['GET'])
def admin_get_models():
    routes_list = [dataclasses.asdict(r) for r in _routes.values()]
    return jsonify({"aliases": _aliases, "settings": _settings, "models": routes_list})


@app.route('/admin/api/models/<model_id>', methods=['PUT'])
def admin_update_model(model_id):
    if model_id not in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' not found"}), 404
    body = request.get_json(force=True)
    data = read_model_config_raw()
    updated = False
    for model in data.get('models', []):
        if model.get('id') == model_id:
            for key, value in body.items():
                if key == 'id':
                    continue
                model[key] = value
            updated = True
            break
    if not updated:
        return jsonify({"status": "error", "message": f"Model '{model_id}' not found"}), 404
    write_model_config_raw(data)
    reload_model_config_globals()
    return jsonify({"status": "ok", "model": model_id})


@app.route('/admin/api/models', methods=['POST'])
def admin_create_model():
    body = request.get_json(force=True)
    model_id = body.get('id', '')
    if not model_id:
        return jsonify({"status": "error", "message": "Missing 'id' field"}), 400
    if model_id in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' already exists"}), 400
    data = read_model_config_raw()
    data.setdefault('models', []).append(body)
    write_model_config_raw(data)
    reload_model_config_globals()
    return jsonify({"status": "ok", "model": model_id}), 201


@app.route('/admin/api/models/<model_id>', methods=['DELETE'])
def admin_delete_model(model_id):
    if model_id not in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' not found"}), 404
    data = read_model_config_raw()
    before = len(data.get('models', []))
    data['models'] = [m for m in data.get('models', []) if m.get('id') != model_id]
    if len(data['models']) == before:
        return jsonify({"status": "error", "message": f"Model '{model_id}' not found"}), 404
    aliases = data.get('aliases', {})
    data['aliases'] = {k: v for k, v in aliases.items() if v != model_id and k != model_id}
    write_model_config_raw(data)
    reload_model_config_globals()
    return jsonify({"status": "ok"})


@app.route('/admin', methods=['GET'])
def admin_page():
    admin_html = os.path.join(os.path.dirname(__file__), 'static', 'admin.html')
    if os.path.exists(admin_html):
        return send_file(admin_html)
    return "<h1>Admin page not found</h1>", 404


# ═══ Main ═══

if __name__ == '__main__':
    configure_browser_job_store(restore=True)
    app.run(host=BIND_HOST, port=PORT, debug=False)
