/* ============================================================
   sparkBook · src/bridge/commands.ts
   Typed wrappers around Tauri's invoke(). When running in
   plain Vite (no Tauri host) the wrappers fall back to safe
   in-memory implementations so the renderer can be developed
   and tested in the browser.
   ============================================================ */
import { invoke as tInvoke } from "@tauri-apps/api/core";

const isTauri = typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    try {
      return (await tInvoke<T>(cmd, args)) as T;
    } catch (e: unknown) {
      // WebKitGTK on Linux often logs "IPC custom protocol failed → postMessage fallback"
      // and may surface as TypeError: Load failed or "Couldn't find callback id" after
      // a reload/HMR while Rust is still processing. Fall back to the in-memory mock
      // so the UI remains usable in `vite` dev without a hard crash, and avoid
      // spamming unhandled rejections. Real Tauri errors still propagate after the
      // fallback check below.
      const msg = String((e as Error)?.message ?? e ?? "");
      if (msg.includes("Load failed") || msg.includes("callback id") || msg.includes("custom protocol")) {
        console.warn(`[bridge] invoke "${cmd}" fell back to mock (Tauri IPC unavailable):`, msg);
        return mock<T>(cmd, args);
      }
      throw e;
    }
  }
  // Browser-only fallback (mocked fs)
  return mock<T>(cmd, args);
}

/* ---------- Lazy Tauri dialog plugin loader ---------- */
// Lazy import so the plugin is only loaded in Tauri context
async function tauriDialog() {
  try { return await import("@tauri-apps/plugin-dialog"); } catch { return null; }
}

/* ---------- Types ---------- */
export interface FileStat { path: string; isFile: boolean; isDir: boolean; size: number; mtime: string }
export interface DirEntry { name: string; isFile: boolean; isDir: boolean }
export interface WriteReceipt { path: string; bytes: number; mtime: string; device: number; inode: number }
export interface DialogFilter { name: string; extensions: string[] }
export interface OpenDialogOptions { multiple?: boolean; directory?: boolean; filters?: DialogFilter[] }
export interface SaveDialogOptions { defaultPath?: string; filters?: DialogFilter[] }

/** Opaque watcher id returned by `watchPath`. Backed by the host's `watch_path`. */
export type WatchId = string;

/* ---------- FS ---------- */
export const readFile  = (path: string) => call<string>("read_file", { path });
/** Read a file as base64 (binary-safe).  Falls back to text→base64 in browser mock. */
export const readFileBase64 = (path: string) => call<string>("read_file_base64", { path });
export const readFileBinary = (path: string) => readFileBase64(path);
export const writeFile = (path: string, contents: string) => call<WriteReceipt>("write_file", { path, contents });
/** Write raw bytes given as a base64 string. Used by the image editor and
    any surface whose document is binary rather than text. */
export const writeFileBase64 = (path: string, base64: string) =>
  call<WriteReceipt>("write_file_base64", { path, contents: base64 });
export const stat      = (path: string) => call<FileStat>("stat", { path });
export const readDir   = (path: string) => call<DirEntry[]>("read_dir", { path });
export const renamePath= (from: string, to: string) => call<void>("rename", { from, to });
/** Move `path` to the OS trash, or remove it outright when `permanent`. */
export const deletePath= (path: string, permanent = false) => call<void>("delete", { path, permanent });
export const copyPath  = (from: string, to: string) => call<void>("copy", { from, to });

/** Open the host's terminal emulator rooted at `cwd`. No-op in browser mock. */
export const openInTerminal = (cwd: string) => call<void>("open_in_terminal", { cwd });
/** Reveal `path` in the OS file manager (Finder/Explorer/Nautilus). */
export const revealInOS = (path: string) => call<void>("reveal_in_folder", { path });
/** Open a file with the OS default application. */
export const openWithOS = (path: string) => call<void>("open_with_os", { path });
/** Open an http(s) link in the default browser. The host refuses anything else. */
export const openUrl = (url: string) => call<void>("open_url", { url });
/** Add one file to the asset-protocol scope so the media player can stream
    it with range requests. The scope starts empty; this is the only way in. */
export const mediaAllow = (path: string) => call<void>("media_allow", { path });

/**
 * Create a new file at `path` with optional `contents` (defaults to "").
 * Throws `{ kind: "AlreadyExists", path }` if the path already exists.
 * Returns a fresh `FileStat` for the new file.
 */
export const createFile = (path: string, contents: string = "") =>
  call<FileStat>("create_file", { path, contents });

/**
 * Create a directory at `path`. No-op if the directory already exists.
 * Intermediate parents are not created — the host is expected to reject
 * the call (or the call is expected to be invoked after the parent exists).
 */
export const mkdir = (path: string) => call<void>("mkdir", { path });

/**
 * Subscribe to filesystem change notifications for `path`.
 * Returns a `WatchId` that can be passed to `unwatchPath` to cancel.
 * In the browser mock this returns a fake id and is otherwise inert.
 */
export const watchPath = (path: string) => call<WatchId>("watch_path", { path });

/**
 * Cancel a watcher previously registered with `watchPath`.
 * No-op if the id is unknown (matches the documented host behaviour).
 */
export const unwatchPath = (id: WatchId) => call<void>("unwatch_path", { id });

/* ---------- Project-wide ---------- */

export interface ProjectFileList {
  /** Paths relative to the root, `/`-separated. */
  files: string[];
  /** The walk hit a bound (count or time) and the list is partial. */
  truncated: boolean;
}

export interface SearchHit {
  /** Absolute path. */
  path: string;
  /** 1-based. */
  line: number;
  col: number;
  /** The matching line, trimmed and length-capped. */
  text: string;
}

export interface ProjectSearchResult {
  hits: SearchHit[];
  filesSearched: number;
  truncated: boolean;
}

/** Every file under `root`, skipping VCS, dependency and build folders. */
export const listProjectFiles = (root: string, limit?: number) =>
  call<ProjectFileList>("list_project_files", { root, limit });

/** Lines under `root` containing `query` literally. */
export const searchProject = (root: string, query: string, caseSensitive = false, limit?: number) =>
  call<ProjectSearchResult>("search_project", { root, query, caseSensitive, limit });

/* ---------- New projects (Projects window) ---------- */
export interface ProjectCreated {
  path: string;
  /** Set when the folder was made but `git init` failed. */
  gitError?: string;
}
/** Make `parent/name` (absent or empty only), optionally `git init` it. */
export const projectCreate = (parent: string, name: string, gitInit: boolean) =>
  call<ProjectCreated>("project_create", { parent, name, gitInit });
/** Clone `url` into `parent/name`. Rejects with message "cancelled" when cancelled. */
export const projectClone = (url: string, parent: string, name: string) =>
  call<string>("project_clone", { url, parent, name });
/** Stop this window's clone; a no-op when none is running. */
export const projectCloneCancel = () => call<void>("project_clone_cancel");
/** Branch (or short commit) checked out at each root, null when not a repository. */
export const projectGitBranches = (roots: string[]) =>
  call<Array<string | null>>("project_git_branches", { roots });

/* ---------- Path helpers ---------- */
/**
 * Split an absolute path into ordered segments. Empty / "/" yield an empty array.
 * Examples:
 *   splitPath("/")        -> []
 *   splitPath("/docs")    -> ["docs"]
 *   splitPath("/a/b/c.md")-> ["a", "b", "c.md"]
 */
export function splitPath(path: string): string[] {
  if (!path) return [];
  const norm = path.startsWith("/") ? path.slice(1) : path;
  if (norm === "") return [];
  return norm.split("/").filter((seg) => seg.length > 0);
}

/**
 * Join a parent directory and a child name with a single "/".
 * Empty parent collapses to "/". No trailing slash on the result.
 * Examples:
 *   joinPath("/", "docs")          -> "/docs"
 *   joinPath("/docs", "reference") -> "/docs/reference"
 *   joinPath("", "README.md")      -> "/README.md"
 */
export function joinPath(parent: string, name: string): string {
  const p = !parent || parent === "/" ? "" : parent.replace(/\/+$/, "");
  if (!name) return p === "" ? "/" : p;
  return `${p}/${name}`;
}

/* ---------- Mock FS (browser only) ---------- */
const MEMORY_FS = new Map<string, string>([
  ["/welcome.md", `# Welcome to sparkBook\n\nThis is a *demo* document.\n\n\`\`\`ts\nconst hello = "world";\n\`\`\`\n`],
  ["/notes.md",   `# Notes\n\n- Markdown surface\n- Rich text\n- Code`],
  ["/hello.ts",   `// hello.ts\nexport const greet = (n: string) => \`Hello, \${n}!\`;\n`],
  ["/README.md",  `# sparkBook\n\nUnifies markdown, rich text, and code in one window.`],
  ["/docs/README.md", `# docs/\n\nReference and explanation documents.`],
  ["/demo/index.html", `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"><title>Demo</title></head><body><h1>Hello HTML preview</h1><p>This file is rendered via <code>HtmlPreview</code> without a server.</p><script src="./app.js"></script></body></html>`],
  ["/demo/style.css", `body{font-family:Inter,sans-serif;padding:24px;color:#222}h1{color:#6c5ce7}`],
  ["/demo/sample.srt", `1\n00:00:00,300 --> 00:00:01,800\nsparkBook <i>subtitle</i> sample\n\n2\n00:00:02,000 --> 00:00:03,700\nSecond cue, two lines\nof text\n`],
  ["/demo/app.js", `console.log("bundled js works"); document.body.insertAdjacentHTML("beforeend","<p><em>js bundled ✓</em></p>")`],
  ["/demo/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect x="10" y="10" width="180" height="60" rx="10" fill="#6c5ce7"/><text x="100" y="45" text-anchor="middle" fill="white" font-family="Inter" font-size="16">spark svg</text></svg>`],
  ["/sample.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect x="80" y="80" width="220" height="140" rx="12" fill="#6c5ce7" stroke="#2d3436" stroke-width="2"/><circle cx="520" cy="180" r="70" fill="#00cec9" stroke="#2d3436" stroke-width="2"/><text x="80" y="300" fill="#2d3436" font-size="20" font-family="Inter">Editable SVG — select, drag, recolour</text></svg>`],
]);

/**
 * Binary fixtures for the mock host. Kept apart from `MEMORY_FS` because
 * `read_file_base64` must return these payloads verbatim rather than
 * base64-encoding a text string. They give the image and PDF surfaces
 * something real to open when the renderer runs under plain `vite`.
 */
const MEMORY_BIN = new Map<string, string>([
  ["/sample.png",
    "iVBORw0KGgoAAAANSUhEUgAAAPAAAADwCAYAAAA+VemSAAADIklEQVR42u3TQQ0AIAwEwTrBGX55QHBU8NBfM4/NGbiJ" +
    "MW+qb3GWOufkAAtgASyABbAAFsAAC2ABLIAFsAAWwAALYAEsgAWwABbAAAtgASyABbAAFsACGGABLIAFsAAWwAIYYAEs" +
    "gAWwABbAAhhgASyABbAAFsACGGABLIAFsAAWwAJYAAMsgAWwABbAAlgAAyyABbAAFsACWAADLIAFsAAWwAJYAAPs5AAL" +
    "YAEsgAWwABbAAAtgASyABbAAFsAAC2ABLIAFsAAWwAALYAEsgAWwABbAcnKABbAAFsACWAALYIAFsAAWwAJYAAtggAWw" +
    "ABbAAlgAC2CABbAAFsACWAALYAEMsAAWwAJYAAtgAQywABbAAlgAC2ABDLAAFsACWAALYAEMsAAWwAJYAAtgASyAARbA" +
    "AlgAC2ABLIABFsACWAALYAEsgAEWwAJYAAtgASyAAXZygAWwABbAAlgAC2CABbAAFsACWAALYIAFsAAWwAJYAAtggAWw" +
    "ABbAAlgAC2ABDLAAFsACWAALYAEMsAAWwAJYAAtgAQywABbAAlgAq1ymWrf/qG0ODrAAFsACWAALYAEMsAAWwAJYAAtg" +
    "AQywABbAAlgAC2ABDLAAFsACWAALYAEsgAEWwAJYAAtgASyAARbAAlgAC2ABLIABFsACWAALYAEsgAEWwAJYAAtgASyA" +
    "BTDAAlgAC2ABLIAFMMACWAALYAEsgAUwwAJYAAtgASyABTDATg6wABbAAlgAC2ABDLAAFsACWAALYAEMsAAWwAJYAAtg" +
    "AQywABbAAlgAC2ABLIABFsACWAALYAEsgAEWwAJYAAtgASyAARbAAlgAC2ABLIABFsACWAALYAEsgAUwwAJYAAtgASyA" +
    "BTDAAlgAC2ABLIAFMMACWAALYAEsgAUwwAJYAAtgASyABbAABlgAC2ABLIAFsAAGWAALYAEsgAWwAAZYAAtgASyABbAA" +
    "lpMDLIAFsAAWwAJYAAMsgAWwABbAAlgAAyyABbAAFsACWAADLIAFsAAWwAJYAMvBARbAAlgAC2ABLIABFsACWAALYAEs" +
    "gAEWwAJYAAtglXtym/2aWdeeNgAAAABJRU5ErkJggg=="],
  ["/sample.pdf",
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwg" +
    "L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2Ug" +
    "L1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA0MjAgMzAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAg" +
    "UiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxNjEgPj4Kc3RyZWFtCkJU" +
    "IC9GMSAyMiBUZiA0OCAyMTAgVGQgKHNwYXJrQm9vayBQREYgc2FtcGxlKSBUaiBFVApCVCAvRjEgMTIgVGYgNDggMTc4" +
    "IFRkIChTY3JvbGwsIHpvb20sIHNlYXJjaCBhbmQgc2VsZWN0IHRoaXMgdGV4dC4pIFRqIEVUCjAuMTIgMC4zNyAwLjgy" +
    "IHJnIDQ4IDYwIDMyMCA5MCByZSBmCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlw" +
    "ZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAK" +
    "MDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0" +
    "MSAwMDAwMCBuIAowMDAwMDAwNDUzIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFy" +
    "dHhyZWYKNTIzCiUlRU9GCg=="],
  /* 4 s VP8/Opus test pattern and a 4 s MP3 sweep with ID3 tags, small
     enough to ship in the mock so the players can be driven headless. */
  ["/demo/sample.webm",
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAACiiEU2bdLpNu4tTq4QVSalmU6yBoU27" +
    "i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggGLTbuMU6uEHFO7a1OsgiiM7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECvUAAAAAAAFlSua0CtrgEAAAAA" +
    "AAA/14EBc8WIcbdjiMA5CZ2cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QE95DV4JCwgVC6gS2agQJVsIRVuYEBrgEA" +
    "AAAAAABc14ECc8WIN/XwUlS0uKecgQAitZyDdW5kiIEAhoZBX09QVVNWqoNjLqBWu4QExLQAg4EC4ZGfgQG1iEDncAAA" +
    "AAAAYmSBEGOik09wdXNIZWFkAQE4AYC7AAAAAAASVMNnQNZzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYwLjE2LjEw" +
    "MHNz1mPAi2PFiHG3Y4jAOQmdZ8ihRaOHRU5DT0RFUkSHlExhdmM2MC4zMS4xMDIgbGlidnB4Z8ihRaOIRFVSQVRJT05E" +
    "h5MwMDowMDowNC4wMDAwMDAwMDAAc3PXY8CLY8WIN/XwUlS0uKdnyKJFo4dFTkNPREVSRIeVTGF2YzYwLjMxLjEwMiBs" +
    "aWJvcHVzZ8ihRaOIRFVSQVRJT05Eh5MwMDowMDowNC4wMDgwMDAwMDAAH0O2dWYf54EAo5GCAACACINtgtAc/epJ/gE/" +
    "wKNCi4EAAIAwEACdASpQAC0ACMcIhYWIhYSIHYICzBXjTPeP9r/ID8q/kJr79m3ocnfYt+46QO2B8wP6eeq//l/1J90X" +
    "kV+kB7In7Qewj+qvWT/tt+0ftTNEMa/eA/JT4Dw/LjDFA6Ji/kk2DbBqj0PpyRm+sJSF6gWSBdIVXWduOjyrhv7vE4iH" +
    "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"],
  ["/demo/tone.mp3",
    "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" +
    "CVCSKAAHdomhnjI6BEEgzyYClFpjr5yCX19dn+n/////6dVaaNPy4y1UBwCAGTD/8yDE6gnQjhQAB7aJC0AGMBaAMjA8" +
    "TPM1JsyzMIrCVDBBgPkwI0CEMBQATTALwCo7VMYG//MixOkJSJIIAAe2iSL/Ndi3Fc6S3KGtpCFlzAgDDBsJTEAXDJ1G" +
    "zajYD1bEUMWUMswBAOj/8yDE6wnYkfQAB7aJUARFQAFVW5QTMWL/FdZ4Zxhy12IBzAgEMOiMy4jjO9UO9pZQxmgo//Mg" +
    "xOoKAJXhQAB4ZQwGQIRAAAvt6I/MU+aq/uNWggtuii44EEJSDZQxiDOIc2cxegxzBv/zIMTpD8CZ1H4GfGhwLjAgANAw" +
    "CSCq6n5o7tbG3UzsP+xBFcBAAwmETHQ6NT0sEXgzWrj/8yLE0Q5QoeQAB/CM81ixmTA4BqGQJyEAxD1bTY4YllHe/ndV" +
    "5Q+7AEBYAGDKfEwclMVgjv/zIMS/C5CeDAAHfIiNOkHswVgAhYB9OBv4RF6SpnXHKrWiLSi3JnfOcyAGFaeIbqYypgP/" +
    "8yDEtwnolhwABzyJ4GBgAACpDMNf6UjBit4V5Q+60Aq8aSP5MFULE0QQaQEGeLAKLPeS//MgxLYKMJ4oAAb8iC8spwz/" +
    "yyxrUsNMBBI4+As8zMxgYk5u2oycDUwdAYHACps4sWvaF//zIMS0CwCeLAAHPIj+45TLPhwXnRxKAQAYCwDhmSW5mO2A" +
    "ENA8kQCSrXOhEvr0qgHJWAP/8yLErwkYmkQABvyIbbb8lQ4HCTh8AxcBA+LuTleACEkiU////2wKxkhoYoGSsN+/j0Y3" +
    "+//zIMSyCFiORAAG/KUEAxid4YEgILB8cD7wQcUd/Ln+GAvIVJT4dx7oo4TkIspeGQg6cNX/8yDEtweAkmAABjyliSKH" +
    "BvUDyQxBpcXCJSGdI1J/yWJ4gRmXP/LpkZuapGX8PBIPhJn+//MgxMAIuJZcAAa6iZAJEKsH1UxBTUUzLjEwMFVVVVVV" +
    "VVVVVVVVVVVVVVVVVVVVVVVVVf/zIsTECIiWRAAHPKVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
    "VVVV//MgxMkQAObaWUV4AlVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zIMSwD8kaoAGNkABV" +
    "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yDElwAAA0gBwAAAVVVVVVVVVVVVVVVVVVVVVVVV" +
    "VVVVVVVVVVVVVVVVVVVVVVVVVVVV"],
]);

/**
 * Directories known to the in-memory mock. Kept separate from `MEMORY_FS`
 * so the existing flat file map stays compatible with `read_file` /
 * `write_file` / `stat`. `read_dir` consults this set to expose folders.
 */
const MEMORY_DIRS: Set<string> = new Set<string>([
  "/",
  "/docs",
  "/docs/audits",
  "/docs/explanation",
  "/docs/reference",
  "/demo",
]);

/** Mirrors SKIP_DIRS in src-tauri/src/project.rs. */
const MOCK_SKIP = new Set([
  "node_modules", "target", "dist", "build", "__pycache__", "venv",
]);

function mockPrefix(root: string): string {
  return root.endsWith("/") ? root : `${root}/`;
}

/** Mock files under `root`, as absolute paths, walk rules applied. */
function mockProjectFiles(root: string): string[] {
  const prefix = mockPrefix(root);
  return [...MEMORY_FS.keys(), ...MEMORY_BIN.keys()].filter((p) => {
    if (!p.startsWith(prefix)) return false;
    const dirs = p.slice(prefix.length).split("/").slice(0, -1);
    return !dirs.some((d) => d.startsWith(".") || MOCK_SKIP.has(d));
  });
}

function mock<T>(cmd: string, args?: any): T {
  switch (cmd) {
    case "read_file": {
      const v = MEMORY_FS.get(args.path);
      if (v === undefined) throw { kind: "NotFound", path: args.path };
      return v as unknown as T;
    }
    case "write_file": {
      MEMORY_FS.set(args.path, args.contents);
      return { path: args.path, bytes: args.contents.length, mtime: new Date().toISOString(), device: 0, inode: 0 } as unknown as T;
    }
    case "create_file": {
      if (MEMORY_FS.has(args.path) || MEMORY_DIRS.has(args.path)) {
        throw { kind: "AlreadyExists", path: args.path };
      }
      MEMORY_FS.set(args.path, args.contents ?? "");
      const stat = {
        path: args.path,
        isFile: true,
        isDir: false,
        size: (args.contents ?? "").length,
        mtime: new Date().toISOString(),
      };
      return stat as unknown as T;
    }
    case "mkdir": {
      MEMORY_DIRS.add(args.path);
      return undefined as unknown as T;
    }
    case "stat": {
      const p: string = args.path;
      if (MEMORY_DIRS.has(p) && !MEMORY_FS.has(p)) {
        return { path: p, isFile: false, isDir: true, size: 0, mtime: new Date().toISOString() } as unknown as T;
      }
      const isFile = MEMORY_FS.has(p) || MEMORY_BIN.has(p);
      return { path: p, isFile, isDir: false, size: 0, mtime: new Date().toISOString() } as unknown as T;
    }
    case "read_dir": {
      const p: string = args.path;
      const norm = p === "/" || p === "" ? "" : p.replace(/\/+$/, "");
      const prefix = norm === "" ? "/" : `${norm}/`;
      // Any directory directly under `p` that has either a file or a sub-dir
      // entry inside `MEMORY_FS` / `MEMORY_DIRS` should appear.
      const names = new Set<string>();
      for (const k of [...MEMORY_FS.keys(), ...MEMORY_BIN.keys()]) {
        if (k === norm) continue; // path itself is a file
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
      for (const d of MEMORY_DIRS) {
        if (d === norm) continue;
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const seg = rest.split("/")[0];
          if (seg) names.add(seg);
        }
      }
      const out: DirEntry[] = [];
      for (const n of names) {
        const child = `${prefix}${n}`;
        const isDir = MEMORY_DIRS.has(child) && !MEMORY_FS.has(child);
        out.push({ name: n, isFile: !isDir, isDir });
      }
      out.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return out as unknown as T;
    }
    case "write_file_base64": {
      MEMORY_BIN.set(args.path, args.contents);
      return { path: args.path, bytes: args.contents.length, mtime: new Date().toISOString(), device: 0, inode: 0 } as unknown as T;
    }
    case "read_file_base64":
    case "read_file_binary": {
      const bin = MEMORY_BIN.get(args.path);
      if (bin !== undefined) return bin as unknown as T;
      const v = MEMORY_FS.get(args.path);
      if (v === undefined) throw { kind: "NotFound", path: args.path };
      try { return btoa(unescape(encodeURIComponent(v))) as unknown as T; } catch { return "" as unknown as T; }
    }
    case "media_allow": {
      if (!MEMORY_BIN.has(args.path) && !MEMORY_FS.has(args.path)) throw { kind: "NotFound", path: args.path };
      return undefined as unknown as T;
    }
    case "watch_path":
      return ("mock-" + Math.random().toString(36).slice(2)) as unknown as T;
    case "unwatch_path":
      return undefined as unknown as T;
    case "rename": {
      // Move every MEMORY_FS / MEMORY_DIRS entry whose key starts with `${from}/`
      // to use `${to}/` instead. Refuse if `to` collides.
      const from = args.from as string;
      const to = args.to as string;
      if (MEMORY_FS.has(to) || MEMORY_DIRS.has(to)) {
        throw { kind: "AlreadyExists", path: to };
      }
      const fromPrefix = from + "/";
      const toPrefix = to + "/";
      const renameKey = (k: string) => (k === from ? to : k.startsWith(fromPrefix) ? toPrefix + k.slice(fromPrefix.length) : k);
      for (const k of Array.from(MEMORY_FS.keys())) {
        const v = MEMORY_FS.get(k);
        MEMORY_FS.delete(k);
        MEMORY_FS.set(renameKey(k), v as string);
      }
      for (const d of Array.from(MEMORY_DIRS)) {
        MEMORY_DIRS.delete(d);
        MEMORY_DIRS.add(renameKey(d));
      }
      return undefined as unknown as T;
    }
    case "delete": {
      // Remove a file or (recursively) a directory from the mock.
      const p = args.path as string;
      const prefix = p + "/";
      for (const k of Array.from(MEMORY_FS.keys())) {
        if (k === p || k.startsWith(prefix)) MEMORY_FS.delete(k);
      }
      for (const d of Array.from(MEMORY_DIRS)) {
        if (d === p || d.startsWith(prefix)) MEMORY_DIRS.delete(d);
      }
      return undefined as unknown as T;
    }
    case "copy": {
      const from = args.from as string;
      const to = args.to as string;
      if (MEMORY_FS.has(to) || MEMORY_DIRS.has(to)) {
        throw { kind: "AlreadyExists", path: to };
      }
      const fromPrefix = from + "/";
      const toPrefix = to + "/";
      const renameKey = (k: string) => k.startsWith(fromPrefix) ? toPrefix + k.slice(fromPrefix.length) : k;
      for (const [k, v] of MEMORY_FS) {
        if (k === from) { MEMORY_FS.set(to, v); }
        else if (k.startsWith(fromPrefix)) { MEMORY_FS.set(renameKey(k), v); }
      }
      for (const d of Array.from(MEMORY_DIRS)) {
        if (d === from) MEMORY_DIRS.add(to);
        else if (d.startsWith(fromPrefix)) { MEMORY_DIRS.add(renameKey(d)); }
      }
      return undefined as unknown as T;
    }
    case "open_in_terminal":
    case "reveal_in_folder":
    case "open_with_os":
      return undefined as unknown as T;
    case "list_project_files": {
      const files = mockProjectFiles(args.root).map((p) => p.slice(mockPrefix(args.root).length));
      return { files: files.sort(), truncated: false } as unknown as T;
    }
    case "search_project": {
      const needle: string = args.caseSensitive ? args.query : String(args.query).toLowerCase();
      const hits: SearchHit[] = [];
      if (needle) {
        for (const path of mockProjectFiles(args.root).sort()) {
          const text = MEMORY_FS.get(path);
          if (text === undefined) continue;
          text.split("\n").forEach((line, i) => {
            const col = (args.caseSensitive ? line : line.toLowerCase()).indexOf(needle);
            if (col >= 0) hits.push({ path, line: i + 1, col: col + 1, text: line.trim() });
          });
        }
      }
      return { hits, filesSearched: MEMORY_FS.size, truncated: false } as unknown as T;
    }
    case "project_create": {
      const parent = String(args?.parent ?? "");
      const name = String(args?.name ?? "").trim();
      if (!parent.startsWith("/") || !name || name.includes("/")) {
        throw { kind: "InvalidPath", data: { path: name, reason: "not a folder name" } };
      }
      const path = `${parent.replace(/\/+$/, "")}/${name}`;
      if (MEMORY_FS.has(path) || [...MEMORY_FS.keys()].some((k) => k.startsWith(`${path}/`))) {
        throw { kind: "AlreadyExists", data: { path } };
      }
      MEMORY_DIRS.add(path);
      return { path } as unknown as T;
    }
    case "project_clone":
      throw { kind: "Internal", data: { message: "Cloning needs the desktop app" } };
    case "project_clone_cancel":
      return undefined as unknown as T;
    case "project_git_branches":
      return ((args?.roots as string[] | undefined) ?? []).map(() => null) as unknown as T;
    case "recents_get":
      return [
        "/welcome.md", "/notes.md", "/hello.ts", "/README.md",
        "/demo/index.html", "/sample.svg", "/sample.png", "/sample.pdf",
        "/demo/sample.webm", "/demo/tone.mp3",
      ] as unknown as T;
    case "open_file":
    case "open_folder":
    case "save_file":
      return null as unknown as T;
    default:
      return null as unknown as T;
  }
}

/* ---------- App state ---------- */
/* App state used to live behind `app_state_get` / `app_state_set`. Those
   Rust commands were never implemented; the workspace cache now owns that
   job renderer-side — see src/store/projects.ts. */

/* ---------- Recents ---------- */
export const recentsGet  = () => call<string[]>("recents_get");
export const recentsAdd  = (path: string) => call<string[]>("recents_add", { path });
export const recentsClear= () => call<void>("recents_clear");

/* ---------- Window ---------- */

/* ---------- Dialogs (Tauri + browser fallback) ---------- */
/**
 * Open a file or directory picker.
 * In Tauri: delegates to @tauri-apps/plugin-dialog's open().
 * In browser: dispatches a "spark:dialog:openFile" CustomEvent on window,
 *   expected to be handled by the OpenDialog component.
 */
export function openFileDialog(opts: OpenDialogOptions = {}): Promise<string | string[] | null> {
  if (isTauri) {
    return tauriDialog().then(async (d) => {
      if (!d) return null;
      if (opts.directory) {
        return (await d.open({ directory: true, multiple: opts.multiple })) as string | string[] | null;
      }
      return (await d.open({
        multiple: opts.multiple,
        filters: opts.filters,
      })) as string | string[] | null;
    });
  }
  return new Promise<string | string[] | null>((resolve) => {
    window.dispatchEvent(new CustomEvent("spark:dialog:openFile", { detail: { resolve, opts } }));
  });
}

/**
 * Open a folder picker. Returns the first selected path or null.
 */
export function openFolderDialog(): Promise<string | null> {
  return openFileDialog({ directory: true }).then((res) => {
    if (res == null) return null;
    if (Array.isArray(res)) return res[0] ?? null;
    return res;
  });
}

/**
 * Open a save-as file picker.
 * In Tauri: delegates to @tauri-apps/plugin-dialog's save().
 * In browser: dispatches a "spark:dialog:saveFile" CustomEvent on window.
 */
export function saveFileDialog(opts: SaveDialogOptions = {}): Promise<string | null> {
  if (isTauri) {
    return tauriDialog().then(async (d) => {
      if (!d) return null;
      return (await d.save({
        defaultPath: opts.defaultPath,
        filters: opts.filters,
      })) as string | null;
    });
  }
  return new Promise<string | null>((resolve) => {
    window.dispatchEvent(new CustomEvent("spark:dialog:saveFile", { detail: { resolve, opts } }));
  });
}

/* ---------- Mode picker ---------- */

/** Raster image extensions the viewer and the image editor can open. */
export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif",
] as const;

/** Video containers the player opens. The webview's media engine decides
    which codecs inside them actually play; the rest get a clear error
    and an "open in system player" handoff instead of a code view of
    binary bytes. `.ts` is absent on purpose: it is TypeScript here. */
export const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "wmv", "flv", "3gp", "mpg", "mpeg",
] as const;

/** Audio formats the player opens. Same contract as `VIDEO_EXTENSIONS`. */
export const AUDIO_EXTENSIONS = [
  "mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "weba", "aiff", "aif", "wma",
] as const;

/** Extensions that must be read as bytes rather than as UTF-8 text. */
export const BINARY_EXTENSIONS: readonly string[] = [
  ...IMAGE_EXTENSIONS, "pdf", ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS,
];

/** Lowercase extension without the dot; "" when the path has none. */
export function extname(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** True when `path` should be loaded through `readFileBase64`. */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.includes(extname(path));
}

/** MIME type for an image extension. Falls back to PNG. */
export function imageMime(path: string): string {
  switch (extname(path)) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "bmp":  return "image/bmp";
    case "ico":  return "image/x-icon";
    case "avif": return "image/avif";
    case "svg":  return "image/svg+xml";
    default:     return "image/png";
  }
}

/** MIME type for a video or audio extension. Used for blob URLs, where
    the engine has no server header to sniff from. */
export function mediaMime(path: string): string {
  switch (extname(path)) {
    case "mp4":  case "m4v": return "video/mp4";
    case "webm": return "video/webm";
    case "ogv":  return "video/ogg";
    case "mov":  return "video/quicktime";
    case "mkv":  return "video/x-matroska";
    case "avi":  return "video/x-msvideo";
    case "wmv":  return "video/x-ms-wmv";
    case "flv":  return "video/x-flv";
    case "3gp":  return "video/3gpp";
    case "mpg":  case "mpeg": return "video/mpeg";
    case "mp3":  return "audio/mpeg";
    case "wav":  return "audio/wav";
    case "ogg":  case "oga": case "opus": return "audio/ogg";
    case "flac": return "audio/flac";
    case "m4a":  return "audio/mp4";
    case "aac":  return "audio/aac";
    case "weba": return "audio/webm";
    case "aiff": case "aif": return "audio/aiff";
    case "wma":  return "audio/x-ms-wma";
    default:     return "application/octet-stream";
  }
}

/**
 * Pick an editor mode from a file path based on its extension.
 *  - raster images → "image" (viewer; switch to "imageedit" to edit)
 *  - video → "video", audio → "audio" (streamed players, read-only)
 *  - .pdf  → "pdf"
 *  - .sparkanim → "animation"
 *  - .svg  → "svg"
 *  - .html / .htm → "html" (webview preview)
 *  - .md / .markdown → "markdown"
 *  - everything else, .json included → "code". JSON used to open in
 *    "rich", which cannot show it and wrote HTML over it on the first
 *    keystroke.
 */
export function pickMode(path: string): ModeName {
  const lower = path.toLowerCase();
  const ext = extname(lower);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return "audio";
  if (lower.endsWith(".sparkanim") || lower.endsWith(".anim.json")) return "animation";
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "code";
}

type ModeName =
  | "markdown" | "rich" | "code" | "html" | "svg"
  | "image" | "imageedit" | "animation" | "pdf" | "video" | "audio";

export { isTauri };
