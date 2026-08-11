#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="${TMPDIR:-/tmp}/phantom-relay-browser-host.log"
PID="${TMPDIR:-/tmp}/phantom-relay-browser-host.pid"
PYTHON="${PHANTOM_RELAY_PYTHON:-$(command -v python3)}"
# A killed browser must stay killed. Restarting a browser from a test harness
# is an explicit opt-in because it can recreate the visible about:blank race
# the harness is meant to diagnose. Product activation remains API-owned.
MAX_RESTARTS="${PHANTOM_RELAY_HOST_MAX_RESTARTS:-0}"
RESTART_DELAY="${PHANTOM_RELAY_HOST_RESTART_DELAY:-2}"

# BiDi is test infrastructure, never the default product activation path.
# Refuse to start unless the caller explicitly makes it the sole owner.
if [[ "${PHANTOM_RELAY_ENABLE_BIDI_HOST:-0}" != "1" || "${PHANTOM_RELAY_ACTIVATION_OWNER:-}" != "bidi" || "${PHANTOM_RELAY_BIDI_NAVIGATION:-0}" != "1" ]]; then
  printf '%s\n' 'bidi_host_disabled: set PHANTOM_RELAY_ENABLE_BIDI_HOST=1 PHANTOM_RELAY_ACTIVATION_OWNER=bidi PHANTOM_RELAY_BIDI_NAVIGATION=1 for explicit test-harness use' >&2
  exit 0
fi

API="${PHANTOM_RELAY_API:-http://127.0.0.1:8765}"
api_health="$(curl -fsS --max-time 2 "$API/health" 2>/dev/null || true)"
case "$api_health" in
  *'"browser_activation_owner":"bidi"'*|*'"browser_activation_owner": "bidi"'*)
    ;;
  *'"browser_activation_owner"'*'"api"'*)
    printf '%s\n' 'bidi_api_owner_conflict: API owns browser activation; restart the API with PHANTOM_RELAY_ACTIVATION_OWNER=bidi for harness-only navigation' >&2
    exit 3
    ;;
  *)
    printf '%s\n' 'bidi_api_owner_unknown: API health must report browser_activation_owner=bidi before starting the harness' >&2
    exit 3
    ;;
esac

case "$MAX_RESTARTS" in
  ''|*[!0-9]*)
    echo "PHANTOM_RELAY_HOST_MAX_RESTARTS must be a non-negative integer" >&2
    exit 2
    ;;
esac

if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3)"
fi

if [ -f "$PID" ] && kill -0 "$(cat "$PID" 2>/dev/null || true)" 2>/dev/null; then
  exit 0
fi

export PHANTOM_RELAY_BROWSER_PROFILE="${PHANTOM_RELAY_BROWSER_PROFILE:-/tmp/phantom-relay-bidi-host}"
(
  trap 'rm -f "$PID"' EXIT INT TERM
  restart_count=0
  while [ "$restart_count" -le "$MAX_RESTARTS" ]; do
    if "$PYTHON" "$ROOT/scripts/bidi_browser_host.py" >>"$LOG" 2>&1; then
      exit_code=0
    else
      exit_code=$?
    fi
    [ "$exit_code" -eq 75 ] || exit "$exit_code"
    if [ "$restart_count" -eq "$MAX_RESTARTS" ]; then
      printf '%s\n' "host_restart_budget_exhausted max_restarts=$MAX_RESTARTS" >>"$LOG"
      exit "$exit_code"
    fi
    restart_count=$((restart_count + 1))
    sleep "$RESTART_DELAY"
  done
) >>"$LOG" 2>&1 &
echo $! >"$PID"
