// "Copy text" view: a plain-text snapshot of a session's tmux pane in a
// read-only <textarea>, so text can be selected and copied normally.
//
// Why not select in the terminal itself: Claude Code runs in tmux's alternate
// screen and repaints on every frame, which clears an in-progress xterm.js
// selection; on touch, a one-finger drag is consumed by the scroll shim
// (ttyd/shim.html) and never becomes a selection at all.

import { $, flash } from "./utils.js";
import { capturePane } from "./api.js";

let openName = null;

/** Copy `text` to the clipboard. Falls back to execCommand on insecure origins
 *  (plain http to a LAN IP), where navigator.clipboard is undefined. */
async function toClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  const ta = $("capText");
  ta.focus();
  ta.setSelectionRange(0, ta.value.length);
  try { return document.execCommand("copy"); } catch (_) { return false; }
}

async function load() {
  const ta = $("capText");
  ta.value = "Loading…";
  try {
    const { text } = await capturePane(openName, 2000);
    ta.value = text || "(empty)";
    ta.scrollTop = ta.scrollHeight;   // newest output first, like the terminal
  } catch (e) {
    ta.value = "Capture failed: " + e.message;
  }
}

/** Open the copy view for a session (called from the terminal modal). */
export async function openCapture(name) {
  openName = name;
  $("capTitle").textContent = name;
  $("capModal").classList.add("open");
  await load();
}

export function closeCapture() {
  if (!openName) return;
  $("capModal").classList.remove("open");
  openName = null;
}

export const isCaptureOpen = () => openName !== null;

/** Wire the copy-view buttons. Call once on load. */
export function initCapture() {
  $("capClose").addEventListener("click", closeCapture);
  $("capReload").addEventListener("click", load);
  $("capAll").addEventListener("click", async () => {
    const ok = await toClipboard($("capText").value);
    flash($("capMsg"), ok ? "Copied" : "Copy blocked — select and copy manually", ok);
  });
}
