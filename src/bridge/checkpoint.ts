/* ============================================================
   sparkBook · src/bridge/checkpoint.ts

   The checkpoint host. In Tauri every call goes to Rust, where one
   mutex serializes the whole table — that is what makes a write from
   window A and a write from window B safe to issue at the same time.

   Outside Tauri (vite dev, vitest) the same rules run here over a
   module-scope Session, persisted to localStorage. The reducers are
   shared with the native path by construction: store/checkpoint.ts
   states them once, Rust mirrors them, and this fallback calls them.

   Calls are queued rather than issued concurrently from one window.
   Ordering already survives a reorder (the rev guard rejects a stale
   write), but a queue means the accepted rev a caller reads back is
   the one it wrote, so a window's own revision counter cannot drift.
   ============================================================ */
import { invoke as tInvoke } from "@tauri-apps/api/core";
import {
  openSession,
  claimRestore as claimRestoreOf,
  allocateLabel,
  saveWindow as saveWindowOf,
  saveProject as saveProjectOf,
  removeProject as removeProjectOf,
  toDisk,
  coerceCheckpoint,
  MAIN_LABEL,
  type Checkpoint,
  type Geometry,
  type ProjectSave,
  type Session,
  type WindowRecord,
  type WindowSave,
} from "@store/checkpoint";

export const isTauriHost =
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export interface SaveAck {
  accepted: boolean;
  rev: number;
  reason?: string;
}

/* ---------- Window identity ---------- */

/**
 * This window's Tauri label — the key it owns in the checkpoint's
 * window table. Outside Tauri there is one window and it is "main".
 */
export function currentWindowLabel(): string {
  if (!isTauriHost) return MAIN_LABEL;
  try {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
    }).__TAURI_INTERNALS__;
    return internals?.metadata?.currentWindow?.label || MAIN_LABEL;
  } catch {
    return MAIN_LABEL;
  }
}

/* ---------- Browser fallback ---------- */

const LOCAL_KEY = "spark.checkpoint";

let session: Session | null = null;

function readLocal(): unknown {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getSession(): Session {
  if (!session) session = openSession(readLocal());
  return session;
}

function commit(next: Session) {
  session = next;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(toDisk(next)));
  } catch {
    /* private mode / quota — the in-memory session still applies */
  }
}

/** Test seam: forget the fallback session and its mirror. */
export function __resetCheckpointHost() {
  session = null;
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* nothing to clear */
  }
}

/* ---------- Serialization ----------
   One promise chain per window. Every call below awaits the previous
   one, so a burst of autosaves reaches the host in the order it was
   made and each caller reads back the rev its own write produced. */

let chain: Promise<unknown> = Promise.resolve();

function queue<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  // The chain must survive a rejected call, or one failure would stall
  // every later write behind it.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function host<T>(cmd: string, args: Record<string, unknown>, fallback: () => T): Promise<T> {
  if (!isTauriHost) return fallback();
  try {
    return (await tInvoke<T>(cmd, args)) as T;
  } catch (e) {
    // The checkpoint is an enhancement: a host that cannot answer costs
    // the user a restore, never the editor.
    console.warn(`[checkpoint] ${cmd} failed:`, e);
    return fallback();
  }
}

/* ---------- API ---------- */

/** The whole checkpoint, coerced. */
export function checkpointLoad(): Promise<Checkpoint> {
  return queue(async () => {
    const raw = await host<unknown>("checkpoint_load", {}, () => toDisk(getSession()));
    return coerceCheckpoint(raw);
  });
}

/**
 * Take the previous run's window list. Resolves to the plan for the
 * first caller in the app and null for every caller after it.
 */
export function checkpointClaimRestore(): Promise<WindowRecord[] | null> {
  return queue(async () => {
    if (isTauriHost) {
      const raw = await host<unknown>("checkpoint_claim_restore", {}, () => null);
      if (!Array.isArray(raw)) return null;
      return coerceCheckpoint({
        version: 1,
        projects: [],
        windows: raw,
        updatedAt: 0,
      }).windows;
    }
    const { session: next, plan } = claimRestoreOf(getSession());
    commit(next);
    return plan;
  });
}

export function checkpointSaveWindow(save: WindowSave): Promise<SaveAck> {
  return queue(async () =>
    host<SaveAck>("checkpoint_save_window", { save }, () => {
      const res = saveWindowOf(getSession(), save);
      commit(res.session);
      return { accepted: res.accepted, rev: res.rev, reason: res.reason };
    }),
  );
}

export function checkpointSaveProject(save: ProjectSave): Promise<SaveAck> {
  return queue(async () =>
    host<SaveAck>("checkpoint_save_project", { save }, () => {
      const res = saveProjectOf(getSession(), save);
      commit(res.session);
      return { accepted: res.accepted, rev: res.rev, reason: res.reason };
    }),
  );
}

export function checkpointRemoveProject(id: string): Promise<void> {
  return queue(async () =>
    host<void>("checkpoint_remove_project", { id }, () => {
      commit(removeProjectOf(getSession(), id));
    }),
  );
}

/**
 * Open another editor window bound to `projectId`. The host allocates
 * the label under its lock and seeds the window's row before the
 * webview exists, so the new window finds its own project the moment
 * it boots. Resolves to the new label.
 */
export function checkpointOpenWindow(
  projectId: string | null,
  geometry: Geometry | null = null,
): Promise<string> {
  return queue(async () => {
    // Not through `host`: a window the host refused (the window cap, a
    // webview that would not build) must reach the caller. The fallback
    // would hand back a label for a window that does not exist.
    if (isTauriHost) return tInvoke<string>("checkpoint_open_window", { projectId, geometry });
    // No second OS window outside Tauri; still allocate the label and
    // record the row so the fallback models the same table.
    const { session: allocated, label } = allocateLabel(getSession());
    // rev 0, so the window's own first registration is a newer write.
    const res = saveWindowOf(allocated, { label, projectId, geometry, rev: 0 });
    commit(res.session);
    return label;
  });
}

/** Readable text for a rejected host call: `{ kind, data: { message | path } }`. */
export function hostErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  const err = e as { kind?: string; data?: { message?: string; path?: string; reason?: string } } | null;
  const d = err?.data;
  if (d?.message) return d.message;
  if (d?.path && d.reason) return `${d.path}: ${d.reason}`;
  if (err?.kind && d?.path) {
    const what: Record<string, string> = {
      NotFound: "not found",
      PermissionDenied: "permission denied",
      AlreadyExists: "already exists",
      IsADirectory: "is a directory",
    };
    return `${d.path} ${what[err.kind] ?? err.kind}`;
  }
  return String(err?.kind ?? e);
}
