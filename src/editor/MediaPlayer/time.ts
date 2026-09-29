/* ============================================================
   sparkBook · src/editor/MediaPlayer/time.ts
   Clock and rate formatting for the transport.
   ============================================================ */

/** Playback rates the speed menu and the `<` / `>` keys step through. */
export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

/**
 * 0:07 · 4:05 · 1:02:03. Hours appear when `ref` (normally the duration)
 * reaches an hour, so the readout keeps one width for the whole file.
 * Non-finite input (unknown duration, live streams) renders as "--:--".
 */
export function formatTime(seconds: number, ref: number = seconds): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const neg = seconds < 0;
  let s = Math.floor(Math.abs(seconds) + 1e-6);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const showHours = h > 0 || (Number.isFinite(ref) && Math.abs(ref) >= 3600);
  const ss = String(s).padStart(2, "0");
  const body = showHours ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  return neg ? `-${body}` : body;
}

/** 1× · 1.5× · 0.25× */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** The next rate above (`dir` 1) or below (-1) `rate`, clamped to the list. */
export function stepRate(rate: number, dir: 1 | -1): number {
  if (dir > 0) return RATES.find((r) => r > rate + 1e-6) ?? RATES[RATES.length - 1];
  return [...RATES].reverse().find((r) => r < rate - 1e-6) ?? RATES[0];
}

/** Snap a measured frame rate to the broadcast rate it almost certainly is. */
export function snapFps(fps: number): number {
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
  let best = fps;
  let bestErr = Infinity;
  for (const c of common) {
    const err = Math.abs(c - fps) / c;
    if (err < bestErr) { best = c; bestErr = err; }
  }
  return bestErr < 0.04 ? best : Math.round(fps);
}
