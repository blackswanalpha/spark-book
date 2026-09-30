/* ============================================================
   sparkBook · src/shell/projects/windowBridge.ts

   The wiring between editor windows and the Projects window.

   The Projects window is one OS window (label `projects`), opened
   from any editor window's rail. It owns no workspace: it reads the
   checkpoint, writes project rows through it, and tells editor
   windows what to do with three events:

     · open-here — sent to ONE editor window: switch to this project.
     · edited    — broadcast: a project was renamed, pinned or
                   removed, so every window's cache follows.
     · opener    — sent to the Projects window: a different editor
                   window just asked for it, so that is now "this
                   window".

   Outside Tauri (vite dev) the Projects window is a popup tab and the
   same events travel as DOM events on `window.opener`.

   `OPENER_EVENT` is also emitted by the host (project_new.rs) when the
   window already exists; the two names must match.
   ============================================================ */
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo } from "@tauri-apps/api/event";
import {
  checkpointSaveProject,
  currentWindowLabel,
  isTauriHost,
} from "@bridge/checkpoint";
import { MAIN_LABEL } from "@store/checkpoint";
import type { Workspace } from "@store/projects";

export const PROJECTS_LABEL = "projects";
export const OPEN_HERE_EVENT = "spark:projects:open-here";
export const EDITED_EVENT = "spark:projects:edited";
export const OPENER_EVENT = "spark:projects:opener";

/** A project as it travels between windows: a checkpoint row, minus bookkeeping. */
export interface ProjectPayload {
  id: string;
  rootPath: string;
  name: string;
  lastOpened: number;
  pinned: boolean;
  workspace: Workspace;
}

export interface OpenHerePayload {
  /** The window meant to act. Checked on arrival as well as routed. */
  target: string;
  /** `auto`: only if this window is free, else open a new window.
      `replace`: switch this window, unless it has unsaved files. */
  mode: "auto" | "replace";
  project: ProjectPayload;
}

export type EditedPayload =
  | { kind: "rename"; id: string; name: string }
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "remove"; id: string };

export function isProjectsWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("projects");
  } catch {
    return false;
  }
}

/* ---------- Opening the Projects window ----------
   Window lookups go through the host (project_new.rs): "is it open,
   open it, focus it" is one call there rather than three here. */

/** Longest an open may take before the latch lets go. */
const OPEN_TIMEOUT_MS = 10_000;

let opening: Promise<void> | null = null;

/**
 * Open the Projects window, or bring it forward and make `opener` its
 * "this window". Latched so a double click cannot race two creates,
 * and the latch is bounded so a call that never answers cannot leave
 * the button dead.
 */
export function openProjectsWindow(opener = currentWindowLabel()): Promise<void> {
  if (!opening) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The Projects window did not respond. Try again.")), OPEN_TIMEOUT_MS);
    });
    opening = Promise.race([open(opener), timeout]).finally(() => {
      clearTimeout(timer);
      opening = null;
    });
  }
  return opening;
}

async function open(opener: string): Promise<void> {
  if (!isTauriHost) {
    window.open(`index.html?projects=1&opener=${encodeURIComponent(opener)}`, "spark-projects", "popup,width=960,height=640");
    return;
  }
  await invoke("projects_window_open", { opener });
}

/* ---------- Other windows ---------- */

/** Bring window `label` forward. False when it no longer exists. */
export async function focusWindow(label: string): Promise<boolean> {
  if (!isTauriHost) return false;
  return invoke<boolean>("window_focus", { label });
}

/** Bring this window forward. */
export async function focusSelf(): Promise<void> {
  if (!isTauriHost) {
    window.focus();
    return;
  }
  await invoke("window_focus", { label: currentWindowLabel() }).catch(() => {});
}

/** Labels of the windows that exist right now. */
export async function liveLabels(): Promise<Set<string>> {
  if (!isTauriHost) {
    const opener = (window.opener as Window | null) ?? null;
    return new Set(opener && !opener.closed ? [MAIN_LABEL] : []);
  }
  return new Set(await invoke<string[]>("window_labels"));
}

export async function closeSelf(): Promise<void> {
  if (!isTauriHost) {
    window.close();
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/* ---------- Events ---------- */

/** The editor tab that opened this popup, in vite dev. Its own
    CustomEvent constructor is used so the event belongs to its realm. */
type OpenerWindow = Window & { CustomEvent: typeof CustomEvent };

function openerWindow(): OpenerWindow | null {
  const o = (window.opener as OpenerWindow | null) ?? null;
  return o && !o.closed ? o : null;
}

export async function sendOpenHere(payload: OpenHerePayload): Promise<void> {
  if (isTauriHost) {
    await emitTo(payload.target, OPEN_HERE_EVENT, payload);
    return;
  }
  const o = openerWindow();
  if (!o) throw new Error("The window this was opened from has closed.");
  o.dispatchEvent(new o.CustomEvent(OPEN_HERE_EVENT, { detail: payload }));
}

export async function broadcastEdit(payload: EditedPayload): Promise<void> {
  if (isTauriHost) {
    await emit(EDITED_EVENT, payload);
    return;
  }
  const o = openerWindow();
  o?.dispatchEvent(new o.CustomEvent(EDITED_EVENT, { detail: payload }));
}

/* ---------- Checkpoint rows ---------- */

let lastRev = 0;

/**
 * Write one project row as the Projects window. Revs are clock-based:
 * the host rejects a rev at or below the last one from the same writer,
 * and a reopened Projects window starts a fresh counter.
 */
export async function writeRow(p: ProjectPayload): Promise<boolean> {
  lastRev = Math.max(Date.now(), lastRev + 1);
  const ack = await checkpointSaveProject({
    id: p.id,
    rootPath: p.rootPath,
    name: p.name,
    lastOpened: p.lastOpened,
    rev: lastRev,
    writer: PROJECTS_LABEL,
    pinned: p.pinned,
    workspace: p.workspace,
  });
  return ack.accepted;
}
