#!/usr/bin/env python3
"""Phantom Relay API v3 — protocol-based gateway, backend drives Chrome, extension executes."""
import json, time, os, hashlib, threading, uuid, subprocess, sys, dataclasses
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

PORT = 8765
BIND_HOST = os.environ.get("PHANTOM_RELAY_BIND_HOST", "127.0.0.1")
DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE   = os.path.join(DIR, "conversations.json")
STATS_FILE  = os.path.join(DIR, "stats.json")
TRACE_FILE  = os.path.join(DIR, "page-trace.jsonl")
ROUTES_FILE = os.path.join(DIR, "model_routes.json")
SELECTOR_TEMPLATES_FILE = os.path.join(DIR, "selector_templates.json")
EXT_DIR     = os.path.join(os.path.dirname(DIR), "extension")
CONTENT_JS  = os.path.join(EXT_DIR, "content.js")
os.chdir(DIR)  # Ensure we're in server/ for relative imports

app = Flask(__name__)

BROWSER_LOCK    = threading.RLock()
BROWSER_JOBS    = {}
BROWSER_QUEUE   = []
BROWSER_CLIENTS = {}
BROWSER_READY   = {}
BROWSER_READY_EVENTS = {}
BROWSER_EVENTS  = {}
BROWSER_DELTAS  = {}
BROWSER_BINDINGS = {}  # (conversation_id, domain) -> tab ownership binding
CONVERSATION_LOCK = threading.Lock()
IDEMPOTENCY = {}
IDEMPOTENCY_TTL = 24 * 60 * 60
POLL_LAST       = {}
POLL_MIN_INTERVAL = 0.25
CLIENT_TTL      = 45.0
_BROWSER_WAKE_LOCK = threading.Lock()
_BROWSER_WAKE_LAST = 0.0
BROWSER_HOST_CONFIG = os.environ.get("PHANTOM_RELAY_BROWSER_CONFIG", os.path.join(os.path.dirname(DIR), "browser-host.conf"))
BROWSER_WAKE_COMMAND = os.environ.get("PHANTOM_RELAY_BROWSER_WAKE_COMMAND", "")
_BROWSER_WAKE_COOLDOWN = 15.0

MODEL_LIST_CREATED_TS = 1  # Stable Unix epoch for /v1/models; the real freshness is in the route entries.

# ═══ Model Config Loading (new) ═══

def load_model_config(config_path=None):
    """Load model routes and aliases from model_routes.json."""
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), 'model_routes.json')
    
    with open(config_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    routes = {}
    for model_data in data.get('models', []):
        caps_data = model_data.get('capabilities', {})
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
        
        cost_data = model_data.get('cost', {})
        route = ModelRoute(
            id=model_data.get('id', ''),
            name=model_data.get('name', ''),
            owned_by=model_data.get('owned_by', ''),
            domain=model_data.get('provider', {}).get('domain', ''),
            url=model_data.get('provider', {}).get('url', ''),
            api=model_data.get('api', 'browser'),
            capabilities=caps,
            selectors=model_data.get('selectors', {}),
            cost={
                'input_per_million_tokens': cost_data.get('input_per_million_tokens', 0),
                'output_per_million_tokens': cost_data.get('output_per_million_tokens', 0),
                'cache_read_per_million_tokens': cost_data.get('cache_read_per_million_tokens', 0),
                'cache_write_per_million_tokens': cost_data.get('cache_write_per_million_tokens', 0),
            },
            created=model_data.get('created', 1700000000),
        )
        routes[model_data['id']] = route
    
    aliases = data.get('aliases', {})
    settings = data.get('settings', {})
    
    return routes, aliases, settings

# Load config at import time
_routes, _aliases, _settings = load_model_config()

# Compatibility snapshot for callers/tests
model_routes = {}


# ═══ Existing browser infrastructure functions ═══

def wake_browser_host():
    """Start the configured browser host, including the Phantom Relay extension."""
    global _BROWSER_WAKE_LAST
    now = time.time()
    with _BROWSER_WAKE_LOCK:
        if now - _BROWSER_WAKE_LAST < _BROWSER_WAKE_COOLDOWN:
            return False
        _BROWSER_WAKE_LAST = now
    command = BROWSER_WAKE_COMMAND.strip()
    if not command and os.path.exists(BROWSER_HOST_CONFIG):
        for line in open(BROWSER_HOST_CONFIG, encoding="utf-8"):
            line=line.strip()
            if line.startswith("wake_command="):
                command=line.split("=",1)[1].strip()
                break
    try:
        if command:
            env=dict(os.environ)
            env["PHANTOM_RELAY_API"] = f"http://{BIND_HOST}:{PORT}"
            subprocess.Popen(command, shell=True, cwd=os.path.dirname(DIR), env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            trace_api_event("browser_wake_requested", {"mode":"command"})
            return True
        bundle_id = os.environ.get("PHANTOM_RELAY_BROWSER_BUNDLE_ID", "")
        if not bundle_id:
            trace_api_event("browser_wake_failed", {"error":"wake_command_not_configured"})
            return False
        subprocess.Popen(["open", "-b", bundle_id], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        trace_api_event("browser_wake_requested", {"mode":"bundle"})
        return True
    except Exception as exc:
        trace_api_event("browser_wake_failed", {"error": type(exc).__name__})
        return False

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

def idempotency_key(body):
    value = request.headers.get("Idempotency-Key") or body.get("idempotency_key") or body.get("request_id")
    return str(value or "").strip()

def claim_idempotency(key, fingerprint):
    if not key:
        return None, True, False
    with BROWSER_LOCK:
        now = time.time()
        for stale_key, stale in list(IDEMPOTENCY.items()):
            if now - stale.get("updated_at", stale.get("created_at", now)) > IDEMPOTENCY_TTL:
                IDEMPOTENCY.pop(stale_key, None)
        current = IDEMPOTENCY.get(key)
        if current:
            if current["fingerprint"] != fingerprint:
                return current, False, True
            return current, False, False
        record = {"key": key, "fingerprint": fingerprint, "status": "processing",
                  "job_id": None, "event": threading.Event(), "response": None,
                  "created_at": time.time(), "updated_at": time.time()}
        IDEMPOTENCY[key] = record
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

def load_routes():
    global model_routes
    if os.path.exists(ROUTES_FILE):
        with open(ROUTES_FILE, "r") as f:
            raw = json.load(f)
        model_routes = {k: (v if isinstance(v, dict) else str(v)) for k, v in raw.items()}
        return model_routes
    model_routes = {}
    return model_routes

model_routes = load_routes()

def save_routes(routes):
    with open(ROUTES_FILE, "w", encoding="utf-8") as f:
        json.dump(routes, f, ensure_ascii=False, indent=2)

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
    if os.path.exists(SELECTOR_TEMPLATES_FILE):
        try:
            with open(SELECTOR_TEMPLATES_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
            return raw if isinstance(raw, dict) else {}
        except Exception:
            return {}
    return {}

def save_selector_templates(value):
    with open(SELECTOR_TEMPLATES_FILE, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)

def merge_recorded_selector_template(existing, incoming):
    current = dict(existing) if isinstance(existing, dict) else {}
    proposed = incoming if isinstance(incoming, dict) else {}
    for role in ("input", "send", "response"):
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
        result[key] = merge_recorded_selector_template(result.get(key), template)
    return result

selector_templates = load_selector_templates()

def route_hostname(route):
    value = str(route or '').strip()
    if value.startswith(('http://','https://')):
        return urlparse(value).hostname or ''
    return value

def route_entry(model):
    name = (model or '').strip().lower()
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

def route_capabilities(model):
    return route_entry(model).get('capabilities', {})

def resolve_domain(model):
    return route_entry(model).get('domain', '')

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
    return {
        "transport": transport,
        "can_observe": bool(raw.get("can_observe", body.get("ready", True) if legacy_background else body.get("ready", False))),
        "can_execute": bool(raw.get("can_execute", (body.get("input_ready", True) and body.get("send_ready", True)) if legacy_background else (body.get("input_ready", False) and body.get("send_ready", False)))),
        "can_stream": bool(raw.get("can_stream", True)),
        "can_create_tab": bool(raw.get("can_create_tab", False)),
        "can_close_tab": bool(raw.get("can_close_tab", False)),
        "can_snapshot": bool(raw.get("can_snapshot", body.get("ready", False))),
    }

def merge_browser_capabilities(previous, incoming):
    old = previous if isinstance(previous, dict) else {}
    new = incoming if isinstance(incoming, dict) else {}
    merged = dict(new)
    for key in ("can_observe", "can_execute", "can_stream", "can_create_tab", "can_close_tab", "can_snapshot"):
        merged[key] = bool(old.get(key, False) or new.get(key, False))
    if old.get("transport") and not merged.get("transport"):
        merged["transport"] = old["transport"]
    return merged

def mark_browser_ready(body):
    key=str(body.get("tab_id") or body.get("domain") or "unknown")
    with BROWSER_LOCK:
        previous = BROWSER_CLIENTS.get(key) or {}
        info=dict(domain=body.get("domain", ""), tab_id=body.get("tab_id"),
                  last_seen=time.time(), ready=bool(body.get("ready")),
                  input_ready=bool(body.get("input_ready")),
                  send_ready=bool(body.get("send_ready")),
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

def conversation_binding(conversation_id, domain):
    key = (str(conversation_id or ""), str(domain or "").strip().lower())
    with BROWSER_LOCK:
        binding = BROWSER_BINDINGS.get(key)
        if not binding:
            return None
        if time.time() - binding.get("last_seen", 0) >= CLIENT_TTL:
            BROWSER_BINDINGS.pop(key, None)
            return None
        return dict(binding)

def purge_stale_browser_state():
    cutoff = time.time() - CLIENT_TTL
    with BROWSER_LOCK:
        for store in (BROWSER_CLIENTS, BROWSER_READY):
            for key, value in list(store.items()):
                if value.get("last_seen", 0) < cutoff:
                    store.pop(key, None)
        live_tabs = {
            int(value.get("tab_id")) for value in BROWSER_CLIENTS.values()
            if value.get("tab_id") is not None
            and value.get("last_seen", 0) >= cutoff
            and value.get("ready")
            and value.get("source") == "content-ready"
            and (value.get("capabilities") or {}).get("can_execute") is True
        }
        for key, binding in list(BROWSER_BINDINGS.items()):
            tab_id = binding.get("tab_id")
            if tab_id is None or int(tab_id) not in live_tabs:
                BROWSER_BINDINGS.pop(key, None)
        for job in BROWSER_JOBS.values():
            if job.get("status") != "claimed":
                continue
            tab_id = job.get("tab_id")
            if tab_id is not None and int(tab_id) not in live_tabs:
                tab_present = any(str(value.get("tab_id")) == str(tab_id) for value in BROWSER_CLIENTS.values())
                if tab_present:
                    continue
                job["status"] = "queued"
                job["tab_id"] = None
                job["reservation_tab_id"] = None
                job["claim_token"] = uuid.uuid4().hex
                job["lease_expires_at"] = None
                job["last_worker_seen"] = None
                job["updated_at"] = datetime.now().isoformat()
                if job.get("id") not in BROWSER_QUEUE:
                    BROWSER_QUEUE.append(job.get("id"))

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
                for field in ("domain", "tab_id", "last_seen", "ready", "input_ready", "send_ready", "capabilities", "url", "source", "heartbeat")
                if field in value
            }
        jobs = {
            jid: {"id": job.get("id"), "status": job.get("status"),
                  "domain": job.get("domain"), "conversation_id": job.get("conversation_id"),
                  "tab_id": job.get("tab_id"), "model": job.get("model")}
            for jid, job in BROWSER_JOBS.items()
            if job.get("status") in ("queued", "claimed")
        }
        bindings = {f"{key[0]}::{key[1]}": {
            "conversation_id": value.get("conversation_id"), "domain": value.get("domain"),
            "tab_id": value.get("tab_id"), "profile": value.get("profile"),
            "last_seen": value.get("last_seen")
        } for key, value in BROWSER_BINDINGS.items()}
    return {"clients": clients, "jobs": jobs, "bindings": bindings, "queue_depth": len(BROWSER_QUEUE)}

def new_browser_job(message, domain="", model="", new_tab=False, target_url="", messages=None, request_meta=None, conversation_id=None):
    jid = f"job_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}"
    conversation_id = str(conversation_id or f"conv_{uuid.uuid4().hex}")
    job = dict(id=jid, conversation_id=conversation_id, conversation_bound=bool(conversation_id and not conversation_id.startswith("conv_")),
               message=message, messages=messages or [{"role":"user","content":message}],
               domain=domain, model=model, request_meta=request_meta or {},
               new_tab=bool(new_tab), target_url=target_url,
               close_previous=False, status="queued", tab_id=None,
               reservation_tab_id=None, queued_at=time.time(), claimed_at=None,
               lease_expires_at=None, last_worker_seen=None,
               claim_token=uuid.uuid4().hex, claim_attempt=0,
               created_at=datetime.now().isoformat(), updated_at=datetime.now().isoformat(),
               result=None, error=None, stream_snapshot="")
    with BROWSER_LOCK:
        BROWSER_JOBS[jid] = job; BROWSER_QUEUE.append(jid)
        BROWSER_EVENTS[jid] = threading.Event()
        BROWSER_DELTAS[jid] = []
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
        return dict(job), None

def append_browser_delta(body):
    _, error = validate_job_actor(body)
    if error:
        return False
    jid = str(body.get("job_id") or "")
    text = normalize_stream_snapshot(body.get("text") or "")
    if not jid or not text:
        return False
    with BROWSER_LOCK:
        job = BROWSER_JOBS.get(jid)
        if not job or job.get("status") not in ("queued", "claimed"):
            return False
        job["last_worker_seen"] = time.time()
        job["lease_expires_at"] = time.time() + 150.0
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

def reap_expired_browser_jobs():
    now = time.time()
    with BROWSER_LOCK:
        for job in BROWSER_JOBS.values():
            if job.get("status") != "claimed":
                continue
            if not job.get("lease_expires_at"):
                job["lease_expires_at"] = now + 150.0
                job["updated_at"] = datetime.now().isoformat()
                continue
            if job["lease_expires_at"] > now:
                continue
            job["status"] = "queued"
            job["error"] = None
            old_tab_id = job.get("tab_id")
            job["tab_id"] = None
            job["reservation_tab_id"] = None
            job["claim_token"] = uuid.uuid4().hex
            job["claim_attempt"] = int(job.get("claim_attempt", 0)) + 1
            if job["claim_attempt"] > 5:
                job["status"] = "failed"
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
            if job.get("id") not in BROWSER_QUEUE:
                BROWSER_QUEUE.append(job.get("id"))

def claim_browser_job(domain=None, tab_id=None, conversation_id=None):
    with BROWSER_LOCK:
        client = BROWSER_CLIENTS.get(str(tab_id)) if tab_id is not None else None
        if tab_id is not None and client is None:
            return None
        if tab_id is not None and client and time.time() - float(client.get("last_seen", 0) or 0) >= CLIENT_TTL:
            return None
        caps = (client or {}).get("capabilities")
        if tab_id is not None and client and caps is not None:
            if caps.get("can_observe") is False or caps.get("can_execute") is False:
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
            if binding and binding.get("tab_id") != tab_id:
                continue
            if tab_id and any(
                other.get("status") == "claimed" and other.get("tab_id") == tab_id
                for other in BROWSER_JOBS.values()
                if other.get("id") != jid
            ):
                continue
            BROWSER_QUEUE.remove(jid)
            job["status"] = "claimed"
            job["claimed_at"] = time.time()
            job["last_worker_seen"] = time.time()
            job["lease_expires_at"] = time.time() + 150.0
            job["claim_token"] = uuid.uuid4().hex
            job["reservation_tab_id"] = tab_id or job.get("reservation_tab_id")
            job["tab_id"] = tab_id or job.get("tab_id")
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
                source=client_record.get("source") or "content-ready",
                capabilities=client_record.get("capabilities", {}),
            )
            BROWSER_CLIENTS[str(tab_id or "unknown")] = client_record
            return browser_json(job)
    return None

def finish_browser_job(jid,status,result=None,error=None):
    allowed = {"queued": {"claimed", "failed"}, "claimed": {"completed", "failed"},
               "completed": set(), "failed": set()}
    with BROWSER_LOCK:
        job=BROWSER_JOBS.get(jid)
        if not job: return None
        current = job.get("status")
        if status not in allowed.get(current, set()):
            return browser_json(job)
        job["status"]=status; job["result"]=result; job["error"]=error
        job["lease_expires_at"] = None
        job["last_worker_seen"] = time.time()
        job["updated_at"]=datetime.now().isoformat()
        ev=BROWSER_EVENTS.pop(jid, None)
        if ev: ev.set()
        return browser_json(job)

def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE,"r",encoding="utf-8") as f: return json.load(f)
    return {"conversations":[],"models":[]}

def save_data(data):
    with open(DATA_FILE,"w",encoding="utf-8") as f: json.dump(data,f,ensure_ascii=False)

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
            f.write(json.dumps({"source":"api", "kind":kind, "time":time.time(), **data}, ensure_ascii=False) + "\\n")
    except Exception:
        pass


# ═══ Flask Routes — Existing browser endpoints (preserved) ═══

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status":"ok","service":"phantom-relay-api"})


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
    return jsonify(browser_status_snapshot())


@app.route('/browser/reset', methods=['GET', 'POST'])
def browser_reset():
    with BROWSER_LOCK:
        for jid, job in list(BROWSER_JOBS.items()):
            if job.get("status") in ("queued", "claimed"):
                job["status"] = "failed"
                job["error"] = "reset"
                event = BROWSER_EVENTS.pop(jid, None)
                if event: event.set()
        BROWSER_QUEUE.clear()
    return jsonify({"ok": True})


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
            clean = {r: incoming.get(r) for r in ("input","send","response") if incoming.get(r) not in (None, "", False)}
            selector_templates[domain] = merge_recorded_selector_template(selector_templates.get(domain), clean)
            save_selector_templates(selector_templates)
            return jsonify({"ok":True,"domain":domain,"selectors":selector_templates[domain]})
        return jsonify({"domain":domain,"selectors":selector_templates.get(domain,{})})
    else:
        domain = request.args.get("domain", "").strip().lower()
        return jsonify({"domain":domain,"selectors":selector_templates.get(domain,{})})


@app.route('/browser/pending-domains', methods=['GET'])
def browser_pending_domains():
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


@app.route('/browser/clients', methods=['GET', 'POST'])
def browser_clients():
    purge_stale_browser_state()
    with BROWSER_LOCK: clients = dict(BROWSER_CLIENTS)
    return jsonify({"clients":clients})


@app.route('/browser/result-token', methods=['GET'])
def browser_result_token():
    try:
        jid = str(request.args.get("job_id") or "")
        tab_id = str(request.args.get("tab_id") or "")
        domain = str(request.args.get("domain") or "").strip().lower()
        conversation_id = str(request.args.get("conversation_id") or "")
        with BROWSER_LOCK:
            job = BROWSER_JOBS.get(jid)
            valid = bool(job and job.get("status")=="claimed"
                and str(job.get("tab_id"))==tab_id
                and str(job.get("domain") or "").strip().lower()==domain
                and str(job.get("conversation_id") or "")==conversation_id)
            token = str(job.get("claim_token") or "") if valid else ""
        if not token:
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
    if routes:
        save_routes(routes)
        model_routes = routes
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
    domain = str(body.get("domain") or "")
    job = new_browser_job(msg, domain, model=body.get("model",""), new_tab=body.get("new_tab",False),
                          conversation_id=body.get("conversation_id") or body.get("session_id") or body.get("conversation"),
                          messages=body.get("messages"), request_meta=body.get("request_meta"))
    job["close_previous"] = bool(body.get("close_previous",False))
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
    job = claim_browser_job(domain, tab_id, conversation_id=conversation_id)
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
    if jid and not str(body.get("claim_token") or ""):
        with BROWSER_LOCK:
            candidate = BROWSER_JOBS.get(str(jid)) or {}
            identity_matches = bool(candidate and candidate.get("status")=="claimed"
                and str(candidate.get("tab_id"))==str(body.get("tab_id"))
                and str(candidate.get("domain") or "").strip().lower()==str(body.get("domain") or "").strip().lower()
                and str(candidate.get("conversation_id") or "")==str(body.get("conversation_id") or ""))
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
                candidate["status"]="claimed"
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


@app.route('/browser/launch', methods=['POST'])
def browser_launch():
    return jsonify({"ok":False,"error":{"message":"browser launch is extension-owned","type":"browser_launch_delegated"}}), 409


@app.route('/browser/heartbeat', methods=['POST'])
def browser_heartbeat():
    body = request.get_json(force=True)
    if body.get("ready"):
        mark_browser_ready(body)
        return jsonify({"ok":True,"ready":True})
    else:
        with BROWSER_LOCK:
            key = str(body.get("tab_id") or body.get("domain") or "unknown")
            previous = BROWSER_CLIENTS.get(key) or {}
            BROWSER_CLIENTS[key] = dict(previous, domain=body.get("domain", ""), tab_id=body.get("tab_id"),
                                        url=body.get("url", ""), last_seen=time.time(), heartbeat=True,
                                        capabilities=merge_browser_capabilities(previous.get("capabilities"),
                                                                               normalize_browser_capabilities(body)))
        return jsonify({"ok":True})


@app.route('/browser/ready', methods=['POST'])
def browser_ready():
    body = request.get_json(force=True)
    mark_browser_ready(body)
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
    tools = []
    for t in raw_tools:
        fn = t.get('function', {})
        tools.append(ToolDefinition(type=t.get('type', 'function'), function=fn))
    
    tool_prompt = inject_tool_defs(tools, route.capabilities.supports_tool_calling)
    full_prompt = browser_text + tool_prompt
    
    stream = body.get('stream', False)
    
    # Create browser job using existing infrastructure
    job = new_browser_job(
        full_prompt,
        domain=route.domain,
        model=route.id,
        new_tab=False,
        target_url=route.url,
        messages=[{"role":"user","content":full_prompt}],
        request_meta={
            "idempotency_key": idempotency_key(body),
            "tools": raw_tools,
        },
    )
    
    wake_browser_host()
    
    # Wait for result
    timeout_ms = _settings.get('request_timeout_ms', 120000)
    timeout_sec = min(300.0, max(5.0, timeout_ms / 1000))
    
    ev = BROWSER_EVENTS.get(job["id"])
    if not ev or not ev.wait(timeout_sec):
        timed_out = finish_browser_job(job["id"], "failed", error="browser_timeout")
        err, code = build_openai_error("Request timed out", "server_error", "timeout", 504)
        return jsonify(err), code
    
    with BROWSER_LOCK:
        final = browser_json(BROWSER_JOBS.get(job["id"]))
    
    if not final or final["status"] != "completed":
        error_msg = (final or {}).get("error") or "browser_error"
        err, code = build_openai_error(str(error_msg), "server_error", "browser_error", 502)
        return jsonify(err), code
    
    result_data = final.get("result") or {}
    result_text = str(result_data.get("assistant") or "")
    
    # Extract tool calls from result
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
    
    # Save conversation in background
    threading.Thread(
        target=save_conversation,
        args=(full_prompt, result_text, route.id, "api", job.get("conversation_id", ""),
              job["id"], "stop"),
        daemon=True,
    ).start()
    
    return jsonify(dataclasses.asdict(response))


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
    return jsonify({"status": "ok", "model": model_id})


@app.route('/admin/api/models', methods=['POST'])
def admin_create_model():
    body = request.get_json(force=True)
    model_id = body.get('id', '')
    if not model_id:
        return jsonify({"status": "error", "message": "Missing 'id' field"}), 400
    if model_id in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' already exists"}), 400
    return jsonify({"status": "ok", "model": model_id}), 201


@app.route('/admin/api/models/<model_id>', methods=['DELETE'])
def admin_delete_model(model_id):
    if model_id not in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' not found"}), 404
    return jsonify({"status": "ok"})


@app.route('/admin', methods=['GET'])
def admin_page():
    admin_html = os.path.join(os.path.dirname(__file__), 'static', 'admin.html')
    if os.path.exists(admin_html):
        return send_file(admin_html)
    return "<h1>Admin page not found</h1>", 404


# ═══ Main ═══

if __name__ == '__main__':
    app.run(host=BIND_HOST, port=PORT, debug=False)
