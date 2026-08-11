"""Durable, provider-neutral storage for browser relay jobs.

The API server still owns the live in-memory state.  This module only defines
the durable boundary so that a later integration can persist jobs without
leaking browser credentials or runtime-only objects into SQLite.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence


_SCHEMA_VERSION = 1
_UNSAFE_KEYS = {
    "access_token",
    "api_key",
    "apikey",
    "authorization",
    "claim_token",
    "cookie",
    "password",
    "refresh_token",
    "secret",
    "set_cookie",
    "token",
}
_RUNTIME_ONLY_KEYS = {
    "event",
    "lock",
    "page_trace",
    "ready_event",
    "thread",
    "trace",
}


@dataclass(frozen=True)
class JobSnapshot:
    """A complete durable view of the job coordinator state."""

    jobs: dict[str, dict[str, Any]]
    queue: list[str]
    deltas: dict[str, list[dict[str, Any]]]
    bindings: list[dict[str, Any]] = field(default_factory=list)
    idempotency: dict[str, dict[str, Any]] = field(default_factory=dict)


def _normalized_key(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"(?<!^)(?=[A-Z])", "_", text)
    return re.sub(r"[-\s]+", "_", text).lower()


def _is_json_scalar(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _sanitize(value: Any, *, key: str | None = None) -> Any:
    normalized = _normalized_key(key) if key is not None else ""
    if normalized in _UNSAFE_KEYS or normalized in _RUNTIME_ONLY_KEYS:
        return _DROP
    if _is_json_scalar(value):
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            child_key = str(raw_key)
            sanitized = _sanitize(raw_value, key=child_key)
            if sanitized is not _DROP:
                result[child_key] = sanitized
        return result
    if isinstance(value, (list, tuple)):
        result = []
        for item in value:
            sanitized = _sanitize(item)
            if sanitized is not _DROP:
                result.append(sanitized)
        return result
    raise TypeError(f"durable job state contains unsupported value: {type(value).__name__}")


class _DropValue:
    pass


_DROP = _DropValue()


def _safe_job(job_id: str, job: Mapping[str, Any]) -> dict[str, Any]:
    value = _sanitize(dict(job))
    if not isinstance(value, dict):
        raise TypeError("job must serialize to an object")
    value.setdefault("id", str(job_id))
    value["id"] = str(value["id"] or job_id)
    return value


def _safe_deltas(
    deltas: Mapping[str, Sequence[Mapping[str, Any]]] | None,
    job_ids: set[str],
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for raw_job_id, raw_items in (deltas or {}).items():
        job_id = str(raw_job_id)
        if job_id not in job_ids or not isinstance(raw_items, Sequence):
            continue
        items: list[dict[str, Any]] = []
        for raw_item in raw_items:
            if not isinstance(raw_item, Mapping):
                continue
            item = _sanitize(dict(raw_item))
            if isinstance(item, dict):
                items.append(item)
        if items:
            result[job_id] = items
    return result


def _safe_queue(queue: Sequence[Any] | None, job_ids: set[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw_job_id in queue or ():
        job_id = str(raw_job_id)
        if job_id not in job_ids or job_id in seen:
            continue
        seen.add(job_id)
        result.append(job_id)
    return result


def _safe_bindings(bindings: Mapping[Any, Mapping[str, Any]] | None) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for raw_key, raw_binding in (bindings or {}).items():
        if not isinstance(raw_binding, Mapping):
            continue
        binding = _sanitize(dict(raw_binding))
        if not isinstance(binding, dict):
            continue
        if isinstance(raw_key, (tuple, list)) and len(raw_key) == 2:
            conversation_id = str(raw_key[0] or "")
            domain = str(raw_key[1] or "").strip().lower()
        else:
            conversation_id = str(binding.get("conversation_id") or "")
            domain = str(binding.get("domain") or "").strip().lower()
        if not conversation_id or not domain:
            continue
        binding["conversation_id"] = conversation_id
        binding["domain"] = domain
        result.append({
            "conversation_id": conversation_id,
            "domain": domain,
            "binding": binding,
        })
    result.sort(key=lambda item: (item["conversation_id"], item["domain"]))
    return result


def _safe_idempotency(
    records: Mapping[str, Mapping[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for raw_key, raw_record in (records or {}).items():
        key = str(raw_key or "").strip()
        if not key or not isinstance(raw_record, Mapping):
            continue
        record = _sanitize(dict(raw_record))
        if not isinstance(record, dict):
            continue
        record["key"] = key
        result[key] = record
    return result


class DurableJobStore:
    """SQLite-backed snapshot store for queued and in-flight browser jobs."""

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)

    def _connect(self) -> sqlite3.Connection:
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(self.path), timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS queue (
                position INTEGER PRIMARY KEY,
                job_id TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS deltas (
                job_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bindings (
                binding_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS idempotency (
                idempotency_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
            ("schema_version", str(_SCHEMA_VERSION)),
        )
        connection.commit()
        return connection

    def save_snapshot(
        self,
        jobs: Mapping[str, Mapping[str, Any]],
        queue: Sequence[Any] | None,
        *,
        deltas: Mapping[str, Sequence[Mapping[str, Any]]] | None = None,
        bindings: Mapping[Any, Mapping[str, Any]] | None = None,
        idempotency: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> None:
        safe_jobs = {
            str(job_id): _safe_job(str(job_id), job)
            for job_id, job in jobs.items()
            if isinstance(job, Mapping)
        }
        safe_queue = _safe_queue(queue, set(safe_jobs))
        safe_deltas = _safe_deltas(deltas, set(safe_jobs))
        safe_bindings = _safe_bindings(bindings)
        safe_idempotency = _safe_idempotency(idempotency)
        encoded_jobs = {
            job_id: json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            for job_id, job in safe_jobs.items()
        }
        encoded_deltas = {
            job_id: json.dumps(items, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            for job_id, items in safe_deltas.items()
        }
        encoded_bindings = {
            json.dumps([item["conversation_id"], item["domain"]], ensure_ascii=False, separators=(",", ":")): json.dumps(
                item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            for item in safe_bindings
        }
        encoded_idempotency = {
            key: json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            for key, record in safe_idempotency.items()
        }

        connection = self._connect()
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
                ((position, job_id) for position, job_id in enumerate(safe_queue)),
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

    def load_snapshot(self) -> JobSnapshot:
        if str(self.path) != ":memory:" and not self.path.exists():
            return JobSnapshot(jobs={}, queue=[], deltas={})
        connection = self._connect()
        try:
            jobs: dict[str, dict[str, Any]] = {}
            for row in connection.execute("SELECT job_id, payload FROM jobs"):
                value = json.loads(row["payload"])
                if isinstance(value, dict):
                    jobs[str(row["job_id"])] = value
            queue = [str(row["job_id"]) for row in connection.execute(
                "SELECT job_id FROM queue ORDER BY position ASC"
            ) if str(row["job_id"]) in jobs]
            deltas: dict[str, list[dict[str, Any]]] = {}
            for row in connection.execute("SELECT job_id, payload FROM deltas"):
                value = json.loads(row["payload"])
                if isinstance(value, list) and str(row["job_id"]) in jobs:
                    deltas[str(row["job_id"])] = [
                        item for item in value if isinstance(item, dict)
                    ]
            bindings: list[dict[str, Any]] = []
            for row in connection.execute("SELECT payload FROM bindings"):
                value = json.loads(row["payload"])
                if isinstance(value, dict):
                    bindings.append(value)
            idempotency: dict[str, dict[str, Any]] = {}
            for row in connection.execute("SELECT idempotency_key, payload FROM idempotency"):
                value = json.loads(row["payload"])
                if isinstance(value, dict):
                    idempotency[str(row["idempotency_key"])] = value
            return JobSnapshot(
                jobs=jobs,
                queue=queue,
                deltas=deltas,
                bindings=bindings,
                idempotency=idempotency,
            )
        finally:
            connection.close()
