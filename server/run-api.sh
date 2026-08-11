#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PHANTOM_RELAY_PYTHON:-$(command -v python3)}"
API="http://127.0.0.1:8765/health"

# Do not start duplicate API instances. Reuse the healthy listener.
if curl -fsS --max-time 2 "$API" >/dev/null 2>&1; then
  echo "Phantom Relay API already running on :8765"
  exit 0
fi

exec env PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" "$PYTHON" "$ROOT/server/api_server.py"
