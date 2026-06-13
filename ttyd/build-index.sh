#!/usr/bin/env bash
# Regenerate ttyd/index.html = ttyd's stock web UI + our touch-scroll shim.
# Run this after installing or upgrading ttyd (the bundle is pinned to the
# ttyd build it was generated from). Self-contained: spins up a throwaway ttyd
# on a scratch port, grabs its stock index, injects shim.html, writes index.html.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-7799}"

command -v ttyd >/dev/null || { echo "ttyd not found in PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found in PATH" >&2; exit 1; }

# Stock ttyd on a scratch port so we always inject into a clean bundle.
ttyd --port "$PORT" --interface 127.0.0.1 sh -c 'sleep 3600' &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
sleep 1

curl -fsS --max-time 8 "http://127.0.0.1:$PORT/" -o "$HERE/.ttyd-stock.html"
node "$HERE/inject.js" "$HERE/.ttyd-stock.html" "$HERE/shim.html" "$HERE/index.html"
rm -f "$HERE/.ttyd-stock.html"
echo "[build-index] done — ttyd/index.html regenerated"
