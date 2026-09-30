/* ============================================================
   sparkBook · src/shell/openDocument.ts
   One way to turn a path into an open tab.

   Text and binary documents are read through different host
   commands (`read_file` vs `read_file_base64`), and every call
   site that forgot the difference opened a PNG as mojibake. This
   module owns the choice so the callers only pass a path.
   ============================================================ */
import { readFile, readFileBase64, recentsAdd, pickMode, isBinaryPath, stat } from "@bridge/commands";
import { useDocs, isBinaryMode, isStreamMode, basename, type DocMode } from "@store/documents";

export interface OpenPathResult {
  id: string;
  mode: ReturnType<typeof pickMode>;
}

/**
 * The `raw` a document in `mode` starts with. Video and audio are not read
 * at all: the player streams them from the path, and a multi-gigabyte
 * base64 string would stall the webview. A stat still runs so a missing
 * file rejects here, like every other mode.
 */
export async function readForMode(path: string, mode: DocMode): Promise<string> {
  if (isStreamMode(mode)) {
    await stat(path);
    return "";
  }
  return isBinaryMode(mode) || isBinaryPath(path) ? readFileBase64(path) : readFile(path);
}

/** The open tab already showing `path`, if any. */
export function findOpenDoc(path: string): string | null {
  const { docs, order } = useDocs.getState();
  return order.find((id) => docs[id]?.path === path) ?? null;
}

/**
 * Read `path` with the right host command for its type and open it as a
 * tab. Throws whatever the host threw so callers can surface the reason.
 *
 * A file that is already open is focused, not opened again: two tabs of
 * one file hold two independent buffers, and saving either one silently
 * overwrote whatever had been typed into the other.
 */
export async function openPath(path: string): Promise<OpenPathResult> {
  const existing = findOpenDoc(path);
  if (existing) {
    const docs = useDocs.getState();
    docs.setActive(existing);
    return { id: existing, mode: docs.docs[existing].mode as ReturnType<typeof pickMode> };
  }
  const mode = pickMode(path);
  const binary = isBinaryMode(mode) || isBinaryPath(path);
  const raw = await readForMode(path, mode);
  const id = useDocs.getState().open({
    name: basename(path) || path,
    path,
    mode,
    raw,
    binary,
  });
  await recentsAdd(path).catch(() => {});
  return { id, mode };
}

/**
 * Open `path` with the caret on `line` (1-based), scrolled into view —
 * where Quick Open's `file:42` and a Find in Files hit land. An open tab
 * is focused and asked to move; a new one starts at the line.
 */
export async function openPathAt(path: string, line?: number, col = 1): Promise<OpenPathResult> {
  if (!line) return openPath(path);
  const cursor = { line, col };
  const existing = findOpenDoc(path);
  let result: OpenPathResult;
  if (existing) {
    result = await openPath(path);
  } else {
    const mode = pickMode(path);
    const binary = isBinaryMode(mode) || isBinaryPath(path);
    const raw = await readForMode(path, mode);
    const id = useDocs.getState().open({ name: basename(path) || path, path, mode, raw, binary, cursor });
    await recentsAdd(path).catch(() => {});
    result = { id, mode };
  }
  // The editor for a new tab mounts on the next frame and restores the
  // caret itself; this also scrolls it to the middle of the view.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("spark:editor:reveal", { detail: { id: result.id, line, col } })),
    ),
  );
  return result;
}
