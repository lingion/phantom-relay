import importlib.util
import pathlib
import threading
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_api_module():
    spec = importlib.util.spec_from_file_location(
        "phantom_live_stream_contract",
        ROOT / "server" / "api_server.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load_api_module()


def test_live_sse_emits_dom_snapshot_before_terminal_browser_result():
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_EVENTS.clear()
    api.BROWSER_DELTAS.clear()

    route = api._build_model_route(
        {
            "id": "recorded-model",
            "name": "Recorded Model",
            "owned_by": "user",
            "api": "browser",
            "capabilities": {"supports_streaming": True},
        },
        domain="custom.example",
        url="https://custom.example/workspace/chat",
        selectors={},
    )
    job = api.new_browser_job(
        "emit while generating",
        domain=route.domain,
        model=route.id,
        conversation_id="live-stream-contract",
    )
    job.update(
        status="claimed",
        tab_id=7,
        client_id="client-live-stream",
        lease_expires_at=time.time() + 60,
    )
    api.BROWSER_DELTAS[job["id"]].append(
        {
            "key": "response-1",
            "text": "partial answer",
            "delta": "partial answer",
            "streaming": True,
            "completion_reason": "",
        }
    )

    stream = api.iter_live_browser_sse(
        job,
        route,
        request_key="",
        full_prompt=job["message"],
        tool_choice="none",
        timeout_sec=2,
    )
    role_chunk = next(stream)
    partial_chunk = next(stream)

    assert '"role":"assistant"' in role_chunk
    assert '"content":"partial answer"' in partial_chunk
    assert api.BROWSER_JOBS[job["id"]]["status"] == "claimed"

    def complete_job():
        time.sleep(0.02)
        api.finish_browser_job(
            job["id"],
            "completed",
            result={"assistant": "partial answer finished", "key": "response-1", "tool_call": None},
        )

    thread = threading.Thread(target=complete_job)
    thread.start()
    tail = "".join(stream)
    thread.join()

    assert '"content":" finished"' in tail
    assert '"finish_reason":"stop"' in tail
    assert "data: [DONE]" in tail
