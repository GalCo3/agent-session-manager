// Confirm dialog for killing one or many sessions.

import { $, esc } from "./utils.js";
import { killSession } from "./api.js";
import { refresh } from "./sessions.js";
import { isSelecting, exitSelect } from "./selection.js";

let killTargets = [];

/** Open the confirm dialog for a single name or a list of names. */
export function confirmKill(nameOrList) {
  killTargets = Array.isArray(nameOrList) ? [...nameOrList] : [nameOrList];
  const n = killTargets.length;
  const title = n === 1 ? "Kill session?" : `Kill ${n} sessions?`;
  const body = n === 1
    ? 'End session <b class="mono">' + esc(killTargets[0]) + '</b>. Stops Claude and the tmux session. Cannot be undone.'
    : `End <b>${n}</b> sessions. Stops Claude and the tmux sessions. Cannot be undone.`;
  $("dlgTitle").textContent = title;
  $("dlgBody").innerHTML = body;
  $("scrim").classList.add("open");
  $("dialog").classList.add("open");
  setTimeout(() => $("dlgCancel").focus(), 200);
}

export function closeDialog() {
  $("dialog").classList.remove("open");
  if (!$("sheet").classList.contains("open")) $("scrim").classList.remove("open");
  killTargets = [];
}

/** Wire up the dialog's Cancel/Confirm buttons. Call once on load. */
export function initDialog() {
  $("dlgCancel").addEventListener("click", closeDialog);
  $("dlgConfirm").addEventListener("click", async () => {
    if (!killTargets.length) return;
    const names = killTargets;
    const btn = $("dlgConfirm"); btn.disabled = true;
    try {
      const results = await Promise.allSettled(names.map((n) => killSession(n)));
      const failed = results.filter((r) => r.status === "rejected").length;
      closeDialog();
      if (isSelecting()) exitSelect();
      refresh();
      if (failed) alert(`Failed to kill ${failed} of ${names.length} session(s).`);
    } catch (e) {
      alert("Kill: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });
}
