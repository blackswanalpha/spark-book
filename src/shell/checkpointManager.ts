/* ============================================================
   sparkBook · src/shell/checkpointManager.ts

   One window's half of the checkpoint.

   Boot claims the previous run's window list, reopens the windows it
   names, and hands this window the project it should show. From then
   on a debounced mirror keeps the host's copy of the active project
   and of this window's row up to date.

   Three things this module is careful about, because a checkpoint
   that gets them wrong is worse than no checkpoint at all:

     · claim-once — `bootCheckpoint` is latched on a module promise, so
       StrictMode's double mount, or two callers racing, still produce
       exactly one claim and one set of windows. The host enforces the
       same thing across windows; this is the per-window half.

     · no writes after teardown — every scheduled write checks the
       generation it was scheduled in. A tick that was already queued
       when the window tore down finds a bumped generation and returns
       without touching the host.

     · nothing outlives the window — teardown clears the timer, drops
       every store subscription and removes every listener it added.
       There is no other state to release: geometry is read from the
       webview synchronously rather than through a Tauri listener, so
       there is no async unlisten to lose.
   ============================================================ */
import {
  checkpointClaimRestore,
  checkpointLoad,
  checkpointOpenWindow,
  checkpointRemoveProject,
  checkpointSaveProject,
  checkpointSaveWindow,
  currentWindowLabel,
  type SaveAck,
} from "@bridge/checkpoint";
import {
  MAIN_LABEL,
  MAX_WINDOWS,
  type Geometry,
  type ProjectRecord,
  type WindowRecord,
} from "@store/checkpoint";
import { useProjects, SCHEMA_VERSION, byPinThenRecency, type Project } from "@store/projects";
import { captureWorkspace, isRestoring } from "@shell/workspace";

/** Matches the workspace autosave, so the two settle in one beat. */
export const CHECKPOINT_DEBOUNCE_MS = 800;

/* ---------- Module state ----------
   All of it is per window: a webview is its own JS realm, so "module
   scope" here means "this window", not "this app". */

let bootPromise: Promise<CheckpointBoot> | null = null;
let revision = 0;
/** Bumped by every teardown. A tick from an older generation is a no-op. */
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let live: LiveState | null = null;

interface LiveState {
  generation: number;
  label: string;
  /** Last window row written, so an unchanged row is not rewritten. */
  lastWindowKey: string;
  /** Last project row written, keyed by id + serialized workspace. */
  lastProjectKey: string;
  unsubs: Array<() => void>;
  onUnload: () => void;
}

const nextRev = () => ++revision;

/* ---------- Boot ---------- */

export interface CheckpointBoot {
  /** This window's Tauri label — the row it owns. */
  label: string;
  /** The project this window should open, or null to fall through. */
  projectId: string | null;
  /** Project rows the host knows about, newest first. */
  projects: Project[];
  /** Labels of windows this boot reopened. Empty for every window but one. */
  openedWindows: string[];
  /** True when this window took the restore plan. */
  claimed: boolean;
}

function toProject(rec: ProjectRecord): Project {
  return {
    id: rec.id,
    rootPath: rec.rootPath,
    name: rec.name,
    lastOpened: rec.lastOpened,
    pinned: rec.pinned === true,
    workspace: rec.workspace,
  };
}

/** Geometry straight from the webview. No listener, so nothing to unlisten. */
export function readGeometry(): Geometry | null {
  if (typeof window === "undefined") return null;
  const w = window.outerWidth || window.innerWidth || 0;
  const h = window.outerHeight || window.innerHeight || 0;
  if (w < 1 || h < 1) return null;
  return {
    x: window.screenX || 0,
    y: window.screenY || 0,
    w,
    h,
    maximized: false,
  };
}

async function runBoot(label: string): Promise<CheckpointBoot> {
  const cp = await checkpointLoad();
  const projects = cp.projects.map(toProject);

  let projectId: string | null = null;
  let claimed = false;
  const openedWindows: string[] = [];

  if (label === MAIN_LABEL) {
    // Only the window Tauri creates for the app claims. The host would
    // refuse a second claim anyway; asking from one place keeps the
    // reason for that legible.
    const plan: WindowRecord[] | null = await checkpointClaimRestore();
    if (plan && plan.length > 0) {
      claimed = true;
      projectId = plan[0].projectId;
      // Sequentially: the host allocates labels under its lock, and a
      // failure to open the third window must not cost the fourth.
      for (const rec of plan.slice(1, MAX_WINDOWS)) {
        try {
          openedWindows.push(await checkpointOpenWindow(rec.projectId, rec.geometry));
        } catch {
          /* a window that will not open is a lost window, not a lost boot */
        }
      }
    }
  } else {
    // A window the host opened: its row was seeded under the lock
    // before this webview existed, so it is already here.
    projectId = cp.windows.find((w) => w.label === label)?.projectId ?? null;
  }

  await checkpointSaveWindow({
    label,
    projectId,
    geometry: readGeometry(),
    rev: nextRev(),
  });

  return { label, projectId, projects, openedWindows, claimed };
}

/**
 * Claim the restore plan and report what this window should show.
 * Latched: every caller in this window shares one run.
 */
export function bootCheckpoint(label = currentWindowLabel()): Promise<CheckpointBoot> {
  if (!bootPromise) bootPromise = runBoot(label);
  return bootPromise;
}

/**
 * Fold the host's project rows into the projects store. The checkpoint
 * wins over the local mirror: it is the copy every window writes
 * through, so it is the one that saw the other windows — unless the
 * local copy of that project is newer. The mirror lands one debounce
 * after the local save, so a quit that skips the flush (a crash, a
 * logout's SIGTERM) left the checkpoint a step behind, and boot restored
 * the older workspace over the newer one.
 */
export function seedProjects(rows: Project[], activeId: string | null) {
  const s = useProjects.getState();
  const byId = new Map<string, Project>();
  for (const p of s.projects) byId.set(p.id, p);
  for (const p of rows) {
    const local = byId.get(p.id);
    if (!local || p.lastOpened >= local.lastOpened) byId.set(p.id, p);
  }
  const projects = [...byId.values()].sort(byPinThenRecency);
  useProjects.setState({
    version: SCHEMA_VERSION,
    projects,
    activeId: activeId && projects.some((p) => p.id === activeId) ? activeId : s.activeId,
  });
}

/* ---------- Mirror ---------- */

function windowKey(projectId: string | null, g: Geometry | null): string {
  return `${projectId ?? ""}|${g ? `${g.x},${g.y},${g.w},${g.h}` : ""}`;
}

async function writeNow(gen: number): Promise<void> {
  // The window this tick belongs to is gone, or a restore is replaying
  // into the stores it would read. Either way there is nothing true to
  // write yet.
  if (gen !== generation || !live || live.generation !== gen) return;
  if (isRestoring()) return;

  const state = useProjects.getState();
  const active = state.projects.find((p) => p.id === state.activeId) ?? null;

  const geometry = readGeometry();
  const key = windowKey(active?.id ?? null, geometry);
  if (key !== live.lastWindowKey) {
    live.lastWindowKey = key;
    const ack = await checkpointSaveWindow({
      label: live.label,
      projectId: active?.id ?? null,
      geometry,
      rev: nextRev(),
    });
    if (gen !== generation || !live) return;
    if (!settled(ack)) live.lastWindowKey = "";
  }

  if (!active) return;
  // captureWorkspace reads the live stores, which is what makes this a
  // mirror of the window rather than of the projects cache: the cache's
  // own debounce may not have landed yet.
  const workspace = captureWorkspace();
  const projectKey = `${active.id}|${JSON.stringify(workspace)}`;
  if (projectKey === live.lastProjectKey) return;
  live.lastProjectKey = projectKey;
  const ack = await checkpointSaveProject({
    id: active.id,
    rootPath: active.rootPath,
    name: active.name,
    lastOpened: active.lastOpened || Date.now(),
    rev: nextRev(),
    writer: live.label,
    pinned: active.pinned === true,
    workspace,
  });
  if (gen !== generation || !live) return;
  if (!settled(ack)) live.lastProjectKey = "";
}

/**
 * Whether the host is done with this row. An accepted write is settled,
 * and so is one it will never take — a workspace past the byte ceiling
 * will not fit on the next tick either, and retrying it every keystroke
 * would be a busy loop. Anything else is worth sending again.
 */
function settled(ack: SaveAck): boolean {
  return ack.accepted || ack.reason === "too-large";
}

function schedule() {
  if (!live) return;
  if (isRestoring()) return;
  const gen = live.generation;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void writeNow(gen);
  }, CHECKPOINT_DEBOUNCE_MS);
}

/** Write the pending mirror now. Safe to call after teardown — it no-ops. */
export function flushCheckpoint(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!live) return Promise.resolve();
  return writeNow(live.generation);
}

/**
 * Mirror this window into the checkpoint until the returned teardown
 * runs. Starting twice tears the first one down first, so a hot reload
 * cannot leave two mirrors on one window.
 */
export function startCheckpointMirror(label = currentWindowLabel()): () => void {
  stopCheckpointMirror();
  const gen = ++generation;

  const state: LiveState = {
    generation: gen,
    label,
    lastWindowKey: "",
    lastProjectKey: "",
    unsubs: [],
    onUnload: () => {
      // Last chance before the webview is torn down. The host keeps the
      // row (the app is quitting, not the window), so what matters here
      // is that the final workspace lands.
      void flushCheckpoint();
    },
  };
  live = state;

  state.unsubs.push(useProjects.subscribe(schedule));
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", state.onUnload);
    state.unsubs.push(() => window.removeEventListener("beforeunload", state.onUnload));
  }

  return () => {
    if (live !== state) return; // already replaced; the replacement owns teardown
    stopCheckpointMirror();
  };
}

/** Drop the mirror: timer, subscriptions and listeners all go. */
export function stopCheckpointMirror() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const state = live;
  live = null;
  generation++;
  if (!state) return;
  for (const off of state.unsubs.splice(0)) {
    try {
      off();
    } catch {
      /* a listener that will not detach must not block the rest */
    }
  }
}

/**
 * Write one project row now.
 *
 * The mirror only follows the project in front of this window, so a
 * rename from the switcher — which can name any project — would sit in
 * the local cache and be undone by the next launch without this.
 */
export function mirrorProject(project: Project): Promise<unknown> {
  return checkpointSaveProject({
    id: project.id,
    rootPath: project.rootPath,
    name: project.name,
    lastOpened: project.lastOpened || Date.now(),
    rev: nextRev(),
    writer: live?.label ?? currentWindowLabel(),
    pinned: project.pinned === true,
    workspace: project.workspace,
  }).catch(() => undefined);
}

/** Drop a project row. Removing it from the switcher has to mean this. */
export function dropProject(id: string): Promise<unknown> {
  return checkpointRemoveProject(id).catch(() => undefined);
}

/** Test seam: forget the boot latch and every mirror. */
export function __resetCheckpointManager() {
  stopCheckpointMirror();
  bootPromise = null;
  revision = 0;
}
