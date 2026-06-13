#!/usr/bin/env bash
# Start the Claude Session Manager natively: ttyd (browser terminal) in the
# background, then the Node API/UI server in the foreground. When the server
# exits, ttyd is torn down too, so a service supervisor can cleanly restart
# the whole thing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- config (override via environment) -------------------------------------
export DEV_ROOT="${DEV_ROOT:-$HOME/StudioProjects}"
export PORT="${PORT:-3000}"
export TTYD_PORT="${TTYD_PORT:-7681}"
# SECURITY: bind loopback by default — the terminal is an unauthenticated shell
# into the host. Reach it from other devices via `tailscale serve` (set up by
# install-service.sh) or an SSH tunnel. BIND_ADDR=0.0.0.0 re-opens it to the
# whole LAN; only do that behind a VPN/reverse-proxy that adds auth.
export BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
# tmux socket used by the API and by ttyd's attach command. Native = host tmux.
TMUX_SOCKET="${TMUX_SOCKET:-/tmp/tmux-0}"

# Make sure node / ttyd / tmux / claude are findable under launchd/systemd,
# which start with a minimal PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

command -v ttyd >/dev/null || { echo "ttyd not found in PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found in PATH" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux not found in PATH" >&2; exit 1; }

echo "[run] DEV_ROOT=$DEV_ROOT PORT=$PORT TTYD_PORT=$TTYD_PORT socket=$TMUX_SOCKET"

# --- ttyd ------------------------------------------------------------------
# --url-arg is required so the ?arg=<tmux attach cmd> query is honored.
# --index serves our patched UI (ttyd's stock bundle + a touch-scroll shim;
# regenerate with ttyd/build-index.sh after upgrading ttyd).
# sh -c 'exec $1' word-splits the single arg back into argv and execs tmux.
ttyd \
  --port "$TTYD_PORT" \
  --interface "$BIND_ADDR" \
  --writable \
  --url-arg \
  --max-clients 0 \
  --index "$HERE/ttyd/index.html" \
  sh -c 'exec $1' ttyd-cmd &
TTYD_PID=$!

# --- node API/UI -----------------------------------------------------------
node "$HERE/backend/server.js" &
NODE_PID=$!

# Tear down both children on exit / signal so the supervisor restarts cleanly.
cleanup() { kill "$TTYD_PID" "$NODE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Exit when the server exits (its status becomes this script's status).
wait "$NODE_PID"
