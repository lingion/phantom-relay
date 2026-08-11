import importlib.util
import pathlib
import threading


ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_api_module():
    spec = importlib.util.spec_from_file_location(
        "phantom_chat_idempotency", ROOT / "server" / "api_server.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_chat_completion_replays_completed_idempotency_key(monkeypatch, tmp_path):
    api = _load_api_module()
    monkeypatch.setattr(api, "DATA_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(api, "route_has_executable_profile", lambda route: True)
    recorded_route = api._build_model_route(
        {
            "id": "recorded-model",
            "name": "Recorded Model",
            "owned_by": "user",
            "api": "browser",
            "capabilities": {},
        },
        domain="custom.example",
        url="https://custom.example/workspace/chat",
        selectors={},
    )
    monkeypatch.setattr(api, "_routes", {recorded_route.id: recorded_route})
    monkeypatch.setattr(api, "_aliases", {})
    api.IDEMPOTENCY.clear()
    api.BROWSER_JOBS.clear()
    api.BROWSER_EVENTS.clear()
    calls = []

    def fake_new_browser_job(message, **kwargs):
        calls.append(message)
        job_id = f"job-test-{len(calls)}"
        job = {
            "id": job_id,
            "conversation_id": "conv-test",
            "status": "completed",
            "model": kwargs["model"],
            "message": message,
            "request_meta": kwargs.get("request_meta") or {},
            "result": {"assistant": "cached"},
        }
        api.BROWSER_JOBS[job_id] = job
        event = threading.Event()
        event.set()
        api.BROWSER_EVENTS[job_id] = event
        return job

    monkeypatch.setattr(api, "new_browser_job", fake_new_browser_job)
    client = api.app.test_client()
    request = {
        "model": "recorded-model",
        "messages": [{"role": "user", "content": "hello"}],
        "stream": False,
    }

    first = client.post(
        "/v1/chat/completions",
        json=request,
        headers={"Idempotency-Key": "same-request"},
    )
    second = client.post(
        "/v1/chat/completions",
        json=request,
        headers={"Idempotency-Key": "same-request"},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json()["choices"][0]["message"]["content"] == "cached"
    assert second.get_json() == first.get_json()
    assert len(calls) == 1


def test_corrupt_conversation_store_is_backed_up_and_replaced_atomically(tmp_path):
    api = _load_api_module()
    data_file = tmp_path / "conversations.json"
    data_file.write_text('{"conversations":[', encoding="utf-8")
    api.DATA_FILE = str(data_file)
    api._CORRUPT_DATA_BACKUP = None

    assert api.load_data() == {"conversations": [], "models": []}
    assert api._CORRUPT_DATA_BACKUP
    assert pathlib.Path(api._CORRUPT_DATA_BACKUP).read_text(encoding="utf-8") == '{"conversations":['

    api.save_conversation("hello", "cached", model="recorded-model")
    saved = __import__("json").loads(data_file.read_text(encoding="utf-8"))
    assert saved["conversations"][0]["assistant"] == "cached"
