#!/bin/bash
set -euo pipefail

# Phantom Relay browser wake helper for macOS.
# This is a one-shot compatibility hook. The API owns wake-up timing; this
# script must not become a polling daemon or keep a browser in the foreground.
# The bundle ID is an explicit local configuration value, never inferred from a
# process name.
ROOT="$(cd "$(dirname "$0")" && pwd)"
API="${PHANTOM_RELAY_API:-http://127.0.0.1:8765}"
CONFIG_FILE="${PHANTOM_RELAY_BROWSER_CONFIG:-$ROOT/browser-host.conf}"
BROWSER_BUNDLE_ID="${PHANTOM_RELAY_BROWSER_BUNDLE_ID:-}"
if [[ -z "$BROWSER_BUNDLE_ID" && -f "$CONFIG_FILE" ]]; then
  BROWSER_BUNDLE_ID="$(awk -F= '$1=="bundle_id" {print $2; exit}' "$CONFIG_FILE" | tr -d '[:space:]')"
fi
if [[ -z "$BROWSER_BUNDLE_ID" ]]; then
  echo "PHANTOM_RELAY_BROWSER_BUNDLE_ID is required; refusing to guess a browser" >&2
  exit 2
fi

pending="$(curl -fsS "$API/browser/pending-domains" 2>/dev/null || true)"
if [[ -z "$pending" || "$pending" == *'"jobs":[]'* ]]; then
  exit 0
fi

# -g prevents a background compatibility hook from repeatedly stealing focus.
target_url="${PHANTOM_RELAY_BROWSER_TARGET_URL:-}"
if [[ -z "$target_url" ]]; then
  echo "browser_target_url_required: refusing to open a blank browser tab" >&2
  exit 2
fi
open -g -b "$BROWSER_BUNDLE_ID" "$target_url"
