// Usage-limits strip: 5-hour + weekly utilization and reset countdowns.
// Data comes from /api/usage (cached 180s server-side). Stays hidden when
// usage can't be fetched, so it never nags.

import { $ } from "./utils.js";

let last = null; // most recent payload, for cheap countdown re-renders

function fmtReset(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return "";
  if (ms <= 0) return "resetting…";
  const m = Math.floor(ms / 60000);
  if (m < 60) return "resets in " + m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return "resets in " + h + "h " + (m % 60) + "m";
  const d = Math.floor(h / 24);
  return "resets in " + d + "d " + (h % 24) + "h";
}

function paint(meter, info) {
  const fill = meter.querySelector(".meter-fill");
  const pct = meter.querySelector(".meter-pct");
  const reset = meter.querySelector(".meter-reset");
  if (!info || typeof info.utilization !== "number") {
    fill.style.width = "0%"; pct.textContent = "—"; reset.textContent = "";
    fill.classList.remove("warn", "crit");
    return;
  }
  const u = Math.max(0, Math.min(100, Math.round(info.utilization)));
  fill.style.width = u + "%";
  pct.textContent = u + "%";
  reset.textContent = fmtReset(info.resets_at);
  fill.classList.toggle("warn", u >= 75 && u < 90);
  fill.classList.toggle("crit", u >= 90);
}

function render(data) {
  paint($("m5"), data.five_hour);
  paint($("mWk"), data.seven_day);
}

/** Fetch usage and reveal the strip; hide it quietly on any failure. */
export async function loadUsage() {
  try {
    const res = await fetch("/api/usage");
    if (!res.ok) throw new Error("usage " + res.status);
    const data = await res.json();
    if (!data.five_hour && !data.seven_day) throw new Error("no usage data");
    last = data;
    render(data);
    $("usage").hidden = false;
  } catch (_) {
    last = null;
    $("usage").hidden = true;
  }
}

/** Re-render reset countdowns from cached data (no network). */
export function tickUsage() {
  if (last) render(last);
}
