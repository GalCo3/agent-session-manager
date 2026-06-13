#!/usr/bin/env bash
# Install the Claude Session Manager as an auto-starting service.
#   macOS  -> launchd  (per-user LaunchAgent)
#   Linux  -> systemd  (system service, e.g. OpenMediaVault)
#
# Config via environment (all optional):
#   DEV_ROOT     dev folder to expose                  (default: $HOME/StudioProjects)
#   PORT         web UI / API port                     (default: 3000)
#   TTYD_PORT    ttyd terminal port                    (default: 7681)
#   BIND_ADDR    address services listen on            (default: 127.0.0.1, loopback)
#   TAILSCALE    auto|1|0 expose loopback ports over   (default: auto)
#                the tailnet via `tailscale serve`
#   LIMITED_USER 1 = run the Linux service as a        (default: 0)
#                dedicated keyless user (Layer B)
#   SERVICE_USER_NAME  name of that user               (default: claude-web)
#
# SECURITY: services bind loopback (BIND_ADDR=127.0.0.1) so the unauthenticated
# terminal is NOT exposed to the LAN. Remote access is meant to go over Tailscale
# (`tailscale serve`, set up below) or an SSH tunnel. Setting BIND_ADDR=0.0.0.0
# re-opens every interface — only do that behind a VPN/reverse-proxy that adds auth.
#
# Usage:
#   ./install-service.sh                       install + start (loopback + tailscale)
#   LIMITED_USER=1 ./install-service.sh        also run service as keyless claude-web user
#   TAILSCALE=0 ./install-service.sh           skip tailnet setup (localhost/SSH-tunnel only)
#   ./install-service.sh uninstall             stop + remove
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/run.sh"
chmod +x "$RUN"

DEV_ROOT="${DEV_ROOT:-$HOME/StudioProjects}"
PORT="${PORT:-3000}"
TTYD_PORT="${TTYD_PORT:-7681}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
TAILSCALE="${TAILSCALE:-auto}"
LIMITED_USER="${LIMITED_USER:-0}"
SERVICE_USER_NAME="${SERVICE_USER_NAME:-claude-web}"

LABEL="com.claude.sessions"
ACTION="${1:-install}"
OS="$(uname -s)"

# --------------------------------------------------------------------------
install_macos() {
  local plist="$HOME/Library/LaunchAgents/${LABEL}.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HERE/logs"

  if [ "$ACTION" = "uninstall" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "Removed launchd service: $LABEL"
    return
  fi

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${RUN}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEV_ROOT</key><string>${DEV_ROOT}</string>
    <key>PORT</key><string>${PORT}</string>
    <key>TTYD_PORT</key><string>${TTYD_PORT}</string>
    <key>BIND_ADDR</key><string>${BIND_ADDR}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HERE}/logs/service.log</string>
  <key>StandardErrorPath</key><string>${HERE}/logs/service.err.log</string>
</dict>
</plist>
PLIST

  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "Installed + started launchd service: $LABEL"
  echo "  UI:    http://localhost:${PORT}"
  echo "  logs:  $HERE/logs/service.log"
  echo "  stop:  launchctl unload \"$plist\""
}

# --------------------------------------------------------------------------
install_linux() {
  local unit="/etc/systemd/system/claude-sessions.service"
  local SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

  if [ "$ACTION" = "uninstall" ]; then
    $SUDO systemctl disable --now claude-sessions.service 2>/dev/null || true
    $SUDO rm -f "$unit"
    $SUDO systemctl daemon-reload
    echo "Removed systemd service: claude-sessions"
    echo "  (the '${SERVICE_USER_NAME}' user, if created, is left in place — remove with: $SUDO userdel -r ${SERVICE_USER_NAME})"
    return
  fi

  # Layer B (opt-in): run the service as a dedicated keyless user so that even if
  # someone escapes claude to a shell, they land as an unprivileged user with no
  # ssh keys and no sudo — not as you. Off by default (keeps the current user's
  # claude auth + parent-folders config); turn on with LIMITED_USER=1.
  local RUN_AS="${SUDO_USER:-$USER}"
  if [ "$LIMITED_USER" = "1" ]; then
    RUN_AS="$SERVICE_USER_NAME"
    if ! id "$RUN_AS" >/dev/null 2>&1; then
      echo "Creating keyless service user '$RUN_AS'…"
      $SUDO useradd --system --create-home --shell /bin/bash "$RUN_AS"
    fi
  fi

  $SUDO tee "$unit" >/dev/null <<UNIT
[Unit]
Description=Claude Code Session Manager
After=network.target

[Service]
Type=simple
User=${RUN_AS}
Environment=DEV_ROOT=${DEV_ROOT}
Environment=PORT=${PORT}
Environment=TTYD_PORT=${TTYD_PORT}
Environment=BIND_ADDR=${BIND_ADDR}
ExecStart=/bin/bash ${RUN}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now claude-sessions.service
  echo "Installed + started systemd service: claude-sessions (User=${RUN_AS})"
  echo "  UI:    http://${BIND_ADDR}:${PORT}  (loopback — reach remotely via Tailscale/SSH tunnel)"
  echo "  logs:  journalctl -u claude-sessions -f"
  echo "  stop:  $SUDO systemctl stop claude-sessions"

  if [ "$LIMITED_USER" = "1" ]; then
    cat <<NOTE

  ── Layer B follow-ups (required for '${RUN_AS}') ───────────────────────────
  The service now runs as '${RUN_AS}', which has its OWN home, claude auth, and
  parent-folders config — so it starts fresh. Do these once:
    1. Log claude in as that user:   $SUDO -u ${RUN_AS} -H claude   (then /login)
    2. Grant it access to each working-folder parent you'll use, e.g.:
         $SUDO setfacl -R -m u:${RUN_AS}:rwx /path/to/parent
         $SUDO setfacl -R -d -m u:${RUN_AS}:rwx /path/to/parent   # inherit on new files
       (or chown/chgrp the dirs to ${RUN_AS}, or add ${RUN_AS} to a shared group)
    3. Ensure node/ttyd/tmux/claude are on a system PATH that '${RUN_AS}' sees
       (run.sh exports a sane PATH; nvm/per-user installs won't be visible).
    4. Re-add your parent folders in the UI settings sheet (config is per-user).
  ────────────────────────────────────────────────────────────────────────────
NOTE
  fi
}

# --------------------------------------------------------------------------
# Layer A remote access: expose the loopback-bound ports over the tailnet ONLY,
# via `tailscale serve --tcp`. Traffic rides the WireGuard tunnel (encrypted);
# the LAN/internet still can't reach the ports. `serve` config persists in
# tailscaled across reboots, so this is a one-time setup. We forward raw TCP
# (not TLS-terminated) so the existing http://host:PORT two-origin UI + ttyd
# websocket work unchanged.
setup_tailscale() {
  case "$TAILSCALE" in 0|no|false) return 0 ;; esac

  local TS="tailscale"
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null; then TS="sudo tailscale"; fi

  if ! command -v tailscale >/dev/null 2>&1; then
    [ "$TAILSCALE" = "auto" ] || echo "TAILSCALE=$TAILSCALE but tailscale not found." >&2
    echo "• Tailscale not installed — services stay loopback-only."
    echo "  To reach the UI from your phone: install Tailscale (https://tailscale.com/download),"
    echo "  run '$TS up', then re-run this installer (or set TAILSCALE=0 to silence this)."
    return 0
  fi

  if [ "$ACTION" = "uninstall" ]; then
    $TS serve --tcp="$PORT" off 2>/dev/null || true
    $TS serve --tcp="$TTYD_PORT" off 2>/dev/null || true
    echo "Removed tailscale serve forwards for :$PORT and :$TTYD_PORT"
    return 0
  fi

  if ! tailscale status >/dev/null 2>&1; then
    echo "• Tailscale installed but not logged in — skipping tailnet exposure."
    echo "  Run '$TS up', then re-run this installer."
    return 0
  fi

  $TS serve --bg --tcp="$PORT"      "tcp://127.0.0.1:$PORT"      >/dev/null
  $TS serve --bg --tcp="$TTYD_PORT" "tcp://127.0.0.1:$TTYD_PORT" >/dev/null

  local dns
  dns="$(tailscale status --json 2>/dev/null \
         | grep -o '"DNSName":"[^"]*"' | head -1 \
         | sed 's/.*:"//; s/".*//; s/\.$//')"
  [ -n "$dns" ] || dns="<your-tailnet-host>"
  echo "• Tailscale serve: tailnet → 127.0.0.1:$PORT and :$TTYD_PORT"
  echo "  Reach the UI at  http://${dns}:${PORT}  from any device on your tailnet."
}

# --------------------------------------------------------------------------
# ensure backend deps present
if [ ! -d "$HERE/backend/node_modules" ] && [ "$ACTION" != "uninstall" ]; then
  echo "Installing backend dependencies…"
  ( cd "$HERE/backend" && npm install --omit=dev )
fi

case "$OS" in
  Darwin) install_macos ;;
  Linux)  install_linux ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

setup_tailscale
