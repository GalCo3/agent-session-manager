// "Resume a session" sheet, opened from the button in the create sheet (+).
// Like `claude -r`, scoped to a folder: pick a parent + folder, see the past
// Claude conversations in it and its subfolders (newest first), resume one in
// a new tmux session (server: `claude --resume <id>`).

import { $, esc, age } from "./utils.js";
import { getParents, getFolders, getConversations, resumeConversation } from "./api.js";
import { refresh } from "./sessions.js";
import { openTerminal } from "./terminal.js";

let loadSeq = 0; // guards against a stale list landing after the folder changed

const setMsg = (text, cls) => { const m = $("wakeMsg"); m.textContent = text || ""; m.className = "msg" + (cls ? " " + cls : ""); };
const empty = (text) => { $("wakeList").innerHTML = `<div class="wake-empty">${esc(text)}</div>`; };

function fillSelect(sel, values, label, placeholder) {
  sel.innerHTML = "";
  if (!values.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = placeholder;
    sel.appendChild(o);
  }
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label(v); o.title = v;
    sel.appendChild(o);
  }
}

function render(list) {
  const box = $("wakeList");
  box.innerHTML = "";
  if (!list.length) return empty("No past conversations in this folder.");
  for (const c of list) {
    const where = c.sub ? c.sub + "/" : "./";
    const live = c.liveSession ? ` · <span class="wake-live">open in ${esc(c.liveSession)}</span>` : "";
    // Known session name (= what the Claude app shows) leads; the AI title then
    // takes the second line, else the last prompt does.
    const head = c.name || c.title;
    const sub = c.name ? c.title : c.prompt;
    const prompt = sub && sub !== head ? `<span class="wake-prompt">${esc(sub)}</span>` : "";
    const row = document.createElement("div");
    row.className = "wake-row";
    row.innerHTML = `
      <div class="wake-info">
        <span class="wake-name" dir="auto">${esc(head)}</span>
        ${prompt}
        <span class="wake-meta mono">${esc(where)} · ${age(c.lastActive)} ago${live}</span>
        <span class="wake-note msg" role="status"></span>
      </div>
      <button class="primary wake-go" type="button">Resume</button>`;

    // Feedback goes in the tapped row itself: #wakeMsg sits below a list of up
    // to 50 rows, off-screen on a phone, so a failed tap looked like a no-op.
    const btn = row.querySelector(".wake-go");
    const note = row.querySelector(".wake-note");
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Resuming…";
      note.textContent = ""; note.className = "wake-note msg";
      try {
        const r = await resumeConversation(c.id, c.cwd);
        btn.textContent = "Opening…";
        note.textContent = "Resumed as " + r.name; note.className = "wake-note msg ok";
        refresh();
        // Land in the resumed session so the result is visible.
        setTimeout(() => {
          closeWake();
          openTerminal(r.name).catch(() => {});
        }, 500);
      } catch (e) {
        btn.disabled = false; btn.textContent = "Resume";
        note.textContent = e.message; note.className = "wake-note msg err";
      }
    });
    box.appendChild(row);
  }
}

/** Fetch + paint the conversations for the selected parent/folder. */
async function loadList() {
  const parent = $("rParent").value, folder = $("rFolder").value;
  const seq = ++loadSeq;
  setMsg("");
  if (!parent || !folder) return empty("Pick a folder to see its past conversations.");
  empty("Loading…");
  try {
    const list = await getConversations(parent, folder);
    if (seq === loadSeq) render(list);
  } catch (e) {
    if (seq === loadSeq) { empty(""); setMsg(e.message, "err"); }
  }
}

async function loadFolderSelect(prefer) {
  const parent = $("rParent").value;
  const folders = parent ? await getFolders(parent).catch(() => []) : [];
  fillSelect($("rFolder"), folders, (f) => f, "No folders");
  if (prefer && folders.includes(prefer)) $("rFolder").value = prefer;
}

/** Open the sheet, preselecting the parent/folder chosen in the create sheet. */
export async function openWake() {
  $("scrim").classList.add("open");
  $("wakeSheet").classList.add("open");
  setMsg("");
  empty("Loading…");
  const parents = await getParents().catch(() => []);
  fillSelect($("rParent"), parents, (p) => p.replace(/\/+$/, "").split("/").pop() || p, "No parent folders — add one in Settings");
  const wantParent = $("sParent").value;
  if (parents.includes(wantParent)) $("rParent").value = wantParent;
  await loadFolderSelect($("rParent").value === wantParent ? $("sFolder").value : null);
  loadList();
}

export function closeWake() {
  $("wakeSheet").classList.remove("open");
  $("scrim").classList.remove("open");
}

export const isWakeOpen = () => $("wakeSheet").classList.contains("open");

/** Wire the parent/folder pickers. Call once on load. */
export function initWake() {
  $("rParent").addEventListener("change", async () => { await loadFolderSelect(null); loadList(); });
  $("rFolder").addEventListener("change", loadList);
}
