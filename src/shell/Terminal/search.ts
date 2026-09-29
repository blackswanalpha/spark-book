/* ============================================================
   sparkBook · src/shell/Terminal/search.ts

   Geometry for find-in-terminal. The host searches the whole buffer
   and numbers lines from the oldest one in history (`pty_search`);
   these turn a line number into a viewport offset and back.

   Line L is on screen at row `L - (max - offset)`, where `max` is the
   history length and `offset` how far the view is scrolled back.
   ============================================================ */
import type { PtyMatch } from "@bridge/pty";

/** Scrollback offset that shows `line` a third of the way down. */
export function offsetForLine(
  line: number,
  scrollbackMax: number,
  rows: number,
): number {
  const target = scrollbackMax - line + Math.floor(rows / 3);
  return Math.max(0, Math.min(scrollbackMax, target));
}

export interface VisibleMatch {
  /** Index into the match list. */
  index: number;
  row: number;
  col: number;
  len: number;
}

/** The matches currently on screen, as viewport rows. */
export function visibleMatches(
  matches: PtyMatch[],
  scrollbackMax: number,
  scrolledBack: number,
  rows: number,
): VisibleMatch[] {
  const top = scrollbackMax - scrolledBack;
  const out: VisibleMatch[] = [];
  matches.forEach((m, index) => {
    const row = m.line - top;
    if (row >= 0 && row < rows)
      out.push({ index, row, col: m.col, len: m.len });
  });
  return out;
}

/** The match to start on: the newest one, nearest the prompt. */
export function initialMatch(matches: PtyMatch[]): number {
  return matches.length - 1;
}

/** Step through matches with wrap-around. `dir` -1 is older (up). */
export function stepMatch(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir < 0 ? count - 1 : 0;
  return (current + dir + count) % count;
}
