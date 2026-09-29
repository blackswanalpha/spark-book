/* ============================================================
   sparkBook · src/shell/Terminal/links.ts

   Finding a web link under a cell, for Ctrl+click and the context
   menu. Works on the painted row text, so it sees exactly what the
   user sees — a URL the program wrapped across two rows is two
   separate strings and only the part under the pointer is found.
   ============================================================ */
import type { PtyRow } from "@bridge/pty";
import { rowText } from "./selection";

export interface Link {
  url: string;
  /** First column of the link. */
  start: number;
  /** Column after the last one. */
  end: number;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Drop punctuation that ends a sentence rather than the URL, keeping a
    closing bracket the URL itself opened (Wikipedia-style links). */
function trimTail(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (!last) return out;
    if (".,;:!?".includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const open = pairs[last];
    if (open) {
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    return out;
  }
}

/** Every link on a row. */
export function linksIn(row: PtyRow | null | undefined, cols: number): Link[] {
  const text = rowText(row, cols);
  // rowText is one code point per cell, so string offsets are columns
  // once the string is walked by code point.
  const chars = [...text];
  const flat = chars.join("");
  const out: Link[] = [];
  for (const m of flat.matchAll(URL_RE)) {
    const url = trimTail(m[0]);
    const start = [...flat.slice(0, m.index)].length;
    out.push({ url, start, end: start + [...url].length });
  }
  return out;
}

/** The link covering `col` on `row`, if any. */
export function linkAt(
  row: PtyRow | null | undefined,
  col: number,
  cols: number,
): Link | null {
  return linksIn(row, cols).find((l) => col >= l.start && col < l.end) ?? null;
}
