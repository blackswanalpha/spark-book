/* ============================================================
   sparkBook · src/shell/projects/receiver.ts

   An editor window's half of the Projects window: act on "open this
   project here", and keep this window's project cache in step with
   renames, pins and removals made over there.

   Switching a window's project closes its tabs, so a window with
   unsaved files never switches. An `auto` request (the Projects
   window thought this window was free) goes to a new window instead;
   an explicit one is refused with a toast that says why.
   ============================================================ */
import { listen } from "@tauri-apps/api/event";
import {
  checkpointOpenWindow,
  currentWindowLabel,
  hostErrorMessage,
  isTauriHost,
} from "@bridge/checkpoint";
import { useDocs } from "@store/documents";
import { useProjects } from "@store/projects";
import { seedProjects } from "@shell/checkpointManager";
import {
  EDITED_EVENT,
  OPEN_HERE_EVENT,
  focusSelf,
  type EditedPayload,
  type OpenHerePayload,
} from "./windowBridge";

function toastError(title: string, body?: string) {
  window.dispatchEvent(new CustomEvent("spark:toast:error", { detail: { title, body } }));
}

export async function openHere(p: OpenHerePayload): Promise<void> {
  if (!p?.project?.rootPath || p.target !== currentWindowLabel()) return;
  const dirty = Object.values(useDocs.getState().docs).some((d) => d.dirty);
  const activeId = useProjects.getState().activeId;

  // No second OS window outside Tauri, so there `auto` means here.
  if (isTauriHost && p.mode === "auto" && (activeId !== null || dirty)) {
    try {
      await checkpointOpenWindow(p.project.id);
    } catch (e) {
      await focusSelf();
      toastError(`Could not open ${p.project.name}`, hostErrorMessage(e));
    }
    return;
  }

  await focusSelf();
  if (dirty) {
    toastError(
      `${p.project.name} was not opened`,
      "This window has unsaved changes. Save or close them first, or open the project in a new window.",
    );
    return;
  }
  if (p.project.id === activeId) return;

  // The row may be newer than this window's cache, or missing from it
  // (created after this window booted). Without it, the switch below
  // would start the project from an empty snapshot.
  seedProjects([{ ...p.project }], activeId);
  window.dispatchEvent(
    new CustomEvent("spark:folder:open", { detail: { path: p.project.rootPath, projectId: p.project.id } }),
  );
}

export function applyEdit(e: EditedPayload): void {
  if (!e?.id) return;
  const s = useProjects.getState();
  if (e.kind === "rename") {
    s.renameProject(e.id, e.name);
  } else if (e.kind === "pin") {
    const p = s.get(e.id);
    if (p && (p.pinned === true) !== e.pinned) s.togglePin(e.id);
  } else if (e.kind === "remove") {
    // The Projects window refuses to remove an open project; this only
    // guards against a window that opened it in the meantime.
    if (e.id !== s.activeId) s.removeProject(e.id);
  }
}

/**
 * Start listening. The returned teardown is safe to call before the
 * async Tauri listeners have registered: they unlisten on arrival.
 */
export function listenForProjectsWindow(): () => void {
  let disposed = false;
  const offs: Array<() => void> = [];
  const hold = (p: Promise<() => void>) =>
    void p.then(
      (off) => (disposed ? off() : offs.push(off)),
      () => {},
    );

  if (isTauriHost) {
    // Registered on this webview, not app-wide: open-here is addressed
    // to one window and every other one must ignore it.
    hold(
      import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().listen<OpenHerePayload>(OPEN_HERE_EVENT, (ev) => void openHere(ev.payload)),
      ),
    );
    hold(listen<EditedPayload>(EDITED_EVENT, (ev) => applyEdit(ev.payload)));
  } else {
    const onOpen = (ev: Event) => void openHere((ev as CustomEvent<OpenHerePayload>).detail);
    const onEdit = (ev: Event) => applyEdit((ev as CustomEvent<EditedPayload>).detail);
    window.addEventListener(OPEN_HERE_EVENT, onOpen);
    window.addEventListener(EDITED_EVENT, onEdit);
    offs.push(() => {
      window.removeEventListener(OPEN_HERE_EVENT, onOpen);
      window.removeEventListener(EDITED_EVENT, onEdit);
    });
  }

  return () => {
    disposed = true;
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        /* a listener that will not detach must not block the rest */
      }
    }
  };
}
