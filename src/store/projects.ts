/* ============================================================
   sparkBook · src/store/projects.ts

   Projects cache. A "project" is an opened folder root; each one
   carries a Workspace — the snapshot restored on next launch.

   Persistence mirrors settings.ts / ThemeProvider: the Tauri Store
   plugin (projects.json) when running in the app, localStorage when
   not. Both are written; localStorage is the synchronous mirror that
   survives a webview reload before the async Tauri read resolves.

   Unlike settings there is no cross-window broadcast: the main Shell
   is the only writer (the pop-out terminal window never touches this
   store), so an emit/listen pair would only add echo hazards.

   The word "session" is deliberately avoided — it already means a
   terminal PTY tab (src/shell/Terminal/sessions.ts).
   ============================================================ */
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { DocMode } from "@store/documents";
import type { PtyPrivilege } from "@bridge/pty";
import { normalizeRoot } from "@store/explorer";

/* ---------- Shape ---------- */

export interface TabSnapshot {
  /** Absolute path. Untitled buffers are never persisted. */
  path: string;
  mode: DocMode;
  cursor: { line: number; col: number };
  scrollTop: number;
}

export interface ExplorerSnapshot {
  root: string | null;
  /** Absolute directory paths that were expanded. */
  expanded: string[];
  showHidden: boolean;
  selectedPath: string | null;
}

export interface TerminalTabSnapshot {
  cwd: string;
  privilege: PtyPrivilege;
  label: string;
}

export interface TerminalSnapshot {
  tabs: TerminalTabSnapshot[];
  activeIndex: number;
  isOpen: boolean;
  nextOrdinal: number;
  panel: { x: number; y: number; w: number; h: number };
  mobile: boolean;
}

export interface LayoutSnapshot {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  showStatus: boolean;
}

export interface Workspace {
  tabs: TabSnapshot[];
  /** Index into `tabs`; -1 when nothing was open. */
  activeIndex: number;
  explorer: ExplorerSnapshot;
  terminal: TerminalSnapshot;
  layout: LayoutSnapshot;
}

export interface Project {
  /** normalizeRoot(rootPath), or LOOSE_ID for the no-folder bucket. */
  id: string;
  rootPath: string | null;
  name: string;
  /** Epoch ms. */
  lastOpened: number;
  workspace: Workspace;
}

export interface ProjectsCache {
  version: 1;
  activeId: string | null;
  projects: Project[];
}

/* ---------- Constants ---------- */

const STORE_FILE = "projects.json";
const STORE_KEY = "spark.projects";

export const SCHEMA_VERSION = 1;
/** Reserved project for files opened without a folder root. */
export const LOOSE_ID = "(no folder)";
export const MAX_PROJECTS = 20;
export const MAX_RESTORE_TABS = 20;
export const MAX_EXPANDED = 200;

const DOC_MODES: DocMode[] = [
  "markdown", "rich", "code", "html", "svg",
  "image", "imageedit", "animation", "pdf", "video", "audio",
];

export const EMPTY_WORKSPACE: Workspace = {
  tabs: [],
  activeIndex: -1,
  explorer: { root: null, expanded: [], showHidden: false, selectedPath: null },
  terminal: {
    tabs: [],
    activeIndex: -1,
    isOpen: false,
    nextOrdinal: 1,
    panel: { x: 0, y: 0, w: 720, h: 440 },
    mobile: false,
  },
  layout: { sidebarWidth: 260, sidebarCollapsed: false, showStatus: true },
};

export const EMPTY_CACHE: ProjectsCache = { version: SCHEMA_VERSION, activeId: null, projects: [] };

/* ---------- Coercion ----------
   Persisted JSON is untrusted: it may come from an older build that
   never wrote a key, or from a hand-edited projects.json. Every field
   is validated against the default rather than spread. */

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function int(v: unknown, fallback: number, min = -Infinity): number {
  const n = Math.trunc(num(v, fallback));
  return n < min ? fallback : n;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function coerceMode(v: unknown): DocMode {
  return DOC_MODES.includes(v as DocMode) ? (v as DocMode) : "code";
}

function coerceTab(raw: unknown): TabSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const path = str(r.path);
  if (!path) return null; // a tab without a path cannot be reopened
  const cursorRaw = (r.cursor ?? {}) as Record<string, unknown>;
  return {
    path,
    mode: coerceMode(r.mode),
    cursor: { line: int(cursorRaw.line, 1, 1), col: int(cursorRaw.col, 1, 1) },
    scrollTop: Math.max(0, num(r.scrollTop, 0)),
  };
}

function coerceExplorer(raw: unknown): ExplorerSnapshot {
  const d = EMPTY_WORKSPACE.explorer;
  if (!raw || typeof raw !== "object") return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    root: str(r.root),
    expanded: strList(r.expanded, MAX_EXPANDED),
    showHidden: bool(r.showHidden, d.showHidden),
    selectedPath: str(r.selectedPath),
  };
}

function coerceTerminal(raw: unknown): TerminalSnapshot {
  const d = EMPTY_WORKSPACE.terminal;
  if (!raw || typeof raw !== "object") return { ...d, tabs: [], panel: { ...d.panel } };
  const r = raw as Record<string, unknown>;
  const tabs: TerminalTabSnapshot[] = [];
  if (Array.isArray(r.tabs)) {
    for (const item of r.tabs) {
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      const cwd = str(t.cwd);
      if (!cwd) continue;
      tabs.push({
        cwd,
        privilege: t.privilege === "root" ? "root" : "user",
        label: str(t.label) ?? `Terminal ${tabs.length + 1}`,
      });
      if (tabs.length >= MAX_RESTORE_TABS) break;
    }
  }
  const panelRaw = (r.panel ?? {}) as Record<string, unknown>;
  const activeIndex = int(r.activeIndex, -1);
  return {
    tabs,
    activeIndex: activeIndex >= 0 && activeIndex < tabs.length ? activeIndex : tabs.length ? 0 : -1,
    isOpen: bool(r.isOpen, d.isOpen) && tabs.length > 0,
    // Ordinals must never collide with restored labels, so the floor is
    // one past the tab count rather than 1.
    nextOrdinal: Math.max(int(r.nextOrdinal, 1, 1), tabs.length + 1),
    panel: {
      x: Math.max(0, num(panelRaw.x, d.panel.x)),
      y: Math.max(0, num(panelRaw.y, d.panel.y)),
      w: Math.max(1, num(panelRaw.w, d.panel.w)),
      h: Math.max(1, num(panelRaw.h, d.panel.h)),
    },
    mobile: bool(r.mobile, d.mobile),
  };
}

function coerceLayout(raw: unknown): LayoutSnapshot {
  const d = EMPTY_WORKSPACE.layout;
  if (!raw || typeof raw !== "object") return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    sidebarWidth: int(r.sidebarWidth, d.sidebarWidth, 1),
    sidebarCollapsed: bool(r.sidebarCollapsed, d.sidebarCollapsed),
    showStatus: bool(r.showStatus, d.showStatus),
  };
}

export function coerceWorkspace(raw: unknown): Workspace {
  if (!raw || typeof raw !== "object") {
    return { ...EMPTY_WORKSPACE, tabs: [], explorer: { ...EMPTY_WORKSPACE.explorer, expanded: [] } };
  }
  const r = raw as Record<string, unknown>;
  const tabs: TabSnapshot[] = [];
  if (Array.isArray(r.tabs)) {
    for (const item of r.tabs) {
      const t = coerceTab(item);
      if (t) tabs.push(t);
      if (tabs.length >= MAX_RESTORE_TABS) break;
    }
  }
  const activeIndex = int(r.activeIndex, -1);
  return {
    tabs,
    activeIndex: activeIndex >= 0 && activeIndex < tabs.length ? activeIndex : tabs.length ? 0 : -1,
    explorer: coerceExplorer(r.explorer),
    terminal: coerceTerminal(r.terminal),
    layout: coerceLayout(r.layout),
  };
}

function coerceProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const rootPath = id === LOOSE_ID ? null : str(r.rootPath);
  if (id !== LOOSE_ID && !rootPath) return null;
  return {
    id,
    rootPath,
    name: str(r.name) ?? defaultName(rootPath),
    lastOpened: Math.max(0, num(r.lastOpened, 0)),
    workspace: coerceWorkspace(r.workspace),
  };
}

export function coerce(raw: unknown): ProjectsCache {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CACHE, projects: [] };
  const r = raw as Record<string, unknown>;
  // A version mismatch discards the cache. Unlike settings.json this file
  // is disposable — the worst case is one launch that does not restore.
  if (r.version !== SCHEMA_VERSION) return { ...EMPTY_CACHE, projects: [] };

  const seen = new Set<string>();
  const projects: Project[] = [];
  if (Array.isArray(r.projects)) {
    for (const item of r.projects) {
      const p = coerceProject(item);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      projects.push(p);
    }
  }
  projects.sort((a, b) => b.lastOpened - a.lastOpened);
  projects.length = Math.min(projects.length, MAX_PROJECTS);

  const activeId = str(r.activeId);
  return {
    version: SCHEMA_VERSION,
    activeId: activeId && projects.some((p) => p.id === activeId) ? activeId : null,
    projects,
  };
}

/* ---------- Identity ---------- */

/** The normalized root path is the id — human-readable in projects.json. */
export function projectId(rootPath: string | null): string {
  return rootPath ? normalizeRoot(rootPath) : LOOSE_ID;
}

export function defaultName(rootPath: string | null): string {
  if (!rootPath) return "No folder";
  const norm = normalizeRoot(rootPath);
  const base = norm.split("/").filter(Boolean).pop();
  return base || norm;
}

/* ---------- Persistence ---------- */

function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

let tauriStore: LazyStore | null = null;
function getStore(): LazyStore | null {
  if (!inTauri()) return null;
  if (!tauriStore) tauriStore = new LazyStore(STORE_FILE, { autoSave: true });
  return tauriStore;
}

function readLocal(): ProjectsCache {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return coerce(v ? JSON.parse(v) : null);
  } catch {
    return coerce(null);
  }
}

function writeLocal(c: ProjectsCache) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(c));
  } catch {
    /* private mode / quota — the in-memory cache still applies */
  }
}

/** localStorage first (synchronous, survives a crash mid-write), then the
    Tauri store fire-and-forget. */
function persist(next: ProjectsCache) {
  writeLocal(next);
  getStore()?.set(STORE_KEY, next).catch(() => {});
}

/* ---------- Store ---------- */

interface ProjectsState extends ProjectsCache {
  /** True once the Tauri-backed read has resolved (or been ruled out). */
  hydrated: boolean;
  /** The active project, or null. */
  active: () => Project | null;
  get: (id: string) => Project | null;
  /** Create-or-touch a project for `rootPath` and make it active. */
  openProject: (rootPath: string | null) => Project;
  /** Replace the active project's workspace snapshot. */
  saveWorkspace: (workspace: Workspace) => void;
  renameProject: (id: string, name: string) => void;
  removeProject: (id: string) => void;
  clearActive: () => void;
}

function commit(next: ProjectsCache): ProjectsCache {
  next.projects.sort((a, b) => b.lastOpened - a.lastOpened);
  next.projects.length = Math.min(next.projects.length, MAX_PROJECTS);
  if (next.activeId && !next.projects.some((p) => p.id === next.activeId)) next.activeId = null;
  persist(next);
  return next;
}

function snapshot(s: ProjectsState): ProjectsCache {
  return { version: SCHEMA_VERSION, activeId: s.activeId, projects: s.projects.map((p) => ({ ...p })) };
}

export const useProjects = create<ProjectsState>((set, get) => {
  const initial = typeof window === "undefined" ? { ...EMPTY_CACHE, projects: [] } : readLocal();

  return {
    ...initial,
    hydrated: false,

    active: () => {
      const s = get();
      return s.projects.find((p) => p.id === s.activeId) ?? null;
    },

    get: (id) => get().projects.find((p) => p.id === id) ?? null,

    openProject: (rootPath) => {
      const id = projectId(rootPath);
      const normalized = rootPath ? normalizeRoot(rootPath) : null;
      const s = get();
      const existing = s.projects.find((p) => p.id === id);
      const project: Project = existing
        ? { ...existing, rootPath: normalized, lastOpened: Date.now() }
        : {
            id,
            rootPath: normalized,
            name: defaultName(normalized),
            lastOpened: Date.now(),
            workspace: { ...EMPTY_WORKSPACE, tabs: [] },
          };
      const next = commit({
        version: SCHEMA_VERSION,
        activeId: id,
        projects: [project, ...s.projects.filter((p) => p.id !== id)],
      });
      set(next);
      return project;
    },

    saveWorkspace: (workspace) => {
      const s = get();
      if (!s.activeId) return;
      const idx = s.projects.findIndex((p) => p.id === s.activeId);
      if (idx < 0) return;
      const next = snapshot(s);
      next.projects[idx] = { ...next.projects[idx], workspace, lastOpened: Date.now() };
      set(commit(next));
    },

    renameProject: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const s = get();
      const idx = s.projects.findIndex((p) => p.id === id);
      if (idx < 0) return;
      const next = snapshot(s);
      next.projects[idx] = { ...next.projects[idx], name: trimmed };
      set(commit(next));
    },

    removeProject: (id) => {
      const s = get();
      const next = snapshot(s);
      next.projects = next.projects.filter((p) => p.id !== id);
      if (next.activeId === id) next.activeId = null;
      set(commit(next));
    },

    clearActive: () => {
      const next = snapshot(get());
      next.activeId = null;
      set(commit(next));
    },
  };
});

/**
 * Read the persisted cache. Resolves once the Tauri-backed read has
 * settled (or been ruled out), so boot can await it before restoring.
 */
export async function hydrateProjects(): Promise<void> {
  const store = getStore();
  if (store) {
    try {
      const v = await store.get<ProjectsCache>(STORE_KEY);
      if (v != null) {
        const c = coerce(v);
        useProjects.setState({ version: c.version, activeId: c.activeId, projects: c.projects });
      }
    } catch {
      /* unreadable cache — the localStorage mirror already seeded the store */
    }
  }
  useProjects.setState({ hydrated: true });
}

/** Non-React reader, mirroring getSettings(). */
export const getProjects = (): ProjectsCache => {
  const s = useProjects.getState();
  return { version: s.version, activeId: s.activeId, projects: s.projects };
};
