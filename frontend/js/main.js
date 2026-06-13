// Entry point: wire shared overlay handlers, then start the poll loops.

import { $ } from "./utils.js";
import { refresh } from "./sessions.js";
import { initSelection, isSelecting, exitSelect } from "./selection.js";
import { initCreate, loadFolders, closeSheet } from "./create.js";
import { initDialog, closeDialog } from "./dialog.js";
import { initTerminal, closeTerminal } from "./terminal.js";
import { loadUsage, tickUsage } from "./usage.js";
import { closeWake } from "./offline.js";
import { initSettings, closeSettings } from "./settings.js";

initSelection();
initCreate();
initDialog();
initTerminal();
initSettings();

// scrim (backdrop) tap closes any open overlay
$("scrim").addEventListener("click", () => { closeSheet(); closeDialog(); closeWake(); closeSettings(); });

// Esc closes overlays and leaves select mode
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSheet();
    closeDialog();
    closeTerminal();
    closeWake();
    closeSettings();
    if (isSelecting()) exitSelect();
  }
});

// initial load + poll loops
refresh();
loadFolders();
loadUsage();
setInterval(refresh, 5000);
setInterval(loadFolders, 30000);
setInterval(loadUsage, 180000);  // server caches 180s — don't poll faster
setInterval(tickUsage, 60000);   // tick reset countdowns between fetches
