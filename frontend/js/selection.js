// Multiselect mode driven by a contextual toolbar in the header.
// Entered via the "Select" link or a long-press on a card (see sessions.js).

import { $ } from "./utils.js";
import { confirmKill } from "./dialog.js";

let selectMode = false;
/** Names of currently selected sessions. Read by sessions.js when rendering. */
export const selected = new Set();

/** Whether multiselect mode is active. */
export const isSelecting = () => selectMode;

/** All session names currently rendered in the list. */
function allNames() {
  return [...document.querySelectorAll(".card[data-name]")].map((c) => c.dataset.name);
}

/** Refresh the toolbar: count, kill-enabled, and the Select-all/none label. */
export function updateBar() {
  const n = selected.size;
  $("selKill").disabled = n === 0;
  const names = allNames();
  const allSel = names.length > 0 && names.every((name) => selected.has(name));
  $("selAll").textContent = allSel ? "Deselect all" : "Select all";
}

export function toggleSelect(name, el) {
  if (selected.has(name)) { selected.delete(name); el.classList.remove("sel"); }
  else { selected.add(name); el.classList.add("sel"); }
  updateBar();
}

export function enterSelect() {
  if (selectMode) return;
  selectMode = true;
  document.body.classList.add("selecting");
  updateBar();
}

export function exitSelect() {
  selectMode = false;
  selected.clear();
  document.body.classList.remove("selecting");
  document.querySelectorAll(".card.sel").forEach((c) => c.classList.remove("sel"));
}

/** Enter select mode and select one card — used by long-press. */
export function beginSelectionWith(name, el) {
  enterSelect();
  if (!selected.has(name)) toggleSelect(name, el);
}

function toggleAll() {
  const names = allNames();
  const allSel = names.length > 0 && names.every((name) => selected.has(name));
  document.querySelectorAll(".card[data-name]").forEach((c) => {
    if (allSel) { selected.delete(c.dataset.name); c.classList.remove("sel"); }
    else { selected.add(c.dataset.name); c.classList.add("sel"); }
  });
  updateBar();
}

/** Drop selected names that are no longer present; returns true if anything changed. */
export function pruneSelection(liveNames) {
  if (!selected.size) return false;
  const live = new Set(liveNames);
  let changed = false;
  for (const n of [...selected]) if (!live.has(n)) { selected.delete(n); changed = true; }
  if (changed) updateBar();
  return changed;
}

/** Wire the Select link and the toolbar buttons. Call once on load. */
export function initSelection() {
  $("selectToggle").addEventListener("click", () => (selectMode ? exitSelect() : enterSelect()));
  $("selCancel").addEventListener("click", exitSelect);
  $("selAll").addEventListener("click", toggleAll);
  $("selKill").addEventListener("click", () => {
    if (selected.size) confirmKill([...selected]);
  });
}
