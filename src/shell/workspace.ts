/* ============================================================
   sparkBook · src/shell/workspace.ts

   Capture and restore the Workspace of the active project — the
   tabs, explorer tree, terminal tabs and panel layout that make a
   relaunch land where the last quit left off.

   This is the only module that reads all four stores at once. It
   deliberately does not import React: boot calls it once, and the
   autosave subscription runs outside the render tree.

   Guard discipline: nothing is written while `restoring` is true or
   before `hydrated`, so the restore's own store writes never feed
   back into the cache they came from.
   ============================================================ */
import { isTauri } from "@bridge/commands";
import { findOpenDoc, readForMode } from "./openDocument";
import { useDocs, isBinaryMode } from "@store/documents";
import { useExplorer } from "@store/explorer";
import { useTerminal } from "@store/terminal";
import { currentCwd } from "@shell/Terminal/sessions";
import {
  useProjects,
  EMPTY_WORKSPACE,
  MAX_RESTORE_TABS,
  MAX_EXPANDED,
  type Workspace,
  type TabSnapshot,
} from "@store/projects";

/* ---------- Layout bridge ----------
   Sidebar width/collapse live in a React hook (useSidebarLayout) and
   the status-bar toggle is App-local state, so neither is reachable
   from a plain module. The Shell registers accessors on mount. */

export interface LayoutBridge {
  getWidth: () => number;
  getCollapsed: () => boolean;
  getShowStatus: () => boolean;
  setWidth: (px: number) => void;
  setCollapsed: (v: boolean) => void;
  setShowStatus: (v: boolean) => void;
}

let layout: LayoutBridge | null = null;

export function registerLayoutBridge(bridge: LayoutBridge | null) {
  layout = bridge;
}

/* ---------- Guards ---------- */

let restoring = false;
let hydrated = false;

/** True while restoreWorkspace is running. Exported for tests. */
export const isRestoring = () => restoring;

export function markHydrated() {
  hydrated = true;
}

/* ---------- Capture ---------- */

export function captureWorkspace(): Workspace {
  const d = useDocs.getState();
  const e = useExplorer.getState();
  const t = useTerminal.getState();

  // Untitled buffers have no path and cannot be reopened from disk, so
  // they are dropped rather than persisted as empty shells.
  const tabs: TabSnapshot[] = [];
  for (const id of d.order) {
    const doc = d.docs[id];
    if (!doc?.path) continue;
    tabs.push({
      path: doc.path,
      mode: doc.mode,
      cursor: doc.cursor,
      scrollTop: doc.scrollTop ?? 0,
    });
    if (tabs.length >= MAX_RESTORE_TABS) break;
  }

  const activePath = d.active ? d.docs[d.active]?.path ?? null : null;
  const activeIndex = activePath ? tabs.findIndex((tb) => tb.path === activePath) : -1;

  const terminalActive = t.sessions.findIndex((s) => s.id === t.activeId);

  return {
    tabs,
    activeIndex: activeIndex >= 0 ? activeIndex : tabs.length ? 0 : -1,
    explorer: {
      root: e.root,
      expanded: Array.from(e.expanded).slice(0, MAX_EXPANDED),
      showHidden: e.showHidden,
      selectedPath: e.selectedPath,
    },
    terminal: {
      tabs: t.sessions.slice(0, MAX_RESTORE_TABS).map((s) => ({
        cwd: currentCwd(s),
        privilege: s.privilege,
        label: s.label,
        ...(s.name ? { name: s.name } : {}),
      })),
      activeIndex: terminalActive >= 0 ? terminalActive : t.sessions.length ? 0 : -1,
      isOpen: t.isOpen,
      nextOrdinal: t.nextOrdinal,
      panel: { ...t.panel },
      mobile: t.mobile,
    },
    layout: {
      sidebarWidth: layout?.getWidth() ?? EMPTY_WORKSPACE.layout.sidebarWidth,
      sidebarCollapsed: layout?.getCollapsed() ?? EMPTY_WORKSPACE.layout.sidebarCollapsed,
      showStatus: layout?.getShowStatus() ?? EMPTY_WORKSPACE.layout.showStatus,
    },
  };
}

/* ---------- Restore ---------- */

export interface RestoreResult {
  /** Tabs actually opened. */
  opened: number;
  /** Paths that no longer exist on disk. */
  missing: string[];
}

/**
 * Replay a workspace into the live stores. Returns how much came back
 * so boot can decide whether to fall through to the welcome path.
 *
 * Order matters: the explorer root must land before expansion, because
 * setRoot resets the expanded set to just the root.
 */
export async function restoreWorkspace(ws: Workspace): Promise<RestoreResult> {
  restoring = true;
  const missing: string[] = [];
  try {
    /* 1. Explorer root, then the expanded directories it just cleared. */
    if (ws.explorer.root) {
      const ex = useExplorer.getState();
      try {
        await ex.setRoot(ws.explorer.root);
      } catch {
        /* the folder is gone — leave the tree empty, tabs still restore */
      }
      // Shallow paths first, and sequentially: loadChildren drops results
      // from superseded navigations (`_loadGen`), so parallel expansion of
      // a deep path can race its own parent.
      const dirs = ws.explorer.expanded
        .filter((p) => p !== ws.explorer.root)
        .sort((a, b) => a.split("/").length - b.split("/").length);
      for (const dir of dirs) {
        try {
          await useExplorer.getState().setExpanded(dir, true);
        } catch {
          /* directory removed since last quit */
        }
      }
      if (ws.explorer.showHidden !== useExplorer.getState().showHidden) {
        useExplorer.getState().toggleShowHidden();
      }
      if (ws.explorer.selectedPath) {
        useExplorer.getState().setSelected(ws.explorer.selectedPath);
      }
    }

    /* 2. Tabs. Reads run in parallel; a rejection means the file is gone.
          One tab per path: snapshots from before openPath refused
          duplicates can hold the same file several times, and a file
          that is already open is not opened again. */
    const seen = new Set<string>();
    const wanted = ws.tabs
      .filter((t) => {
        if (seen.has(t.path) || findOpenDoc(t.path)) return false;
        seen.add(t.path);
        return true;
      })
      .slice(0, MAX_RESTORE_TABS);
    const activePath = ws.tabs[ws.activeIndex]?.path ?? null;
    // Image and PDF tabs hold bytes, not text: reading them through
    // `readFile` would return mojibake (or fail on invalid UTF-8). Video
    // and audio tabs are not read at all; they stream from the path.
    const results = await Promise.allSettled(wanted.map((t) => readForMode(t.path, t.mode)));

    const openDocs = useDocs.getState().open;
    const ids: string[] = [];
    let activeId: string | null = null;

    results.forEach((res, i) => {
      const tab = wanted[i];
      if (res.status !== "fulfilled") {
        missing.push(tab.path);
        return;
      }
      const id = openDocs({
        name: tab.path.split(/[\\/]/).pop() || tab.path,
        path: tab.path,
        mode: tab.mode,
        raw: res.value,
        binary: isBinaryMode(tab.mode),
        cursor: tab.cursor,
        scrollTop: tab.scrollTop,
      });
      ids.push(id);
      if (tab.path === activePath) activeId = id;
    });

    /* 3. Active tab. `open` focuses each doc as it lands, so the saved
          one is re-focused at the end; clamp when it was one of the
          missing files. */
    if (ids.length) {
      useDocs.getState().setActive(activeId ?? ids[0]);
    }

    /* 4. Terminal. The renderer has no PTY outside Tauri, so restoring
          tabs in a browser preview would only paint dead chrome. A
          snapshot with no tabs still replaces whatever is open: those
          shells belong to the project being left, not this one. */
    if (isTauri && ws.terminal.tabs.length) {
      useTerminal
        .getState()
        .restoreTabs(
          ws.terminal.tabs,
          ws.terminal.activeIndex,
          ws.terminal.nextOrdinal,
          ws.terminal.isOpen,
        );
    } else {
      useTerminal.getState().reset();
    }
    useTerminal.getState().setPanelRect(ws.terminal.panel, true);
    useTerminal.getState().setMobile(ws.terminal.mobile);

    /* 5. Layout. */
    if (layout) {
      layout.setWidth(ws.layout.sidebarWidth);
      layout.setCollapsed(ws.layout.sidebarCollapsed);
      layout.setShowStatus(ws.layout.showStatus);
    }

    return { opened: ids.length, missing };
  } finally {
    restoring = false;
  }
}

/* ---------- Autosave ---------- */

const DEBOUNCE_MS = 800;
let timer: ReturnType<typeof setTimeout> | null = null;

function write() {
  timer = null;
  if (restoring || !hydrated) return;
  if (!useProjects.getState().activeId) return;
  useProjects.getState().saveWorkspace(captureWorkspace());
}

function schedule() {
  if (restoring || !hydrated) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(write, DEBOUNCE_MS);
}

/** Write the pending snapshot now. Called before the window closes. */
export function flushWorkspace() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  write();
}

/**
 * Subscribe the cache to the stores. Start this only after restore has
 * finished, so the restore's writes are not mistaken for user edits.
 * Returns a teardown.
 */
export function startWorkspaceAutosave(): () => void {
  const unsubs = [
    useDocs.subscribe(schedule),
    useExplorer.subscribe(schedule),
    useTerminal.subscribe(schedule),
  ];
  const onUnload = () => flushWorkspace();
  if (typeof window !== "undefined") window.addEventListener("beforeunload", onUnload);
  return () => {
    for (const u of unsubs) u();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", onUnload);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Test seam: clear the module guards between cases. */
export function __resetWorkspaceGuards() {
  restoring = false;
  hydrated = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
