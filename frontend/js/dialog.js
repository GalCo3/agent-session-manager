// Confirm dialog for killing one or many sessions, or restarting one.

import { $, esc } from "./utils.js";
import { killSession, restartSession } from "./api.js";
import { refresh } from "./sessions.js";
import { isSelecting, exitSelect } from "./selection.js";

let targets = [];
let mode = "kill"; // "kill" | "restart"

const KILL_STYLE = "background:var(--danger);color:#fff;border-color:var(--danger)";

function openDialog(title, body, confirmLabel, confirmClass, confirmStyle) {
  $("dlgTitle").textContent = title;
  $("dlgBody").innerHTML = body;
  const btn = $("dlgConfirm");
  btn.textContent = confirmLabel;
  btn.className = confirmClass;
  btn.style.cssText = confirmStyle;
  $("scrim").classList.add("open");
  $("dialog").classList.add("open");
  setTimeout(() => $("dlgCancel").focus(), 200);
}

/** Open the confirm dialog for a single name or a list of names. */
export function confirmKill(nameOrList) {
  mode = "kill";
  targets = Array.isArray(nameOrList) ? [...nameOrList] : [nameOrList];
  const n = targets.length;
  const title = n === 1 ? "Kill session?" : `Kill ${n} sessions?`;
  const body = n === 1
    ? 'End session <b class="mono">' + esc(targets[0]) + '</b>. Stops Claude and the tmux session. Cannot be undone.'
    : `End <b>${n}</b> sessions. Stops Claude and the tmux sessions. Cannot be undone.`;
  openDialog(title, body, "Kill", "kill", KILL_STYLE);
}

/** Confirm restarting Claude in one session (same name, same conversation). */
export function confirmRestart(name) {
  mode = "restart";
  targets = [name];
  const body = 'Restart Claude in <b class="mono">' + esc(name) + '</b> and resume the same conversation. '
    + "Anything Claude is doing right now is interrupted.";
  openDialog("Restart session?", body, "Restart", "primary", "");
}

export function closeDialog() {
  $("dialog").classList.remove("open");
  if (!$("sheet").classList.contains("open")) $("scrim").classList.remove("open");
  targets = [];
}

/** Wire up the dialog's Cancel/Confirm buttons. Call once on load. */
export function initDialog() {
  $("dlgCancel").addEventListener("click", closeDialog);
  $("dlgConfirm").addEventListener("click", async () => {
    if (!targets.length) return;
    const names = targets;
    const btn = $("dlgConfirm"); btn.disabled = true;
    try {
      if (mode === "restart") {
        await restartSession(names[0]);
        closeDialog();
        refresh();
        return;
      }
      const results = await Promise.allSettled(names.map((n) => killSession(n)));
      const failed = results.filter((r) => r.status === "rejected").length;
      closeDialog();
      if (isSelecting()) exitSelect();
      refresh();
      if (failed) alert(`Failed to kill ${failed} of ${names.length} session(s).`);
    } catch (e) {
      alert((mode === "restart" ? "Restart: " : "Kill: ") + e.message);
    } finally {
      btn.disabled = false;
    }
  });
}
