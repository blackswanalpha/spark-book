/* ============================================================
   sparkBook · src/editor/MediaPlayer/videoHooks.ts
   Video-only behaviour: subtitles, scrubber thumbnails, frame
   rate measurement, fullscreen and picture-in-picture.
   ============================================================ */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTauri, openFileDialog, readDir, readFileBase64 } from "@bridge/commands";
import { basename } from "@store/documents";
import { base64ToBytes } from "@lib/binary";
import {
  decodeSubtitleBytes, findSidecars, parseSubtitles, SUBTITLE_EXTENSIONS,
  type Cue, type SubtitleTrack,
} from "./subtitles";
import { snapFps } from "./time";

/* ---------- Paths ---------- */

/** Parent directory of `path`, keeping the separator style of the input. */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return ".";
  if (i === 0) return path[0];
  const dir = path.slice(0, i);
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
}

function sibling(path: string, name: string): string {
  const dir = dirOf(path);
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/* ---------- Subtitles ---------- */

export interface SubtitleState {
  tracks: SubtitleTrack[];
  active: string | null;
  cues: Cue[];
  /** Seconds added to every cue. Positive shows subtitles later. */
  delay: number;
  error: string | null;
  select: (path: string | null) => void;
  setDelay: (s: number) => void;
  /** Captions key: off when on, back to the last track when off. */
  toggle: () => boolean;
  addFromDialog: () => Promise<void>;
}

export function useSubtitles(videoPath: string | null): SubtitleState {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [delay, setDelay] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, Cue[]>());
  const lastActive = useRef<string | null>(null);

  // Sidecar discovery: film.srt, film.en.vtt … next to the video.
  useEffect(() => {
    setTracks([]);
    setActive(null);
    setDelay(0);
    setError(null);
    cache.current.clear();
    lastActive.current = null;
    if (!videoPath) return;
    let cancelled = false;
    readDir(dirOf(videoPath))
      .then((entries) => {
        if (cancelled) return;
        const names = entries.filter((e) => e.isFile).map((e) => e.name);
        const found = findSidecars(basename(videoPath), names)
          .map((s) => ({ path: sibling(videoPath, s.name), label: s.label }));
        setTracks(found);
        if (found.length) setActive(found[0].path);
      })
      .catch(() => { /* unreadable folder: no sidecars, not an error */ });
    return () => { cancelled = true; };
  }, [videoPath]);

  useEffect(() => {
    if (active) lastActive.current = active;
    if (!active) { setCues([]); setError(null); return; }
    const hit = cache.current.get(active);
    if (hit) { setCues(hit); setError(null); return; }
    let cancelled = false;
    readFileBase64(active)
      .then((b64) => {
        const parsed = parseSubtitles(decodeSubtitleBytes(base64ToBytes(b64)));
        cache.current.set(active, parsed);
        if (cancelled) return;
        setCues(parsed);
        setError(parsed.length ? null : "No subtitle cues were found in this file.");
      })
      .catch(() => {
        if (!cancelled) { setCues([]); setError("The subtitle file could not be read."); }
      });
    return () => { cancelled = true; };
  }, [active]);

  const toggle = useCallback(() => {
    if (active) { setActive(null); return true; }
    const next = lastActive.current ?? tracks[0]?.path ?? null;
    if (!next) return false;
    setActive(next);
    return true;
  }, [active, tracks]);

  const addFromDialog = useCallback(async () => {
    const picked = await openFileDialog({
      filters: [{ name: "Subtitles", extensions: [...SUBTITLE_EXTENSIONS] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    setTracks((t) => (t.some((x) => x.path === path) ? t : [...t, { path, label: basename(path) }]));
    cache.current.delete(path);
    setActive(path);
  }, []);

  return { tracks, active, cues, delay, error, select: setActive, setDelay, toggle, addFromDialog };
}

/* ---------- Scrubber thumbnails ---------- */

const THUMB_WIDTH = 160;
const THUMB_CACHE = 150;

/**
 * Frames for the scrubber tooltip, grabbed from a second, muted <video>
 * on the same URL so the main picture never moves. Requests are
 * coalesced: while one seek is in flight only the latest hover position
 * is kept, and finished frames are cached per time bucket.
 */
export function useThumbnailer(url: string | null) {
  const s = useRef({
    video: null as HTMLVideoElement | null,
    cache: new Map<number, HTMLCanvasElement>(),
    want: null as number | null,
    inFlight: null as number | null,
    target: null as HTMLCanvasElement | null,
    failed: false,
  });
  const [available, setAvailable] = useState(true);

  const draw = useCallback((key: number) => {
    const frame = s.current.cache.get(key);
    const target = s.current.target;
    if (!frame || !target) return;
    if (target.width !== frame.width || target.height !== frame.height) {
      target.width = frame.width;
      target.height = frame.height;
    }
    target.getContext("2d")?.drawImage(frame, 0, 0);
  }, []);

  const next = useCallback(() => {
    const st = s.current;
    const v = st.video;
    if (!v || st.inFlight != null || st.want == null || v.readyState < 1) return;
    if (st.cache.has(st.want)) { draw(st.want); return; }
    st.inFlight = st.want;
    v.currentTime = st.want;
  }, [draw]);

  useEffect(() => {
    const st = s.current;
    setAvailable(!!url);
    st.failed = false;
    return () => {
      if (st.video) {
        st.video.removeAttribute("src");
        st.video.load();
      }
      st.video = null;
      st.cache.clear();
      st.want = null;
      st.inFlight = null;
    };
  }, [url]);

  const ensure = useCallback(() => {
    const st = s.current;
    if (st.video || !url || st.failed) return;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.addEventListener("loadedmetadata", next);
    v.addEventListener("seeked", () => {
      const key = st.inFlight;
      st.inFlight = null;
      if (key != null && v.videoWidth > 0) {
        const c = document.createElement("canvas");
        c.width = THUMB_WIDTH;
        c.height = Math.max(1, Math.round((THUMB_WIDTH * v.videoHeight) / v.videoWidth));
        c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
        st.cache.set(key, c);
        if (st.cache.size > THUMB_CACHE) st.cache.delete(st.cache.keys().next().value as number);
        if (st.want === key) draw(key);
      }
      next();
    });
    v.addEventListener("error", () => { st.failed = true; setAvailable(false); });
    v.src = url;
    st.video = v;
  }, [url, next, draw]);

  const request = useCallback((t: number, duration: number) => {
    if (!url || s.current.failed) return;
    const step = duration > 1800 ? 5 : duration > 300 ? 2 : duration > 60 ? 1 : 0.25;
    const key = Math.min(Math.max(0, duration - 0.05), Math.round(t / step) * step);
    s.current.want = key;
    if (s.current.cache.has(key)) { draw(key); return; }
    ensure();
    next();
  }, [url, ensure, next, draw]);

  const setTarget = useCallback((c: HTMLCanvasElement | null) => {
    s.current.target = c;
    if (c && s.current.want != null) draw(s.current.want);
  }, [draw]);

  return { available, request, setTarget };
}

/* ---------- Frame rate ---------- */

type FrameMeta = { mediaTime: number };
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/**
 * Measured frame rate, or null until enough frames were seen. The media
 * element does not expose the stream's rate, so it is inferred from the
 * smallest gap between presented frames and snapped to the nearest
 * broadcast rate. Used for frame stepping and the stats overlay.
 */
export function useFrameRate(video: HTMLVideoElement | null): number | null {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    setFps(null);
    const v = video as RvfcVideo | null;
    if (!v || typeof v.requestVideoFrameCallback !== "function") return;
    let handle = 0;
    let last: number | null = null;
    let best = Infinity;
    let seen = 0;
    const onFrame = (_: number, meta: FrameMeta) => {
      if (last != null) {
        const d = meta.mediaTime - last;
        if (d > 0.002 && d < 0.2 && d < best) best = d;
        if (++seen >= 8 && Number.isFinite(best)) setFps(snapFps(1 / best));
      }
      last = meta.mediaTime;
      handle = v.requestVideoFrameCallback!(onFrame);
    };
    handle = v.requestVideoFrameCallback(onFrame);
    return () => v.cancelVideoFrameCallback?.(handle);
  }, [video]);
  return fps;
}

/* ---------- Fullscreen ---------- */

async function setWindowFullscreen(on: boolean) {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  } catch {
    /* permission missing or unsupported: the in-window fallback still works */
  }
}

/**
 * Element fullscreen where the engine grants it. Where it does not
 * (some webviews ship with it disabled) the player covers the whole
 * window instead and, under Tauri, the window itself goes fullscreen.
 */
export function useFullscreen(ref: RefObject<HTMLElement>) {
  const [native, setNative] = useState(false);
  const [pseudo, setPseudo] = useState(false);

  useEffect(() => {
    const onChange = () => setNative(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [ref]);

  useEffect(() => {
    if (!pseudo) return;
    document.documentElement.classList.add("mp-pseudo-fs");
    void setWindowFullscreen(true);
    return () => {
      document.documentElement.classList.remove("mp-pseudo-fs");
      void setWindowFullscreen(false);
    };
  }, [pseudo]);

  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setPseudo(false);
  }, []);

  const toggle = useCallback(async () => {
    if (native || pseudo) { exit(); return; }
    const el = ref.current;
    if (el && typeof el.requestFullscreen === "function" && document.fullscreenEnabled !== false) {
      try { await el.requestFullscreen(); return; } catch { /* refused: use the fallback */ }
    }
    setPseudo(true);
  }, [native, pseudo, exit, ref]);

  return { active: native || pseudo, pseudo, toggle, exit };
}

/* ---------- Picture in picture ---------- */

type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

export function usePictureInPicture(video: HTMLVideoElement | null) {
  const [active, setActive] = useState(false);
  const v = video as WebkitVideo | null;
  const standard = !!v && !!document.pictureInPictureEnabled && typeof v.requestPictureInPicture === "function";
  const webkit = !!v && typeof v.webkitSupportsPresentationMode === "function" && v.webkitSupportsPresentationMode("picture-in-picture");

  useEffect(() => {
    if (!v) return;
    const on = () => setActive(true);
    const off = () => setActive(false);
    const wk = () => setActive(v.webkitPresentationMode === "picture-in-picture");
    v.addEventListener("enterpictureinpicture", on);
    v.addEventListener("leavepictureinpicture", off);
    v.addEventListener("webkitpresentationmodechanged", wk);
    return () => {
      v.removeEventListener("enterpictureinpicture", on);
      v.removeEventListener("leavepictureinpicture", off);
      v.removeEventListener("webkitpresentationmodechanged", wk);
    };
  }, [v]);

  const toggle = useCallback(async () => {
    if (!v) return;
    try {
      if (standard) {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await v.requestPictureInPicture();
      } else if (webkit) {
        v.webkitSetPresentationMode?.(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
      }
    } catch {
      /* metadata not loaded yet, or the engine refused */
    }
  }, [v, standard, webkit]);

  return { supported: standard || webkit, active, toggle };
}
