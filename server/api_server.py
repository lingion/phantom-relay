#!/usr/bin/env python3
"""Phantom Relay API v3 — backend drives Chrome, extension executes."""
import json, time, os, hashlib, threading, uuid, subprocess, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime

PORT = 8765
DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE   = os.path.join(DIR, "conversations.json")
STATS_FILE  = os.path.join(DIR, "stats.json")
TRACE_FILE  = os.path.join(DIR, "page-trace.jsonl")
ROUTES_FILE = os.path.join(DIR, "model_routes.json")
SELECTOR_TEMPLATES_FILE = os.path.join(DIR, "selector_templates.json")
EXT_DIR     = os.path.join(os.path.dirname(DIR), "extension")
CONTENT_JS  = os.path.join(EXT_DIR, "content.js")
os.chdir(DIR)  # Ensure we're in server/ for relative imports

BROWSER_LOCK    = threading.Lock()
BROWSER_JOBS    = {}
BROWSER_QUEUE   = []
BROWSER_CLIENTS = {}
BROWSER_READY   = {}
BROWSER_READY_EVENTS = {}
BROWSER_EVENTS  = {}
BROWSER_DELTAS  = {}
IDEMPOTENCY = {}
POLL_LAST       = {}
POLL_MIN_INTERVAL = 0.25
CLIENT_TTL      = 45.0

def request_fingerprint(model, messages, request_meta):
    payload = json.dumps({"model": model, "messages": messages,
                          "request_meta": request_meta}, ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def idempotency_key(handler, body):
    value = handler.headers.get("Idempotency-Key") or body.get("idempotency_key") or body.get("request_id")
    return str(value or "").strip()

def claim_idempotency(key, fingerprint):
    """Return (record, owner, conflict).

    The claim is made before browser side effects. A replay of a processing key
    receives the original job/event instead of creating a second submission.
    """
    if not key:
        return None, True, False
    with BROWSER_LOCK:
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

# Canary is user-owned. The API never launches or opens the browser;
# the MV3 background worker creates/reuses the exact target tab.
CHROME_APP = "Google Chrome Canary"

def load_routes():
    if os.path.exists(ROUTES_FILE):
        with open(ROUTES_FILE, "r") as f:
            raw = json.load(f)
        # Route metadata is only model -> domain; selector truth remains in extension storage.
        return {k: (v.get("domain", "") if isinstance(v, dict) else str(v)) for k, v in raw.items()}
    return {}

def save_routes(routes):
    with open(ROUTES_FILE, "w") as f: json.dump(routes, f, ensure_ascii=False)

model_routes = load_routes()

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

selector_templates = load_selector_templates()

def route_hostname(route):
    value = str(route or '').strip()
    if value.startswith(('http://','https://')):
        from urllib.parse import urlparse as _up
        return _up(value).hostname or ''
    return value

def resolve_domain(model):
    name = (model or '').strip().lower()
    routes = load_routes()
    direct = routes.get(name, {})
    if isinstance(direct, dict):
        return (direct.get("domain") or "").strip()
    return str(direct or '').strip()

def launch_chrome():
    """Deprecated: browser lifecycle belongs to the Canary extension worker."""
    return False


def open_target_page(target_url):
    """Deprecated: target tabs are opened only by extension/background.js."""
    return False

def mark_browser_ready(body):
    key=str(body.get("tab_id") or body.get("domain") or "unknown")
    with BROWSER_LOCK:
        info=dict(domain=body.get("domain", ""), tab_id=body.get("tab_id"),
                  last_seen=time.time(), ready=bool(body.get("ready")),
                  input_ready=bool(body.get("input_ready")),
                  send_ready=bool(body.get("send_ready")),
                  url=body.get("url", ""), source=body.get("source", ""))
        BROWSER_CLIENTS[key]=info
        if info["ready"] and info["input_ready"] and info["send_ready"]:
            BROWSER_READY[key]=info
            ev=BROWSER_READY_EVENTS.get(key)
            if ev: ev.set()

def purge_stale_browser_state():
    cutoff = time.time() - CLIENT_TTL
    with BROWSER_LOCK:
        for store in (BROWSER_CLIENTS, BROWSER_READY):
            for key, value in list(store.items()):
                if value.get("last_seen", 0) < cutoff:
                    store.pop(key, None)


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

def new_browser_job(message, domain="", model="", new_tab=False, target_url="", messages=None, request_meta=None):
    jid = f"job_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}"
    job = dict(id=jid, message=message, messages=messages or [{"role":"user","content":message}],
               domain=domain, model=model, request_meta=request_meta or {},
               new_tab=bool(new_tab), target_url=target_url,
               close_previous=False, status="queued",
               created_at=datetime.now().isoformat(), updated_at=datetime.now().isoformat(),
               result=None, error=None)
    with BROWSER_LOCK:
        BROWSER_JOBS[jid] = job; BROWSER_QUEUE.append(jid)
        BROWSER_EVENTS[jid] = threading.Event()
        BROWSER_DELTAS[jid] = []
    return job

def normalize_stream_snapshot(value):
    import re
    lines = []
    for line in str(value or '').splitlines():
        line = ' '.join(line.replace('\u00a0', ' ').replace('\u200b', ' ').split()).strip()
        if not line or len(line) > 80:
            if line: lines.append(line)
            continue
        if re.match(r'^(?:正在)?(?:思考|深度思考|推理|分析)(?:中|\.\.\.|…)?$', line, re.I):
            continue
        if re.match(r'^(?:正在)?(?:阅读|读取|浏览|查看)(?:中|\.\.\.|…)?$', line, re.I):
            continue
        if re.match(r'^(?:正在)?(?:搜索|检索|查找)(?:几篇文章|一些文章|资料|网页)?(?:中|\.\.\.|…)?$', line, re.I):
            continue
        if re.match(r'^(?:thinking|reasoning|searching|browsing|reading|loading)(?:\.\.\.|…)?$', line, re.I):
            continue
        lines.append(line)
    return '\\n'.join(lines).strip()

def append_browser_delta(body):
    jid = str(body.get("job_id") or "")
    text = normalize_stream_snapshot(body.get("text") or "")
    if not jid or not text:
        return False
    with BROWSER_LOCK:
        job = BROWSER_JOBS.get(jid)
        if not job or job.get("status") not in ("queued", "claimed"):
            return False
        events = BROWSER_DELTAS.setdefault(jid, [])
        item = {"key": body.get("key") or "", "text": text,
                "streaming": bool(body.get("streaming")),
                "completion_reason": body.get("completion_reason") or "",
                "time": time.time()}
        if not events or events[-1].get("text") != text:
            events.append(item)
            if len(events) > 500:
                del events[:-500]
        return True

def browser_json(job): return dict(job) if job else None

def claim_browser_job(domain=None, tab_id=None):
    with BROWSER_LOCK:
        for jid in list(BROWSER_QUEUE):
            job = BROWSER_JOBS.get(jid)
            if not job or job["status"]!="queued": BROWSER_QUEUE.remove(jid); continue
            if job.get("domain") and domain and job["domain"]!=domain: continue
            if job.get("domain") and not domain: continue
            if job.get("tab_id") and tab_id and job["tab_id"]!=tab_id: continue
            BROWSER_QUEUE.remove(jid)
            job["status"]="claimed"; job["tab_id"]=tab_id or job.get("tab_id")
            job["updated_at"]=datetime.now().isoformat()
            BROWSER_CLIENTS[str(tab_id or "unknown")]=dict(domain=domain or "",last_seen=time.time())
            return browser_json(job)
    return None

def finish_browser_job(jid,status,result=None,error=None):
    with BROWSER_LOCK:
        job=BROWSER_JOBS.get(jid)
        if not job: return None
        job["status"]=status; job["result"]=result; job["error"]=error
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

def save_conversation(user,assistant,model="",source="api"):
    data=load_data()
    conv=dict(user=user,assistant=assistant,model=model,source=source,
              timestamp=datetime.now().isoformat(),id=f"conv_{int(time.time()*1000)}_{len(data['conversations'])}")
    data["conversations"].append(conv)
    if model and model not in data["models"]: data["models"].append(model)
    save_data(data)
    return conv

def message_content(value):
    """OpenAI content can be a string or an array of text parts."""
    if isinstance(value, str): return value
    if isinstance(value, list):
        parts=[]
        for part in value:
            if isinstance(part, str): parts.append(part)
            elif isinstance(part, dict) and part.get("type") in (None, "text"):
                if part.get("text") is not None: parts.append(str(part["text"]))
        return "".join(parts)
    return "" if value is None else str(value)


def normalize_messages(messages):
    out=[]
    if not isinstance(messages, list): return out
    for item in messages:
        if not isinstance(item, dict): continue
        role=str(item.get("role") or "user").strip().lower()
        if role not in ("system", "developer", "user", "assistant", "tool"): continue
        content=message_content(item.get("content", "")).strip()
        if content: out.append({"role":role,"content":content})
    return out


def browser_prompt(messages):
    """Preserve the OpenAI message sequence when the target site has no API.
    The final user turn stays last; earlier turns are explicit context rather
    than being silently discarded.
    """
    if not messages: return ""
    if len(messages)==1 and messages[0]["role"]=="user": return messages[0]["content"]
    labels={"system":"系统","developer":"开发者","user":"用户","assistant":"助手","tool":"工具"}
    lines=["【以下是对话上下文，请基于它回答最后一个用户问题】"]
    for item in messages[:-1]:
        lines.append(f"{labels[item['role']]}：\n{item['content']}")
    last=messages[-1]
    lines.append(f"【当前用户问题】\n{last['content']}")
    return "\n\n".join(lines)


def approx_tokens(text):
    cn=sum(1 for c in text if '\u4e00'<=c<='\u9fff')
    return int(cn/1.5+(len(text)-cn)/4)


def trace_api_event(kind, data):
    try:
        with open(TRACE_FILE, 'a', encoding='utf-8') as f:
            f.write(json.dumps({"source":"api", "kind":kind, "time":time.time(), **data}, ensure_ascii=False) + "\n")
    except Exception:
        pass

class BrowserAPIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _send_json(self,data,status=200):
        body=json.dumps(data,ensure_ascii=False)
        try:
            self.send_response(status)
            self.send_header("Content-Type","application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin","*")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
        except (BrokenPipeError,ConnectionResetError): return False
        return True


    def _read_body(self):
        length=int(self.headers.get("Content-Length",0))
        if length==0: return {}
        try: return json.loads(self.rfile.read(length))
        except: raise ValueError("invalid_json_body")

    def do_OPTIONS(self): self._send_json({},204)

    def do_GET(self):
        path=urlparse(self.path).path
        if path=="/health": self._send_json({"status":"ok","service":"phantom-relay-api"})
        elif path=="/model-routes": self._send_json({"routes":load_routes()})
        elif path=="/v1/models":
            routes=load_routes()
            models=[]
            seen=set()
            for model in list(routes.keys()):
                if model in seen or "." in model: continue
                seen.add(model)
                models.append({"id":model,"object":"model","created":0,"owned_by":"phantom-relay"})
            self._send_json({"object":"list","data":models})
        elif path=="/browser/selectors":
            query=urlparse(self.path).query
            domain=query.split("domain=",1)[1] if "domain=" in query else ""
            from urllib.parse import unquote
            domain=unquote(domain).strip().lower()
            self._send_json({"domain":domain,"selectors":selector_templates.get(domain,{})})
        elif path=="/browser/pending-domains":
            with BROWSER_LOCK:
                domains=[]
                for jid in BROWSER_QUEUE:
                    job=BROWSER_JOBS.get(jid)
                    if job and job.get("status") == "queued" and job.get("domain"):
                        domains.append(job["domain"])
            self._send_json({"domains":list(dict.fromkeys(domains))})
        elif path=="/browser/clients":
            purge_stale_browser_state()
            with BROWSER_LOCK: clients=dict(BROWSER_CLIENTS)
            self._send_json({"clients":clients})
        elif path=="/trace/tail":
            limit=int(urlparse(self.path).query.split("=")[-1] or "20")
            entries=[]
            if os.path.exists(TRACE_FILE):
                with open(TRACE_FILE,"r") as f:
                    for line in f:
                        try: entries.append(json.loads(line))
                        except: pass
            self._send_json({"entries":entries[-limit:]})
        else: self._send_json({"error":"Unknown endpoint"},404)

    def do_POST(self):
        path=urlparse(self.path).path
        try: return self._do_POST(path)
        except ValueError as e: self._send_json({"error":{"message":str(e),"type":"invalid_request_error"}},400)
        except (BrokenPipeError,ConnectionResetError): return

    def _do_POST(self,path):
        if path=="/browser/sync-routes":
            body=self._read_body()
            incoming=body.get("routes",{})
            # Accept only model -> domain metadata; never persist selectors from the backend API.
            routes={k: (v.get("domain", "") if isinstance(v, dict) else str(v))
                    for k, v in incoming.items()}
            if routes:
                save_routes(routes)
                global model_routes
                model_routes=routes
            self._send_json({"ok":True,"count":len(routes)}); return

        if path=="/browser/selectors":
            body=self._read_body()
            domain=str(body.get("domain") or "").strip().lower()
            if not domain: self._send_json({"error":"domain empty"},400); return
            global selector_templates
            if body.get("selectors") is not None:
                incoming=body.get("selectors")
                if not isinstance(incoming, dict): self._send_json({"error":"selectors must be object"},400); return
                clean={r: incoming.get(r) for r in ("input","send","response") if incoming.get(r)}
                selector_templates[domain]=clean
                save_selector_templates(selector_templates)
                self._send_json({"ok":True,"domain":domain,"selectors":clean}); return
            self._send_json({"domain":domain,"selectors":selector_templates.get(domain,{})}); return

        if path=="/trace":
            body=self._read_body()
            entry={
                "source":"phantom-relay",
                "domain":body.get("domain", ""),
                "tabId":body.get("tabId"),
                "entry":body.get("entry", body),
            }
            with open(TRACE_FILE,"a",encoding="utf-8") as f:
                f.write(json.dumps(entry,ensure_ascii=False)+"\n")
            self._send_json({"ok":True}); return

        if path=="/browser/submit":
            body=self._read_body()
            msg=str(body.get("message","")).strip()
            if not msg: self._send_json({"error":"message empty"},400); return
            job=new_browser_job(msg,body.get("domain"),model=body.get("model",""),new_tab=body.get("new_tab",False))
            job["close_previous"]=bool(body.get("close_previous",False))
            self._send_json(job,202); return

        if path=="/browser/poll":
            body=self._read_body()
            domain=(body.get("domain") or "").strip()
            tab_id=body.get("tab_id")
            # Only the background worker may claim jobs. A content-script poll
            # without a concrete tab id is an old/stale execution path and must
            # never consume a job for the wrong page.
            if not tab_id:
                self._send_json({"job":None,"ignored":"tab_id_required"}); return
            poll_key=str(tab_id or domain or "unknown")
            now=time.monotonic()
            last=POLL_LAST.get(poll_key, 0.0)
            if now-last < POLL_MIN_INTERVAL:
                self._send_json({"job":None,"throttled":True}); return
            POLL_LAST[poll_key]=now
            job = claim_browser_job(domain, tab_id)
            # 非阻塞轮询：扩展本身每 3 秒请求一次；服务端不再占住连接等待。
            self._send_json({"job": job}); return

        if path=="/browser/delta":
            body=self._read_body()
            self._send_json({"ok":append_browser_delta(body)}); return

        if path=="/browser/result":
            body=self._read_body()
            jid=body.get("job_id")
            ok=bool(body.get("success"))
            result={"user":body.get("user",""),"assistant":body.get("assistant",""),"key":body.get("key")}
            job=finish_browser_job(jid,"completed" if ok else "failed",result=result if ok else None,error=body.get("error"))
            if not job: self._send_json({"error":"job_not_found"},404); return
            if ok:
                save_conversation(body.get("user",""),body.get("assistant",""),body.get("model",""),"browser")
                meta=(job.get("request_meta") or {})
                key=str(meta.get("idempotency_key") or "")
                if key:
                    assistant=str(body.get("assistant") or "")
                    model_name=str(body.get("model") or job.get("model") or "")
                    prompt_text=str(job.get("message") or "")
                    pt=approx_tokens(prompt_text); ct=approx_tokens(assistant)
                    complete_idempotency(key, {
                        "id":f"chatcmpl-{job['id']}","object":"chat.completion",
                        "created":int(time.time()),"model":model_name,
                        "choices":[{"index":0,"message":{"role":"assistant","content":assistant},"finish_reason":"stop"}],
                        "usage":{"prompt_tokens":pt,"completion_tokens":ct,"total_tokens":pt+ct},
                    })
            self._send_json({"ok":True}); return

        if path=="/browser/clients":
            purge_stale_browser_state()
            with BROWSER_LOCK: clients=dict(BROWSER_CLIENTS)
            self._send_json({"clients":clients}); return

        if path=="/browser/heartbeat":
            body=self._read_body()
            if body.get("ready"):
                mark_browser_ready(body)
                self._send_json({"ok":True,"ready":True})
            else:
                key=str(body.get("tab_id") or body.get("domain") or "unknown")
                with BROWSER_LOCK:
                    BROWSER_CLIENTS[key]=dict(domain=body.get("domain", ""), tab_id=body.get("tab_id"),
                                              url=body.get("url", ""), last_seen=time.time(), heartbeat=True)
                self._send_json({"ok":True})
            return

        if path=="/browser/ready":
            body=self._read_body()
            mark_browser_ready(body)
            self._send_json({"ok":True}); return

        if path=="/v1/chat/completions":
            body=self._read_body()
            messages=normalize_messages(body.get("messages",[]))
            if not messages:
                self._send_json({"error":{"message":"missing messages","type":"invalid_request_error"}},400); return
            user_msg=next((m["content"] for m in reversed(messages) if m["role"]=="user"),"")
            if not user_msg: self._send_json({"error":{"message":"missing user message","type":"invalid_request_error"}},400); return

            model=(body.get("model") or "").strip().lower()
            stream=bool(body.get("stream",False))
            timeout=min(300.0,max(5.0,float(body.get("timeout",120))))
            prompt=browser_prompt(messages)
            request_meta={k:body.get(k) for k in ("temperature","top_p","max_tokens","max_completion_tokens","stop","frequency_penalty","presence_penalty","stream") if k in body}
            idem_key = idempotency_key(self, body)
            fingerprint = request_fingerprint(model, messages, request_meta)
            idem, is_owner, conflict = claim_idempotency(idem_key, fingerprint)
            if conflict:
                self._send_json({"error":{"message":"Idempotency-Key was already used with a different request body","type":"idempotency_key_conflict"}},409); return
            if idem and not is_owner:
                if idem.get("status") == "failed" and idem.get("error"):
                    self._send_json({"error":{"message":str(idem["error"]),"type":"idempotent_failed"}},502); return
                if idem.get("status") == "completed" and idempotency_response(idem):
                    replay = idempotency_response(idem)
                    if idem.get("stream"):
                        self.send_response(200)
                        self.send_header("Content-Type","text/event-stream; charset=utf-8")
                        self.send_header("Cache-Control","no-cache"); self.send_header("Connection","close")
                        self.send_header("Access-Control-Allow-Origin","*"); self.end_headers()
                        p={"id":replay["id"],"object":"chat.completion.chunk","created":replay["created"],"model":replay["model"]}
                        for chunk in (
                            dict(p,choices=[{"index":0,"delta":{"role":"assistant"},"finish_reason":None}]),
                            dict(p,choices=[{"index":0,"delta":{"content":replay["choices"][0]["message"]["content"]},"finish_reason":None}]),
                            dict(p,choices=[{"index":0,"delta":{},"finish_reason":"stop"}]),
                        ):
                            self.wfile.write(f"data: {json.dumps(chunk,ensure_ascii=False)}\n\n".encode()); self.wfile.flush()
                        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                    else:
                        replay["idempotent_replay"] = True
                        self._send_json(replay, 200)
                    return
                if idem.get("job_id"):
                    self._send_json({"error":{"message":"request is already processing","type":"request_in_progress","job_id":idem["job_id"]}},409); return
                self._send_json({"error":{"message":"request is already processing","type":"request_in_progress"}},409); return
            if idem:
                with BROWSER_LOCK:
                    idem["stream"] = stream
                    idem["updated_at"] = time.time()
            trace_api_event("request_received", {"model":model,"message_count":len(messages),"roles":[m["role"] for m in messages],"prompt_chars":len(prompt),"stream":stream,"idempotency_key":bool(idem_key)})

            target_domain=resolve_domain(model)
            if not target_domain:
                fail_idempotency(idem_key, "model_route_missing", terminal=True)
                self._send_json({"error":{"message":f"model '{model}' not bound to any domain","type":"model_route_missing"}},400); return

            target_url = f"https://{target_domain}/"
            # The extension background is the sole owner of target-tab creation.
            # The API only queues the job; opening from here races with the
            # background poller and can leave DeepSeek on a non-chat landing tab.
            job = new_browser_job(prompt, domain=target_domain, model=model,
                                  new_tab=True, target_url=target_url,
                                  messages=messages, request_meta=dict(request_meta, idempotency_key=idem_key))
            if idem:
                with BROWSER_LOCK:
                    idem["job_id"] = job["id"]
                    idem["updated_at"] = time.time()
            trace_api_event("job_queued", {"job_id":job["id"],"model":model,"domain":target_domain,
                                            "message_count":len(messages),"prompt_chars":len(prompt)})

            ev = BROWSER_EVENTS[job["id"]]
            if stream:
                # True browser-backed streaming: send snapshot suffixes as the
                # page grows; never expose UI reasoning/status as content.
                self.send_response(200)
                self.send_header("Content-Type","text/event-stream; charset=utf-8")
                self.send_header("Cache-Control","no-cache"); self.send_header("Connection","close")
                self.send_header("Access-Control-Allow-Origin","*"); self.end_headers()
                stream_id=f"chatcmpl-{job['id']}"
                stream_base={"id":stream_id,"object":"chat.completion.chunk","created":int(time.time()),"model":model}
                try:
                    first_chunk=dict(stream_base, choices=[{"index":0,"delta":{"role":"assistant"},"finish_reason":None}])
                    self.wfile.write(f"data: {json.dumps(first_chunk,ensure_ascii=False)}\n\n".encode()); self.wfile.flush()
                    sent_count=0
                    stream_deadline=time.time()+timeout
                    terminal_seen=False
                    idle_after_terminal=0
                    while time.time() < stream_deadline:
                        with BROWSER_LOCK:
                            deltas=list(BROWSER_DELTAS.get(job["id"], []))
                            current=BROWSER_JOBS.get(job["id"])
                        for item in deltas[sent_count:]:
                            sent_count += 1
                            text_delta=str(item.get("text") or "")
                            if not text_delta: continue
                            previous = str(deltas[sent_count-2].get("text") or "") if sent_count > 1 else ""
                            if previous and text_delta.startswith(previous): text_delta=text_delta[len(previous):]
                            elif previous and text_delta == previous: text_delta=""
                            if text_delta:
                                chunk=dict(stream_base,choices=[{"index":0,"delta":{"content":text_delta},"finish_reason":None}])
                                self.wfile.write(f"data: {json.dumps(chunk,ensure_ascii=False)}\n\n".encode()); self.wfile.flush()
                        terminal_now=ev.is_set() or (current and current.get("status") in ("completed","failed"))
                        if terminal_now:
                            if terminal_seen:
                                break
                            terminal_seen=True
                            idle_after_terminal=0
                        elif terminal_seen:
                            idle_after_terminal += 1
                            if idle_after_terminal >= 2: break
                        self.wfile.write(b": heartbeat\n\n"); self.wfile.flush()
                        time.sleep(0.25)
                    with BROWSER_LOCK: terminal=browser_json(BROWSER_JOBS.get(job["id"]))
                    if not terminal or terminal.get("status") != "completed":
                        err=(terminal or {}).get("error","browser_timeout")
                        error_chunk=dict(stream_base,choices=[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],error=err)
                        self.wfile.write(f"data: {json.dumps(error_chunk,ensure_ascii=False)}\n\n".encode())
                    else:
                        final_text=str((terminal.get("result") or {}).get("assistant") or "")
                        if sent_count == 0 and final_text:
                            chunk=dict(stream_base,choices=[{"index":0,"delta":{"content":final_text},"finish_reason":None}])
                            self.wfile.write(f"data: {json.dumps(chunk,ensure_ascii=False)}\n\n".encode())
                        stop_chunk=dict(stream_base,choices=[{"index":0,"delta":{},"finish_reason":"stop"}])
                        self.wfile.write(f"data: {json.dumps(stop_chunk,ensure_ascii=False)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                except (BrokenPipeError,ConnectionResetError): return
                return

            if not ev.wait(timeout):
                with BROWSER_LOCK:
                    cur=BROWSER_JOBS.get(job["id"])
                    if cur and cur["status"] in ("queued","claimed"):
                        # Keep an idempotent request in processing: the browser
                        # may already have submitted the message even though
                        # this HTTP waiter timed out. A retry must not click
                        # the page a second time.
                        cur["error"]="browser_timeout"
                    # Keep the job claimable/observable after the HTTP waiter
                    # times out. Removing it here would strand the
                    # idempotency record in `processing` forever.
                BROWSER_EVENTS.pop(job["id"], None)
                self._send_json({"error":{"message":"browser timeout","type":"browser_timeout","job_id":job["id"]}},504); return

            with BROWSER_LOCK: result=browser_json(BROWSER_JOBS.get(job["id"]))
            if not result or result["status"]!="completed":
                err=(result or {}).get("error","unknown")
                fail_idempotency(idem_key, err, terminal=False)
                self._send_json({"error":{"message":err,"type":"browser_error","job_id":job["id"]}},502); return

            assistant=(result.get("result") or {}).get("assistant","")
            created=int(time.time())
            prompt_tokens=approx_tokens(prompt)
            completion_tokens=approx_tokens(assistant)
            usage={"prompt_tokens":prompt_tokens,"completion_tokens":completion_tokens,
                   "total_tokens":prompt_tokens+completion_tokens}

            response_payload = {
                "id":f"chatcmpl-{job['id']}","object":"chat.completion","created":created,"model":model,
                "choices":[{"index":0,"message":{"role":"assistant","content":assistant},"finish_reason":"stop"}],
                "usage":usage,
            }
            complete_idempotency(idem_key, response_payload)

            if stream:
                self.send_response(200)
                self.send_header("Content-Type","text/event-stream; charset=utf-8")
                self.send_header("Cache-Control","no-cache"); self.send_header("Connection","close")
                self.send_header("Access-Control-Allow-Origin","*"); self.end_headers()
                try:
                    p={"id":f"chatcmpl-{job['id']}","object":"chat.completion.chunk","created":created,"model":model}
                    for chunk in (
                        dict(p,choices=[{"index":0,"delta":{"role":"assistant"},"finish_reason":None}]),
                        dict(p,choices=[{"index":0,"delta":{"content":assistant},"finish_reason":None}]),
                        dict(p,choices=[{"index":0,"delta":{},"finish_reason":"stop"}]),
                    ):
                        self.wfile.write(f"data: {json.dumps(chunk,ensure_ascii=False)}\n\n".encode()); self.wfile.flush()
                    self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                except (BrokenPipeError,ConnectionResetError): return
            else:
                self._send_json(response_payload)
            return

        self._send_json({"error":"Unknown endpoint"},404)

    def log_message(self,fmt,*args):
        # 轮询是正常的高频心跳；只记录实际 job/错误相关请求，避免日志洪泛。
        rendered = fmt%args if args else fmt
        if 'POST /browser/poll' in rendered:
            return
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {rendered}")

def port_has_healthy_api():
    """Return True when this port is already served by a healthy Phantom Relay API."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1.5) as response:
            data = json.loads(response.read().decode("utf-8"))
        return data.get("status") == "ok" and data.get("service") == "phantom-relay-api"
    except Exception:
        return False
def main():
    if port_has_healthy_api():
        print(f"Phantom Relay API already running on :{PORT}; reusing existing instance")
        return 0
    server=ThreadingHTTPServer(("0.0.0.0",PORT),BrowserAPIHandler)
    print(f"""\nPhantom Relay API v3 :{PORT}\nmodel-routes: GET /model-routes\nchat: POST /v1/chat/completions\n""")
    try: server.serve_forever()
    except KeyboardInterrupt: print("stop"); server.shutdown()
    return 0

if __name__=="__main__": main()