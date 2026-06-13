#!/usr/bin/env bash
# Install the Claude Session Manager as an auto-starting service.
#   macOS  -> launchd  (per-user LaunchAgent)
#   Linux  -> systemd  (system service, e.g. OpenMediaVault)
#
# Config via environment (all optional):
#   DEV_ROOT    dev folder to expose      (default: $HOME/StudioProjects)
#   PORT        web UI / API port         (default: 3000)
#   TTYD_PORT   ttyd terminal port        (default: 7681)
#
# Usage:
#   ./install-service.sh            install + start
#   ./install-service.sh uninstall  stop + remove
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/run.sh"
chmod +x "$RUN"

DEV_ROOT="${DEV_ROOT:-$HOME/StudioProjects}"
PORT="${PORT:-3000}"
TTYD_PORT="${TTYD_PORT:-7681}"

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
    return
  fi

  $SUDO tee "$unit" >/dev/null <<UNIT
[Unit]
Description=Claude Code Session Manager
After=network.target

[Service]
Type=simple
User=${SUDO_USER:-$USER}
Environment=DEV_ROOT=${DEV_ROOT}
Environment=PORT=${PORT}
Environment=TTYD_PORT=${TTYD_PORT}
ExecStart=/bin/bash ${RUN}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now claude-sessions.service
  echo "Installed + started systemd service: claude-sessions"
  echo "  UI:    http://localhost:${PORT}"
  echo "  logs:  journalctl -u claude-sessions -f"
  echo "  stop:  $SUDO systemctl stop claude-sessions"
}

# --------------------------------------------------------------------------
# ensure backend deps present
if [ ! -d "$HERE/backend/node_modules" ]; then
  echo "Installing backend dependencies…"
  ( cd "$HERE/backend" && npm install --omit=dev )
fi

case "$OS" in
  Darwin) install_macos ;;
  Linux)  install_linux ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac
