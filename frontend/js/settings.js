// Settings sheet: manage the configured parent folders via a directory browser.

import { $, esc, flash, ic } from "./utils.js";
import { getParents, addParent, removeParent, reorderParents, browseDir } from "./api.js";
import { loadParents } from "./create.js";

let browseCur = null;     // path currently shown in the browser
let browseParent = null;  // its parent dir (null at filesystem root)

/** Render the list of configured parents, each with a remove button. */
async function renderParents() {
  const list = $("parentList");
  let parents;
  try { parents = await getParents(); }
  catch (e) { list.innerHTML = ""; flash($("settingsMsg"), e.message, false); return; }

  if (!parents.length) {
    list.innerHTML = '<div class="empty-mini">None yet — pick one below.</div>';
    return;
  }
  list.innerHTML = "";
  parents.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "parent-row";
    const upDis = i === 0 ? "disabled" : "";
    const downDis = i === parents.length - 1 ? "disabled" : "";
    row.innerHTML = `<span class="parent-path mono">${esc(p)}</span>
      <button class="iconbtn parent-move" type="button" aria-label="Move up" title="Move up" ${upDis}>${ic.arrowUp}</button>
      <button class="iconbtn parent-move" type="button" aria-label="Move down" title="Move down" ${downDis}>${ic.arrowDown}</button>
      <button class="iconbtn parent-del" type="button" aria-label="Remove parent" title="Remove">${ic.trash}</button>`;
    const [upBtn, downBtn] = row.querySelectorAll(".parent-move");
    upBtn.addEventListener("click", () => move(parents, i, i - 1));
    downBtn.addEventListener("click", () => move(parents, i, i + 1));
    row.querySelector(".parent-del").addEventListener("click", async () => {
      try {
        await removeParent(p);
        await renderParents();
        await loadParents();
      } catch (e) { flash($("settingsMsg"), e.message, false); }
    });
    list.appendChild(row);
  });
}

/** Swap two parents and persist the new order. */
async function move(parents, from, to) {
  if (to < 0 || to >= parents.length) return;
  const next = [...parents];
  [next[from], next[to]] = [next[to], next[from]];
  try {
    await reorderParents(next);
    await renderParents();
    await loadParents();
  } catch (e) { flash($("settingsMsg"), e.message, false); }
}

/** Show the directory browser at `path` (null => server default start dir). */
async function renderBrowse(path) {
  let data;
  try { data = await browseDir(path); }
  catch (e) { flash($("settingsMsg"), e.message, false); return; }

  browseCur = data.path;
  browseParent = data.parent;
  $("browsePath").textContent = data.path;
  $("browseUp").disabled = !data.parent;

  const list = $("browseList");
  if (!data.dirs.length) {
    list.innerHTML = '<div class="empty-mini">No subfolders here.</div>';
    return;
  }
  list.innerHTML = "";
  const sep = data.path.endsWith("/") ? "" : "/";
  for (const d of data.dirs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "browse-row";
    row.innerHTML = `${ic.folder}<span>${esc(d)}</span>${ic.chevron}`;
    row.addEventListener("click", () => renderBrowse(data.path + sep + d));
    list.appendChild(row);
  }
}

export function openSettings() {
  $("scrim").classList.add("open");
  $("settingsSheet").classList.add("open");
  $("settingsMsg").textContent = "";
  renderParents();
  renderBrowse(null);
}

export function closeSettings() {
  $("settingsSheet").classList.remove("open");
  $("scrim").classList.remove("open");
}

/** Wire the gear button + browser controls. Call once on load. */
export function initSettings() {
  $("settingsBtn").addEventListener("click", openSettings);

  $("browseUp").addEventListener("click", () => {
    if (browseParent) renderBrowse(browseParent);
  });

  $("browseAdd").addEventListener("click", async () => {
    if (!browseCur) return;
    try {
      await addParent(browseCur);
      flash($("settingsMsg"), "Added " + browseCur, true);
      await renderParents();
      await loadParents();
    } catch (e) { flash($("settingsMsg"), e.message, false); }
  });
}
