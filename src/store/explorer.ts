/* ============================================================
   sparkBook · src/store/explorer.ts
   File explorer store. Holds the root folder, expanded
   directories, lazily-cached children, and selection state
   for the sidebar tree.  Backed by zustand + immer.
   Independent from the document store — the explorer is a
   different concern with its own lifecycle.
   ============================================================ */
import { create } from "zustand";
import { enableMapSet } from "immer";
import {
  readDir,
  createFile as bridgeCreateFile,
  mkdir as bridgeMkdir,
  renamePath as bridgeRename,
  deletePath as bridgeDelete,
  copyPath as bridgeCopy,
  openInTerminal as bridgeOpenInTerminal,
  revealInOS as bridgeRevealInOS,
  watchPath as bridgeWatchPath,
  unwatchPath as bridgeUnwatchPath,
} from "@bridge/commands";
import { on, type FileChangeEvent } from "@bridge/events";
import { useDocs } from "@store/documents";

enableMapSet();

/* ---------- Types ---------- */
export interface ExplorerNode {
  name: string;
  path: string;        // absolute, joined from parent + name
  isDir: boolean;
  isFile: boolean;
}

/**
 * The directory a path stands for: itself when the tree knows it as a
 * directory — listed, or named as one in its parent's listing — and its
 * parent otherwise. Checking only for a listing treated every collapsed
 * folder as a file, so terminals meant for it opened in its parent.
 */
export function directoryOf(children: Map<string, ExplorerNode[]>, path: string): string {
  if (children.has(path)) return path;
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = idx > 0 ? path.slice(0, idx) || "/" : "/";
  const entry = children.get(parent)?.find((n) => n.path === path);
  return entry?.isDir ? path : parent;
}

/* One wire type for `file:changed`, declared beside the bridge that
   receives it. This store used to keep its own copy, which had "bulk"
   while the bridge's did not, and an `isDir` the host never sends. */
export type { FileChangeEvent };

export interface CreateFileResult {
  ok: boolean;
  error?: string;
  /** The path the operation produced (create, duplicate). */
  path?: string;
}

/** An inline input row in the tree: a new entry being named inside `dir`,
 *  or an existing entry at `path` being renamed. */
export type ExplorerEdit =
  | { kind: "new-file" | "new-folder"; dir: string }
  | { kind: "rename"; path: string };

/* ---------- State ---------- */
interface State {
  root: string | null;
  explicitRoot: boolean;
  expanded: Set<string>;
  children: Map<string, ExplorerNode[]>;
  loading: Set<string>;
  errors: Map<string, string>;
  selectedPath: string | null;
  showHidden: boolean;
  history: string[];
  historyIndex: number;
  /** Active cut/copy clipboard entry. `pasteInto` consumes it. */
  clipboard: ClipboardEntry | null;
  /** The inline create/rename row, if one is open. */
  edit: ExplorerEdit | null;
  /** Name filter typed into the explorer; "" shows the whole tree. */
  filter: string;
  /** True while the folder is being listed ahead of a filter. */
  indexing: boolean;
}

/* ---------- Actions ---------- */
export type ClipboardOp = "copy" | "cut";
export interface ClipboardEntry { op: ClipboardOp; path: string; }

interface Actions {
  setRoot: (path: string | null) => Promise<void>;
  goUp: () => Promise<void>;
  /** Show `path` as the explorer root without changing the project:
   *  "move into" a folder, or jump to an ancestor from the breadcrumb. */
  navigateTo: (path: string) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  toggleShowHidden: () => void;
  setExpanded: (path: string, expanded: boolean) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  /** `quiet` re-reads without the loading/error flags and leaves the
   *  listing untouched when nothing changed; the file watcher uses it. */
  loadChildren: (path: string, opts?: { quiet?: boolean }) => Promise<void>;
  refresh: (path?: string) => Promise<void>;
  collapseAll: () => void;
  setSelected: (path: string | null) => void;
  createFile: (parentDir: string, name: string) => Promise<CreateFileResult>;
  createFolder: (parentDir: string, name: string) => Promise<CreateFileResult>;
  renamePath: (path: string, newName: string) => Promise<CreateFileResult>;
  /** Move a file/folder to a fully-qualified `to` path (may be in a
   *  different parent directory than the source). */
  moveTo: (from: string, to: string) => Promise<CreateFileResult>;
  /** Move to the OS trash, or remove outright when `permanent`. */
  deletePath: (path: string, permanent?: boolean) => Promise<CreateFileResult>;
  copyTo: (from: string, to: string) => Promise<CreateFileResult>;
  /** Copy `path` next to itself as "name copy.ext". */
  duplicate: (path: string) => Promise<CreateFileResult>;
  /** Expand every ancestor of `path` under the root and select it. */
  reveal: (path: string) => Promise<void>;
  /** Expand every folder that shares a parent with `path` (the `*` key). */
  expandSiblings: (path: string) => Promise<void>;
  beginCreate: (kind: "file" | "folder", dir: string) => void;
  beginRename: (path: string) => void;
  cancelEdit: () => void;
  setFilter: (q: string) => void;
  /** Mark `path` for cut or copy. The actual filesystem copy/delete
   *  happens on `pasteInto(targetDir)`. */
  setClipboard: (entry: ClipboardEntry | null) => void;
  pasteInto: (targetDir: string) => Promise<CreateFileResult>;
  /** Move ("cut") or copy `path` into `targetDir`, keeping its name unless
   *  a copy would collide. Shared by paste and drag-and-drop. */
  transfer: (op: ClipboardOp, path: string, targetDir: string) => Promise<CreateFileResult>;
  openInTerminal: (cwd: string) => Promise<CreateFileResult>;
  revealInOS: (path: string) => Promise<CreateFileResult>;
  subscribeToFileChanges: () => Promise<() => void>;
}

/* ---------- Module-scope: monotonic load generation.
   Bumped on every setRoot() so any in-flight loadChildren from a
   previous root can detect it's stale and drop its result. */
let _loadGen = 0;
/* Folders the watcher asked to re-read, gathered for one pass. The host
   sends each change as its own event, up to 65 per flush, so re-reading
   per event read one folder dozens of times in a burst. */
const _refreshQueue = new Set<string>();
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_BATCH_MS = 150;

/** Newest loadChildren request per folder; see loadChildren. */
let _loadSeq = 0;
const _latestLoad = new Map<string, number>();

/* ---------- Module-scope: the host watcher for the current root.
   Exactly one watch is live at a time; retargeting it is the only way
   the tree learns about changes made outside the app. */
let _watchId: string | null = null;
/** Root `_watchId` was requested for (null when nothing is watched). */
let _watchedRoot: string | null = null;
/** Root the latest navigation wants watched. */
let _wantedRoot: string | null = null;
let _watchSync: Promise<void> | null = null;

/**
 * Point the host watcher at `root` (or stop it when null).
 *
 * One host call is in flight at a time. Each watch walks up to 4096
 * directories and holds an inotify instance, so clicking Up five times
 * used to start five walks at once, and every discarded one still spent
 * its watches until it was unwatched. Now the loop drops the old watch,
 * then watches whatever the newest navigation asked for.
 */
function retargetWatch(root: string | null): Promise<void> {
  _wantedRoot = root;
  // `.finally` runs after the assignment even when there is nothing to
  // do, so a finished loop can never leave a stale promise behind.
  _watchSync ??= syncWatch().finally(() => { _watchSync = null; });
  return _watchSync;
}

async function syncWatch(): Promise<void> {
  while (_watchedRoot !== _wantedRoot) {
    const target = _wantedRoot;
    const previous = _watchId;
    _watchId = null;
    _watchedRoot = null;
    if (previous) await bridgeUnwatchPath(previous).catch(() => {});
    if (target === null) continue;
    try {
      _watchId = await bridgeWatchPath(target);
    } catch {
      // Watching is an enhancement: without it the tree still works, it
      // just needs a manual refresh. Never fail navigation over it.
      _watchId = null;
    }
    _watchedRoot = target;
  }
}

/** Stop watching. Exposed for teardown in tests and on app shutdown. */
export async function stopWatching(): Promise<void> {
  await retargetWatch(null);
}

/* ---------- Helpers ---------- */
export function normalizeRoot(path: string): string {
  if (!path) return "/";
  let p = String(path).trim();
  // Strip surrounding quotes (some dialogs return quoted paths).
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  // Strip file:// URI scheme (case-insensitive).
  p = p.replace(/^file:\/\//i, "");
  // On Windows the file:///C:/foo becomes /C:/foo; strip the leading slash before drive letter.
  p = p.replace(/^\/([A-Za-z]:)/, "$1");
  // Decode percent-encoded characters.
  try { p = decodeURIComponent(p); } catch { /* leave as-is if malformed */ }
  // Normalize all backslashes to forward slashes.
  p = p.replace(/\\/g, "/");
  // Strip trailing slashes (but keep a single "/" for root).
  p = p.replace(/\/+$/, "");
  if (p === "") return "/";
  // Ensure leading slash.
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
  return parent + "/" + name;
}

/** True when `child` is `ancestor` or lies inside it. An ancestor that
 *  already ends in a separator ("/") is matched as a plain prefix —
 *  appending another "/" made nothing count as inside the root "/". */
export function isUnder(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  if (ancestor.endsWith("/") || ancestor.endsWith("\\")) return child.startsWith(ancestor);
  return child.startsWith(ancestor + "/") || child.startsWith(ancestor + "\\");
}

/** Last path segment. */
export function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Containing directory, without the normalisation `parentOf` applies. */
export function dirName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : "/";
}

/* Folders first, then names in natural, case-insensitive order
   ("file2" before "file10", "Readme" beside "readme"). The host sorts
   by raw byte order, which put every capitalised name first. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function compareNodes(a: ExplorerNode, b: ExplorerNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * A readable message for a failed host call. The Tauri host rejects with
 * `{ kind, data: { path } }` and the browser mock with `{ kind, path }`;
 * stringifying either gave the user "[object Object]".
 */
export function describeError(err: unknown): string {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  const e = err as { kind?: string; path?: string; message?: string; data?: { path?: string; message?: string; reason?: string } };
  const path = e.data?.path ?? e.path;
  const name = path ? `“${baseName(path)}”` : "The item";
  switch (e.kind) {
    case "AlreadyExists": return `${name} already exists here.`;
    case "NotFound": return `${name} no longer exists.`;
    case "PermissionDenied": return `Permission denied for ${name}.`;
    case "IsADirectory": return `${name} is a folder.`;
    case "InvalidPath": return `Invalid path ${name}${e.data?.reason ? `: ${e.data.reason}` : ""}.`;
    case "Internal": return e.data?.message ?? e.message ?? "Internal error";
  }
  return e.message ?? e.kind ?? String(err);
}

/**
 * Why `name` cannot be used, or null when it can. `nested` allows
 * "a/b/c.ts" (create makes the missing folders); rename does not.
 * `siblings` are the names already in the target folder.
 */
export function validateName(name: string, siblings: string[], opts: { nested?: boolean; current?: string } = {}): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name is required.";
  if (!opts.nested && /[/\\]/.test(trimmed)) return "A name cannot contain / or \\.";
  const segments = trimmed.split(/[/\\]/);
  for (const seg of segments) {
    if (!seg) return "A path segment is empty.";
    if (seg === "." || seg === "..") return `“${seg}” is not a valid name.`;
    if (/[\0<>:"|?*]/.test(seg)) return `“${seg}” contains a character that is not allowed.`;
  }
  // Only the first segment can collide with this folder's listing; a
  // deeper one lives in a folder that may not exist yet.
  const first = segments[0];
  const collides = segments.length === 1
    ? siblings.includes(first) && first !== opts.current
    : false;
  if (collides) return `“${first}” already exists here.`;
  return null;
}

/** Point every open tab at or under `from` to its new location. */
function retargetOpenDocs(from: string, to: string) {
  const docs = useDocs.getState();
  for (const d of Object.values(docs.docs)) {
    if (!d.path || !isUnder(d.path, from)) continue;
    const next = to + d.path.slice(from.length);
    docs.setPath(d.id, next);
    docs.setName(d.id, baseName(next));
  }
}

/* Folders a filter never descends into: they are rarely what the user is
   looking for and can hold more entries than the rest of the tree. */
const INDEX_SKIP = new Set([
  ".git", "node_modules", "target", "dist", "build", ".next", ".cache",
  "__pycache__", ".venv", "venv", ".idea", ".gradle",
]);
const INDEX_MAX_DIRS = 3000;
/** Root the filter index was built for; reset whenever the root changes. */
let _indexedRoot: string | null = null;

/** Return the parent directory of `path`, or `null` if `path` is the root "/". */
function parentOf(path: string): string | null {
  const norm = normalizeRoot(path);
  if (norm === "/") return null;
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx <= 0) return "/";
  return norm.slice(0, idx) || "/";
}

/** Keep a selection only while it remains inside `root`. */
function keepSelection(selected: string | null, root: string): string | null {
  return selected && isUnder(selected, root) ? selected : null;
}

/** True when a fresh listing names the same entries as the cached one. */
function sameListing(prev: ExplorerNode[] | undefined, next: ExplorerNode[]): boolean {
  if (!prev || prev.length !== next.length) return false;
  return prev.every((n, i) => n.name === next[i].name && n.isDir === next[i].isDir && n.isFile === next[i].isFile);
}

/** Remove `path` from the loading set without touching anything else. */
function clearLoading(
  get: () => State & Actions,
  set: (p: Partial<State>) => void,
  path: string,
) {
  const loading = get().loading;
  if (!loading.has(path)) return;
  const next = new Set(loading);
  next.delete(path);
  set({ loading: next });
}

/* ---------- internal: push history (truncate forward) ---------- */
function pushHistory(get: () => State & Actions, set: (p: Partial<State>) => void, path: string) {
  const { history, historyIndex } = get();
  if (historyIndex >= 0 && history[historyIndex] === path) return;
  const truncated = historyIndex >= 0 ? history.slice(0, historyIndex + 1) : [];
  truncated.push(path);
  // keep reasonable cap (100)
  const capped = truncated.length > 100 ? truncated.slice(truncated.length - 100) : truncated;
  set({ history: capped, historyIndex: capped.length - 1 });
}

/* ---------- internal: find a non-colliding destination for paste/copy ---------- */
/** True when `p` names an existing file or directory.
 *  The Tauri host returns Err(NotFound) for a missing path; the browser
 *  mock returns a stat with both flags false. Both mean "missing". */
async function pathExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("@bridge/commands");
    const s = (await stat(p)) as { isFile?: boolean; isDir?: boolean };
    return Boolean(s?.isFile || s?.isDir);
  } catch {
    return false;
  }
}

async function nextAvailableDest(targetDir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 1000; n++) {
    const candidate = joinPath(targetDir, n === 0 ? `${stem} copy${ext}` : `${stem} copy (${n})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  // Fallback: timestamped name.
  return joinPath(targetDir, `${stem} copy ${Date.now()}${ext}`);
}

/** Turn a host listing into sorted tree nodes. Older hosts sent
 *  snake_case flags, so both spellings are accepted. */
function toNodes(dir: string, entries: unknown): ExplorerNode[] {
  const list = (Array.isArray(entries) ? entries : []) as Array<{
    name: string; isDir?: boolean; is_dir?: boolean; isFile?: boolean; is_file?: boolean;
  }>;
  return list.map((e) => {
    const isDir = Boolean(e.isDir ?? e.is_dir);
    const isFileRaw = e.isFile ?? e.is_file;
    const isFile = isFileRaw !== undefined ? Boolean(isFileRaw) : !isDir;
    return { name: e.name, path: joinPath(dir, e.name), isDir, isFile };
  }).sort(compareNodes);
}

/**
 * Create a file or folder named `name` inside `parentDir`. A name with
 * separators ("src/lib/util.ts") creates the missing folders first, the
 * way VS Code's explorer does. Each level is created on its own so the
 * listings refreshed afterwards include every new folder.
 */
async function createEntry(
  get: () => State & Actions,
  set: (p: Partial<State>) => void,
  parentDir: string,
  name: string,
  kind: "file" | "folder",
): Promise<CreateFileResult> {
  const segments = name.trim().split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return { ok: false, error: "A name is required." };
  const leaf = segments.pop()!;
  const touched: string[] = [parentDir];
  let dir = parentDir;
  try {
    for (const seg of segments) {
      dir = joinPath(dir, seg);
      await bridgeMkdir(dir);
      touched.push(dir);
    }
    const fullPath = joinPath(dir, leaf);
    if (kind === "file") await bridgeCreateFile(fullPath, "");
    else await bridgeMkdir(fullPath);
    // Re-read every listing the create touched, then show the result.
    for (const d of touched) await get().loadChildren(d);
    const expanded = new Set(get().expanded);
    for (const d of touched) expanded.add(d);
    set({ expanded, selectedPath: fullPath });
    return { ok: true, path: fullPath };
  } catch (err) {
    // A partial nested create still made folders; show what exists.
    for (const d of touched) void get().loadChildren(d);
    return { ok: false, error: describeError(err) };
  }
}

/**
 * List the folder breadth-first so a filter can match files in folders
 * the user has not opened. Bounded by INDEX_MAX_DIRS and INDEX_SKIP, and
 * written in batches so the tree re-renders a few times, not per folder.
 * Abandoned as soon as the root changes.
 */
async function indexTree(get: () => State & Actions, set: (p: Partial<State>) => void, root: string) {
  const gen = _loadGen;
  set({ indexing: true });
  const queue: string[] = [root];
  const pending = new Map<string, ExplorerNode[]>();
  let visited = 0;
  const flush = () => {
    if (pending.size === 0 || gen !== _loadGen) return;
    const children = new Map(get().children);
    for (const [k, v] of pending) children.set(k, v);
    pending.clear();
    set({ children });
  };
  while (queue.length && visited < INDEX_MAX_DIRS) {
    if (gen !== _loadGen) return;
    const dir = queue.shift()!;
    visited++;
    let nodes = get().children.get(dir);
    if (!nodes) {
      try {
        nodes = toNodes(dir, await readDir(dir));
        pending.set(dir, nodes);
      } catch {
        continue;
      }
    }
    for (const n of nodes) {
      if (n.isDir && !INDEX_SKIP.has(n.name) && !n.name.startsWith(".")) queue.push(n.path);
    }
    if (pending.size >= 40) flush();
  }
  flush();
  if (gen === _loadGen) set({ indexing: false });
}

/**
 * Re-root the tree at `target` while navigating (up, into, back, forward).
 * Listings and expansion already known under `target` are kept, so going
 * back does not re-read the disk. Moving to an ancestor also opens the
 * folders down to where the user came from, so they can see it.
 * `history` is "push" for a new step, or the index being moved to.
 */
async function moveRoot(
  get: () => State & Actions,
  set: (p: Partial<State>) => void,
  target: string,
  history: "push" | number,
) {
  _loadGen++;
  _indexedRoot = null;
  const previous = get().root;
  const keptExpanded = new Set<string>([target]);
  for (const e of get().expanded) {
    if (isUnder(e, target)) keptExpanded.add(e);
  }
  if (previous && previous !== target && isUnder(previous, target)) {
    for (let cur = previous; cur !== target && isUnder(cur, target); cur = dirName(cur)) {
      keptExpanded.add(cur);
      if (cur === "/") break;
    }
  }
  const keptChildren = new Map<string, ExplorerNode[]>();
  for (const [k, v] of get().children) {
    if (isUnder(k, target)) keptChildren.set(k, v);
  }
  set({
    root: target,
    explicitRoot: true,
    expanded: keptExpanded,
    children: keptChildren,
    loading: new Set<string>(),
    errors: new Map<string, string>(),
    // Keep the selection when it is still inside the new root — the
    // user navigated, they did not deselect.
    selectedPath: keepSelection(get().selectedPath, target),
    edit: null,
    indexing: false,
    ...(history === "push" ? {} : { historyIndex: history }),
  });
  if (history === "push") pushHistory(get, set, target);
  void retargetWatch(target);
  window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: target } }));
  await get().loadChildren(target);
}

/* ---------- Store ---------- */
export const useExplorer = create<State & Actions>((set, get) => ({
  root: null,
  explicitRoot: false,
  expanded: new Set<string>(),
  children: new Map<string, ExplorerNode[]>(),
  loading: new Set<string>(),
  errors: new Map<string, string>(),
  selectedPath: null,
  showHidden: false,
  history: [],
  historyIndex: -1,
  clipboard: null,
  edit: null,
  filter: "",
  indexing: false,

  setRoot: async (path) => {
    _loadGen++;
    _indexedRoot = null;
    if (path === null) {
      set({
        root: null,
        explicitRoot: false,
        expanded: new Set<string>(),
        children: new Map<string, ExplorerNode[]>(),
        loading: new Set<string>(),
        errors: new Map<string, string>(),
        selectedPath: null,
        history: [],
        historyIndex: -1,
        edit: null,
        filter: "",
        indexing: false,
      });
      void retargetWatch(null);
      window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: null } }));
      return;
    }
    const normalized = normalizeRoot(path);
    const isSameRoot = get().root === normalized;
    set({
      root: normalized,
      explicitRoot: true,
      expanded: new Set<string>([normalized]),
      children: isSameRoot ? new Map<string, ExplorerNode[]>(get().children) : new Map<string, ExplorerNode[]>(),
      loading: new Set<string>(),
      errors: new Map<string, string>(),
      selectedPath: null,
      edit: null,
      filter: isSameRoot ? get().filter : "",
      indexing: false,
    });
    pushHistory(get, set, normalized);
    if (!isSameRoot) void retargetWatch(normalized);
    window.dispatchEvent(new CustomEvent("spark:explorer:root-changed", { detail: { root: normalized } }));
    await get().loadChildren(normalized);
  },

  goUp: async () => {
    const current = get().root;
    const parent = current ? parentOf(current) : null;
    if (parent) await moveRoot(get, set, parent, "push");
  },

  navigateTo: async (path) => {
    const current = get().root;
    const target = normalizeRoot(path);
    if (current && target !== current) await moveRoot(get, set, target, "push");
  },

  goBack: async () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    await moveRoot(get, set, history[historyIndex - 1], historyIndex - 1);
  },

  goForward: async () => {
    const { history, historyIndex } = get();
    if (historyIndex < 0 || historyIndex >= history.length - 1) return;
    await moveRoot(get, set, history[historyIndex + 1], historyIndex + 1);
  },

  canGoBack: () => get().historyIndex > 0,
  canGoForward: () => {
    const { history, historyIndex } = get();
    return historyIndex >= 0 && historyIndex < history.length - 1;
  },

  toggleShowHidden: () => {
    set({
      showHidden: !get().showHidden,
    });
  },

  setExpanded: async (path, expanded) => {
    const next = new Set(get().expanded);
    if (expanded) next.add(path);
    else next.delete(path);
    set({ expanded: next });
    if (expanded && !get().children.has(path)) {
      await get().loadChildren(path);
    }
  },

  toggleDir: async (path) => {
    const wasExpanded = get().expanded.has(path);
    await get().setExpanded(path, !wasExpanded);
  },

  loadChildren: async (path, opts) => {
    const quiet = opts?.quiet === true;
    const myGen = _loadGen;
    // A watcher event, an expand and a refresh can all read one folder at
    // once, and the replies arrive in any order. Only the newest request
    // may write, or an older listing lands last and the first reply to
    // arrive clears the spinner while the newer read is still going.
    const token = ++_loadSeq;
    _latestLoad.set(path, token);
    if (!quiet) {
      const loading = new Set(get().loading);
      const errors = new Map(get().errors);
      loading.add(path);
      errors.delete(path);
      set({ loading, errors });
    }
    try {
      const entries = await readDir(path);
      if (_latestLoad.get(path) !== token) return;
      _latestLoad.delete(path);
      if (myGen !== _loadGen) {
        // Root changed under us — drop the result, but still clear the
        // loading flag or this row keeps a spinner that never resolves.
        clearLoading(get, set, path);
        return;
      }
      const nodes = toNodes(path, entries);
      const before = get();
      // Unchanged: keep the old array so nothing re-renders. A save or a
      // log append inside a listed folder changes no names, and a tree
      // rooted at `~` or `/` hears about those several times a second.
      if (sameListing(before.children.get(path), nodes) && !before.errors.has(path)) {
        clearLoading(get, set, path);
        return;
      }
      const children = new Map(before.children);
      const loadingAfter = new Set(before.loading);
      const errorsAfter = new Map(before.errors);
      children.set(path, nodes);
      loadingAfter.delete(path);
      errorsAfter.delete(path);
      set({ children, loading: loadingAfter, errors: errorsAfter });
    } catch (err) {
      if (_latestLoad.get(path) !== token) return;
      _latestLoad.delete(path);
      // A background re-read that fails (the folder was just removed)
      // is settled by the parent's own re-read, not by an error row.
      if (myGen !== _loadGen || quiet) {
        clearLoading(get, set, path);
        return;
      }
      const loadingAfter = new Set(get().loading);
      const errorsAfter = new Map(get().errors);
      loadingAfter.delete(path);
      errorsAfter.set(path, describeError(err));
      set({ loading: loadingAfter, errors: errorsAfter });
    }
  },

  refresh: async (path) => {
    const root = get().root;
    if (!root) return;
    const target = path ?? root;
    // Collect this directory and all currently-expanded descendants.
    const queue: string[] = [target];
    const visited = new Set<string>([target]);
    const allExpanded = get().expanded;
    // BFS over expanded entries; we only recurse into ones under `target`.
    for (const exp of allExpanded) {
      if (isUnder(exp, target) && !visited.has(exp)) {
        visited.add(exp);
        queue.push(exp);
      }
    }
    for (const p of queue) {
      await get().loadChildren(p);
    }
  },

  collapseAll: () => {
    const root = get().root;
    // Keep the root expanded so the top-level children remain accessible.
    // Clearing everything (including the root) leaves the tree empty with
    // no way to re-expand — the user would perceive this as "cannot access folders".
    set({ expanded: root ? new Set<string>([root]) : new Set<string>() });
  },

  setSelected: (path) => {
    set({ selectedPath: path });
  },

  createFile: (parentDir, name) => createEntry(get, set, parentDir, name, "file"),

  createFolder: (parentDir, name) => createEntry(get, set, parentDir, name, "folder"),

  renamePath: async (path, newName) => {
    if (!newName || newName.includes("/") || newName.includes("\\")) {
      return { ok: false, error: "Invalid name" };
    }
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const parent = idx > 0 ? path.slice(0, idx) : "/";
    const to = joinPath(parent, newName);
    if (to === path) return { ok: true };
    try {
      await bridgeRename(path, to);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
    // Eagerly update cache: rewrite children's name/path for the renamed entry,
    // and drop any cached children for the old path (it's gone).
    const children = new Map(get().children);
    // 1) the parent's listing
    const siblings = children.get(parent);
    if (siblings) {
      const replaced = siblings.map((n) =>
        n.path === path ? { ...n, name: newName, path: to } : n,
      );
      const sorted = replaced.slice().sort(compareNodes);
      children.set(parent, sorted);
    }
    // 2) cached children of the entry itself (if it was a dir): remap keys
    const remapped = new Map<string, ExplorerNode[]>();
    for (const [k, v] of children) {
      if (k === path) {
        // old cached children of renamed dir are now at `to`
        remapped.set(to, v);
      } else if (k.startsWith(path + "/")) {
        remapped.set(to + k.slice(path.length), v);
      } else {
        remapped.set(k, v);
      }
    }
    // 3) expanded set: same key remap
    const expanded = new Set<string>();
    for (const e of get().expanded) {
      if (e === path) expanded.add(to);
      else if (e.startsWith(path + "/")) expanded.add(to + e.slice(path.length));
      else expanded.add(e);
    }
    // 4) selection moves too
    const sel = get().selectedPath;
    const selected = sel === path ? to : (sel && sel.startsWith(path + "/") ? to + sel.slice(path.length) : sel);
    set({ children: remapped, expanded, selectedPath: selected });
    retargetOpenDocs(path, to);
    return { ok: true, path: to };
  },

  moveTo: async (from, to) => {
    if (from === to) return { ok: true };
    try {
      await bridgeRename(from, to);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
    const srcIdx = Math.max(from.lastIndexOf("/"), from.lastIndexOf("\\"));
    const dstIdx = Math.max(to.lastIndexOf("/"), to.lastIndexOf("\\"));
    const srcParent = srcIdx > 0 ? from.slice(0, srcIdx) : "/";
    const dstParent = dstIdx > 0 ? to.slice(0, dstIdx) : "/";
    const newName = to.slice(dstIdx + 1);
    const children = new Map(get().children);
    // 1) drop the source entry from its parent's listing
    const srcSiblings = children.get(srcParent);
    if (srcSiblings) {
      children.set(srcParent, srcSiblings.filter((n) => n.path !== from));
    }
    // 2) add the new entry to the dest parent's listing (if cached)
    const destSiblings = children.get(dstParent);
    if (destSiblings && !destSiblings.some((n) => n.path === to)) {
      const srcEntry = srcSiblings?.find((n) => n.path === from);
      const isDir = srcEntry?.isDir ?? false;
      const isFile = srcEntry?.isFile ?? !isDir;
      const next = [...destSiblings, { name: newName, path: to, isDir, isFile }];
      next.sort(compareNodes);
      children.set(dstParent, next);
    }
    // 3) remap cached children keys
    const remapped = new Map<string, ExplorerNode[]>();
    for (const [k, v] of children) {
      if (k === from) remapped.set(to, v);
      else if (k.startsWith(from + "/")) remapped.set(to + k.slice(from.length), v);
      else remapped.set(k, v);
    }
    // 4) remap expanded set
    const expanded = new Set<string>();
    for (const e of get().expanded) {
      if (e === from) expanded.add(to);
      else if (e.startsWith(from + "/")) expanded.add(to + e.slice(from.length));
      else expanded.add(e);
    }
    // 5) ensure dest parent is expanded so the moved entry is visible
    expanded.add(dstParent);
    // 6) selection moves if it pointed inside the moved subtree
    const sel = get().selectedPath;
    const selected = sel === from ? to : (sel && sel.startsWith(from + "/") ? to + sel.slice(from.length) : sel);
    set({ children: remapped, expanded, selectedPath: selected });
    retargetOpenDocs(from, to);
    return { ok: true, path: to };
  },

  deletePath: async (path, permanent = false) => {
    try {
      await bridgeDelete(path, permanent);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const parent = idx > 0 ? path.slice(0, idx) : "/";
    // 1) remove from parent's listing
    const children = new Map(get().children);
    const siblings = children.get(parent);
    if (siblings) {
      children.set(parent, siblings.filter((n) => n.path !== path));
    }
    // 2) drop any cached subtree
    const trimmed = new Map<string, ExplorerNode[]>();
    for (const [k, v] of children) {
      if (k === path || k.startsWith(path + "/")) continue;
      trimmed.set(k, v);
    }
    // 3) collapse/delete from expanded
    const expanded = new Set<string>();
    for (const e of get().expanded) {
      if (e === path || e.startsWith(path + "/")) continue;
      expanded.add(e);
    }
    const sel = get().selectedPath;
    const selected = sel === path || (sel && sel.startsWith(path + "/")) ? null : sel;
    set({ children: trimmed, expanded, selectedPath: selected });
    return { ok: true };
  },

  copyTo: async (from, to) => {
    try {
      await bridgeCopy(from, to);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
    const idx = Math.max(to.lastIndexOf("/"), to.lastIndexOf("\\"));
    const destParent = idx > 0 ? to.slice(0, idx) : "/";
    const newName = to.slice(idx + 1);
    // Eagerly add to the dest parent's listing if cached.
    const children = new Map(get().children);
    const siblings = children.get(destParent);
    if (siblings) {
      // Look the source up in ITS OWN parent's listing. Searching the
      // destination's listing only works for same-directory duplicates;
      // a cross-directory copy found nothing and defaulted to isDir:false,
      // so copied folders showed up in the tree as files.
      const srcIdx = Math.max(from.lastIndexOf("/"), from.lastIndexOf("\\"));
      const srcParent = srcIdx > 0 ? from.slice(0, srcIdx) : "/";
      const srcEntry =
        children.get(srcParent)?.find((n) => n.path === from) ??
        siblings.find((n) => n.path === from);
      const isDir = srcEntry?.isDir ?? false;
      const isFile = srcEntry?.isFile ?? !isDir;
      if (!siblings.some((n) => n.path === to)) {
        const next = [...siblings, { name: newName, path: to, isDir, isFile }];
        next.sort(compareNodes);
        children.set(destParent, next);
        const expanded = new Set(get().expanded);
        expanded.add(destParent);
        set({ children, expanded });
      }
    } else {
      void get().loadChildren(destParent);
    }
    return { ok: true };
  },

  setClipboard: (entry) => {
    set({ clipboard: entry });
  },

  pasteInto: async (targetDir) => {
    const clip = get().clipboard;
    if (!clip) return { ok: false, error: "Clipboard is empty" };
    const res = await get().transfer(clip.op, clip.path, targetDir);
    if (res.ok && clip.op === "cut") set({ clipboard: null });
    return res;
  },

  transfer: async (op, path, targetDir) => {
    const name = baseName(path);
    if (op === "cut" && isUnder(targetDir, path)) {
      return { ok: false, error: `Cannot move “${name}” into itself.` };
    }
    // No-op cut into the same directory.
    if (op === "cut" && dirName(path) === targetDir) return { ok: true, path };
    const to = joinPath(targetDir, name);
    if (op === "cut") return get().moveTo(path, to);
    // Keep the original name when the destination is free; only fall
    // back to "name copy" on a real collision. Always suffixing meant
    // pasting into an empty folder produced "README copy.md".
    const dest = to === path || (await pathExists(to)) ? await nextAvailableDest(targetDir, name) : to;
    const res = await get().copyTo(path, dest);
    return res.ok ? { ok: true, path: dest } : res;
  },

  openInTerminal: async (cwd) => {
    try {
      await bridgeOpenInTerminal(cwd);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  },

  revealInOS: async (path) => {
    try {
      await bridgeRevealInOS(path);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  },

  duplicate: async (path) => {
    const dest = await nextAvailableDest(dirName(path), baseName(path));
    const res = await get().copyTo(path, dest);
    if (res.ok) set({ selectedPath: dest });
    return res.ok ? { ok: true, path: dest } : res;
  },

  reveal: async (path) => {
    const root = get().root;
    if (!root || path === root || !isUnder(path, root)) return;
    const chain: string[] = [];
    for (let cur = dirName(path); cur !== root && isUnder(cur, root); cur = dirName(cur)) {
      chain.unshift(cur);
      if (cur === "/") break;
    }
    const dirs = [root, ...chain];
    const expanded = get().expanded;
    if (dirs.some((d) => !expanded.has(d))) {
      const next = new Set(expanded);
      for (const d of dirs) next.add(d);
      set({ expanded: next });
    }
    for (const d of dirs) {
      if (!get().children.has(d)) await get().loadChildren(d);
    }
    if (get().root === root) set({ selectedPath: path });
  },

  expandSiblings: async (path) => {
    const siblings = get().children.get(dirName(path)) ?? [];
    const dirs = siblings.filter((n) => n.isDir && (get().showHidden || !n.name.startsWith(".")));
    const next = new Set(get().expanded);
    for (const d of dirs) next.add(d.path);
    set({ expanded: next });
    await Promise.all(dirs.filter((d) => !get().children.has(d.path)).map((d) => get().loadChildren(d.path)));
  },

  beginCreate: (kind, dir) => {
    const expanded = new Set(get().expanded);
    expanded.add(dir);
    set({ edit: { kind: kind === "file" ? "new-file" : "new-folder", dir }, expanded });
    if (!get().children.has(dir)) void get().loadChildren(dir);
  },

  beginRename: (path) => {
    if (path === get().root) return;
    set({ edit: { kind: "rename", path }, selectedPath: path });
  },

  cancelEdit: () => {
    if (get().edit) set({ edit: null });
  },

  setFilter: (q) => {
    set({ filter: q });
    const root = get().root;
    if (!q.trim() || !root || _indexedRoot === root) return;
    _indexedRoot = root;
    void indexTree(get, set, root);
  },

  subscribeToFileChanges: async () => {
    // Each call returns its own unlisten so callers can manage
    // their own subscription lifecycle (no module-level caching).
    const unlisten = await on<FileChangeEvent>("file:changed", (evt) => {
      const state = get();
      const root = state.root;
      if (!root || !evt) return;

      // Too much changed at once to name it. Re-read what is on screen
      // rather than trusting listings taken before the storm.
      // Only open folders are re-read. Re-reading every cached listing
      // (the filter index alone holds up to 3000) started thousands of
      // reads at once, each copying the whole tree map, and a tree rooted
      // at `/` got a bulk event whenever the system was busy. The other
      // listings are dropped and read again when opened.
      const queue = (dirs: Iterable<string>) => {
        for (const d of dirs) _refreshQueue.add(d);
        _refreshTimer ??= setTimeout(() => {
          _refreshTimer = null;
          const batch = [..._refreshQueue];
          _refreshQueue.clear();
          // The tree may have moved on while the batch waited.
          const current = get().root;
          for (const d of batch) {
            if (current && isUnder(d, current)) void get().loadChildren(d, { quiet: true });
          }
        }, REFRESH_BATCH_MS);
      };
      if (evt.kind === "bulk") {
        const open = [...state.children.keys()].filter((dir) => dir === root || state.expanded.has(dir));
        if (open.length !== state.children.size) {
          const kept = new Map<string, ExplorerNode[]>();
          for (const dir of open) kept.set(dir, state.children.get(dir)!);
          set({ children: kept });
          if (state.filter.trim() && !state.indexing) void indexTree(get, set, root);
        }
        queue(state.children.has(root) ? open : [...open, root]);
        return;
      }
      if (!evt.path) return;
      // Find the closest known ancestor of evt.path (or evt.from for renames)
      // that exists in our children cache, and refresh it.
      const candidate = evt.kind === "renamed" ? (evt.from ?? evt.path) : evt.path;

      // Walk up one level at a time to the nearest cached directory. The
      // previous version computed the separator index once, before the
      // loop, and then reused it as a slice length against a string that
      // kept shrinking — so it skipped levels and often refreshed the
      // wrong directory (or none).
      const targets = new Set<string>();
      let cursor = candidate;
      for (let depth = 0; depth < 64; depth++) {
        const sep = Math.max(cursor.lastIndexOf("/"), cursor.lastIndexOf("\\"));
        if (sep <= 0) break;
        cursor = cursor.slice(0, sep) || "/";
        if (state.children.has(cursor) || cursor === root) {
          targets.add(cursor);
          break;
        }
        if (cursor === "/") break;
      }

      // A rename moves an entry between two directories; both listings are
      // now stale, so refresh the destination's parent as well.
      if (evt.kind === "renamed" && evt.from && evt.path !== evt.from) {
        const sep = Math.max(evt.path.lastIndexOf("/"), evt.path.lastIndexOf("\\"));
        const destParent = sep > 0 ? evt.path.slice(0, sep) : "/";
        if (state.children.has(destParent)) targets.add(destParent);
      }

      if (targets.size === 0 && isUnder(candidate, root)) targets.add(root);
      queue(targets);
    });
    return unlisten;
  },
}));

/* ---------- Helpers ---------- */
export const activeExplorerRoot = (): string | null => useExplorer.getState().root;
