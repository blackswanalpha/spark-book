/* ============================================================
   sparkBook · src/shell/Terminal/sessions.ts

   The terminal panel's session list, as pure functions.

   Two places hold a list of terminals: the zustand store behind
   the docked panel, and the pop-out window's local state. Sharing
   the transitions rather than the container keeps "closing the
   active tab focuses its neighbour" from being written twice and
   drifting.

   A session carries the cwd and privilege it was SPAWNED with, not
   the ones the explorer currently points at. A shell you are typing
   in must not change directory because the file tree selection
   moved, and with several tabs open there is no single "current"
   directory to follow anyway.
   ============================================================ */
import type { PtyPrivilege } from "@bridge/pty";

export interface TerminalSession {
  id: string;
  /** Fallback tab name ("Terminal 2"), fixed for the session's life. */
  label: string;
  cwd: string;
  privilege: PtyPrivilege;
  /** Bumping this respawns the shell in place, keeping the tab. */
  restartKey: number;
  /** Title reported by the shell, when it sets one. */
  title: string | null;
  /** Where the shell is now, as the host last reported it. `cwd` stays
      the directory it was spawned in, because it keys the view: changing
      it would respawn the shell. */
  liveCwd?: string;
  /** A name the user gave the tab. Wins over everything else. */
  name?: string | null;
  /** Typed into the shell once it starts — a task's command line. */
  initialInput?: string;
  /** A live host session to attach to instead of spawning — set on a tab
      that was moved from another window. Only the first mount uses it; a
      restart spawns fresh. */
  adopt?: string;
}

/**
 * Ordinals are supplied by the caller, which holds `nextOrdinal` beside
 * its list. A module-level counter would be a side effect in what React
 * treats as pure — a `useState` initialiser runs twice under StrictMode,
 * and the first window's first tab came up named "Terminal 2".
 *
 * Ordinals are never reused, so two live tabs cannot share a name.
 */
export function createSession(
  cwd: string,
  privilege: PtyPrivilege,
  ordinal: number,
): TerminalSession {
  return {
    id: `term-${ordinal}`,
    label: `Terminal ${ordinal}`,
    cwd,
    privilege,
    restartKey: 0,
    title: null,
  };
}

/**
 * What the tab shows.
 *
 * NOT the shell's own title: most shells set it to "user@host: dir", so
 * every tab read "mbugua@…" once truncated to tab width — the one part
 * that differs between two shells was the part cut off. The directory's
 * last segment is short and is usually exactly what distinguishes them.
 * The full title and path stay in the tooltip.
 */
export function displayName(s: TerminalSession): string {
  const named = s.name?.trim();
  if (named) return named;
  const base = currentCwd(s).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base || s.label;
}

/** Where the shell is now: the reported directory, else where it started. */
export function currentCwd(s: TerminalSession): string {
  return s.liveCwd || s.cwd;
}

/** Tooltip: where the shell is, plus whatever title it reports. */
export function sessionTooltip(s: TerminalSession): string {
  const title = s.title?.trim();
  const where = currentCwd(s);
  return title ? `${where}\n${title}` : where;
}

export function patchSession(
  list: TerminalSession[],
  id: string,
  patch: Partial<TerminalSession>,
): TerminalSession[] {
  let changed = false;
  const next = list.map((s) => {
    if (s.id !== id) return s;
    // Titles arrive with every frame that carries one; returning the same
    // object for a no-op keeps the tab strip from re-rendering constantly.
    if (Object.entries(patch).every(([k, v]) => s[k as keyof TerminalSession] === v)) {
      return s;
    }
    changed = true;
    return { ...s, ...patch };
  });
  return changed ? next : list;
}

export function closeSession(list: TerminalSession[], id: string): TerminalSession[] {
  return list.filter((s) => s.id !== id);
}

/**
 * Which tab to focus once `id` is gone.
 *
 * Closing an inactive tab must not move focus, and closing the active one
 * lands on the tab that took its place — the neighbour to the right, or
 * the new last tab. Returns null when nothing is left.
 */
export function nextActiveAfterClose(
  list: TerminalSession[],
  id: string,
  activeId: string | null,
): string | null {
  if (activeId !== id) {
    return list.some((s) => s.id === activeId) ? activeId : (list[0]?.id ?? null);
  }
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return list[0]?.id ?? null;
  const remaining = closeSession(list, id);
  if (remaining.length === 0) return null;
  return remaining[Math.min(idx, remaining.length - 1)].id;
}

/** The session already sitting at `cwd`, if there is one. A shell that
    has since `cd`-ed elsewhere is not sitting there any more. */
export function findByCwd(list: TerminalSession[], cwd: string): TerminalSession | undefined {
  return list.find((s) => currentCwd(s) === cwd);
}

/** The session `step` places from `activeId`, wrapping at either end. */
export function cycleFrom(
  list: TerminalSession[],
  activeId: string | null,
  step: 1 | -1,
): string | null {
  if (list.length === 0) return null;
  const idx = list.findIndex((s) => s.id === activeId);
  if (idx < 0) return list[0].id;
  return list[(idx + step + list.length) % list.length].id;
}

/** A user-given tab name: trimmed, capped, and null when blank. */
export function cleanName(name: string | null | undefined): string | null {
  const t = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return t || null;
}
