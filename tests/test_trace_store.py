import importlib.util
import json
import pathlib
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.trace_store import TraceStore


def _load_api_module():
    spec = importlib.util.spec_from_file_location(
        "phantom_api_trace_store",
        ROOT / "server" / "api_server.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load_api_module()


def _reset_browser_state():
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_READY.clear()


def _use_tmp_trace(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "TRACE_FILE", str(tmp_path / "page-trace.jsonl"))


def test_tail_returns_latest_entries_oldest_first(tmp_path):
    store = TraceStore(str(tmp_path / "trace.sqlite3"))
    for index in range(5):
        store.record({"source": "api", "kind": f"event_{index}", "time": time.time()})
    entries = store.tail(limit=3)
    assert [entry["kind"] for entry in entries] == ["event_2", "event_3", "event_4"]


def test_levels_are_classified_and_cleanup_respects_ttl(tmp_path):
    store = TraceStore(str(tmp_path / "trace.sqlite3"))
    now = time.time()
    store.record({"source": "api", "kind": "page_ready_heartbeat_result", "time": now - 2 * 86400})
    store.record({"source": "api", "kind": "browser_wake_requested", "time": now - 2 * 86400})
    store.record({"source": "api", "kind": "browser_delta_rejected", "time": now - 2 * 86400})

    deleted = store.cleanup(now=now)
    assert deleted == 1
    remaining = store.tail(limit=100)
    kinds = {entry["kind"] for entry in remaining}
    assert kinds == {"browser_wake_requested", "browser_delta_rejected"}

    old = now - 8 * 86400
    store.record({"source": "api", "kind": "browser_wake_requested", "time": old})
    store.cleanup(now=now + 86400)
    remaining = {entry["kind"] for entry in store.tail(limit=100)}
    assert remaining == {"browser_wake_requested", "browser_delta_rejected"}


def test_error_markers_map_to_error_level(tmp_path):
    store = TraceStore(str(tmp_path / "trace.sqlite3"))
    store.record({"source": "api", "kind": "browser_queue_timeout", "time": time.time()})
    errors = store.tail(limit=10, level="error")
    assert [entry["kind"] for entry in errors] == ["browser_queue_timeout"]


def test_jsonl_migration_imports_and_archives(tmp_path):
    legacy = tmp_path / "page-trace.jsonl"
    epoch = time.time() - 3600
    lines = [
        json.dumps({"source": "api", "kind": "browser_wake_requested", "time": epoch}),
        json.dumps({"source": "phantom-relay-background", "kind": "probe",
                    "time": "2026-08-18T07:42:28.315Z"}),
        "not json at all",
    ]
    legacy.write_text("\n".join(lines) + "\n", encoding="utf-8")

    store = TraceStore(str(tmp_path / "page-trace.sqlite3"), legacy_jsonl=str(legacy))
    assert store.imported_count == 2
    entries = store.tail(limit=10)
    assert [entry["kind"] for entry in entries] == ["browser_wake_requested", "probe"]
    assert not legacy.exists()
    assert list(tmp_path.glob("page-trace.jsonl.imported*"))


def test_concurrent_records_are_all_persisted(tmp_path):
    store = TraceStore(str(tmp_path / "trace.sqlite3"))
    errors = []

    def worker(worker_index):
        try:
            for index in range(25):
                store.record({"source": "api", "kind": f"w{worker_index}-{index}",
                              "time": time.time()})
        except Exception as exc:  # pragma: no cover - surfaced via assertion
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert len(store.tail(limit=1000)) == 200


def test_trace_post_and_tail_round_trip(monkeypatch, tmp_path):
    _reset_browser_state()
    _use_tmp_trace(monkeypatch, tmp_path)
    client = api.app.test_client()

    response = client.post("/trace", json={
        "domain": "example.com",
        "tabId": 7,
        "entry": {"kind": "recorded_elements_ready", "url": "https://example.com/"},
    })
    assert response.status_code == 200
    api.trace_api_event("browser_wake_requested", {"domain": "example.com"})

    payload = client.get("/trace/tail?limit=10").get_json()
    kinds = [entry.get("kind") for entry in payload["entries"]]
    assert kinds == ["recorded_elements_ready", "browser_wake_requested"]
    assert payload["entries"][0]["domain"] == "example.com"
    assert payload["entries"][0]["tabId"] == 7
    assert payload["entries"][0]["entry"]["url"] == "https://example.com/"

    database = tmp_path / "page-trace.sqlite3"
    assert database.exists()
    assert not (tmp_path / "page-trace.jsonl").exists()


def test_trace_tail_filters_by_kind_and_job(monkeypatch, tmp_path):
    _use_tmp_trace(monkeypatch, tmp_path)
    client = api.app.test_client()

    client.post("/trace", json={"domain": "a.com", "tabId": 1, "entry": {"kind": "probe_a"}})
    client.post("/trace", json={"domain": "b.com", "tabId": 2, "entry": {"kind": "probe_b"}})
    api.trace_api_event("job_event", {"job_id": "job-9"})

    payload = client.get("/trace/tail?kind=probe_b").get_json()
    assert [entry["entry"]["kind"] for entry in payload["entries"]] == ["probe_b"]

    payload = client.get("/trace/tail?job_id=job-9").get_json()
    assert [entry["kind"] for entry in payload["entries"]] == ["job_event"]


def test_browser_debug_writes_to_store(monkeypatch, tmp_path):
    _use_tmp_trace(monkeypatch, tmp_path)
    client = api.app.test_client()

    response = client.post("/browser/debug", json={
        "domain": "example.com",
        "tabId": 3,
        "message": "browser_registration_failed",
        "details": {"error": "Failed to fetch"},
    })
    assert response.status_code == 200

    payload = client.get("/trace/tail").get_json()
    entry = payload["entries"][-1]
    assert entry["source"] == "phantom-relay-background"
    assert entry["message"] == "browser_registration_failed"


def test_trace_api_event_swallows_store_failures(monkeypatch):
    def _broken_store():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(api, "trace_store", _broken_store)
    api.trace_api_event("anything", {"x": 1})


def test_trace_store_follows_monkeypatched_trace_file(monkeypatch, tmp_path):
    first = tmp_path / "first.jsonl"
    monkeypatch.setattr(api, "TRACE_FILE", str(first))
    api.trace_api_event("first_event", {})
    assert (tmp_path / "first.sqlite3").exists()

    second = tmp_path / "second.jsonl"
    monkeypatch.setattr(api, "TRACE_FILE", str(second))
    api.trace_api_event("second_event", {})
    assert (tmp_path / "second.sqlite3").exists()

    payload = api.app.test_client().get("/trace/tail").get_json()
    assert [entry["kind"] for entry in payload["entries"]] == ["second_event"]
