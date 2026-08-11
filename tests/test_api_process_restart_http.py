import json
import os
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _start_api(store_path):
    source = textwrap.dedent(
        """
        import sys
        from werkzeug.serving import make_server
        from server import api_server as api

        api.configure_browser_job_store(sys.argv[1], restore=True)
        server = make_server("127.0.0.1", 0, api.app)
        print(server.server_port, flush=True)
        server.serve_forever()
        """
    )
    environment = dict(os.environ)
    environment["PYTHONPATH"] = ROOT
    process = subprocess.Popen(
        [sys.executable, "-c", source, str(store_path)],
        cwd=ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    port_line = process.stdout.readline().strip()
    if not port_line:
        stderr = process.stderr.read() if process.stderr else ""
        process.kill()
        raise AssertionError(f"API process did not start: {stderr}")
    return process, int(port_line)


def _json_request(port, path, *, method="GET", body=None):
    payload = None
    headers = {}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=payload,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def test_http_api_restart_fails_incomplete_submitted_job_without_shared_process(tmp_path):
    store_path = tmp_path / "http-restart.sqlite3"
    first = second = None
    try:
        first, first_port = _start_api(store_path)
        status, submitted = _json_request(
            first_port,
            "/browser/submit",
            method="POST",
            body={
                "message": "restart probe",
                "model": "fixture-model",
                "domain": "example.test",
                "target_url": "https://example.test/chat",
                "conversation_id": "restart-conversation",
            },
        )
        assert status == 202
        job_id = submitted["id"]
        _stop(first)
        first = None

        second, second_port = _start_api(store_path)
        status, snapshot = _json_request(second_port, "/browser/status")
        assert status == 200
        restored = snapshot["terminal_jobs"][job_id]
        assert restored["status"] == "failed"
        assert restored["state_reason"] == "server_restart_incomplete"
        assert restored["tab_id"] is None
        assert restored["conversation_id"] == "restart-conversation"
        assert restored["target_url"] == "https://example.test/chat"
        assert snapshot["queue_depth"] == 0
    finally:
        if first is not None:
            _stop(first)
        if second is not None:
            _stop(second)
