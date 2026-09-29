/* ============================================================
   sparkBook · src/editor/MediaPlayer/useTransport.ts
   Everything the video and audio players do the same way:
   play/seek/volume/speed, whole-file and A-B loops, remembered
   volume and position, the transient on-screen feedback, and the
   OS media session (media keys, lock-screen controls).
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaSnapshot } from "./useMediaElement";
import type { MediaAction } from "./keymap";
import { formatRate, formatTime, stepRate } from "./time";
import { loadPrefs, loadResume, savePrefs, saveResume } from "./prefs";

export interface SessionMeta {
  title: string;
  artist?: string;
  album?: string;
  /** Object or data URL of cover art. */
  artwork?: string;
}

export interface Bezel { id: number; text: string; icon?: string }

export interface Transport {
  toggle: () => void;
  seek: (t: number) => void;
  seekBy: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setRate: (r: number) => void;
  loop: boolean;
  toggleLoop: () => void;
  ab: { a: number | null; b: number | null };
  cycleAB: () => void;
  bezel: Bezel | null;
  flash: (text: string, icon?: string) => void;
  /** Run a key action shared by both players. False when not handled here. */
  run: (a: MediaAction) => boolean;
}

/** How often the resume position is written while playing, in seconds. */
const RESUME_EVERY = 5;

export function useTransport(
  el: HTMLMediaElement | null,
  snap: MediaSnapshot,
  path: string | null,
  meta: SessionMeta,
): Transport {
  const [loop, setLoop] = useState(false);
  const [ab, setAb] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [bezel, setBezel] = useState<Bezel | null>(null);
  const bezelTimer = useRef<number>(0);
  const bezelId = useRef(0);

  const flash = useCallback((text: string, icon?: string) => {
    window.clearTimeout(bezelTimer.current);
    setBezel({ id: ++bezelId.current, text, icon });
    bezelTimer.current = window.setTimeout(() => setBezel(null), 900);
  }, []);
  useEffect(() => () => window.clearTimeout(bezelTimer.current), []);

  /* ---------- Element setup: remembered volume, pitch, loop ---------- */
  useEffect(() => {
    if (!el) return;
    const p = loadPrefs();
    el.volume = p.volume;
    el.muted = p.muted;
    // Speed changes should not turn voices into chipmunks.
    el.preservesPitch = true;
    (el as HTMLMediaElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    const onVolume = () => savePrefs({ volume: el.volume, muted: el.muted });
    el.addEventListener("volumechange", onVolume);
    return () => el.removeEventListener("volumechange", onVolume);
  }, [el]);

  useEffect(() => { if (el) el.loop = loop; }, [el, loop]);

  // A new file starts with no A-B loop.
  useEffect(() => { setAb({ a: null, b: null }); }, [path]);

  /* ---------- Resume where the file was left ---------- */
  // Last known position of *this* path. When the source is swapped (asset
  // → in-memory fallback) the new source continues from here instead of
  // jumping back to the saved resume point.
  const position = useRef(0);
  useEffect(() => { position.current = 0; }, [path]);

  useEffect(() => {
    if (!el || !path) return;
    let lastSaved = -Infinity;
    const onMeta = () => {
      const target = position.current > 0 ? position.current : loadResume(path, el.duration);
      if (target && target > 0 && target < el.duration) {
        el.currentTime = target;
        if (position.current <= 0) flash(`Resumed at ${formatTime(target, el.duration)}`, "clock-counter-clockwise");
      }
    };
    const onTime = () => {
      if (el.readyState < 1) return;
      position.current = el.currentTime;
      if (Math.abs(el.currentTime - lastSaved) >= RESUME_EVERY) {
        lastSaved = el.currentTime;
        saveResume(path, el.currentTime, el.duration);
      }
    };
    const onStop = () => {
      if (el.readyState >= 1) saveResume(path, el.currentTime, el.duration);
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("pause", onStop);
    el.addEventListener("ended", onStop);
    return () => {
      onStop();
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("pause", onStop);
      el.removeEventListener("ended", onStop);
    };
  }, [el, path, flash]);

  /* ---------- A-B loop enforcement ---------- */
  useEffect(() => {
    if (!el || ab.a == null || ab.b == null) return;
    if (snap.time >= ab.b || snap.ended) {
      el.currentTime = ab.a;
      if (el.paused && snap.ended) void el.play().catch(() => {});
    }
  }, [el, ab, snap.time, snap.ended]);

  /* ---------- Actions ---------- */
  const play = useCallback(() => {
    if (!el) return;
    if (el.ended) el.currentTime = 0;
    // AbortError (a newer load or pause won) and NotAllowedError are both
    // outcomes the UI already reflects through the element's state.
    void el.play().catch(() => {});
  }, [el]);

  const toggle = useCallback(() => {
    if (!el) return;
    if (el.paused || el.ended) play();
    else el.pause();
  }, [el, play]);

  const seek = useCallback((t: number) => {
    if (!el) return;
    const d = el.duration;
    const clamped = Math.max(0, Number.isFinite(d) ? Math.min(d, t) : t);
    el.currentTime = clamped;
    position.current = clamped;
  }, [el]);

  const seekBy = useCallback((s: number) => {
    if (!el) return;
    seek(el.currentTime + s);
    flash(`${s > 0 ? "+" : "−"}${Math.abs(s)} s`, s > 0 ? "clock-clockwise" : "clock-counter-clockwise");
  }, [el, seek, flash]);

  const setVolume = useCallback((v: number) => {
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, v));
    if (el.volume > 0) el.muted = false;
  }, [el]);

  const toggleMute = useCallback(() => {
    if (!el) return;
    el.muted = !el.muted;
    flash(el.muted ? "Muted" : `Volume ${Math.round(el.volume * 100)}%`, el.muted ? "speaker-x" : "speaker-high");
  }, [el, flash]);

  const setRate = useCallback((r: number) => {
    if (!el) return;
    try {
      el.playbackRate = r;
      // Survives a source swap, which resets playbackRate to this.
      el.defaultPlaybackRate = r;
    } catch {
      /* NotSupportedError: the engine refuses this rate; keep the old one */
    }
  }, [el]);

  const toggleLoop = useCallback(() => {
    const next = !loop;
    setLoop(next);
    flash(next ? "Loop on" : "Loop off", "repeat");
  }, [loop, flash]);

  const cycleAB = useCallback(() => {
    if (!el) return;
    const t = el.currentTime;
    const d = el.duration;
    if (ab.a == null) {
      setAb({ a: t, b: null });
      flash(`Loop from ${formatTime(t, d)}`, "repeat");
    } else if (ab.b == null) {
      const a = Math.min(ab.a, t);
      const b = Math.max(ab.a, t);
      if (b - a < 0.2) return;
      setAb({ a, b });
      flash(`Loop ${formatTime(a, d)} – ${formatTime(b, d)}`, "repeat");
    } else {
      setAb({ a: null, b: null });
      flash("A-B loop off", "repeat");
    }
  }, [el, ab, flash]);

  const run = useCallback((a: MediaAction): boolean => {
    if (!el) return false;
    switch (a.type) {
      case "toggle": toggle(); return true;
      case "seekBy": seekBy(a.seconds); return true;
      case "seekFraction":
        if (!Number.isFinite(el.duration)) return false;
        seek(el.duration * a.fraction);
        flash(`${Math.round(a.fraction * 100)}%`);
        return true;
      case "seekEdge":
        seek(a.edge === "start" ? 0 : el.duration);
        return true;
      case "volumeBy": {
        const v = Math.max(0, Math.min(1, Math.round((el.volume + a.delta) * 100) / 100));
        setVolume(v);
        flash(`Volume ${Math.round(v * 100)}%`, v === 0 ? "speaker-x" : v < 0.5 ? "speaker-low" : "speaker-high");
        return true;
      }
      case "mute": toggleMute(); return true;
      case "rate": {
        const r = stepRate(el.playbackRate, a.dir);
        setRate(r);
        flash(formatRate(r));
        return true;
      }
      case "abLoop": cycleAB(); return true;
      case "loop": toggleLoop(); return true;
      default: return false;
    }
  }, [el, toggle, seekBy, seek, flash, setVolume, toggleMute, setRate, cycleAB, toggleLoop]);

  /* ---------- OS media session ---------- */
  useMediaSession(el, meta, { toggle, seekBy, seek });

  return { toggle, seek, seekBy, setVolume, toggleMute, setRate, loop, toggleLoop, ab, cycleAB, bezel, flash, run };
}

function useMediaSession(
  el: HTMLMediaElement | null,
  meta: SessionMeta,
  act: { toggle: () => void; seekBy: (s: number) => void; seek: (t: number) => void },
) {
  const actRef = useRef(act);
  actRef.current = act;

  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!el || !ms || typeof MediaMetadata === "undefined") return;
    try {
      ms.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist ?? "",
        album: meta.album ?? "",
        artwork: meta.artwork ? [{ src: meta.artwork }] : [],
      });
    } catch {
      /* some engines reject artwork URLs they cannot fetch */
    }
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => { if (el.paused) actRef.current.toggle(); }],
      ["pause", () => { if (!el.paused) actRef.current.toggle(); }],
      ["seekbackward", (d) => actRef.current.seekBy(-(d.seekOffset ?? 10))],
      ["seekforward", (d) => actRef.current.seekBy(d.seekOffset ?? 10)],
      ["seekto", (d) => { if (d.seekTime != null) actRef.current.seek(d.seekTime); }],
      ["stop", () => { el.pause(); el.currentTime = 0; }],
    ];
    for (const [action, fn] of handlers) {
      try { ms.setActionHandler(action, fn); } catch { /* action unsupported here */ }
    }
    const sync = () => {
      ms.playbackState = el.paused ? "paused" : "playing";
      if (!Number.isFinite(el.duration) || typeof ms.setPositionState !== "function") return;
      try {
        ms.setPositionState({ duration: el.duration, playbackRate: el.playbackRate, position: Math.min(el.currentTime, el.duration) });
      } catch {
        /* position briefly outside [0, duration] during a source swap */
      }
    };
    const events = ["play", "pause", "seeked", "ratechange", "durationchange"];
    for (const ev of events) el.addEventListener(ev, sync);
    sync();
    return () => {
      for (const ev of events) el.removeEventListener(ev, sync);
      for (const [action] of handlers) {
        try { ms.setActionHandler(action, null); } catch { /* ignore */ }
      }
      ms.metadata = null;
      ms.playbackState = "none";
    };
  }, [el, meta.title, meta.artist, meta.album, meta.artwork]);
}
