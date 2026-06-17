// Multi-terminal grid view: attach several live sessions and watch their ttyd
// terminals side by side in one window. A separate full-screen "page" (overlay)
// reached from the header grid button. Pure frontend — reuses the same
// /api/sessions/:name/terminal URL the single-terminal modal uses; each tile is
// an independent iframe attached to its own tmux session.
//
// Layout (1 / 2 / 4 tiles) and which sessions are attached persist to
// localStorage so the view survives reloads. Focus maximizes one tile without
// tearing down the others (CSS only — no iframe rebuild, so no reconnect).

import { $, esc, ic } from "./utils.js";
import { getSessions, getTerminal } from "./api.js";

const KEY = "gridState_v1";
const SLOTS = 4;                  // fixed pool of tile shells; layout shows 1/2/4
const COUNT = { 1: 1, 2: 2, 3: 3, 4: 4 };

let layout = 1;
let tiles = new Array(SLOTS).fill(null); // session name per slot, or null
let focusedIdx = null;
let pickTarget = null;            // slot awaiting a pick from the picker sheet
let built = false;                // shells created once, lazily
let raf = 0;

// --- persistence -----------------------------------------------------------
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ layout, tiles })); } catch (_) {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && COUNT[s.layout]) layout = s.layout;
    if (s && Array.isArray(s.tiles)) {
      for (let i = 0; i < SLOTS; i++) tiles[i] = typeof s.tiles[i] === "string" ? s.tiles[i] : null;
    }
  } catch (_) {}
}

// --- keep the modal above the on-screen keyboard (same trick as terminal.js) -
function syncViewport() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const vv = window.visualViewport;
    if (!vv) return;
    const m = $("gridModal");
    m.style.height = vv.height + "px";
    m.style.top = vv.offsetTop + "px";
  });
}
function bindViewport(on) {
  const vv = window.visualViewport;
  if (!vv) return;
  if (on) {
    vv.addEventListener("resize", syncViewport);
    vv.addEventListener("scroll", syncViewport);
    syncViewport();
  } else {
    vv.removeEventListener("resize", syncViewport);
    vv.removeEventListener("scroll", syncViewport);
    const m = $("gridModal");
    m.style.height = ""; m.style.top = "";
  }
}

// --- tile rendering --------------------------------------------------------
const tileEl = (i) => $("gridTiles").children[i];
const bodyEl = (i) => tileEl(i).querySelector(".gtile-body");

// Build the 4 persistent tile shells once. Layout/focus only toggle classes on
// these; iframes are rebuilt only when a slot's session actually changes.
function buildShells() {
  const wrap = $("gridTiles");
  wrap.innerHTML = "";
  for (let i = 0; i < SLOTS; i++) {
    const t = document.createElement("div");
    t.className = "gtile";
    t.dataset.idx = i;
    t.innerHTML = `
      <div class="gtile-head">
        <span class="gtile-name mono"></span>
        <span class="spacer"></span>
        <button class="iconbtn gt-focus" type="button" aria-label="Focus tile" title="Focus"></button>
        <button class="iconbtn gt-detach" type="button" aria-label="Detach session" title="Detach">${ic.close}</button>
      </div>
      <div class="gtile-body"></div>`;
    t.querySelector(".gt-focus").addEventListener("click", () => toggleFocus(i));
    t.querySelector(".gt-detach").addEventListener("click", () => detach(i));
    wrap.appendChild(t);
  }
  built = true;
}

function makeFrame(body, url) {
  body.replaceChildren();
  const f = document.createElement("iframe");
  f.title = "Terminal";
  f.setAttribute("allow", "clipboard-read; clipboard-write");
  f.src = url;
  body.appendChild(f);
}

// Paint one tile to match tiles[i]. Rebuilds the iframe only when the attached
// session name changed (tracked on the body's dataset) to avoid reconnect churn.
async function paintTile(i) {
  const t = tileEl(i);
  const body = bodyEl(i);
  const name = tiles[i];
  const nameEl = t.querySelector(".gtile-name");
  const focusBtn = t.querySelector(".gt-focus");
  const detachBtn = t.querySelector(".gt-detach");

  if (!name) {
    nameEl.textContent = "Empty";
    t.classList.add("empty");
    focusBtn.hidden = true;
    detachBtn.hidden = true;
    if (body.dataset.name) { body.replaceChildren(); body.dataset.name = ""; }
    body.innerHTML = `<button class="gt-attach" type="button">${ic.plus}<span>Attach session</span></button>`;
    body.querySelector(".gt-attach").addEventListener("click", () => openPicker(i));
    return;
  }

  nameEl.textContent = name;
  t.classList.remove("empty");
  focusBtn.hidden = false;
  detachBtn.hidden = false;
  focusBtn.innerHTML = focusedIdx === i ? ic.collapse : ic.expand;

  if (body.dataset.name === name && body.querySelector("iframe")) return; // unchanged
  body.dataset.name = name;
  body.innerHTML = "";
  try {
    const { url } = await getTerminal(name);
    if (tiles[i] !== name) return; // changed while awaiting
    makeFrame(body, url);
  } catch (e) {
    body.innerHTML = `<div class="gt-err">${esc(e.message)}</div>`;
  }
}

function paintAll() { for (let i = 0; i < SLOTS; i++) paintTile(i); }

// --- layout / focus --------------------------------------------------------
function applyLayout() {
  const wrap = $("gridTiles");
  wrap.dataset.layout = layout;
  const n = COUNT[layout];
  for (let i = 0; i < SLOTS; i++) tileEl(i).classList.toggle("hidden", i >= n);
  // a focused tile that's no longer visible loses focus
  if (focusedIdx != null && focusedIdx >= n) setFocus(null);
  wrap.classList.toggle("focused", focusedIdx != null);
  document.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", +b.dataset.layout === layout));
}

function setLayout(n) {
  if (!COUNT[n]) return;
  layout = n;
  if (focusedIdx != null) setFocus(null); // picking a layout exits focus mode
  applyLayout();
  save();
}

function setFocus(idx) {
  focusedIdx = idx;
  for (let i = 0; i < SLOTS; i++) tileEl(i).classList.toggle("focused", focusedIdx === i);
  $("gridTiles").classList.toggle("focused", focusedIdx != null);
  if (idx != null) tileEl(idx).querySelector(".gt-focus").innerHTML = ic.collapse;
  for (let i = 0; i < SLOTS; i++) {
    if (i !== idx && tiles[i]) tileEl(i).querySelector(".gt-focus").innerHTML = ic.expand;
  }
}
function toggleFocus(i) { setFocus(focusedIdx === i ? null : i); }

// --- attach / detach -------------------------------------------------------
function setTile(i, name) {
  tiles[i] = name;
  paintTile(i);
  save();
}
function detach(i) {
  if (focusedIdx === i) setFocus(null);
  setTile(i, null);
}

// --- picker sheet ----------------------------------------------------------
async function openPicker(i) {
  pickTarget = i;
  $("scrim").classList.add("open");
  $("gridPicker").classList.add("open");
  document.body.classList.add("picker-over");
  const box = $("pickList");
  $("pickMsg").textContent = "";
  box.innerHTML = `<div class="wake-empty">Loading…</div>`;
  let sessions;
  try { sessions = await getSessions(); }
  catch (e) { box.innerHTML = `<div class="wake-empty">${esc(e.message)}</div>`; return; }

  const taken = new Set(tiles.filter((n, k) => n && k !== i));
  const avail = sessions.filter((s) => !taken.has(s.name));
  if (!avail.length) {
    box.innerHTML = `<div class="wake-empty">No more sessions to attach. Launch one with +.</div>`;
    return;
  }
  box.innerHTML = "";
  for (const s of avail) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pick-row";
    const path = s.cwd ? (s.cwd.replace(/\/+$/, "").split("/").pop() || s.cwd) : "?";
    const run = s.hasClaudeCode ? `<span class="badge run"><i></i>running</span>` : `<span class="badge"><i></i>idle</span>`;
    row.innerHTML = `<span class="term-ic">${ic.term}</span>
      <span class="pick-info"><span class="pick-name">${esc(s.name)}</span><span class="pick-meta mono">${esc(path)}</span></span>
      ${run}`;
    row.addEventListener("click", () => { setTile(pickTarget, s.name); closePicker(); });
    box.appendChild(row);
  }
}

export function closePicker() {
  $("gridPicker").classList.remove("open");
  document.body.classList.remove("picker-over");
  $("scrim").classList.remove("open");
}

// First empty visible slot, else the focused/first visible one (to swap).
function nextTarget() {
  const n = COUNT[layout];
  for (let i = 0; i < n; i++) if (!tiles[i]) return i;
  return focusedIdx != null ? focusedIdx : 0;
}

// --- open / close ----------------------------------------------------------
// The view lives at the #grid route so it's deep-linkable and the browser back
// button closes it. openGrid()/closeGrid() drive the hash; the hashchange
// listener does the actual DOM open/close via route() — keeping URL and view
// in sync no matter how it's triggered (button, Esc, back, direct link).
const HASH = "#grid";

async function applyOpen() {
  if (isGridOpen()) return;
  if (!built) { load(); buildShells(); applyLayout(); paintAll(); }
  $("gridModal").classList.add("open");
  document.body.classList.add("grid-open");
  bindViewport(true);
  // Drop any attached session that's no longer live (e.g. after a restart).
  try {
    const live = new Set((await getSessions()).map((s) => s.name));
    for (let i = 0; i < SLOTS; i++) if (tiles[i] && !live.has(tiles[i])) setTile(i, null);
  } catch (_) {}
}

function applyClose() {
  if (!isGridOpen()) return;
  $("gridModal").classList.remove("open");
  document.body.classList.remove("grid-open");
  bindViewport(false);
  if (isPickerOpen()) closePicker();
}

// Reconcile the view with the current URL hash.
function route() {
  if (location.hash === HASH) applyOpen();
  else applyClose();
}

export function openGrid() {
  if (location.hash === HASH) route();      // already routed — ensure it's open
  else location.hash = "grid";              // fires hashchange -> route -> open
}

export function closeGrid() {
  if (location.hash === HASH) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  route();                                   // hash now cleared -> close
}

export const isGridOpen = () => $("gridModal").classList.contains("open");
export const isPickerOpen = () => $("gridPicker").classList.contains("open");

/** Wire the header button + grid controls + hash routing. Call once on load. */
export function initGrid() {
  $("gridBtn").addEventListener("click", openGrid);
  $("gridClose").addEventListener("click", closeGrid);
  $("gridAdd").addEventListener("click", () => openPicker(nextTarget()));

  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.innerHTML = ic["lay" + b.dataset.layout];
    b.addEventListener("click", () => setLayout(+b.dataset.layout));
  });

  window.addEventListener("hashchange", route);
  route(); // honor a #grid deep-link on initial load
}
