/* ============================================================
   sparkBook · src/editor/MediaPlayer/prefs.ts
   What the player remembers between sessions: volume, mute,
   subtitle size, and where each file was left off.

   localStorage can throw (private mode, quota, disabled storage);
   every access is guarded and a failure means "use the default".
   ============================================================ */

export type SubtitleSize = "s" | "m" | "l";

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  subtitleSize: SubtitleSize;
}

const PREFS_KEY = "spark.media.prefs";
const RESUME_KEY = "spark.media.resume";
/** Files remembered for resume. Oldest entries go first. */
export const RESUME_LIMIT = 200;
/** Positions closer than this to either end are not worth resuming. */
export const RESUME_MARGIN = 5;

const DEFAULTS: PlayerPrefs = { volume: 1, muted: false, subtitleSize: "m" };

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the preference lasts for this session only */
  }
}

export function loadPrefs(): PlayerPrefs {
  const p = read<Partial<PlayerPrefs>>(PREFS_KEY) ?? {};
  const volume = typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : DEFAULTS.volume;
  const size = p.subtitleSize === "s" || p.subtitleSize === "l" ? p.subtitleSize : DEFAULTS.subtitleSize;
  return { volume, muted: p.muted === true, subtitleSize: size };
}

export function savePrefs(patch: Partial<PlayerPrefs>) {
  write(PREFS_KEY, { ...loadPrefs(), ...patch });
}

type ResumeMap = Record<string, { t: number; at: number }>;

/** Saved position for `path`, or null when there is none worth using. */
export function loadResume(path: string, duration: number): number | null {
  const hit = read<ResumeMap>(RESUME_KEY)?.[path];
  if (!hit || !Number.isFinite(hit.t)) return null;
  if (hit.t < RESUME_MARGIN) return null;
  if (Number.isFinite(duration) && hit.t > duration - RESUME_MARGIN) return null;
  return hit.t;
}

/** Remember `time` for `path`; forget it when playback is at either end. */
export function saveResume(path: string, time: number, duration: number) {
  const map = read<ResumeMap>(RESUME_KEY) ?? {};
  const atEnd = Number.isFinite(duration) && time > duration - RESUME_MARGIN;
  if (time < RESUME_MARGIN || atEnd) {
    if (!(path in map)) return;
    delete map[path];
  } else {
    map[path] = { t: Math.round(time * 10) / 10, at: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > RESUME_LIMIT) {
      keys.sort((a, b) => map[a].at - map[b].at);
      for (const k of keys.slice(0, keys.length - RESUME_LIMIT)) delete map[k];
    }
  }
  write(RESUME_KEY, map);
}
