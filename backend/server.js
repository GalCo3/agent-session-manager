'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
// SECURITY: bind loopback by default. The terminal is an unauthenticated shell
// into the host, so it must not listen on the LAN. Reach it from other devices
// via `tailscale serve` (see install-service.sh) or an SSH tunnel. Setting
// BIND_ADDR=0.0.0.0 re-opens it to every host on the network — don't, unless
// something else (VPN/reverse-proxy auth) is gating access.
const BIND_ADDR = process.env.BIND_ADDR || '127.0.0.1';
// DEV_ROOT is no longer the folder root (see config below) — it's only the
// directory browser's default start dir when it's a real directory; otherwise
// browseDefault() falls back to the home dir.
const DEV_ROOT = process.env.DEV_ROOT || os.homedir();
const TTYD_PORT = parseInt(process.env.TTYD_PORT || '7681', 10);
// Model context window (tokens). Default 200k; override for 1M-context sessions.
const CONTEXT_LIMIT = parseInt(process.env.CONTEXT_LIMIT || '200000', 10);

const app = express();
app.use(express.json());

// --- helpers ---------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function sanitize(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || !NAME_RE.test(trimmed)) return null;
  return trimmed;
}

// Turn free text (e.g. Claude's auto-generated session title) into a valid
// session name: collapse anything outside [A-Za-z0-9_-] to dashes, then cap
// the length on a word (dash) boundary so tmux names stay sane. Null if empty.
function slugifyName(text) {
  if (typeof text !== 'string') return null;
  let slug = text.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (slug.length > 40) {
    slug = slug.slice(0, 40);
    const cut = slug.lastIndexOf('-');
    if (cut > 20) slug = slug.slice(0, cut);
    slug = slug.replace(/-+$/g, '');
  }
  return slug || null;
}

// Run a command, resolve { stdout, stderr, code }. Never rejects on non-zero.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

// tmux on the shared host socket (/tmp/tmux-0)
function tmux(args) {
  return run('tmux', ['-S', '/tmp/tmux-0', ...args]);
}

// --- config (parent folders) ----------------------------------------------
// Runtime-mutable list of absolute parent directories that hold session
// working folders. Persisted to ~/.config/claude-sessions/config.json so it
// survives restarts. Cached in-process; reloaded on every mutation. Starts
// empty — the user adds parents via the settings UI (no DEV_ROOT seed).

const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-sessions');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let config = { parents: [] };

async function loadConfig() {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    const parents = Array.isArray(parsed.parents)
      ? parsed.parents.filter((p) => typeof p === 'string')
      : [];
    config = { parents };
  } catch (_) {
    config = { parents: [] }; // missing or corrupt => empty
  }
  return config;
}

// Atomic write (tmp + rename) so a crash mid-write can't corrupt the config.
async function saveConfig() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(config, null, 2));
  await fs.rename(tmp, CONFIG_FILE);
}

const getParents = () => config.parents;

// If `cwd` sits directly under one configured parent, return { parent, folder }
// (folder = the top-level subdir name). Else null. Replaces the old single-
// DEV_ROOT folderOf — guards offline listing + wake against arbitrary client
// dirs now that there are multiple parents.
function parentOf(cwd) {
  for (const parent of getParents()) {
    const rel = path.relative(parent, cwd);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return { parent, folder: rel.split(path.sep)[0] };
  }
  return null;
}

// Default start dir for the directory browser: DEV_ROOT if it's a real dir,
// else the user's home.
async function browseDefault() {
  const st = await fs.stat(DEV_ROOT).catch(() => null);
  return st && st.isDirectory() ? DEV_ROOT : os.homedir();
}

// --- context window --------------------------------------------------------
// Per-session "context left", like the desktop app. Claude's transcript records
// token usage on every assistant message; the latest main-chain assistant
// message's input+cache tokens = what's currently loaded into the context
// window. We mine the same per-cwd history used to wake offline sessions.

// cwd -> Claude's project dir name: every non-alphanumeric char becomes a dash
// (matches how Claude Code encodes the path). Deterministic, so no scan needed.
function projectDirFor(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// Newest .jsonl transcript in `dir` (its mtime = last active), or null.
async function newestTranscript(dir) {
  let files;
  try { files = await fs.readdir(dir); } catch (_) { return null; }
  let newest = null;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    const st = await fs.stat(fp).catch(() => null);
    if (st && (!newest || st.mtimeMs > newest.mtimeMs)) {
      newest = { path: fp, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
  return newest;
}

// Read the last `maxBytes` of a file. Transcripts grow without bound, but the
// latest usage sits near the end — reading the tail keeps the 5s poll cheap.
async function readTail(file, size, maxBytes) {
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// Tokens in the context window = the last main-chain (non-sidechain) assistant
// message's input + cache-read + cache-creation tokens. Scans lines from the
// end; a truncated first line (from tail-reading) just fails to parse, skipped.
function lastContextTokens(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || ln.indexOf('"usage"') < 0) continue;
    let d;
    try { d = JSON.parse(ln); } catch (_) { continue; }
    if (d.isSidechain) continue; // sub-agent turns don't touch the main window
    const m = d.message;
    const u = m && m.role === 'assistant' && m.usage;
    if (u && typeof u.input_tokens === 'number') {
      return (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0);
    }
  }
  return null;
}

const ctxCache = new Map(); // transcript path -> { mtimeMs, tokens }

// { tokens, limit } for the session running in `cwd`, or null if no transcript.
async function contextForCwd(cwd) {
  if (!cwd) return null;
  const dir = path.join(os.homedir(), '.claude', 'projects', projectDirFor(cwd));
  const newest = await newestTranscript(dir);
  if (!newest) return null;

  const cached = ctxCache.get(newest.path);
  let tokens;
  if (cached && cached.mtimeMs === newest.mtimeMs) {
    tokens = cached.tokens; // unchanged since last poll — skip the re-read
  } else {
    const text = await readTail(newest.path, newest.size, 512 * 1024).catch(() => null);
    tokens = text == null ? null : lastContextTokens(text);
    ctxCache.set(newest.path, { mtimeMs: newest.mtimeMs, tokens });
  }
  if (tokens == null) return null;
  return { tokens, limit: CONTEXT_LIMIT };
}

// --- sessions --------------------------------------------------------------

// List sessions with metadata. Determine cwd + whether claude runs per session.
async function listSessions() {
  // Use '|' as the field separator: tmux 3.3a mangles literal tabs in -F
  // output. Safe here — name is sanitized to [A-Za-z0-9_-] and the other
  // fields are numeric.
  const fmt = '#{session_name}|#{session_created}|#{session_attached}';
  const res = await tmux(['list-sessions', '-F', fmt]);
  if (res.code !== 0) {
    // No server running / no sessions => empty list
    return [];
  }

  const lines = res.stdout.split('\n').filter(Boolean);
  const sessions = [];

  for (const line of lines) {
    const [name, created, attached] = line.split('|');
    if (!name) continue;

    // cwd of the active pane
    const cwdRes = await tmux([
      'display-message', '-p', '-t', name, '#{pane_current_path}',
    ]);
    const cwd = cwdRes.code === 0 ? cwdRes.stdout.trim() : '';

    // commands running in panes of this session. Claude renames its process
    // title (e.g. to its version "2.1.168"), so we can't match on "claude".
    // Instead: a pane running anything other than a plain shell counts as
    // "claude running" (this app only ever launches claude in a session).
    const cmdRes = await tmux([
      'list-panes', '-t', name, '-F', '#{pane_current_command}',
    ]);
    const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'tcsh', 'csh', 'dash', 'ksh', 'login']);
    const cmds = cmdRes.code === 0
      ? cmdRes.stdout.split('\n').map((c) => c.trim().replace(/^-/, '')).filter(Boolean)
      : [];
    const hasClaudeCode = cmds.some((c) => !SHELLS.has(c.toLowerCase()));

    // Context window usage (null when no transcript / can't read it).
    const context = await contextForCwd(cwd);

    sessions.push({
      name,
      cwd,
      created: created ? parseInt(created, 10) * 1000 : null,
      attached: attached === '1',
      hasClaudeCode,
      context,
    });
  }

  return sessions;
}

app.get('/api/sessions', async (req, res) => {
  try {
    res.json(await listSessions());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Start claude in a fresh detached tmux session at `dir`. With `resume`, pick up
// the most-recent conversation in that dir (`--continue`) — used to wake a
// session a host/service restart wiped. `name` is sanitized to [A-Za-z0-9_-],
// so it's safe to interpolate. Returns { ok: true } or { error }.
async function launchSession(name, dir, resume) {
  // Remote Control named after the session => controllable from the Claude
  // mobile/web app. --continue resumes the latest conversation in `dir`.
  const cmd = `claude ${resume ? '--continue ' : ''}--permission-mode auto --remote-control ${name}`;

  // SECURITY: run claude AS the tmux window's command, not typed into a login
  // shell via send-keys. With the old send-keys approach, exiting claude
  // (Ctrl-C / Ctrl-D) dropped the attached browser terminal back to a host
  // shell with the service user's full privileges (ssh keys, sudo) — anyone who
  // could reach the unauthenticated terminal got a shell. As the window
  // command, claude exiting kills the pane; remain-on-exit is off by default, so
  // the session is destroyed instead of leaving a shell to land in. `name` and
  // `cmd` are built from the sanitized [A-Za-z0-9_-] name, safe to interpolate.
  const create = await tmux(['new-session', '-d', '-s', name, '-c', dir, cmd]);
  if (create.code !== 0) return { error: create.stderr.trim() || 'Failed to start claude' };

  // Mouse on => tmux reports the wheel to the browser terminal, so a one-finger
  // touch-drag (turned into wheel events by ttyd/shim.html) scrolls the pane's
  // scrollback via copy-mode. Without it, xterm falls back to sending arrow keys
  // (tmux is a full-screen app, so the browser sees an alternate screen). Global
  // option on the shared server — set on every launch so it survives a restart.
  await tmux(['set', '-g', 'mouse', 'on']);

  return { ok: true };
}

app.post('/api/sessions', async (req, res) => {
  // parent must be one of the configured parent dirs — re-checked here so the
  // client can't launch a session in an arbitrary host directory.
  const parent = req.body && req.body.parent;
  if (typeof parent !== 'string' || !getParents().includes(parent)) {
    return res.status(400).json({ error: 'Unknown parent folder' });
  }
  const folder = sanitize(req.body && req.body.folder);
  if (!folder) return res.status(400).json({ error: 'Invalid folder name' });

  const dir = path.join(parent, folder);

  // Name is optional: when blank, derive one (Claude's title, else folder name).
  const raw = req.body && req.body.name;
  const provided = typeof raw === 'string' && raw.trim() !== '';
  let name = provided ? sanitize(raw) : await suggestName(dir);
  if (!name) return res.status(400).json({ error: 'Invalid session name' });

  const exists = async (n) => (await tmux(['has-session', '-t', n])).code === 0;

  // A user-typed name that collides is an error; an auto name gets de-duped.
  if (await exists(name)) {
    if (provided) return res.status(409).json({ error: 'Session already exists' });
    const base = name;
    let i = 2;
    do { name = `${base}-${i++}`; } while (await exists(name) && i < 100);
  }

  const launched = await launchSession(name, dir, false);
  if (launched.error) return res.status(500).json({ error: launched.error });

  res.status(201).json({ name, cwd: dir });
});

app.delete('/api/sessions/:name', async (req, res) => {
  const name = sanitize(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid session name' });

  const kill = await tmux(['kill-session', '-t', name]);
  if (kill.code !== 0) {
    return res.status(404).json({ error: kill.stderr.trim() || 'Session not found' });
  }
  res.json({ ok: true });
});

app.get('/api/sessions/:name/terminal', (req, res) => {
  const name = sanitize(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid session name' });

  const host = (req.headers.host || '').split(':')[0] || 'localhost';
  const cmd = `tmux -S /tmp/tmux-0 attach-session -t ${name}`;
  const url = `http://${host}:${TTYD_PORT}/?arg=${encodeURIComponent(cmd)}`;
  res.json({ url });
});

// --- offline sessions (wake after a restart) -------------------------------
// A host/service restart wipes the tmux server, so every live session is gone.
// Claude's own per-cwd history survives, though: ~/.claude/projects/<dir>/
// <id>.jsonl, one dir per working directory. We mine that to list folders that
// had a session but have no live tmux session now — each can be "woken" by
// recreating a tmux session there and resuming the latest conversation.

async function listOffline() {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = await fs.readdir(projects, { withFileTypes: true });
  } catch (_) {
    return []; // no history dir => nothing to offer
  }

  // cwds that already have a live tmux session aren't "offline".
  const live = new Set((await listSessions()).map((s) => s.cwd).filter(Boolean));

  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projects, d.name);

    // newest transcript in this project dir (its mtime = last active)
    let files;
    try { files = await fs.readdir(dir); } catch (_) { continue; }
    let newest = null;
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const st = await fs.stat(path.join(dir, f)).catch(() => null);
      if (st && (!newest || st.mtimeMs > newest.mtimeMs)) {
        newest = { path: path.join(dir, f), mtimeMs: st.mtimeMs };
      }
    }
    if (!newest) continue;

    // Read the real cwd from the transcript — decoding the dir name is
    // ambiguous because folder names can themselves contain dashes.
    let raw;
    try { raw = await fs.readFile(newest.path, 'utf8'); } catch (_) { continue; }
    const m = raw.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    let cwd;
    try { cwd = JSON.parse('"' + m[1] + '"'); } catch (_) { continue; }

    const m2 = parentOf(cwd);
    if (!m2) continue;            // outside every configured parent
    if (live.has(cwd)) continue;  // still running
    if (seen.has(cwd)) continue;  // dedupe
    seen.add(cwd);

    const name = sanitize(path.basename(cwd)) || sanitize(m2.folder);
    if (!name) continue;

    out.push({ name, folder: m2.folder, parent: m2.parent, cwd, lastActive: Math.round(newest.mtimeMs) });
  }

  out.sort((a, b) => b.lastActive - a.lastActive);
  return out;
}

app.get('/api/sessions/offline', async (req, res) => {
  try {
    res.json(await listOffline());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Suggest a default name for a new session whose working dir is `cwd`: prefer
// the title Claude auto-generated for the most-recent session there (the
// "aiTitle" entry it writes to the transcript), falling back to the basename.
// The cwd->project-dir encoding is deterministic, so we read only that one
// project dir instead of scanning all of them.
async function suggestName(cwd) {
  const fallback = sanitize(path.basename(cwd)) || 'session';
  const dir = path.join(os.homedir(), '.claude', 'projects', projectDirFor(cwd));
  let files;
  try { files = await fs.readdir(dir); } catch (_) { return fallback; }

  let best = null; // { title, mtimeMs } — newest transcript with a title
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    const st = await fs.stat(fp).catch(() => null);
    if (!st) continue;
    if (best && st.mtimeMs <= best.mtimeMs) continue; // can't beat current best

    let raw;
    try { raw = await fs.readFile(fp, 'utf8'); } catch (_) { continue; }

    // last ai-title wins (the title is refined as the conversation grows)
    const titles = raw.match(/"aiTitle":"((?:[^"\\]|\\.)*)"/g);
    if (!titles || !titles.length) continue;
    const lm = titles[titles.length - 1].match(/"aiTitle":"((?:[^"\\]|\\.)*)"/);
    let title;
    try { title = JSON.parse('"' + lm[1] + '"'); } catch (_) { continue; }

    best = { title, mtimeMs: st.mtimeMs };
  }

  return (best && slugifyName(best.title)) || fallback;
}

// Wake an offline session: recreate its tmux session in the (re-validated) cwd
// and resume the latest conversation there. cwd is client-supplied, so re-check
// it's under a configured parent before launching claude in it.
app.post('/api/sessions/:name/wake', async (req, res) => {
  const name = sanitize(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid session name' });

  const cwd = typeof (req.body && req.body.cwd) === 'string' ? path.resolve(req.body.cwd) : null;
  if (!cwd || !parentOf(cwd)) return res.status(400).json({ error: 'cwd must be under a configured parent folder' });

  const st = await fs.stat(cwd).catch(() => null);
  if (!st || !st.isDirectory()) return res.status(404).json({ error: 'Folder no longer exists' });

  const has = await tmux(['has-session', '-t', name]);
  if (has.code === 0) return res.status(409).json({ error: 'Session already exists' });

  const launched = await launchSession(name, cwd, true);
  if (launched.error) return res.status(500).json({ error: launched.error });

  res.status(201).json({ name, cwd });
});

// --- parent folders + directory browser ------------------------------------
// Parents are the configurable set of dirs that hold working folders. The
// browser lets the settings UI navigate the host filesystem to pick one. This
// enumerates host directory names to the (localhost) UI by design.

app.get('/api/parents', (req, res) => {
  res.json(getParents());
});

app.post('/api/parents', async (req, res) => {
  const raw = req.body && req.body.path;
  if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ error: 'Path required' });
  const p = path.resolve(raw.trim());
  const st = await fs.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
  if (!getParents().includes(p)) {
    config.parents = [...getParents(), p]; // append; order is user-managed, not sorted
    await saveConfig();
  }
  res.status(201).json(getParents());
});

// Reorder the parents list. Body `{ order: [...] }` must be a permutation of the
// current parents (same set, no adds/removes) — UI-driven move up/down.
app.put('/api/parents/order', async (req, res) => {
  const order = req.body && req.body.order;
  if (!Array.isArray(order) || order.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'order must be a string array' });
  }
  const cur = getParents();
  const next = order.map((x) => path.resolve(x.trim()));
  const same = next.length === cur.length
    && new Set(next).size === next.length
    && next.every((x) => cur.includes(x));
  if (!same) return res.status(400).json({ error: 'order must be a permutation of current parents' });
  config.parents = next;
  await saveConfig();
  res.json(getParents());
});

app.delete('/api/parents', async (req, res) => {
  const raw = req.body && req.body.path;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'Path required' });
  const p = path.resolve(raw.trim());
  config.parents = getParents().filter((x) => x !== p);
  await saveConfig();
  res.json(getParents());
});

// List immediate (non-hidden) subdirectories of `path` (default: browseDefault).
// `parent` is null at the filesystem root. Used by the settings directory browser.
app.get('/api/browse', async (req, res) => {
  const raw = typeof req.query.path === 'string' && req.query.path.trim()
    ? req.query.path.trim() : await browseDefault();
  const dir = path.resolve(raw);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return res.status(400).json({ error: 'Cannot read directory' });
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const parent = path.dirname(dir);
  res.json({ path: dir, parent: parent === dir ? null : parent, dirs });
});

// --- folders ---------------------------------------------------------------
// A folder is a top-level subdir of one configured parent. Every endpoint
// re-checks `parent` against the configured list so the client can't read or
// write outside it.

app.get('/api/folders', async (req, res) => {
  const parent = typeof req.query.parent === 'string' ? req.query.parent : '';
  if (!getParents().includes(parent)) return res.status(400).json({ error: 'Unknown parent folder' });
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.'))
      .sort();
    res.json(folders);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Suggested default session name for a folder (Claude's title, else folder name).
app.get('/api/folders/suggested-name', async (req, res) => {
  const parent = typeof req.query.parent === 'string' ? req.query.parent : '';
  const folder = sanitize(req.query.folder);
  if (!getParents().includes(parent) || !folder) return res.status(400).json({ error: 'Invalid parent/folder' });
  try {
    res.json({ name: await suggestName(path.join(parent, folder)) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/folders', async (req, res) => {
  const parent = typeof (req.body && req.body.parent) === 'string' ? req.body.parent : '';
  if (!getParents().includes(parent)) return res.status(400).json({ error: 'Unknown parent folder' });
  const name = sanitize(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Invalid folder name' });

  const dir = path.join(parent, name);
  try {
    await fs.mkdir(dir, { recursive: false });
    res.status(201).json({ name });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(409).json({ error: 'Folder already exists' });
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- usage limits ----------------------------------------------------------
// Surfaces Claude's 5-hour + weekly usage via the undocumented OAuth usage
// endpoint (the same data the `/usage` command shows). Reads the host's Claude
// OAuth token. Cached >=180s — the endpoint hands out persistent 429s otherwise.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_TTL = 180 * 1000;     // documented minimum poll interval
const USAGE_ERR_TTL = 60 * 1000;  // back off after a failure
let usageCache = { at: 0, data: null, error: null };
let claudeVersion = null;

async function getClaudeVersion() {
  if (claudeVersion) return claudeVersion;
  const r = await run('claude', ['--version']);
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  claudeVersion = m ? m[1] : '0.0.0';
  return claudeVersion;
}

// Read the Claude OAuth access token from host auth: the credentials file on
// Linux, the login Keychain on macOS. Returns null if unavailable.
async function readOAuthToken() {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (tok) return tok;
  } catch (_) { /* fall through to keychain */ }

  if (process.platform === 'darwin') {
    const r = await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    if (r.code === 0) {
      try {
        const tok = JSON.parse(r.stdout.trim())?.claudeAiOauth?.accessToken;
        if (tok) return tok;
      } catch (_) { /* ignore */ }
    }
  }
  return null;
}

const usageErr = (msg, status) => Object.assign(new Error(msg), { status });

async function fetchUsage() {
  const now = Date.now();
  if (usageCache.data && now - usageCache.at < USAGE_TTL) return usageCache.data;
  if (usageCache.error && now - usageCache.at < USAGE_ERR_TTL) throw usageCache.error;

  const fail = (e) => { usageCache = { at: now, data: null, error: e }; throw e; };

  const token = await readOAuthToken();
  if (!token) fail(usageErr('No Claude credentials on host', 401));

  let resp;
  try {
    resp = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${await getClaudeVersion()}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (_) {
    fail(usageErr('Usage endpoint unreachable', 502));
  }

  if (!resp.ok) {
    if (resp.status === 401) fail(usageErr('Claude auth expired — run `claude` to refresh', 401));
    if (resp.status === 429) fail(usageErr('Rate limited by usage endpoint', 502));
    fail(usageErr(`Usage endpoint error ${resp.status}`, 502));
  }

  const body = await resp.json();
  const pick = (o) => (o && typeof o.utilization === 'number')
    ? { utilization: o.utilization, resets_at: o.resets_at }
    : null;
  const data = { five_hour: pick(body.five_hour), seven_day: pick(body.seven_day) };
  usageCache = { at: now, data, error: null };
  return data;
}

app.get('/api/usage', async (req, res) => {
  try {
    res.json(await fetchUsage());
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

// --- static frontend -------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'frontend')));

loadConfig().then(() => {
  app.listen(PORT, BIND_ADDR, () => {
    console.log(`Claude Session Manager on ${BIND_ADDR}:${PORT}  parents=${getParents().length}`);
  });
});
