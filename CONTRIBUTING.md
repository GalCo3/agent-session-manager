# Contributing

Thanks for your interest! This is a small, dependency-light project — keep it
that way.

## Project layout
See the **Files** section of the [README](README.md). In short:
- `backend/server.js` — all API logic (Express + tmux via `execFile`).
- `frontend/` — static, no build step. One concern per `js/*.js` module;
  `main.js` wires them together.
- `ttyd/` — patched ttyd UI bundle + touch-scroll shim.

## Dev loop
```bash
cd backend && npm install && cd ..
./run.sh                       # ttyd + node, foreground; Ctrl-C stops both
```
- **Editing anything under `frontend/`** → just reload the browser (no restart).
- **Editing `backend/server.js`** → restart the process (Ctrl-C + `./run.sh`,
  or `systemctl restart claude-sessions` / reload the launchd plist).

Requirements (`node`, `tmux`, `ttyd`, `claude`) must be on `PATH`; `claude` must
be logged in on the host.

## Conventions
- **Build-free frontend.** Vanilla ES modules — no framework, no bundler, no new
  runtime deps. The only backend dep is `express`; don't add more without a
  strong reason.
- **Match existing style.** Design tokens as CSS custom properties in `:root`;
  SVG icons inline (no emoji); 44px+ touch targets; respect
  `prefers-reduced-motion`.
- **Security is not optional.** Sanitize every session/folder name to
  `[A-Za-z0-9_-]` (`sanitize()` in `server.js`) before it touches a shell/tmux
  command. HTML-escape (`esc()`) any session-derived string rendered in the DOM.
  Re-validate any client-supplied parent/cwd against the configured parent list.
- **Don't reintroduce Docker** without solving host tmux-socket + auth sharing
  (see README).
- **Don't add a state file** for offline sessions — Claude's per-cwd history is
  the source of truth and already survives restarts.
- After upgrading the pinned ttyd, regenerate `ttyd/index.html` with
  `ttyd/build-index.sh`.

## Pull requests
- One focused change per PR. Describe what and why.
- Test manually on both a desktop browser and a phone-width viewport if the
  change touches the UI.
- No CI yet — please note in the PR how you verified.

## Reporting issues
Include OS, node/tmux/ttyd versions, and steps to reproduce. For anything
security-related (auth bypass, command injection, path traversal), please open
a private report rather than a public issue if possible.
