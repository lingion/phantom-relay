"""Operational SQLite checks for the provider-neutral durable job store.

These tests deliberately exercise the file-backed store through independent
connections and processes.  They are not model or browser tests: a failure is
evidence about the durable coordination boundary itself.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import textwrap
import threading
from pathlib import Path

import pytest

from server import job_store as job_store_module
from server.job_store import DurableJobStore, JobSnapshot


ROOT = Path(__file__).resolve().parents[1]


def _job(job_id: str, generation: str, *, status: str = "queued") -> dict:
    return {
        "id": job_id,
        "conversation_id": f"conversation-{job_id}",
        "domain": "example.test",
        "model": "fixture-model",
        "message": f"request-{job_id}",
        "status": status,
        "state_reason": status,
        "generation": generation,
        "result": None,
        "error": None,
    }


def _snapshot(generation: str, *, queue: list[str] | None = None) -> tuple[
    dict[str, dict], list[str], dict[str, list[dict]], dict, dict
]:
    jobs = {
        "alpha": _job("alpha", generation),
        "beta": _job("beta", generation),
    }
    ordered_queue = queue if queue is not None else ["alpha", "beta"]
    deltas = {
        "alpha": [{"generation": generation, "text": f"delta-{generation}"}],
    }
    bindings = {
        ("conversation-alpha", "example.test"): {
            "conversation_id": "conversation-alpha",
            "domain": "example.test",
            "tab_id": generation,
            "generation": generation,
        },
    }
    idempotency = {
        f"idempotency-{generation}": {
            "key": f"idempotency-{generation}",
            "job_id": "alpha",
            "status": "processing",
            "generation": generation,
        },
    }
    return jobs, ordered_queue, deltas, bindings, idempotency


def _save(
    store: DurableJobStore,
    snapshot: tuple[dict[str, dict], list[str], dict[str, list[dict]], dict, dict],
) -> None:
    jobs, queue, deltas, bindings, idempotency = snapshot
    store.save_snapshot(
        jobs,
        queue,
        deltas=deltas,
        bindings=bindings,
        idempotency=idempotency,
    )


def _snapshot_fingerprint(snapshot: JobSnapshot) -> dict:
    return {
        "jobs": {
            job_id: job.get("generation")
            for job_id, job in sorted(snapshot.jobs.items())
        },
        "queue": list(snapshot.queue),
        "deltas": snapshot.deltas,
        "bindings": snapshot.bindings,
        "idempotency": snapshot.idempotency,
    }


def _run_python(source: str, store_path: Path) -> dict:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(ROOT)
    completed = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(source), str(store_path)],
        cwd=ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _raw_replace_snapshot(
    connect,
    path: Path,
    generation: str,
) -> None:
    """Commit a second complete generation without the store bootstrap writes."""

    jobs, queue, deltas, bindings, idempotency = _snapshot(generation, queue=["beta", "alpha"])
    encoded_jobs = {
        job_id: json.dumps(job, sort_keys=True, separators=(",", ":"))
        for job_id, job in jobs.items()
    }
    encoded_deltas = {
        job_id: json.dumps(items, sort_keys=True, separators=(",", ":"))
        for job_id, items in deltas.items()
    }
    encoded_bindings = {
        json.dumps([conversation_id, domain], separators=(",", ":")): json.dumps(
            {"conversation_id": conversation_id, "domain": domain, "binding": binding},
            sort_keys=True,
            separators=(",", ":"),
        )
        for (conversation_id, domain), binding in bindings.items()
    }
    encoded_idempotency = {
        key: json.dumps(record, sort_keys=True, separators=(",", ":"))
        for key, record in idempotency.items()
    }

    connection = connect(str(path), timeout=0.25)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM jobs")
        connection.execute("DELETE FROM queue")
        connection.execute("DELETE FROM deltas")
        connection.execute("DELETE FROM bindings")
        connection.execute("DELETE FROM idempotency")
        connection.executemany(
            "INSERT INTO jobs(job_id, payload) VALUES (?, ?)",
            encoded_jobs.items(),
        )
        connection.executemany(
            "INSERT INTO queue(position, job_id) VALUES (?, ?)",
            enumerate(queue),
        )
        connection.executemany(
            "INSERT INTO deltas(job_id, payload) VALUES (?, ?)",
            encoded_deltas.items(),
        )
        connection.executemany(
            "INSERT INTO bindings(binding_id, payload) VALUES (?, ?)",
            encoded_bindings.items(),
        )
        connection.executemany(
            "INSERT INTO idempotency(idempotency_key, payload) VALUES (?, ?)",
            encoded_idempotency.items(),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def test_complete_snapshot_survives_a_fresh_process(tmp_path):
    store_path = tmp_path / "restart.sqlite3"
    store = DurableJobStore(store_path)
    _save(store, _snapshot("restart"))

    restored = _run_python(
        """
        import json
        import sys
        from server.job_store import DurableJobStore

        snapshot = DurableJobStore(sys.argv[1]).load_snapshot()
        print(json.dumps({
            "jobs": snapshot.jobs,
            "queue": snapshot.queue,
            "deltas": snapshot.deltas,
            "bindings": snapshot.bindings,
            "idempotency": snapshot.idempotency,
        }, sort_keys=True))
        """,
        store_path,
    )

    expected = _snapshot_fingerprint(store.load_snapshot())
    assert _snapshot_fingerprint(
        JobSnapshot(
            jobs=restored["jobs"],
            queue=restored["queue"],
            deltas=restored["deltas"],
            bindings=restored["bindings"],
            idempotency=restored["idempotency"],
        )
    ) == expected


def test_concurrent_save_snapshot_writers_leave_one_complete_generation(tmp_path):
    store_path = tmp_path / "concurrent-writers.sqlite3"
    store = DurableJobStore(store_path)
    _save(store, _snapshot("initial"))

    writer_count = 8
    barrier = threading.Barrier(writer_count)
    failures: list[BaseException] = []

    def write_generation(index: int) -> None:
        try:
            barrier.wait(timeout=10)
            _save(DurableJobStore(store_path), _snapshot(f"generation-{index}"))
        except BaseException as exc:  # surface every writer failure in the assertion
            failures.append(exc)

    threads = [
        threading.Thread(
            target=write_generation,
            args=(index,),
            name=f"sqlite-writer-{index}",
        )
        for index in range(writer_count)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)

    assert not any(thread.is_alive() for thread in threads)
    assert failures == []

    restored = store.load_snapshot()
    generations = {
        job.get("generation") for job in restored.jobs.values()
    }
    generations.update(item.get("generation") for item in restored.deltas["alpha"])
    generations.update(item["binding"].get("generation") for item in restored.bindings)
    generations.update(record.get("generation") for record in restored.idempotency.values())

    assert len(generations) == 1
    generation = next(iter(generations))
    assert generation.startswith("generation-")
    assert restored.queue == ["alpha", "beta"]


def test_failed_write_rolls_back_all_tables_to_last_good_snapshot(tmp_path):
    store_path = tmp_path / "rollback.sqlite3"
    store = DurableJobStore(store_path)
    good = _snapshot("good")
    _save(store, good)
    before = _snapshot_fingerprint(store.load_snapshot())

    connection = sqlite3.connect(store_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER abort_bad_delta
            BEFORE INSERT ON deltas
            WHEN instr(NEW.payload, 'forced-write-failure') > 0
            BEGIN
                SELECT RAISE(ABORT, 'forced write failure');
            END
            """
        )
        connection.commit()
    finally:
        connection.close()

    bad = _snapshot("bad")
    bad[2]["alpha"][0]["text"] = "forced-write-failure"
    with pytest.raises(sqlite3.Error, match="forced write failure"):
        _save(store, bad)

    assert _snapshot_fingerprint(store.load_snapshot()) == before


def test_load_snapshot_never_returns_a_torn_cross_table_generation(tmp_path, monkeypatch):
    """A load must observe one committed generation across all snapshot tables."""

    store_path = tmp_path / "reader-isolation.sqlite3"
    store = DurableJobStore(store_path)
    first = _snapshot("first")
    _save(store, first)
    expected_first = _snapshot_fingerprint(store.load_snapshot())

    real_connect = sqlite3.connect
    jobs_rows_seen = threading.Event()
    release_reader = threading.Event()
    writer_done = threading.Event()
    writer_errors: list[BaseException] = []

    def replace_from_writer() -> None:
        try:
            _raw_replace_snapshot(real_connect, store_path, "second")
        except BaseException as exc:
            writer_errors.append(exc)
        finally:
            writer_done.set()

    class GateCursor(sqlite3.Cursor):
        def __iter__(self):
            iterator = super().__iter__()
            if getattr(self, "gate_jobs_read", False):
                rows = self.fetchall()
                jobs_rows_seen.set()
                writer = threading.Thread(
                    target=replace_from_writer,
                    name="sqlite-interleaved-writer",
                )
                writer.start()
                assert writer_done.wait(timeout=5), "interleaved writer did not finish"
                assert release_reader.wait(timeout=5), "reader gate was not released"
                writer.join(timeout=5)
                return iter(rows)
            return iterator

    class GateConnection(sqlite3.Connection):
        def cursor(self, factory=None):
            return super().cursor(factory or GateCursor)

        def execute(self, sql, parameters=()):
            cursor = self.cursor()
            cursor.execute(sql, parameters)
            if (
                threading.current_thread().name == "sqlite-snapshot-reader"
                and "SELECT job_id, payload FROM jobs" in sql
            ):
                cursor.gate_jobs_read = True
            return cursor

    def connect_with_gate(*args, **kwargs):
        kwargs["factory"] = GateConnection
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(job_store_module.sqlite3, "connect", connect_with_gate)
    observed: dict[str, JobSnapshot] = {}
    reader_errors: list[BaseException] = []

    def read_snapshot() -> None:
        try:
            observed["snapshot"] = store.load_snapshot()
        except BaseException as exc:
            reader_errors.append(exc)

    reader = threading.Thread(target=read_snapshot, name="sqlite-snapshot-reader")
    reader.start()
    reached_jobs = jobs_rows_seen.wait(timeout=5)
    if not reached_jobs:
        reader.join(timeout=5)
        assert reader_errors == [], f"reader failed before the gate: {reader_errors!r}"
        pytest.fail("reader did not reach the jobs table")
    release_reader.set()
    reader.join(timeout=10)

    assert not reader.is_alive()
    assert reader_errors == []
    assert all(
        isinstance(error, sqlite3.OperationalError) and "locked" in str(error).lower()
        for error in writer_errors
    ), writer_errors
    observed_fingerprint = _snapshot_fingerprint(observed["snapshot"])
    expected_second = _snapshot_fingerprint(
        JobSnapshot(
            jobs=_snapshot("second")[0],
            queue=["beta", "alpha"],
            deltas=_snapshot("second")[2],
            bindings=[
                {
                    "conversation_id": "conversation-alpha",
                    "domain": "example.test",
                    "binding": _snapshot("second")[3][
                        ("conversation-alpha", "example.test")
                    ],
                }
            ],
            idempotency=_snapshot("second")[4],
        )
    )

    assert (
        observed_fingerprint == expected_first
        or observed_fingerprint == expected_second
    )


def test_corrupt_payload_fails_closed_without_silently_dropping_the_row(tmp_path):
    store_path = tmp_path / "corrupt-payload.sqlite3"
    store = DurableJobStore(store_path)
    _save(store, _snapshot("valid"))

    connection = sqlite3.connect(store_path)
    try:
        connection.execute(
            "UPDATE jobs SET payload = ? WHERE job_id = ?",
            ("{not-valid-json", "alpha"),
        )
        connection.commit()
    finally:
        connection.close()

    with pytest.raises(ValueError):
        store.load_snapshot()

    connection = sqlite3.connect(store_path)
    try:
        payload = connection.execute(
            "SELECT payload FROM jobs WHERE job_id = 'alpha'"
        ).fetchone()[0]
    finally:
        connection.close()
    assert payload == "{not-valid-json"


@pytest.mark.parametrize("unsupported_version", ["0", "2", "999"])
def test_unsupported_schema_version_is_rejected_without_downgrade(
    tmp_path,
    unsupported_version,
):
    store_path = tmp_path / f"schema-{unsupported_version}.sqlite3"
    store = DurableJobStore(store_path)
    _save(store, _snapshot("schema-boundary"))

    connection = sqlite3.connect(store_path)
    try:
        connection.execute(
            "UPDATE metadata SET value = ? WHERE key = 'schema_version'",
            (unsupported_version,),
        )
        connection.commit()
    finally:
        connection.close()

    with pytest.raises((RuntimeError, ValueError), match="schema"):
        store.load_snapshot()

    connection = sqlite3.connect(store_path)
    try:
        persisted_version = connection.execute(
            "SELECT value FROM metadata WHERE key = 'schema_version'"
        ).fetchone()[0]
    finally:
        connection.close()
    assert persisted_version == unsupported_version
