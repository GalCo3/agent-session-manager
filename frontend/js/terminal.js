// In-page terminal modal: loads the ttyd session in a full-screen iframe
// instead of opening a new browser tab.

import { $ } from "./utils.js";
import { getTerminal } from "./api.js";

let openName = null;
let raf = 0;

// Keep the modal sized to the *visual* viewport so the terminal's bottom input
// line stays above the on-screen keyboard. iOS/Android shrink the visual
// viewport when the keyboard opens, but a fixed 100dvh element keeps its full
// height and sits behind the keyboard. Resizing the modal shrinks the iframe,
// which makes ttyd refit xterm (fewer rows) so Claude's prompt scrolls in view.
function syncViewport() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const vv = window.visualViewport;
    if (!vv) return;
    const m = $("termModal");
    m.style.height = vv.height + "px";
    m.style.top = vv.offsetTop + "px";
  });
}

function bindViewport(on) {
  const vv = window.visualViewport;
  if (!vv) return;
  if (on) {
    vv.addEventListener("resize", syncViewport);
    vv.addEventListener("scroll", syncViewport);
    syncViewport();
  } else {
    vv.removeEventListener("resize", syncViewport);
    vv.removeEventListener("scroll", syncViewport);
    const m = $("termModal");
    m.style.height = "";
    m.style.top = "";
  }
}

// Build a fresh iframe inside .term-body. We never reuse the iframe across
// opens: ttyd registers a `beforeunload` handler ("leave site?" confirm), so
// navigating it (e.g. src="about:blank") on close pops that dialog. Removing
// the element tears ttyd down silently — no prompt.
function makeFrame(url) {
  const body = document.querySelector("#termModal .term-body");
  body.replaceChildren();
  const f = document.createElement("iframe");
  f.id = "termFrame";
  f.title = "Terminal";
  f.setAttribute("allow", "clipboard-read; clipboard-write");
  f.src = url;
  body.appendChild(f);
}

/** Open the terminal modal for a session, loading its ttyd URL in the iframe. */
export async function openTerminal(name) {
  const { url } = await getTerminal(name);
  openName = name;
  $("termTitle").textContent = name;
  $("termPop").href = url;          // pop-out fallback opens the same URL
  makeFrame(url);
  $("termModal").classList.add("open");
  document.body.classList.add("term-open");
  bindViewport(true);
}

export function closeTerminal() {
  if (!openName) return;
  $("termModal").classList.remove("open");
  document.body.classList.remove("term-open");
  // Remove the iframe element (not navigate it) so ttyd's beforeunload
  // handler can't pop a "leave site?" confirm. Next open builds a fresh one.
  document.querySelector("#termModal .term-body").replaceChildren();
  bindViewport(false);
  openName = null;
}

export const isTerminalOpen = () => openName !== null;

/** Wire the close button. Call once on load. */
export function initTerminal() {
  $("termClose").addEventListener("click", closeTerminal);
}
