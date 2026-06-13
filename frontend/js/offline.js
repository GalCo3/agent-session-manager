// "Restart a session" sheet, opened from the button in the create sheet (+).
// Lists folders that had a Claude session but have no live tmux session now
// (e.g. after a host/service restart). Restarting one recreates the tmux
// session and resumes its latest conversation (server: --continue).

import { $, esc, age } from "./utils.js";
import { getOffline, wakeSession } from "./api.js";
import { refresh } from "./sessions.js";

let list = []; // most recent /api/sessions/offline payload

function render() {
  const box = $("wakeList");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="wake-empty">No recently closed sessions to restart.</div>`;
    return;
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "wake-row";
    row.innerHTML = `
      <div class="wake-info">
        <span class="wake-name">${esc(s.name)}</span>
        <span class="wake-meta mono">${esc(s.folder)} · last active ${age(s.lastActive)} ago</span>
      </div>
      <button class="primary wake-go" type="button">Restart</button>`;

    const btn = row.querySelector(".wake-go");
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Restarting…";
      const msg = $("wakeMsg"); msg.textContent = ""; msg.className = "msg";
      try {
        await wakeSession(s.name, s.cwd);
        list = list.filter((x) => x.cwd !== s.cwd);
        render();
        refresh();
        if (!list.length) setTimeout(closeWake, 600);
      } catch (e) {
        btn.disabled = false; btn.textContent = "Restart";
        const m = $("wakeMsg"); m.textContent = e.message; m.className = "msg err";
      }
    });
    box.appendChild(row);
  }
}

/** Fetch the offline list and paint it into the open sheet. */
async function loadOffline() {
  try { list = await getOffline(); }
  catch (e) {
    list = [];
    const m = $("wakeMsg"); m.textContent = e.message; m.className = "msg err";
  }
  render();
}

export function openWake() {
  $("scrim").classList.add("open");
  $("wakeSheet").classList.add("open");
  $("wakeMsg").textContent = ""; $("wakeMsg").className = "msg";
  $("wakeList").innerHTML = `<div class="wake-empty">Loading…</div>`;
  loadOffline();
}

export function closeWake() {
  $("wakeSheet").classList.remove("open");
  $("scrim").classList.remove("open");
}

export const isWakeOpen = () => $("wakeSheet").classList.contains("open");
