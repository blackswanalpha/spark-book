/* ============================================================
   sparkBook · src/bridge/events.ts
   Typed wrappers around Tauri's listen().
   ============================================================ */
import { listen as tListen, type UnlistenFn } from "@tauri-apps/api/event";

const isTauri = typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export async function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  try {
    return await tListen<T>(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}

/* ---------- Typed event payloads ---------- */

/**
 * A filesystem change notification. The host emits `file:changed` whenever
 * a watched path (or anything underneath it) changes on disk.
 *
 *  - `path` : the affected absolute path; empty for "bulk"
 *  - `kind` : the kind of change that occurred. "bulk" means the host
 *             coalesced more changes than it sends one by one (see
 *             MAX_CHANGES_PER_FLUSH in watch.rs), so every cached
 *             listing under the watched root is suspect.
 *  - `from` : the previous path when `kind === "renamed"`, otherwise
 *             omitted
 *
 * Field names mirror `FileChange` in src-tauri/src/watch.rs — they are
 * the wire format, not a local convenience shape.
 */
export interface FileChangeEvent {
  path: string;
  kind: "modified" | "created" | "removed" | "renamed" | "bulk";
  from?: string;
}

/**
 * Subscribe to filesystem change notifications emitted by the host.
 *
 * In Tauri this forwards to `listen("file:changed", ...)`; in the browser
 * (no Tauri runtime) the returned unlisten is a no-op so callers can wire
 * up subscriptions unconditionally.
 */
export async function onFileChanged(
  handler: (ev: FileChangeEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri) {
    return () => {};
  }
  try {
    return await tListen<FileChangeEvent>("file:changed", (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}
