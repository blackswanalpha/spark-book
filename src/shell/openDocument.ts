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

/**
 * Read `path` with the right host command for its type and open it as a
 * tab. Throws whatever the host threw so callers can surface the reason.
 */
export async function openPath(path: string): Promise<OpenPathResult> {
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
