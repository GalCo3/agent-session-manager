// Session list: card rendering and the polling refresh loop.

import { $, esc, age, ic, tokensShort, ctxLeftPct } from "./utils.js";
import { getSessions } from "./api.js";
import { selected, isSelecting, toggleSelect, beginSelectionWith, pruneSelection, updateBar } from "./selection.js";
import { confirmKill } from "./dialog.js";
import { openTerminal } from "./terminal.js";

const LONG_PRESS_MS = 500;

// Names of cards the user has expanded. Tracked so the state survives the
// poll-driven re-render (same pattern as `selected`).
const expanded = new Set();

function sessionCard(s) {
  const el = document.createElement("div");
  el.className = "card";

  const runBadge = s.hasClaudeCode
    ? `<span class="badge run"><i></i>running</span>`
    : `<span class="badge"><i></i>idle</span>`;
  const attBadge = s.attached ? `<span class="badge att"><i></i>attached</span>` : "";
  const started = s.created ? new Date(s.created).toLocaleString() : "?";
  const fullPath = s.cwd || "?";
  const baseName = fullPath === "?" ? "?" : (fullPath.replace(/\/+$/, "").split("/").pop() || fullPath);

  // Context-window "left" — like the desktop app. Hidden when unknown.
  const left = ctxLeftPct(s.context);
  const ctxClass = left == null ? "" : left <= 10 ? " crit" : left <= 25 ? " warn" : "";
  const ctxChip = left == null ? ""
    : `<span class="chip ctx${ctxClass}">${ic.gauge}<span class="mono">${left}% ctx</span></span>`;
  const ctxRow = left == null ? ""
    : `<div class="d-row"><span class="d-k">Context</span><span class="d-v mono">${left}% left · ${tokensShort(s.context.tokens)}/${tokensShort(s.context.limit)}</span></div>`;

  el.dataset.name = s.name;
  if (selected.has(s.name)) el.classList.add("sel");
  if (expanded.has(s.name)) el.classList.add("expanded");

  el.innerHTML = `
    <div class="card-top">
      <span class="check" aria-hidden="true">${ic.check}</span>
      <div class="s-name"><span>${esc(s.name)}</span></div>
      <div class="badges">${runBadge}${attBadge}</div>
      <span class="chev" aria-hidden="true">${ic.chevron}</span>
    </div>
    <div class="s-meta">
      <span class="chip">${ic.folder}<span class="path mono"><span class="p-short">${esc(baseName)}</span><span class="p-full">${esc(fullPath)}</span></span></span>
      <span class="chip">${ic.clock}<span class="mono">${age(s.created)}</span></span>
      ${ctxChip}
    </div>
    <div class="s-detail">
      <div class="d-row"><span class="d-k">Started</span><span class="d-v mono">${esc(started)}</span></div>
      <div class="d-row"><span class="d-k">Status</span><span class="d-v">${s.hasClaudeCode ? "Claude running" : "Idle shell"}</span></div>
      <div class="d-row"><span class="d-k">Attached</span><span class="d-v">${s.attached ? "Yes" : "No"}</span></div>
      ${ctxRow}
    </div>
    <div class="actions">
      <button class="term" data-open>${ic.term} Terminal</button>
      <button class="kill" data-kill>${ic.trash} Kill</button>
    </div>`;

  // Long-press anywhere on a card enters select mode and picks it.
  let lpTimer = null, longFired = false, sx = 0, sy = 0;
  const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  el.addEventListener("pointerdown", (e) => {
    if (isSelecting() || e.target.closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    clearLP();
    lpTimer = setTimeout(() => { lpTimer = null; longFired = true; beginSelectionWith(s.name, el); }, LONG_PRESS_MS);
  });
  el.addEventListener("pointermove", (e) => {
    if (lpTimer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) clearLP();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => el.addEventListener(ev, clearLP));

  // In select mode, tapping anywhere toggles selection. Otherwise a plain tap
  // (not on a button) expands/collapses the card to reveal full details.
  el.addEventListener("click", (e) => {
    if (longFired) { longFired = false; e.preventDefault(); e.stopPropagation(); return; }
    if (isSelecting()) { e.preventDefault(); toggleSelect(s.name, el); return; }
    if (e.target.closest("button")) return; // Terminal / Kill handle themselves
    const open = el.classList.toggle("expanded");
    if (open) expanded.add(s.name); else expanded.delete(s.name);
  });

  el.querySelector("[data-open]").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      await openTerminal(s.name);
    } catch (err) { alert("Terminal: " + err.message); }
    finally { btn.disabled = false; }
  });

  el.querySelector("[data-kill]").addEventListener("click", () => confirmKill(s.name));
  return el;
}

let inflight = false;
let lastSig = null; // signature of last render — skip DOM churn when unchanged

/** Poll the backend and re-render the list only when the data actually changed. */
export async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    const sessions = await getSessions();
    $("dot").className = "dot live";

    // Only touch the DOM when the data actually changed. Without this the
    // 5s poll rebuilt every card each tick (visible flicker / re-animation).
    // age() drifts each second, so exclude it from the signature; ages
    // refresh on the next real change.
    const sig = JSON.stringify(sessions.map((s) => [s.name, s.cwd, s.hasClaudeCode, s.attached, ctxLeftPct(s.context)]));
    $("count").textContent = sessions.length;

    const names = new Set(sessions.map((s) => s.name));
    pruneSelection(sessions.map((s) => s.name));
    for (const n of expanded) if (!names.has(n)) expanded.delete(n);

    if (sig === lastSig) return;
    lastSig = sig;

    const box = $("list");
    box.innerHTML = "";
    if (!sessions.length) {
      box.innerHTML = `<div class="empty"><div class="ico">${ic.empty}</div><h3>No active sessions</h3><p>Tap + to launch Claude in a new session.</p></div>`;
    } else {
      for (const s of sessions) box.appendChild(sessionCard(s));
    }
    if (isSelecting()) updateBar(); // re-rendered cards may change the all/none state
  } catch (e) {
    $("dot").className = "dot err";
  } finally {
    inflight = false;
  }
}
