/* ============================================================
   sparkBook · src/store/terminal.ts
   Terminal UI store — panel visibility, the list of open terminal
   sessions, which one is in front, and whether the panel is pinned
   to the mobile viewport.

   The shells themselves live in the Rust host; this store only
   holds what the panel needs to decide which sessions to show and
   what to spawn them with. The transitions are in
   shell/Terminal/sessions.ts, shared with the pop-out window.
   ============================================================ */
import { create } from "zustand";
import { useExplorer } from "@store/explorer";
import { getSettings } from "@store/settings";
import {
  cleanName,
  closeSession as removeSession,
  createSession,
  cycleFrom,
  findByCwd,
  nextActiveAfterClose,
  patchSession,
  type TerminalSession,
} from "@shell/Terminal/sessions";
import type { PtyPrivilege } from "@bridge/pty";
import type { TerminalStatus } from "@shell/Terminal/TerminalView";

/** Floating panel geometry. Lives here rather than in TerminalDialog's
    local state so it can be captured into the project workspace. */
export interface PanelRect { x: number; y: number; w: number; h: number }

export const DEFAULT_PANEL: PanelRect = { x: 0, y: 0, w: 720, h: 440 };

/** One restored terminal tab: the shell is respawned, not replayed. */
export interface RestoredTab {
  cwd: string;
  privilege: PtyPrivilege;
  label: string;
  /** The name the user gave the tab, if any. */
  name?: string | null;
}

/** Extras for a tab that is more than a plain shell. */
export interface NewSessionOptions {
  name?: string;
  /** Typed into the shell once it starts. */
  initialInput?: string;
}

interface TerminalState {
  isOpen: boolean;
  sessions: TerminalSession[];
  activeId: string | null;
  /** Name for the next tab. Never decremented, so names are not reused. */
  nextOrdinal: number;
  /** What each session's shell is doing, as its view last reported. */
  statuses: Record<string, TerminalStatus>;
  /** Panel pinned to the mobile viewport from Settings → Terminal. */
  mobile: boolean;
  /** Floating panel position and size. */
  panel: PanelRect;
  /** False until the panel has placed itself for the first time. */
  panelPlaced: boolean;
  /** The panel is showing what a workspace restore put back and nobody
      has touched it yet: its surfaces must not take the keyboard off the
      editor at boot. Any user-driven transition ends it. */
  restoredOpen: boolean;

  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Open the panel with a session at `cwd`, reusing one already there. */
  openAt: (cwd: string) => void;
  /** Create the first session if the panel opened without one. */
  ensureSession: (cwd: string) => void;
  /** The "+" button: always a new tab, always focused. */
  addSession: (cwd: string, opts?: NewSessionOptions) => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  /** Focus the next (1) or previous (-1) tab, wrapping. */
  cycleSession: (step: 1 | -1) => void;
  /** Name a tab; a blank name goes back to the directory. */
  renameSession: (id: string, name: string | null) => void;
  /** Record where a shell is now (it reports this as it `cd`s). */
  setSessionCwd: (id: string, cwd: string) => void;
  setPrivilege: (id: string, p: PtyPrivilege) => void;
  restartSession: (id: string) => void;
  setSessionTitle: (id: string, title: string | null) => void;
  setStatus: (id: string, status: TerminalStatus) => void;
  setMobile: (m: boolean) => void;
  setPanelRect: (patch: Partial<PanelRect>, placed?: boolean) => void;
  /** Rebuild the tab list from a persisted workspace. */
  restoreTabs: (tabs: RestoredTab[], activeIndex: number, nextOrdinal: number, isOpen: boolean) => void;
  /** Drop every session and close the panel — leaving a project. */
  reset: () => void;
}

const defaultPrivilege = () => getSettings().terminal.defaultPrivilege;

/** A shell that can still take input. */
const isLive = (status: TerminalStatus | undefined) =>
  !status || status.phase === "starting" || status.phase === "running";

/** Drop the status of every session that is gone, or the map grows for
    the life of the window. */
function pruneStatuses(
  statuses: Record<string, TerminalStatus>,
  sessions: TerminalSession[],
): Record<string, TerminalStatus> {
  const live = new Set(sessions.map((s) => s.id));
  const keys = Object.keys(statuses);
  if (keys.every((k) => live.has(k))) return statuses;
  const next: Record<string, TerminalStatus> = {};
  for (const k of keys) if (live.has(k)) next[k] = statuses[k];
  return next;
}

export const useTerminal = create<TerminalState>((set) => ({
  isOpen: false,
  sessions: [],
  activeId: null,
  nextOrdinal: 1,
  statuses: {},
  mobile: false,
  panel: { ...DEFAULT_PANEL },
  panelPlaced: false,
  restoredOpen: false,

  // Opening does not spawn anything: the panel derives the cwd from the
  // explorer and calls ensureSession once it has one.
  open: () => set({ isOpen: true, restoredOpen: false }),
  close: () => set({ isOpen: false, restoredOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen, restoredOpen: false })),

  openAt: (cwd) =>
    set((s) => {
      // Clicking "Open in Terminal" on the same folder twice should land
      // you back in that shell, not stack duplicate tabs — unless that
      // shell has exited, which is not a terminal to land in.
      const existing = findByCwd(
        s.sessions.filter((x) => isLive(s.statuses[x.id])),
        cwd,
      );
      if (existing) return { isOpen: true, activeId: existing.id, restoredOpen: false };
      const session = createSession(cwd, defaultPrivilege(), s.nextOrdinal);
      return {
        isOpen: true,
        sessions: [...s.sessions, session],
        activeId: session.id,
        nextOrdinal: s.nextOrdinal + 1,
        restoredOpen: false,
      };
    }),

  // Idempotent, so the panel's mount effect running twice under React's
  // StrictMode double-invoke cannot open two shells.
  ensureSession: (cwd) =>
    set((s) => {
      if (s.sessions.length > 0) {
        return s.activeId ? {} : { activeId: s.sessions[0].id };
      }
      const session = createSession(cwd, defaultPrivilege(), s.nextOrdinal);
      return { sessions: [session], activeId: session.id, nextOrdinal: s.nextOrdinal + 1 };
    }),

  addSession: (cwd, opts) =>
    set((s) => {
      const session = {
        ...createSession(cwd, defaultPrivilege(), s.nextOrdinal),
        name: cleanName(opts?.name),
        initialInput: opts?.initialInput,
      };
      return {
        sessions: [...s.sessions, session],
        activeId: session.id,
        nextOrdinal: s.nextOrdinal + 1,
        restoredOpen: false,
      };
    }),

  closeSession: (id) =>
    set((s) => {
      const activeId = nextActiveAfterClose(s.sessions, id, s.activeId);
      const sessions = removeSession(s.sessions, id);
      // The last tab closing closes the panel: an empty terminal panel is
      // just chrome around nothing.
      return {
        sessions,
        activeId,
        isOpen: sessions.length > 0,
        statuses: pruneStatuses(s.statuses, sessions),
        restoredOpen: false,
      };
    }),

  setActiveSession: (id) => set({ activeId: id, restoredOpen: false }),

  cycleSession: (step) =>
    set((s) => {
      const next = cycleFrom(s.sessions, s.activeId, step);
      return next === s.activeId ? {} : { activeId: next, isOpen: true, restoredOpen: false };
    }),

  renameSession: (id, name) =>
    set((s) => ({ sessions: patchSession(s.sessions, id, { name: cleanName(name) }) })),

  // Both arrive with every frame. Returning the state itself for a no-op
  // is what keeps zustand from notifying: a fresh `{}` counts as a change,
  // and would restart the workspace autosave's debounce on every frame.
  setSessionCwd: (id, cwd) =>
    set((s) => {
      const sessions = patchSession(s.sessions, id, { liveCwd: cwd });
      return sessions === s.sessions ? s : { sessions };
    }),

  // Privilege is per session and keyed by the view, so flipping it
  // respawns that one shell and leaves the other tabs alone. A task's
  // command is dropped: re-running a build as root would leave root-owned
  // files in the project.
  setPrivilege: (id, privilege) =>
    set((s) => ({
      sessions: patchSession(s.sessions, id, { privilege, initialInput: undefined }),
      restoredOpen: false,
    })),

  restartSession: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, restartKey: x.restartKey + 1 } : x,
      ),
      restoredOpen: false,
    })),

  setSessionTitle: (id, title) =>
    set((s) => {
      const sessions = patchSession(s.sessions, id, { title });
      return sessions === s.sessions ? s : { sessions };
    }),

  setStatus: (id, status) =>
    set((s) => {
      // Only for a session the panel still shows; a view tearing down after
      // its tab closed must not resurrect an entry.
      if (!s.sessions.some((x) => x.id === id) || s.statuses[id] === status) return s;
      return { statuses: { ...s.statuses, [id]: status } };
    }),

  setMobile: (mobile) => set({ mobile }),

  setPanelRect: (patch, placed) =>
    set((s) => ({
      panel: { ...s.panel, ...patch },
      panelPlaced: placed ?? s.panelPlaced,
    })),

  // Restore builds sessions directly rather than through addSession,
  // which hard-codes the *default* privilege and cannot reproduce a
  // saved one. Every tab starts at restartKey 0 with a fresh shell:
  // scrollback is not persisted, only where the shell was rooted.
  restoreTabs: (tabs, activeIndex, nextOrdinal, isOpen) =>
    set((s) => {
      const sessions = tabs.map((t, i) => ({
        ...createSession(t.cwd, t.privilege, i + 1),
        label: t.label,
        name: cleanName(t.name),
      }));
      const idx = activeIndex >= 0 && activeIndex < sessions.length ? activeIndex : 0;
      return {
        sessions,
        activeId: sessions.length ? sessions[idx].id : null,
        nextOrdinal: Math.max(nextOrdinal, sessions.length + 1),
        isOpen: isOpen && sessions.length > 0,
        restoredOpen: isOpen && sessions.length > 0,
        // A restored tab that matches a live one by id and cwd keeps its
        // view, so its status must survive too; the rest are stale.
        statuses: pruneStatuses(s.statuses, sessions),
      };
    }),

  // Terminal tabs are part of a project's workspace, the same as its
  // document tabs. Switching or closing a project used to leave the
  // outgoing project's shells running, and the next autosave wrote them
  // into the incoming project's snapshot.
  reset: () =>
    set({
      sessions: [],
      activeId: null,
      nextOrdinal: 1,
      statuses: {},
      isOpen: false,
      restoredOpen: false,
    }),
}));

/** Imperative entry point for non-React callers (context menu, bubble menu). */
export function openTerminalAt(cwd: string) {
  // Keep the explorer selection in sync so the panel's cwd derivation and
  // the tree agree about where "here" is.
  try {
    useExplorer.getState().setSelected(cwd);
  } catch {
    /* explorer not mounted */
  }
  useTerminal.getState().openAt(cwd);
}

export function closeTerminal() {
  useTerminal.getState().close();
}

/** The session the panel's actions apply to, if any. */
export function activeSession(): TerminalSession | null {
  const { sessions, activeId } = useTerminal.getState();
  return sessions.find((s) => s.id === activeId) ?? null;
}
