/* ============================================================
   sparkBook · src/store/checkpoint.ts

   The checkpoint model: which projects exist, and which windows
   were on screen when the app last quit.

   A checkpoint is one file with two tables:

     projects[]  id -> { rootPath, name, workspace }
     windows[]   label -> { projectId, geometry }

   `projects` is what makes a relaunch land on the same tabs; the
   projects store (store/projects.ts) is the per-window view of the
   same rows. `windows` is what makes a relaunch reopen the same
   number of windows.

   Everything here is a pure transition over a `Session`. The native
   host (src-tauri/src/checkpoint.rs) implements the identical rules
   behind a mutex; this module is both the browser-side authority and
   the executable spec the Rust tests mirror. Keep the two in step:
   the rules are stated once in each language, not invented twice.

   The three properties the rules exist to hold:

     · one writer per row — a window record is only ever written by
       the window it names, and a project row records its writer, so
       a stale retry is rejected while a genuine hand-off is not;
     · claim-once — the restore plan is handed out exactly once per
       app run, so two windows racing at boot cannot both reopen it;
     · bounded — every table has a cap and every workspace blob has a
       byte ceiling, so a long-lived checkpoint cannot grow without
       limit.
   ============================================================ */
import { coerceWorkspace, EMPTY_WORKSPACE, type Workspace } from "@store/projects";

/* ---------- Constants ---------- */

export const CHECKPOINT_VERSION = 1;
/** Windows reopened on launch. Past this a restore is a fork bomb, not a session. */
export const MAX_WINDOWS = 8;
/** Project rows kept. Mirrors MAX_PROJECTS in store/projects.ts. */
export const MAX_CHECKPOINT_PROJECTS = 20;
/** Serialized ceiling for one workspace snapshot. */
export const MAX_WORKSPACE_BYTES = 256 * 1024;
/** Prefix for windows the checkpoint opens. "main" is created by Tauri. */
export const EDITOR_LABEL_PREFIX = "editor-";
export const MAIN_LABEL = "main";

/* ---------- Shape ---------- */

export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
  maximized: boolean;
}

export interface WindowRecord {
  /** Tauri window label. Unique, and the only writer of this row. */
  label: string;
  /** Project shown in that window, or null for a window with no folder. */
  projectId: string | null;
  geometry: Geometry | null;
  /** Monotonic per label. A write at or below the stored rev is stale. */
  rev: number;
  /** Creation order, ascending. Restore replays windows in this order. */
  order: number;
}

export interface ProjectRecord {
  id: string;
  rootPath: string | null;
  name: string;
  lastOpened: number;
  /** Monotonic per writer. */
  rev: number;
  /** Label of the window that last wrote this row. */
  writer: string;
  /** Kept at the top of the project list. */
  pinned?: boolean;
  workspace: Workspace;
}

export interface Checkpoint {
  version: number;
  projects: ProjectRecord[];
  windows: WindowRecord[];
  updatedAt: number;
}

/**
 * Host-side state for one app run. `file` is what lands on disk;
 * `pending` is the previous run's window list, held until something
 * claims it.
 */
export interface Session {
  file: Checkpoint;
  pending: WindowRecord[] | null;
  /** Next `editor-N` suffix. Allocated under the same lock as everything else. */
  nextLabel: number;
  /** Next `order` for a window row. */
  nextOrder: number;
  /** True once the app is quitting: closing windows stop forgetting themselves. */
  exiting: boolean;
}

export const EMPTY_CHECKPOINT: Checkpoint = {
  version: CHECKPOINT_VERSION,
  projects: [],
  windows: [],
  updatedAt: 0,
};

export type SaveReason = "stale" | "too-large" | "invalid";

export interface SaveResult {
  session: Session;
  accepted: boolean;
  /** The row's rev after the call — the caller's own value when accepted. */
  rev: number;
  reason?: SaveReason;
}

/* ---------- Coercion ----------
   The file is untrusted: an older build may never have written a key,
   and it is plain JSON a user can edit. Every field is validated
   against a default rather than spread. */

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function uint(v: unknown, fallback: number): number {
  const n = Math.trunc(num(v, fallback));
  return n < 0 ? fallback : n;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function coerceGeometry(raw: unknown): Geometry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const w = num(r.w, 0);
  const h = num(r.h, 0);
  // A zero-sized window is not a window; drop the geometry and let the
  // host use its default rather than opening something invisible.
  if (w < 1 || h < 1) return null;
  return {
    x: num(r.x, 0),
    y: num(r.y, 0),
    w,
    h,
    maximized: bool(r.maximized, false),
  };
}

export function coerceWindowRecord(raw: unknown): WindowRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const label = str(r.label);
  if (!label) return null;
  return {
    label,
    projectId: str(r.projectId),
    geometry: coerceGeometry(r.geometry),
    rev: uint(r.rev, 0),
    order: uint(r.order, 0),
  };
}

export function coerceProjectRecord(raw: unknown): ProjectRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    rootPath: str(r.rootPath),
    name: str(r.name) ?? id,
    lastOpened: Math.max(0, num(r.lastOpened, 0)),
    rev: uint(r.rev, 0),
    writer: str(r.writer) ?? MAIN_LABEL,
    pinned: r.pinned === true,
    workspace: coerceWorkspace(r.workspace),
  };
}

export function coerceCheckpoint(raw: unknown): Checkpoint {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CHECKPOINT, projects: [], windows: [] };
  const r = raw as Record<string, unknown>;
  // A version mismatch discards the file. Worst case is one launch that
  // opens a single empty window — cheaper than guessing at a shape.
  if (r.version !== CHECKPOINT_VERSION) {
    return { ...EMPTY_CHECKPOINT, projects: [], windows: [] };
  }

  const projects: ProjectRecord[] = [];
  const seenProjects = new Set<string>();
  if (Array.isArray(r.projects)) {
    for (const item of r.projects) {
      const p = coerceProjectRecord(item);
      if (!p || seenProjects.has(p.id)) continue;
      seenProjects.add(p.id);
      projects.push(p);
    }
  }
  // Pinned rows first, so the cap never drops one for age.
  projects.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.lastOpened - a.lastOpened);
  projects.length = Math.min(projects.length, MAX_CHECKPOINT_PROJECTS);

  const windows: WindowRecord[] = [];
  const seenWindows = new Set<string>();
  if (Array.isArray(r.windows)) {
    for (const item of r.windows) {
      const w = coerceWindowRecord(item);
      if (!w || seenWindows.has(w.label)) continue;
      seenWindows.add(w.label);
      windows.push(w);
    }
  }
  windows.sort((a, b) => a.order - b.order);
  windows.length = Math.min(windows.length, MAX_WINDOWS);

  return {
    version: CHECKPOINT_VERSION,
    projects,
    windows,
    updatedAt: Math.max(0, num(r.updatedAt, 0)),
  };
}

/* ---------- Session transitions ---------- */

function clone(cp: Checkpoint): Checkpoint {
  return {
    version: cp.version,
    projects: cp.projects.map((p) => ({ ...p })),
    windows: cp.windows.map((w) => ({ ...w })),
    updatedAt: cp.updatedAt,
  };
}

/**
 * Start a run from whatever was on disk. The previous run's windows
 * become the pending restore plan and the live window table starts
 * empty, so a label is never reused across runs and a record left by a
 * window that crashed cannot outlive the run that made it.
 */
export function openSession(raw: unknown, now = Date.now()): Session {
  const file = coerceCheckpoint(raw);
  const pending = file.windows.length ? file.windows.map((w) => ({ ...w })) : null;
  return {
    file: { ...file, windows: [], updatedAt: now },
    pending,
    nextLabel: 1,
    nextOrder: 1,
    exiting: false,
  };
}

/**
 * Hand out the previous run's window list. Exactly one caller per run
 * gets it; every later caller gets null, which is what stops two
 * windows from both reopening the session.
 */
export function claimRestore(s: Session): { session: Session; plan: WindowRecord[] | null } {
  if (s.pending === null) return { session: s, plan: null };
  const plan = s.pending.slice(0, MAX_WINDOWS);
  return { session: { ...s, pending: null }, plan };
}

/** Allocate the next window label. Under the same lock as the tables. */
export function allocateLabel(s: Session): { session: Session; label: string } {
  return {
    session: { ...s, nextLabel: s.nextLabel + 1 },
    label: `${EDITOR_LABEL_PREFIX}${s.nextLabel}`,
  };
}

export interface WindowSave {
  label: string;
  projectId: string | null;
  geometry: Geometry | null;
  rev: number;
}

/**
 * Upsert one window row. A window is the only writer of its own label,
 * so a rev at or below the stored one is a reordered retry and is
 * dropped rather than applied.
 */
export function saveWindow(s: Session, save: WindowSave, now = Date.now()): SaveResult {
  const label = str(save.label);
  if (!label) return { session: s, accepted: false, rev: 0, reason: "invalid" };

  const file = clone(s.file);
  const idx = file.windows.findIndex((w) => w.label === label);
  const existing = idx >= 0 ? file.windows[idx] : null;
  if (existing && save.rev <= existing.rev) {
    return { session: s, accepted: false, rev: existing.rev, reason: "stale" };
  }

  let nextOrder = s.nextOrder;
  const row: WindowRecord = {
    label,
    projectId: str(save.projectId),
    geometry: coerceGeometry(save.geometry),
    rev: uint(save.rev, 0),
    order: existing ? existing.order : nextOrder++,
  };
  if (idx >= 0) file.windows[idx] = row;
  else file.windows.push(row);

  file.windows.sort((a, b) => a.order - b.order);
  // Oldest first, so overflow drops the window opened longest ago
  // rather than the one that just registered.
  if (file.windows.length > MAX_WINDOWS) file.windows = file.windows.slice(-MAX_WINDOWS);
  file.updatedAt = now;

  return { session: { ...s, file, nextOrder }, accepted: true, rev: row.rev };
}

/**
 * Drop a window row.
 *
 * Two cases keep the row instead. While `exiting` the table is the
 * session being saved. And the last window standing is the one whose
 * closing quits the app: its destruction arrives before the runtime's
 * exit event, so forgetting it would mean quitting from a single window
 * always relaunched into an empty one.
 */
export function forgetWindow(s: Session, label: string, now = Date.now()): Session {
  if (s.exiting || s.file.windows.length <= 1) return s;
  const file = clone(s.file);
  const before = file.windows.length;
  file.windows = file.windows.filter((w) => w.label !== label);
  if (file.windows.length === before) return s;
  file.updatedAt = now;
  return { ...s, file };
}

export function markExiting(s: Session): Session {
  return s.exiting ? s : { ...s, exiting: true };
}

export interface ProjectSave {
  id: string;
  rootPath: string | null;
  name: string;
  lastOpened: number;
  rev: number;
  writer: string;
  pinned?: boolean;
  workspace: Workspace;
}

export function workspaceBytes(ws: Workspace): number {
  try {
    return JSON.stringify(ws).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Upsert one project row.
 *
 * The rev guard is scoped to the writer: a window's own stale retry is
 * rejected, but a second window that opens the same project takes the
 * row over rather than being locked out of it. Two windows on one
 * project is last-writer-wins by construction — what the guard buys is
 * that neither can be overwritten by its own reordered IPC.
 */
export function saveProject(s: Session, save: ProjectSave, now = Date.now()): SaveResult {
  const id = str(save.id);
  const writer = str(save.writer);
  if (!id || !writer) return { session: s, accepted: false, rev: 0, reason: "invalid" };

  const file = clone(s.file);
  const idx = file.projects.findIndex((p) => p.id === id);
  const existing = idx >= 0 ? file.projects[idx] : null;
  if (existing && existing.writer === writer && save.rev <= existing.rev) {
    return { session: s, accepted: false, rev: existing.rev, reason: "stale" };
  }
  if (workspaceBytes(save.workspace) > MAX_WORKSPACE_BYTES) {
    return {
      session: s,
      accepted: false,
      rev: existing?.rev ?? 0,
      reason: "too-large",
    };
  }

  const row: ProjectRecord = {
    id,
    rootPath: str(save.rootPath),
    name: str(save.name) ?? id,
    lastOpened: Math.max(0, num(save.lastOpened, now)),
    rev: uint(save.rev, 0),
    writer,
    pinned: save.pinned === true,
    workspace: save.workspace ?? EMPTY_WORKSPACE,
  };
  if (idx >= 0) file.projects[idx] = row;
  else file.projects.push(row);

  file.projects = pruneProjects(file.projects, file.windows);
  file.updatedAt = now;
  return { session: { ...s, file }, accepted: true, rev: row.rev };
}

export function removeProject(s: Session, id: string, now = Date.now()): Session {
  const file = clone(s.file);
  const before = file.projects.length;
  file.projects = file.projects.filter((p) => p.id !== id);
  if (file.projects.length === before) return s;
  file.updatedAt = now;
  return { ...s, file };
}

/**
 * Keep the most recent rows, but never evict a project a live window is
 * bound to: dropping one would leave that window restoring into
 * nothing on the next launch.
 */
export function pruneProjects(projects: ProjectRecord[], windows: WindowRecord[]): ProjectRecord[] {
  const sorted = [...projects].sort((a, b) => b.lastOpened - a.lastOpened);
  if (sorted.length <= MAX_CHECKPOINT_PROJECTS) return sorted;
  const pinned = new Set<string>();
  for (const w of windows) if (w.projectId) pinned.add(w.projectId);

  const kept: ProjectRecord[] = [];
  const spill: ProjectRecord[] = [];
  // Bound to a live window, or pinned by the user.
  for (const p of sorted) (pinned.has(p.id) || p.pinned ? kept : spill).push(p);
  for (const p of spill) {
    if (kept.length >= MAX_CHECKPOINT_PROJECTS) break;
    kept.push(p);
  }
  kept.sort((a, b) => b.lastOpened - a.lastOpened);
  return kept.slice(0, Math.max(MAX_CHECKPOINT_PROJECTS, pinned.size));
}

/**
 * The bytes to persist. Until the plan is claimed it is still the best
 * description of the session, so a project write that lands before any
 * window has registered must not erase it.
 */
export function toDisk(s: Session): Checkpoint {
  const windows = s.file.windows.length ? s.file.windows : (s.pending ?? []);
  return { ...clone(s.file), windows: windows.map((w) => ({ ...w })) };
}
