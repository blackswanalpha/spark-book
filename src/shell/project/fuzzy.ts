/* ============================================================
   sparkBook · src/shell/project/fuzzy.ts

   Quick Open ranking. A query matches a path when its characters
   appear in order (a subsequence), case-insensitively. Scoring
   favours what people actually type: the start of the file name,
   runs of consecutive characters, and the first letter of each
   word or path segment.

   Pure and DOM-free so the ranking is unit-tested.
   ============================================================ */

export interface FuzzyMatch {
  score: number;
  /** Indices into the target that matched, ascending. */
  positions: number[];
}

const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " "]);

function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  if (SEPARATORS.has(prev)) return true;
  // camelCase: a capital after a lower-case letter starts a word.
  const c = target[i];
  return c !== c.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
}

/** Subsequence match of `query` in `target[from..]`, or null. */
function subsequence(query: string, target: string, from: number): number[] | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let ti = from;
  for (let qi = 0; qi < q.length; qi++) {
    const first = t.indexOf(q[qi], ti);
    if (first < 0) return null;
    let pick = first;
    const consecutive = positions.length > 0 && first === positions[positions.length - 1] + 1;
    if (!consecutive && !isBoundary(target, first)) {
      // A later hit that starts a word reads better — "ts" should land on
      // "t"ab_"s"tore, not "ta" — as long as the rest still fits after it.
      for (let j = t.indexOf(q[qi], first + 1); j >= 0; j = t.indexOf(q[qi], j + 1)) {
        if (!isBoundary(target, j)) continue;
        if (canFinish(q, qi + 1, t, j + 1)) pick = j;
        break;
      }
    }
    positions.push(pick);
    ti = pick + 1;
  }
  return positions;
}

function canFinish(q: string, qi: number, t: string, ti: number): boolean {
  for (; qi < q.length; qi++) {
    ti = t.indexOf(q[qi], ti);
    if (ti < 0) return false;
    ti++;
  }
  return true;
}

function scorePositions(target: string, positions: number[], nameStart: number): number {
  let score = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    score += 1;
    if (isBoundary(target, p)) score += 6;
    if (i > 0 && p === positions[i - 1] + 1) score += 4;
    if (p >= nameStart) score += 2;
    if (p === nameStart) score += 6;
  }
  // Gaps and length cost a little, so a tight, short match wins ties.
  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= (span - positions.length) * 0.2;
  score -= target.length * 0.01;
  return score;
}

/**
 * Match `query` against `target` (a relative path). Spaces in the query
 * are ignored, so "src app" finds "src/App.tsx". Returns null when the
 * query is not a subsequence of the target.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "");
  if (!q) return { score: 0, positions: [] };
  const nameStart = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")) + 1;

  // A match inside the file name alone beats one spread over the path.
  const inName = subsequence(q, target, nameStart);
  const inPath = subsequence(q, target, 0);
  const candidates = [inName, inPath].filter((p): p is number[] => p !== null);
  if (candidates.length === 0) return null;

  let best: FuzzyMatch | null = null;
  for (const positions of candidates) {
    const score = scorePositions(target, positions, nameStart) + (positions === inName ? 8 : 0);
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

export interface RankedFile {
  path: string;
  positions: number[];
}

/**
 * The best `limit` files for `query`. With an empty query, `recent`
 * paths (in order) lead and the rest follow alphabetically.
 */
export function rankFiles(
  query: string,
  files: readonly string[],
  recent: readonly string[] = [],
  limit = 100,
): RankedFile[] {
  const q = query.trim();
  if (!q) {
    const seen = new Set<string>();
    const out: RankedFile[] = [];
    for (const p of [...recent, ...files]) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, positions: [] });
      if (out.length >= limit) break;
    }
    return out;
  }
  const recentRank = new Map(recent.map((p, i) => [p, i]));
  const scored: { path: string; m: FuzzyMatch }[] = [];
  for (const path of files) {
    const m = fuzzyMatch(q, path);
    if (!m) continue;
    // A recently used file gets a nudge, not a trump card.
    const r = recentRank.get(path);
    if (r !== undefined) m.score += Math.max(0, 5 - r);
    scored.push({ path, m });
  }
  scored.sort((a, b) => b.m.score - a.m.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => ({ path: s.path, positions: s.m.positions }));
}

export interface QuickOpenQuery {
  text: string;
  line?: number;
  col?: number;
}

/** Split `file.ts:42` / `file.ts:42:7` into the name and a position. */
export function parseQuickOpen(input: string): QuickOpenQuery {
  const m = /^(.*?):(\d+)(?::(\d+))?\s*$/.exec(input.trim());
  if (!m || !m[1]) return { text: input.trim() };
  const line = Number(m[2]);
  const col = m[3] ? Number(m[3]) : undefined;
  return { text: m[1], ...(line > 0 ? { line } : {}), ...(col && col > 0 ? { col } : {}) };
}

/** Split `text` into runs, marking the characters at `positions`. */
export function highlightRuns(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
  const hits = new Set(positions);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}
