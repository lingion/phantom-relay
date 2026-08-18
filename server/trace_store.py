"""SQLite-backed trace event store.

Replaces the append-only page-trace.jsonl diagnostics log with an indexed
event table that supports constant-time tail queries, per-kind filtering
and automatic TTL cleanup.  The legacy JSONL file is imported once and
archived when the store is first opened next to it.
"""
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime

DEBUG_KINDS = {
    "page_ready_heartbeat_result",
    "recorded_selectors_loaded",
    "recorded_elements_ready",
    "recorded_response_probe",
    "recorded_response_completion_state",
    "response_monitor",
}

_ERROR_MARKER_RE = re.compile(
    r"error|fail|reject|corrupt|timeout|unavailable|expired|drift|invalid",
    re.IGNORECASE,
)

DEFAULT_DEBUG_TTL = 24 * 60 * 60.0
DEFAULT_TTL = 7 * 24 * 60 * 60.0
CLEANUP_INTERVAL = 60 * 60.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS trace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    level TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_events_ts ON trace_events(ts);
CREATE INDEX IF NOT EXISTS idx_trace_events_kind ON trace_events(kind, id);
CREATE INDEX IF NOT EXISTS idx_trace_events_job ON trace_events(job_id, id);
"""


def classify_level(kind, level=None):
    if level in ("debug", "info", "error"):
        return level
    kind = str(kind or "")
    if kind in DEBUG_KINDS:
        return "debug"
    if _ERROR_MARKER_RE.search(kind):
        return "error"
    return "info"


def _entry_ts(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            pass
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except (ValueError, TypeError):
            return None
    return None


def _entry_kind(entry):
    kind = entry.get("kind") or entry.get("message")
    if not kind:
        nested = entry.get("entry")
        if isinstance(nested, dict):
            kind = nested.get("kind") or nested.get("message")
    return str(kind or "")


class TraceStore:
    """Thread-safe SQLite trace event store (WAL mode)."""

    def __init__(self, db_path, *, legacy_jsonl=None,
                 debug_ttl=DEFAULT_DEBUG_TTL, default_ttl=DEFAULT_TTL):
        self.db_path = db_path
        self.debug_ttl = float(debug_ttl)
        self.default_ttl = float(default_ttl)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
        self._last_cleanup = time.time()
        imported = 0
        if legacy_jsonl and os.path.exists(legacy_jsonl):
            try:
                imported = self.import_jsonl(legacy_jsonl)
            except (OSError, sqlite3.Error):
                imported = 0
        self.imported_count = imported
        self.cleanup()

    def record(self, entry, *, level=None):
        """Append one trace entry dict (legacy JSONL line shape)."""
        if not isinstance(entry, dict):
            return
        kind = _entry_kind(entry)
        ts = _entry_ts(entry.get("time"))
        if ts is None:
            ts = time.time()
            entry = dict(entry)
            entry["time"] = ts
        job_id = str(entry.get("job_id") or "")
        source = str(entry.get("source") or "")
        resolved_level = classify_level(kind, level)
        payload = json.dumps(entry, ensure_ascii=False)
        with self._lock:
            self._conn.execute(
                "INSERT INTO trace_events (ts, level, kind, source, job_id, data) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (ts, resolved_level, kind, source, job_id, payload),
            )
            self._conn.commit()
            self._maybe_cleanup_unlocked()

    def tail(self, limit=20, *, kind=None, level=None, job_id=None, since=None):
        """Return the newest matching entries, oldest-first (legacy shape)."""
        try:
            limit = max(1, min(int(limit), 1000))
        except (TypeError, ValueError):
            limit = 20
        clauses, params = [], []
        if kind:
            clauses.append("kind = ?")
            params.append(str(kind))
        if level:
            clauses.append("level = ?")
            params.append(str(level))
        if job_id:
            clauses.append("job_id = ?")
            params.append(str(job_id))
        if since is not None:
            clauses.append("ts >= ?")
            params.append(float(since))
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        query = (
            "SELECT kind, data FROM trace_events" + where +
            " ORDER BY id DESC LIMIT ?"
        )
        params.append(limit)
        with self._lock:
            rows = self._conn.execute(query, params).fetchall()
        entries = []
        for kind, payload in reversed(rows):
            try:
                parsed = json.loads(payload)
            except ValueError:
                continue
            if kind and not parsed.get("kind"):
                parsed["kind"] = kind
            entries.append(parsed)
        return entries

    def cleanup(self, *, now=None):
        """Delete debug events older than debug_ttl and everything past default_ttl."""
        now = time.time() if now is None else float(now)
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM trace_events "
                "WHERE (level = 'debug' AND ts <= ?) OR ts <= ?",
                (now - self.debug_ttl, now - self.default_ttl),
            )
            self._conn.commit()
            return cursor.rowcount

    def import_jsonl(self, path, *, archive=True):
        """Import a legacy JSONL trace file, then rename it aside."""
        entries = []
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    entries.append(parsed)
        if entries:
            rows = []
            for entry in entries:
                kind = _entry_kind(entry)
                ts = _entry_ts(entry.get("time")) or time.time()
                rows.append((
                    ts,
                    classify_level(kind),
                    kind,
                    str(entry.get("source") or ""),
                    str(entry.get("job_id") or ""),
                    json.dumps(entry, ensure_ascii=False),
                ))
            with self._lock:
                self._conn.executemany(
                    "INSERT INTO trace_events (ts, level, kind, source, job_id, data) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    rows,
                )
                self._conn.commit()
        if archive:
            self._archive(path)
        return len(entries)

    def _archive(self, path):
        base = path + ".imported"
        target = base
        counter = 1
        while os.path.exists(target):
            target = f"{base}-{counter}"
            counter += 1
        os.replace(path, target)

    def _maybe_cleanup_unlocked(self):
        now = time.time()
        if now - self._last_cleanup >= CLEANUP_INTERVAL:
            self._last_cleanup = now
            self._conn.execute(
                "DELETE FROM trace_events "
                "WHERE (level = 'debug' AND ts <= ?) OR ts <= ?",
                (now - self.debug_ttl, now - self.default_ttl),
            )
            self._conn.commit()

    def close(self):
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass
