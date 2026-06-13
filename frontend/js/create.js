// New-session bottom sheet, including parent/folder load + folder create.

import { $, flash } from "./utils.js";
import { getFolders, createFolder, createSession, getSuggestedName, getParents } from "./api.js";
import { refresh } from "./sessions.js";
import { openWake } from "./offline.js";

/**
 * Show the name the session will get if left blank as the input's placeholder:
 * the folder name immediately, then Claude's auto-title for that parent/folder
 * once the server answers. Guards against a stale answer if the choice changed.
 */
async function updateNamePlaceholder() {
  const parent = $("sParent").value;
  const folder = $("sFolder").value;
  const input = $("sName");
  input.placeholder = folder || "auto";
  if (!parent || !folder) return;
  try {
    const { name } = await getSuggestedName(parent, folder);
    if ($("sParent").value === parent && $("sFolder").value === folder) input.placeholder = name;
  } catch (_) { /* keep the folder-name fallback */ }
}

/** (Re)populate the parent <select> from the configured parents. */
export async function loadParents() {
  try {
    const parents = await getParents();
    const sel = $("sParent");
    const cur = sel.value;
    sel.innerHTML = "";
    if (!parents.length) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = "No parent folders — add one in Settings";
      sel.appendChild(o);
    }
    for (const p of parents) {
      const o = document.createElement("option");
      o.value = p; o.textContent = p.replace(/\/+$/, "").split("/").pop() || p;
      o.title = p;
      sel.appendChild(o);
    }
    if (cur && parents.includes(cur)) sel.value = cur;
    return parents;
  } catch (e) {
    flash($("createMsg"), "Parents: " + e.message, false);
    return [];
  }
}

/** (Re)populate the folder <select> for the chosen parent, preserving choice. */
export async function loadFolders() {
  const parent = $("sParent").value;
  const sel = $("sFolder");
  if (!parent) { sel.innerHTML = ""; return []; }
  try {
    const folders = await getFolders(parent);
    const cur = sel.value;
    sel.innerHTML = "";
    if (!folders.length) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = "No folders — create one below";
      sel.appendChild(o);
    }
    for (const f of folders) {
      const o = document.createElement("option");
      o.value = f; o.textContent = f;
      sel.appendChild(o);
    }
    if (cur && folders.includes(cur)) sel.value = cur;
    return folders;
  } catch (e) {
    flash($("createMsg"), "Folders: " + e.message, false);
    return [];
  }
}

export async function openSheet() {
  $("scrim").classList.add("open");
  $("sheet").classList.add("open");
  await loadParents();
  await loadFolders();
  updateNamePlaceholder();
  setTimeout(() => $("sName").focus(), 300);
}

export function closeSheet() {
  $("sheet").classList.remove("open");
  $("scrim").classList.remove("open");
}

/** Wire up the FAB and the create/add-folder buttons. Call once on load. */
export function initCreate() {
  $("fab").addEventListener("click", openSheet);

  // "Restart a session" — swap the create sheet for the offline-sessions sheet
  $("restartBtn").addEventListener("click", () => { closeSheet(); openWake(); });

  // Parent change => reload its folders, then refresh the suggested name.
  $("sParent").addEventListener("change", async () => {
    await loadFolders();
    updateNamePlaceholder();
  });

  // Keep the placeholder in sync with the chosen folder's suggested name.
  $("sFolder").addEventListener("change", updateNamePlaceholder);

  $("createBtn").addEventListener("click", async () => {
    const name = $("sName").value.trim(); // blank => server derives the name
    const parent = $("sParent").value;
    const folder = $("sFolder").value;
    if (!parent) return flash($("createMsg"), "Add a parent folder in Settings", false);
    if (!folder) return flash($("createMsg"), "Pick or create a folder", false);
    const btn = $("createBtn"); btn.disabled = true;
    try {
      const created = await createSession(name, parent, folder);
      flash($("createMsg"), "Launched " + (created.name || name), true);
      $("sName").value = "";
      setTimeout(() => { closeSheet(); $("createMsg").textContent = ""; }, 700);
      refresh();
    } catch (e) {
      flash($("createMsg"), e.message, false);
    } finally {
      btn.disabled = false;
    }
  });

  $("folderBtn").addEventListener("click", async () => {
    const parent = $("sParent").value;
    const name = $("newFolder").value.trim();
    if (!parent) return flash($("folderMsg"), "Add a parent folder in Settings", false);
    if (!name) return flash($("folderMsg"), "Enter a folder name", false);
    const btn = $("folderBtn"); btn.disabled = true;
    try {
      await createFolder(parent, name);
      flash($("folderMsg"), "Created " + name, true);
      $("newFolder").value = "";
      await loadFolders();
      $("sFolder").value = name;
      updateNamePlaceholder();
    } catch (e) {
      flash($("folderMsg"), e.message, false);
    } finally {
      btn.disabled = false;
    }
  });
}
