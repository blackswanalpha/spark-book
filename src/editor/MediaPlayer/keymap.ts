/* ============================================================
   sparkBook · src/editor/MediaPlayer/keymap.ts
   Keyboard → player action. Pure, so the whole map is testable.

   Bindings follow YouTube where it has one (k j l , . < > 0-9 m f c)
   and mpv otherwise (z x for subtitle delay). Anything with Ctrl,
   Cmd or Alt is left alone: those belong to the app.
   ============================================================ */

export type MediaKind = "video" | "audio";

export type MediaAction =
  | { type: "toggle" }
  | { type: "seekBy"; seconds: number }
  | { type: "seekFraction"; fraction: number }
  | { type: "seekEdge"; edge: "start" | "end" }
  | { type: "volumeBy"; delta: number }
  | { type: "mute" }
  | { type: "rate"; dir: 1 | -1 }
  | { type: "frame"; dir: 1 | -1 }
  | { type: "fullscreen" }
  | { type: "escape" }
  | { type: "pip" }
  | { type: "captions" }
  | { type: "subDelay"; ms: number }
  | { type: "abLoop" }
  | { type: "loop" }
  | { type: "stats" }
  | { type: "help" };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

const VIDEO_ONLY = new Set<MediaAction["type"]>([
  "frame", "fullscreen", "pip", "captions", "subDelay", "stats",
]);

export function keyToAction(e: KeyLike, kind: MediaKind): MediaAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const a = map(e);
  if (!a) return null;
  if (kind === "audio" && VIDEO_ONLY.has(a.type)) return null;
  return a;
}

function map(e: KeyLike): MediaAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (/^[0-9]$/.test(key)) return { type: "seekFraction", fraction: Number(key) / 10 };
  switch (key) {
    case " ":
    case "k": return { type: "toggle" };
    case "ArrowLeft":  return { type: "seekBy", seconds: e.shiftKey ? -1 : -5 };
    case "ArrowRight": return { type: "seekBy", seconds: e.shiftKey ? 1 : 5 };
    case "j": return { type: "seekBy", seconds: -10 };
    case "l": return { type: "seekBy", seconds: 10 };
    case "ArrowUp":   return { type: "volumeBy", delta: 0.05 };
    case "ArrowDown": return { type: "volumeBy", delta: -0.05 };
    case "m": return { type: "mute" };
    case "Home": return { type: "seekEdge", edge: "start" };
    case "End":  return { type: "seekEdge", edge: "end" };
    case ",": return { type: "frame", dir: -1 };
    case ".": return { type: "frame", dir: 1 };
    case "<": return { type: "rate", dir: -1 };
    case ">": return { type: "rate", dir: 1 };
    case "f": return { type: "fullscreen" };
    case "Escape": return { type: "escape" };
    case "p": return { type: "pip" };
    case "c": return { type: "captions" };
    case "z": return { type: "subDelay", ms: -100 };
    case "x": return { type: "subDelay", ms: 100 };
    case "b": return { type: "abLoop" };
    case "r": return { type: "loop" };
    case "i": return { type: "stats" };
    case "?": return { type: "help" };
    default: return null;
  }
}

/** Rows for the shortcut sheet, grouped as they are shown. */
export const SHORTCUTS: Array<{ group: string; kind?: MediaKind; rows: Array<[string, string]> }> = [
  {
    group: "Playback",
    rows: [
      ["Space / K", "Play or pause"],
      ["← / →", "Back / forward 5 s (Shift: 1 s)"],
      ["J / L", "Back / forward 10 s"],
      ["0 – 9", "Jump to 0 – 90 %"],
      ["Home / End", "Start / end"],
      ["< / >", "Slower / faster"],
      ["B", "A-B loop: set A, set B, clear"],
      ["R", "Loop the whole file"],
    ],
  },
  {
    group: "Sound",
    rows: [
      ["↑ / ↓", "Volume up / down"],
      ["M", "Mute"],
    ],
  },
  {
    group: "Picture",
    kind: "video",
    rows: [
      [", / .", "Previous / next frame"],
      ["F", "Fullscreen"],
      ["P", "Picture in picture"],
      ["C", "Subtitles on / off"],
      ["Z / X", "Subtitles 100 ms earlier / later"],
      ["I", "Stats"],
    ],
  },
  { group: "Help", rows: [["?", "This sheet"]] },
];
