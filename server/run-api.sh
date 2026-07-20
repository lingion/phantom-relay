#!/bin/bash
set -u
ROOT=/Users/lingion_k/Desktop/phantom-relay
PY=/Library/Frameworks/Python.framework/Versions/3.10/Resources/Python.app/Contents/MacOS/Python
API="http://127.0.0.1:8765/health"

# Do not start duplicate API instances. Reuse the healthy listener.
if curl -fsS --max-time 2 "$API" >/dev/null 2>&1; then
  echo "Phantom Relay API already running on :8765"
  exit 0
fi

exec "$PY" "$ROOT/server/api_server.py"
