/* ============================================================
   sparkBook · src/editor/MediaPlayer/useMediaElement.ts
   A React snapshot of an HTMLMediaElement.

   The element is the single source of truth. Events refresh the
   snapshot; while playing, a frame loop refreshes `time` so the
   scrubber moves smoothly rather than in 250 ms `timeupdate` steps.
   ============================================================ */
import { useEffect, useState } from "react";

export interface MediaSnapshot {
  paused: boolean;
  ended: boolean;
  time: number;
  duration: number;
  buffered: Array<[number, number]>;
  volume: number;
  muted: boolean;
  rate: number;
  /** Playback wants to advance but is starved of data. */
  waiting: boolean;
  /** Metadata has loaded: duration and dimensions are known. */
  ready: boolean;
  error: MediaError | null;
  width: number;
  height: number;
}

export const EMPTY_SNAPSHOT: MediaSnapshot = {
  paused: true, ended: false, time: 0, duration: NaN, buffered: [],
  volume: 1, muted: false, rate: 1, waiting: false, ready: false, error: null,
  width: 0, height: 0,
};

const EVENTS = [
  "play", "pause", "playing", "ended", "timeupdate", "durationchange", "loadedmetadata",
  "loadeddata", "canplay", "canplaythrough", "progress", "volumechange", "ratechange",
  "waiting", "stalled", "seeking", "seeked", "error", "emptied", "resize",
] as const;

function ranges(tr: TimeRanges): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < tr.length; i++) out.push([tr.start(i), tr.end(i)]);
  return out;
}

export function readSnapshot(el: HTMLMediaElement): MediaSnapshot {
  const video = el as HTMLVideoElement;
  return {
    paused: el.paused,
    ended: el.ended,
    time: el.currentTime,
    duration: el.duration,
    buffered: ranges(el.buffered),
    volume: el.volume,
    muted: el.muted,
    rate: el.playbackRate,
    waiting: !el.paused && !el.ended && !el.error && (el.seeking || el.readyState < 3),
    ready: el.readyState >= 1,
    error: el.error,
    width: video.videoWidth ?? 0,
    height: video.videoHeight ?? 0,
  };
}

export function useMediaElement(el: HTMLMediaElement | null): MediaSnapshot {
  const [snap, setSnap] = useState<MediaSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    if (!el) { setSnap(EMPTY_SNAPSHOT); return; }
    let frame = 0;
    const tick = () => {
      setSnap((s) => (s.time === el.currentTime ? s : { ...s, time: el.currentTime }));
      frame = requestAnimationFrame(tick);
    };
    const refresh = () => {
      const next = readSnapshot(el);
      setSnap(next);
      cancelAnimationFrame(frame);
      if (!next.paused && !next.ended) frame = requestAnimationFrame(tick);
    };
    refresh();
    for (const ev of EVENTS) el.addEventListener(ev, refresh);
    return () => {
      cancelAnimationFrame(frame);
      for (const ev of EVENTS) el.removeEventListener(ev, refresh);
    };
  }, [el]);

  return snap;
}
