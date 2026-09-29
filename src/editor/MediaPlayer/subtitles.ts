/* ============================================================
   sparkBook · src/editor/MediaPlayer/subtitles.ts
   SubRip (.srt) and WebVTT (.vtt) parsing for the video player.

   The player draws cues itself instead of handing a <track> to the
   engine: <track> only accepts WebVTT, renders differently in
   WebKit and Chromium, and cannot be shifted in time without
   rebuilding every cue. Parsed cues are plain data, so the delay
   control is one addition at lookup time.
   ============================================================ */

/** A run of cue text with the only styling SRT and VTT agree on. */
export interface CueSpan { text: string; i?: boolean; b?: boolean; u?: boolean }

export interface Cue {
  start: number;
  end: number;
  /** One entry per displayed line. */
  lines: CueSpan[][];
}

export interface SubtitleTrack {
  /** Absolute path of the subtitle file. Also the track id. */
  path: string;
  label: string;
}

export const SUBTITLE_EXTENSIONS = ["srt", "vtt"] as const;

const STAMP = String.raw`(?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?`;
const TIMING = new RegExp(String.raw`^\s*(${STAMP})\s*-->\s*(${STAMP})`);

/** "01:02:03,450" / "02:03.4" → seconds. Null when it is not a timestamp. */
export function parseTimestamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", lrm: "\u200e", rlm: "\u200f",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Split one cue line into styled spans. <i>, <b> and <u> are honoured;
 * every other tag (VTT voice and class spans, SRT <font>, karaoke
 * timestamps) is dropped, as are ASS override blocks such as {\an8}.
 * Nothing here is ever rendered as HTML.
 */
export function parseCueLine(line: string): CueSpan[] {
  const src = line.replace(/\{\\[^}]*\}/g, "");
  const spans: CueSpan[] = [];
  const state = { i: false, b: false, u: false };
  const tag = /<([^>]*)>/g;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const span: CueSpan = { text: decodeEntities(text) };
    if (state.i) span.i = true;
    if (state.b) span.b = true;
    if (state.u) span.u = true;
    spans.push(span);
  };
  for (let m = tag.exec(src); m; m = tag.exec(src)) {
    push(src.slice(last, m.index));
    last = m.index + m[0].length;
    const style = /^(\/?)\s*([ibu])(?:[\s.]|$)/i.exec(m[1]);
    if (style) state[style[2].toLowerCase() as "i" | "b" | "u"] = style[1] !== "/";
  }
  push(src.slice(last));
  return spans;
}

/** Parse SRT or WebVTT text into cues sorted by start time. Malformed
    blocks are skipped rather than failing the whole file. */
export function parseSubtitles(text: string): Cue[] {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];
  for (const block of src.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n");
    // SRT puts a counter above the timing line; VTT an optional id.
    const at = lines.findIndex((l, i) => i < 3 && TIMING.test(l));
    if (at < 0) continue;
    const m = TIMING.exec(lines[at])!;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start == null || end == null || end <= start) continue;
    const body = lines.slice(at + 1).filter((l) => l.trim() !== "");
    if (!body.length) continue;
    cues.push({ start, end, lines: body.map(parseCueLine).filter((l) => l.length) });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Cues showing at `time`. Overlapping cues are all returned, in order. */
export function cuesAt(cues: readonly Cue[], time: number): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    if (c.start > time) break;
    if (time < c.end) out.push(c);
  }
  return out;
}

/**
 * Decode subtitle bytes. Subtitle files are still often Windows-1252
 * or UTF-16, which a UTF-8 read would mangle or reject outright, so the
 * encoding is chosen from the BOM, then strict UTF-8, then 1252.
 */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Subtitle files that belong to `videoName`, found among its sibling
 * file names: `film.srt`, `film.en.srt`, `Film.English.vtt`. The match is
 * case-insensitive. The exact-stem file sorts first so it is the one
 * shown by default.
 */
export function findSidecars(videoName: string, siblings: readonly string[]): Array<{ name: string; label: string }> {
  const stem = stemOf(videoName).toLowerCase();
  const out: Array<{ name: string; label: string; exact: boolean }> = [];
  for (const name of siblings) {
    const dot = name.lastIndexOf(".");
    const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
    if (!(SUBTITLE_EXTENSIONS as readonly string[]).includes(ext)) continue;
    const s = stemOf(name);
    const lower = s.toLowerCase();
    if (lower === stem) out.push({ name, label: ext.toUpperCase(), exact: true });
    else if (lower.startsWith(`${stem}.`)) out.push({ name, label: s.slice(stem.length + 1), exact: false });
  }
  out.sort((a, b) => (a.exact === b.exact ? a.name.localeCompare(b.name) : a.exact ? -1 : 1));
  return out.map(({ name, label }) => ({ name, label }));
}
