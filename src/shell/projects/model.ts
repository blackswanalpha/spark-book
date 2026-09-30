/* ============================================================
   sparkBook · src/shell/projects/model.ts

   The pure half of the Projects window: which projects it lists,
   in what order, how each one reads, and where opening one lands.
   No Tauri and no React, so all of it is tested directly.

   The list is the checkpoint's project rows (the table every window
   writes through) merged with the persisted projects cache, newest
   copy winning — the same rule boot uses in seedProjects, so this
   window and the switcher agree on what exists.
   ============================================================ */
import type { Checkpoint } from "@store/checkpoint";
import {
  LOOSE_ID,
  EMPTY_WORKSPACE,
  byPinThenRecency,
  type Project,
  type Workspace,
} from "@store/projects";
import { fuzzyMatch } from "@shell/project/fuzzy";

export interface ProjectRow {
  id: string;
  rootPath: string;
  name: string;
  lastOpened: number;
  pinned: boolean;
  workspace: Workspace;
  /** Label of the live window showing this project, or null. */
  openIn: string | null;
}

/** The window the Projects window was opened from. */
export interface Opener {
  label: string;
  /** False once that window has closed. */
  live: boolean;
  /** The project it shows, or null for a window with no folder. */
  projectId: string | null;
}

export type OpenHow = "auto" | "new" | "here";
export type OpenTarget = "new" | "here";

export type OpenPlan =
  /** Already open: bring that window forward instead of opening it twice. */
  | { kind: "focus"; label: string }
  /** Hand it to an editor window. `auto` lets that window pass it on to a
      new window if it turns out to be busy (unsaved files, a project). */
  | { kind: "here"; label: string; mode: "auto" | "replace" }
  | { kind: "new" };

/* ---------- Rows ---------- */

export function buildRows(cp: Checkpoint, local: Project[], live: ReadonlySet<string>): ProjectRow[] {
  const byId = new Map<string, Project>();
  for (const p of local) byId.set(p.id, p);
  for (const r of cp.projects) {
    const l = byId.get(r.id);
    if (!l || r.lastOpened >= l.lastOpened) {
      byId.set(r.id, {
        id: r.id,
        rootPath: r.rootPath,
        name: r.name,
        lastOpened: r.lastOpened,
        pinned: r.pinned === true,
        workspace: r.workspace,
      });
    }
  }

  // A row whose window has closed stays in the table as the session to
  // restore, so only live labels count as "open".
  const holders = new Map<string, string>();
  for (const w of cp.windows) {
    if (w.projectId && live.has(w.label) && !holders.has(w.projectId)) holders.set(w.projectId, w.label);
  }

  return [...byId.values()]
    .filter((p): p is Project & { rootPath: string } => p.id !== LOOSE_ID && Boolean(p.rootPath))
    .sort(byPinThenRecency)
    .map((p) => ({
      id: p.id,
      rootPath: p.rootPath,
      name: p.name,
      lastOpened: p.lastOpened,
      pinned: p.pinned === true,
      workspace: p.workspace,
      openIn: holders.get(p.id) ?? null,
    }));
}

export function openerOf(cp: Checkpoint, label: string | null, live: ReadonlySet<string>): Opener | null {
  if (!label) return null;
  const row = cp.windows.find((w) => w.label === label);
  return { label, live: live.has(label), projectId: row?.projectId ?? null };
}

/** A first snapshot for a folder never opened before: the tree rooted there. */
export function freshWorkspace(rootPath: string): Workspace {
  return {
    ...EMPTY_WORKSPACE,
    tabs: [],
    explorer: { ...EMPTY_WORKSPACE.explorer, root: rootPath, expanded: [] },
  };
}

/* ---------- Filter ---------- */

export interface Match {
  row: ProjectRow;
  /** Positions in `row.name` to highlight. */
  nameHits: number[];
}

/**
 * Rows matching `query` by name (fuzzy), path or branch (substring).
 * Name matches rank first; within each group the list order holds, so
 * pinned and recent projects stay where the user expects them.
 */
export function filterRows(
  rows: ProjectRow[],
  query: string,
  branches: ReadonlyMap<string, string | null> = new Map(),
): Match[] {
  const q = query.trim();
  if (!q) return rows.map((row) => ({ row, nameHits: [] }));
  const needle = q.toLowerCase();
  const byName: Match[] = [];
  const byOther: Match[] = [];
  for (const row of rows) {
    const m = fuzzyMatch(q, row.name);
    if (m) {
      byName.push({ row, nameHits: m.positions });
      continue;
    }
    const branch = branches.get(row.id) ?? "";
    if (row.rootPath.toLowerCase().includes(needle) || branch.toLowerCase().includes(needle)) {
      byOther.push({ row, nameHits: [] });
    }
  }
  return [...byName, ...byOther];
}

/* ---------- Presentation ---------- */

/** Two letters for the avatar: word initials, else camelCase humps, else the first two. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length >= 2) return (first(words[0]) + first(words[1])).toUpperCase();
  const w = words[0];
  const hump = [...w].slice(1).find((c) => /\p{Lu}/u.test(c));
  if (hump && !/^\p{Lu}+$/u.test(w)) return (first(w) + hump).toUpperCase();
  return [...w].slice(0, 2).join("").toUpperCase();
}

function first(s: string): string {
  return [...s][0] ?? "";
}

/** Avatar palette index for a project, stable across launches. */
export const AVATAR_COLORS = 8;
export function avatarIndex(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % AVATAR_COLORS;
}

/** `/home/me/code/app` → `~/code/app`. */
export function tildify(path: string, home: string | null): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, "");
  if (!h) return path;
  if (path === h) return "~";
  if (path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)) return `~${path.slice(h.length)}`;
  return path;
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return trimmed;
  if (i === 0) return trimmed[0];
  return trimmed.slice(0, i);
}

/** Where New Project and Clone suggest putting things: beside the latest project. */
export function suggestedLocation(rows: ProjectRow[], home: string | null): string {
  const latest = [...rows].sort((a, b) => b.lastOpened - a.lastOpened)[0];
  return latest ? parentOf(latest.rootPath) : (home ?? "/");
}

/* ---------- Names ---------- */

/** Why `name` cannot be a folder name, or null. Mirrors the host's check. */
export function folderNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n === "." || n === "..") return "The name cannot be . or ..";
  if (new TextEncoder().encode(n).length > 255) return "The name is too long.";
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f\u007f]/.test(n)) return "The name cannot contain slashes.";
  return null;
}

/** The folder git would clone `url` into. */
export function repoName(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  const last = trimmed.split(/[/:\\]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return folderNameProblem(name) ? "" : name;
}

/* ---------- Where an open lands ---------- */

/**
 * Decide where opening `row` goes.
 *
 * A project lives in one window at a time, so an open project is always
 * focused, never opened twice. Otherwise `how` decides, with `auto`
 * following the user's preference — except that an editor window with
 * no folder is reused rather than left behind empty.
 */
export function planOpen(
  row: Pick<ProjectRow, "openIn">,
  how: OpenHow,
  opener: Opener | null,
  preference: OpenTarget,
): OpenPlan {
  if (row.openIn) return { kind: "focus", label: row.openIn };
  const target: OpenTarget = how === "auto" ? preference : how;
  if (opener?.live) {
    if (target === "here") return { kind: "here", label: opener.label, mode: "replace" };
    if (how === "auto" && opener.projectId === null) return { kind: "here", label: opener.label, mode: "auto" };
  }
  return { kind: "new" };
}
