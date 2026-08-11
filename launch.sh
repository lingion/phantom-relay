#!/bin/bash
set -euo pipefail

# Explicit, opt-in local launchd config for the API only.
# This file is not installed or loaded by the project automatically.
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec env PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" python3 "$ROOT/server/api_server.py"
