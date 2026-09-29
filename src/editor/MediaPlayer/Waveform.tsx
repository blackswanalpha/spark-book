/* ============================================================
   sparkBook · src/editor/MediaPlayer/Waveform.tsx
   Clickable waveform overview for the audio player.

   Two canvases with the same drawing: the base in a muted colour
   and a copy in the accent colour clipped to the played portion.
   Progress is a clip-path change, so playback never redraws.
   ============================================================ */
import { useEffect, useRef } from "react";
import { formatTime } from "./time";
import { resamplePeaks } from "./peaks";
import { useScrub } from "./parts";

const BAR = 2;
const GAP = 1;

function draw(canvas: HTMLCanvasElement, peaks: Float32Array) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).color;
  const bar = BAR * dpr;
  const step = (BAR + GAP) * dpr;
  const n = Math.max(1, Math.floor(w / step));
  const p = resamplePeaks(peaks, n);
  // Normalise to the loudest point so quiet recordings are still legible.
  let norm = 0;
  for (let i = 0; i < p.length; i++) norm = Math.max(norm, Math.abs(p[i]));
  norm = norm || 1;
  const mid = h / 2;
  const amp = (h / 2) * 0.94;
  for (let i = 0; i < n; i++) {
    const top = mid - (p[i * 2 + 1] / norm) * amp;
    const bottom = mid - (p[i * 2] / norm) * amp;
    ctx.fillRect(i * step, top, bar, Math.max(dpr, bottom - top));
  }
}

export function Waveform({ peaks, time, duration, ab, onSeek }: {
  peaks: Float32Array;
  time: number;
  duration: number;
  ab: { a: number | null; b: number | null };
  onSeek: (t: number) => void;
}) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const playedRef = useRef<HTMLCanvasElement>(null);
  const { drag, hover, handlers } = useScrub(duration, onSeek);

  useEffect(() => {
    const redraw = () => {
      if (baseRef.current) draw(baseRef.current, peaks);
      if (playedRef.current) draw(playedRef.current, peaks);
    };
    redraw();
    const ro = new ResizeObserver(redraw);
    if (baseRef.current) ro.observe(baseRef.current);
    // Colours come from the theme; a theme switch has to repaint.
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [peaks]);

  const known = Number.isFinite(duration) && duration > 0;
  const shown = drag ?? time;
  const frac = known ? Math.max(0, Math.min(1, shown / duration)) : 0;
  const pct = (t: number) => `${known ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0}%`;
  const tip = drag ?? hover;

  return (
    <div
      className="mp-wave"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={known ? Math.floor(duration) : 0}
      aria-valuenow={Math.floor(shown)}
      aria-valuetext={`${formatTime(shown, duration)} of ${formatTime(duration)}`}
      {...handlers}
    >
      {ab.a != null && (
        <div className="mp-wave__ab" style={{ left: pct(ab.a), width: ab.b != null && known ? `${((ab.b - ab.a) / duration) * 100}%` : "2px" }} />
      )}
      <canvas ref={baseRef} className="mp-wave__base" aria-hidden />
      <canvas ref={playedRef} className="mp-wave__played" aria-hidden
        style={{ clipPath: `inset(0 ${(1 - frac) * 100}% 0 0)` }} />
      <div className="mp-wave__head" style={{ left: `${frac * 100}%` }} />
      {tip != null && known && (
        <div className="mp-wave__tip" style={{ left: pct(tip) }}>{formatTime(tip, duration)}</div>
      )}
    </div>
  );
}
