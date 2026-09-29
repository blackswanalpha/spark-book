/* ============================================================
   sparkBook · src/shell/zoom.ts
   Whole-UI zoom for View → Zoom In / Zoom Out / Reset Zoom.
   CSS `zoom` on the root element scales every surface at once
   and is honoured by both Chromium and WebKitGTK. The level is
   kept in localStorage and re-applied on boot.
   ============================================================ */

const KEY = "spark.zoom";
const MIN = 0.5;
const MAX = 2;
const STEP = 0.1;

let level = 1;

function apply(next: number) {
  // Rounded to one decimal so repeated steps land on 1.1, 1.2, …
  // instead of accumulating float error.
  level = Math.round(Math.min(MAX, Math.max(MIN, next)) * 10) / 10;
  const root = document.documentElement.style;
  if (level === 1) root.removeProperty("zoom");
  else root.setProperty("zoom", String(level));
  try { localStorage.setItem(KEY, String(level)); } catch { /* storage blocked: the zoom still holds for this session */ }
}

/** Re-apply the saved level. A missing or unreadable value leaves 100%. */
export function restoreZoom() {
  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem(KEY) ?? ""); } catch { /* storage blocked */ }
  if (Number.isFinite(saved)) apply(saved);
}

export const zoomIn = () => apply(level + STEP);
export const zoomOut = () => apply(level - STEP);
export const zoomReset = () => apply(1);
