# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is
A small web app to manage `tmux` sessions that run Claude Code, from a phone
or desktop browser. Node/Express backend serves a REST API + a single-file
frontend; `ttyd` provides in-browser terminals. Originally targeted
OpenMediaVault; now runs **natively** (Docker was removed).

## Architecture
```
browser ──HTTP──> Express (backend/server.js, :3000)
   │                 ├── REST /api/* (sessions, folders, parents, browse)
   │                 └── static frontend/index.html
   └──WS──> ttyd (:7681) ── attaches to a tmux session via ?arg=
                 tmux (shared socket /tmp/tmux-0) ── runs `claude` per session
```
- Sessions are **real host tmux sessions** on socket `/tmp/tmux-0`. `claude`
  runs on the host with host auth — no container, no separate login.
- `run.sh` supervises both processes (ttyd background, node foreground).
- `install-service.sh` installs a launchd (macOS) or systemd (Linux) service.

## Files
- `backend/server.js` — all API logic. tmux invoked via `execFile` on the
  shared socket. State lives in tmux; the only persisted config is the
  parent-folders list (`~/.config/claude-sessions/config.json`).
- `backend/package.json` — only dep is `express`.
- `frontend/` — static, no build step, no framework. Mobile-first.
  - `index.html` — markup only; loads the CSS and `js/main.js` (an ES module).
  - `css/styles.css` — all styles; design tokens in `:root`.
  - `js/` — vanilla ES modules (native `import`/`export`, no bundler):
    `main.js` (entry/init), `api.js` (REST client), `utils.js` (`$`/`esc`/
    `age`/`flash`/icons), `sessions.js` (list + poll), `selection.js`
    (multiselect), `create.js` (new-session sheet), `dialog.js` (kill confirm),
    `offline.js` (wake-offline-sessions sheet), `terminal.js` (terminal modal),
    `usage.js` (usage strip), `settings.js` (parent-folders settings sheet +
    directory browser).
- `run.sh` / `install-service.sh` — native run + service install.

## Running / testing
- Service: `DEV_ROOT=/path ./install-service.sh` (auto-detects OS).
- Foreground dev: `DEV_ROOT=/path ./run.sh`.
- The frontend is served statically — editing any file under `frontend/`
  needs only a browser reload, no restart. Editing `server.js` needs a process restart
  (`launchctl unload/load` the plist, or `systemctl restart claude-sessions`,
  or re-run `run.sh`).
- macOS service logs: `./logs/service.log`. Linux: `journalctl -u claude-sessions`.

## Conventions
- Keep the frontend **build-free**: vanilla ES modules, no framework, no deps,
  no bundler. One concern per `js/*.js` file; `main.js` wires them together.
- Match existing style: design tokens as CSS custom properties; SVG icons
  inline (no emoji); 44px+ touch targets; `prefers-reduced-motion` respected.
- Sanitize every session/folder name to `[A-Za-z0-9_-]` before use — they get
  interpolated into shell/tmux commands (`sanitize()` in server.js).
- HTML-escape any session-derived string rendered in the DOM (`esc()`).

## Non-obvious gotchas (don't regress these)
- **Parent folders, not a single DEV_ROOT.** Working folders live under a
  user-configurable *list* of parent dirs, persisted to
  `~/.config/claude-sessions/config.json` (`{ "parents": [...] }`) — the one
  bit of durable app state (loaded at boot, atomic-rewritten on each change).
  Starts empty; the user adds parents via the settings sheet's directory
  browser. `DEV_ROOT` is **no longer the folder root** — it only seeds the
  browser's default start dir (when it's a real dir). `parentOf(cwd)` (replaces
  the old `folderOf`) checks a cwd is directly under *some* configured parent;
  it guards offline listing + wake, and every folder/session endpoint re-checks
  its `parent` against the configured list (client can't read/write outside).
- **`/api/browse` enumerates the host filesystem** to the (localhost) UI by
  design — roams anywhere. Parent paths are validated abs+exists+dir before
  save; folder names still `sanitize()`d before tmux interpolation.
- **ttyd `--url-arg` is mandatory.** Without it ttyd ignores `?arg=` and the
  terminal launches an empty command, closing instantly (WS code 1000).
- **Patched ttyd UI for mobile scroll.** ttyd's bundled xterm.js has no
  one-finger touch scroll. `run.sh` serves `ttyd/index.html` via `--index` —
  ttyd's stock bundle (inlined, ~730KB, version-pinned to ttyd 1.7.7) plus a
  touch-drag-to-scroll shim (`ttyd/shim.html`). After upgrading ttyd, run
  `ttyd/build-index.sh` to regenerate it, or the UI may break.
- **tmux `-F` tab mangling.** Some tmux builds (3.3a) turn literal tabs in
  format output into other chars. The session list uses `|` as the field
  separator, not `\t`.
- **claude process-title rename.** Claude Code renames its process title to its
  version string (e.g. `2.1.168`), so you can't grep for "claude". `hasClaudeCode`
  is computed as "pane command is not a plain shell".
- **Remote control.** Sessions launch `claude --remote-control <session-name>`
  so they appear in the Claude mobile/web app — requires host claude logged in.
- **Waking offline sessions.** A host/service restart wipes the tmux server, so
  all live sessions vanish. There's no app DB — the source of truth for "what
  existed" is Claude's own per-cwd history: `~/.claude/projects/<dir>/<id>.jsonl`.
  `GET /api/sessions/offline` mines that (reads the real `cwd` out of the newest
  transcript — decoding the dashed dir name is ambiguous since folder names also
  contain dashes), keeps cwds under any configured parent with no live session, and
  `POST /api/sessions/:name/wake` recreates the tmux session + `claude --continue`
  (resumes the latest conversation). Don't add a state file for this — the
  history already survives restarts.
- **Docker is intentionally gone.** On macOS a container can't share the host
  tmux socket (Linux VM) or read host auth (Keychain). Don't reintroduce it
  without solving host-session sharing.

## Communication style
The maintainer uses "caveman mode" (terse). Code, commits, and security notes
stay written normally; prose can be compressed.
