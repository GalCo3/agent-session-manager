# Claude Code Session Manager

Mobile-friendly web UI to manage [Claude Code](https://claude.com/claude-code)
sessions running inside `tmux`. List, create, kill, and open an in-browser
terminal for each session — from your phone or any browser. Runs **natively**
(no Docker) and can install itself as an auto-starting service.

![stack](https://img.shields.io/badge/node-express-339933) ![term](https://img.shields.io/badge/terminal-ttyd-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

<!-- Screenshots: drop PNGs into docs/screenshots/ (see that folder's README). -->
<p align="center">
  <img src="docs/screenshots/sessions.png" alt="Session list" width="30%">
  <img src="docs/screenshots/create.png" alt="Create session" width="30%">
  <img src="docs/screenshots/terminal.png" alt="In-browser terminal" width="30%">
</p>

> [!WARNING]
> **This grants shell access to anyone who can reach the port — read [Security](#security) before exposing it.**
> The in-browser terminal attaches to `claude` running on the host with **no
> authentication**, and the server binds all interfaces (`0.0.0.0`) by default.
> On a trusted LAN that's convenient; on an open network it's remote code
> execution. Bind to localhost and tunnel, or put it behind a VPN/reverse proxy
> with auth.

## Features
- **List sessions** — name, working folder, age, running/idle, attached
- **Create a session** — pick a parent → folder → name; launches
  `claude --permission-mode auto --remote-control <name>`. Name optional
  (auto-derived from Claude's session title, else the folder name).
- **Kill sessions** — single or bulk multiselect, with confirmation
- **In-browser terminal** — full `tmux` attach per session via
  [ttyd](https://github.com/tsl0922/ttyd), patched for one-finger touch scroll
- **Wake offline sessions** — after a host/service restart wipes tmux, recreate
  a session from Claude's own per-cwd history and `--continue` the latest convo
- **Parent folders** — configure a list of directories whose subdirs are
  session targets, via a built-in host directory browser (settings sheet)
- **Create subfolders** on the fly under any configured parent
- **Usage strip** — 5-hour / 7-day Claude usage; per-session context-window meter
- **Auto-refresh every 5s** — re-renders only on real changes (no flicker)

## Why native (not Docker)
Sessions are **real host tmux sessions**, so `claude` runs on the host using the
host's existing auth (macOS Keychain / Linux `~/.claude`). No re-login, no
container isolation. Docker was dropped for exactly this reason — on macOS the
container can't reach the host tmux socket or Keychain.

## Requirements
Install once (all must be on `PATH`):

| Tool | macOS | Linux (Debian/OMV) |
|------|-------|--------------------|
| node (≥18) | `brew install node` | `apt install nodejs npm` |
| tmux | `brew install tmux` | `apt install tmux` |
| ttyd | `brew install ttyd` | [static binary](https://github.com/tsl0922/ttyd/releases) |
| claude | `npm i -g @anthropic-ai/claude-code` | same |

Claude must be authenticated on the host: run `claude` once and log in.

## Install & run

```bash
git clone https://github.com/GalCo3/ClaudeCodeManager.git
cd ClaudeCodeManager/backend && npm install && cd ..
```

### As a service (recommended)
Auto-detects macOS (launchd) or Linux (systemd):

```bash
./install-service.sh
```

- macOS → per-user LaunchAgent `com.claude.sessions`, logs in `./logs/`
- Linux → system service `claude-sessions`, logs via `journalctl -u claude-sessions -f`

Uninstall: `./install-service.sh uninstall`

### Manually (foreground, for dev)
```bash
./run.sh
```
Starts ttyd + the Node server; Ctrl-C tears both down.

Open **http://localhost:3000** (or `http://<host-ip>:3000` from your phone — but
see [Security](#security) first). On first run the parent-folders list is
**empty**: open settings (gear icon) and add a parent directory to start
creating sessions.

## Security
This app is a remote terminal into your host. Treat it accordingly.

- **No built-in auth.** Any client that can reach the web port (`3000`) or the
  ttyd port (`7681`) can create/kill sessions and type into a live `claude`
  shell on your machine. ttyd runs `--writable` on `--interface 0.0.0.0`, and
  the API server binds `0.0.0.0` too.
- **The directory browser roams the whole host filesystem** by design, so the
  UI can pick parent folders. Session/folder *names* are sanitized to
  `[A-Za-z0-9_-]` before being interpolated into tmux/shell commands, but the
  browse endpoint enumerates arbitrary directory names to whoever is connected.
- **Recommended deployments:**
  - **Localhost only + SSH tunnel** — access via
    `ssh -L 3000:localhost:3000 -L 7681:localhost:7681 host`. Safest.
  - **VPN** (Tailscale/WireGuard) — reach it only from your own devices.
  - **Reverse proxy with auth** (nginx/Caddy basic-auth or an SSO proxy) in
    front of both ports.
- **Do not expose ports 3000/7681 to the public internet.** There is no
  rate-limiting, CSRF protection, or login.

If you harden the bind address or add auth, PRs welcome.

## Configuration
Environment variables (defaults shown):

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | web UI + API port |
| `TTYD_PORT` | `7681` | ttyd terminal port |
| `DEV_ROOT` | `$HOME/StudioProjects` | only seeds the directory browser's default start dir (not the folder root) |
| `CONTEXT_LIMIT` | `200000` | model context window in tokens, for the per-session meter (set `1000000` for 1M-context) |
| `TMUX_SOCKET` | `/tmp/tmux-0` | shared tmux socket (`run.sh` only) |

Durable app state is a single file: the parent-folders list at
`~/.config/claude-sessions/config.json` (`{ "parents": [...] }`), written
atomically when you add/remove a parent in the UI.

## API
All names are sanitized to `[A-Za-z0-9_-]`; every folder/session endpoint
re-validates `parent` against the configured parent list.

| Method | Path | Body / query | Result |
|--------|------|--------------|--------|
| GET | `/api/sessions` | — | live sessions (name, cwd, created, attached, hasClaudeCode) |
| POST | `/api/sessions` | `{parent, folder, name?}` | create session + launch claude |
| DELETE | `/api/sessions/:name` | — | kill session |
| GET | `/api/sessions/:name/terminal` | — | `{url}` ttyd link |
| GET | `/api/sessions/offline` | — | woke-able sessions mined from Claude history |
| POST | `/api/sessions/:name/wake` | `{cwd}` | recreate session + `claude --continue` |
| GET | `/api/parents` | — | configured parent dirs |
| POST | `/api/parents` | `{path}` | add a parent dir |
| DELETE | `/api/parents` | `{path}` | remove a parent dir |
| GET | `/api/browse` | `?path=` | list subdirs (host directory browser) |
| GET | `/api/folders` | `?parent=` | subdirs of a parent |
| GET | `/api/folders/suggested-name` | `?parent=&folder=` | suggested session name |
| POST | `/api/folders` | `{parent, name}` | create subdir |
| GET | `/api/usage` | — | Claude 5h / 7d usage |

## Files
```
backend/server.js     Express REST API + static file server (all API logic)
backend/package.json  only dep: express
frontend/index.html   markup; loads the CSS + js/main.js (ES module)
frontend/css/         styles.css (warm amber/indigo dark theme, design tokens)
frontend/js/          vanilla ES modules — no framework, no bundler:
                        main.js      entry: init + shared overlay/key wiring
                        api.js       REST client
                        utils.js     $, esc, age, flash, icons
                        sessions.js  session list + poll loop
                        selection.js multiselect + bulk bar
                        create.js    new-session sheet + folders
                        dialog.js    kill confirm (single + bulk)
                        offline.js   wake-offline-sessions sheet
                        terminal.js  in-browser terminal modal
                        usage.js     usage strip + context meter
                        settings.js  parent-folders settings + directory browser
ttyd/                 patched ttyd UI (stock bundle + touch-scroll shim);
                        regenerate index.html with build-index.sh after upgrades
run.sh                start ttyd + node natively
install-service.sh    install/uninstall as launchd (macOS) or systemd (Linux)
```

The frontend has **no build step**: browsers load the ES modules directly and
Express serves `frontend/` statically. Edit a file, reload the browser. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting
- **Terminal opens then closes immediately** — ttyd needs `--url-arg` (set in `run.sh`).
- **Session shows `idle` while claude is running** — claude renames its process
  title to its version string; detection treats any non-shell pane as running.
- **Remote-control session not in the Claude app** — the host `claude` must be
  logged in (`claude` once interactively). Sessions launch with `--remote-control`.
- **Wrong session names / empty cwd** — some tmux builds (3.3a) mangle literal
  tabs in `-F` output; the server uses `|` as the field separator.
- **Parent-folders list empty / can't create sessions** — add a parent dir in
  the settings sheet first; the list starts empty.

## License
[MIT](LICENSE) © GalCo3
