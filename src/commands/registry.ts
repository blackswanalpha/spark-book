/* ============================================================
   sparkBook · src/commands/registry.ts
   Central command table consumed by the palette, the menu,
   the title bar's MenuMirror, and keybinding dispatch.
   ============================================================ */
import { useDocs, switchableModes, type DocMode } from "@store/documents";
import { useTerminal, activeSession } from "@store/terminal";
import {
  readFile,
  openFileDialog,
  openFolderDialog,
} from "@bridge/commands";
import { openPath } from "@shell/openDocument";
import { checkpointOpenWindow } from "@bridge/checkpoint";
import { useProjects } from "@store/projects";
import { mirrorProject } from "@shell/checkpointManager";
import { projectRoot } from "@shell/project/ProjectPicker";
import { lastTaskFor, runTask } from "@shell/project/tasks";
import { emptyScene, serializeScene } from "@editor/AnimationBuilder/model";

export interface CommandSpec {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  shortcut?: string;
  keywords?: string[];
  run: () => unknown;
}

let palette: { open: () => void; close: () => void } | null = null;
export function bindPalette(p: { open: () => void; close: () => void }) { palette = p; }
export const openPalette = () => palette?.open();

/* Folder root state — exported so App can read it on first mount. */
export let currentRoot: string | null = null;
export function setCurrentRoot(path: string | null) { currentRoot = path; }

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = (key: string) => isMac ? `⌘+${key}` : `Ctrl+${key}`;

export function buildCommands(): CommandSpec[] {
  const docs = useDocs.getState();
  const active = () => {
    const a = useDocs.getState().active;
    return a ? useDocs.getState().docs[a] : null;
  };
  const runIfActive = (fn: (a: NonNullable<ReturnType<typeof active>>) => void) => () => {
    const a = active();
    if (a) fn(a);
  };

  return [
    {
      id: "view.commandPalette", title: "Command Palette", category: "View",
      icon: "command", shortcut: mod("Shift+P"),
      keywords: ["palette", "search", "commands"],
      run: () => { openPalette(); },
    },
    {
      id: "view.toggleSidebar", title: "Toggle Sidebar", category: "View",
      icon: "sidebar-toggle", shortcut: mod("B"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:toggleSidebar")); },
    },
    {
      id: "view.toggleStatusBar", title: "Toggle Status Bar", category: "View",
      run: () => { window.dispatchEvent(new CustomEvent("spark:toggleStatusBar")); },
    },
    {
      id: "view.toggleTerminal", title: "Toggle Terminal", category: "View",
      icon: "terminal", shortcut: mod("`"),
      keywords: ["terminal", "shell", "console", "bash", "pty", "root"],
      run: () => { useTerminal.getState().toggle(); },
    },
    {
      id: "view.terminalNew", title: "New Terminal", category: "Terminal",
      icon: "plus", shortcut: mod("Shift+`"),
      keywords: ["terminal", "shell", "new", "tab", "split", "add"],
      run: () => {
        // The panel derives the directory from the explorer, so it — not
        // the registry — decides where a new shell starts. It opens itself
        // when it hears this, so a closed panel is not a special case.
        window.dispatchEvent(new CustomEvent("spark:terminal:new"));
      },
    },
    {
      id: "terminal.next", title: "Terminal: Next Tab", category: "Terminal",
      icon: "arrow-right", shortcut: mod("PageDown"),
      keywords: ["terminal", "tab", "next", "switch", "shell"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:terminal:cycle", { detail: { step: 1 } })); },
    },
    {
      id: "terminal.prev", title: "Terminal: Previous Tab", category: "Terminal",
      icon: "arrow-left", shortcut: mod("PageUp"),
      keywords: ["terminal", "tab", "previous", "switch", "shell"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:terminal:cycle", { detail: { step: -1 } })); },
    },
    {
      id: "terminal.rename", title: "Terminal: Rename Tab…", category: "Terminal",
      icon: "pencil",
      keywords: ["terminal", "tab", "rename", "name", "label"],
      run: () => {
        useTerminal.getState().open();
        // The panel mounts its tab strip on open; ask on the next frame.
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("spark:terminal:rename")));
      },
    },
    {
      id: "terminal.close", title: "Terminal: Close Tab", category: "Terminal",
      icon: "close",
      keywords: ["terminal", "tab", "close", "kill", "exit", "shell"],
      run: () => {
        const s = activeSession();
        if (s) useTerminal.getState().closeSession(s.id);
      },
    },
    {
      id: "view.terminalRoot", title: "Terminal: Toggle Root Shell", category: "Terminal",
      icon: "alert",
      keywords: ["root", "sudo", "pkexec", "admin", "superuser", "elevate"],
      run: () => {
        const t = useTerminal.getState();
        t.open();
        const s = activeSession();
        // With no session yet the panel is about to spawn one; the
        // Settings default decides its privilege, not this command.
        if (s) t.setPrivilege(s.id, s.privilege === "root" ? "user" : "root");
      },
    },
    {
      id: "view.settings", title: "Settings", category: "View",
      icon: "settings", shortcut: mod(","),
      keywords: ["settings", "preferences", "options", "theme", "font", "density"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:settings:open")); },
    },
    {
      id: "view.toggleWordWrap", title: "Toggle Word Wrap", category: "View",
      icon: "mode-rich",
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:toggleWordWrap")); },
    },
    {
      id: "view.togglePreview", title: "Toggle Preview", category: "View",
      icon: "mode-markdown",
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:togglePreview")); },
    },
    {
      id: "view.zoomIn", title: "Zoom In", category: "View",
      icon: "plus",
      shortcut: mod("="),
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:zoom:in")); },
    },
    {
      id: "view.zoomOut", title: "Zoom Out", category: "View",
      icon: "minus",
      shortcut: mod("-"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:zoom:out")); },
    },
    {
      id: "view.zoomReset", title: "Reset Zoom", category: "View",
      icon: "restore",
      shortcut: mod("0"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:view:zoom:reset")); },
    },
    {
      id: "view.switchMode", title: "Switch Mode (cycle)", category: "View",
      icon: "mode-code",
      run: () => {
        const a = active(); if (!a) return;
        // switchableModes keeps binary documents on surfaces built for
        // their bytes; video, audio and PDF have one surface each.
        const order = switchableModes(a);
        if (order.length < 2) return;
        const at = order.indexOf(a.mode);
        const next = order[(at < 0 ? 0 : at + 1) % order.length];
        useDocs.getState().setMode(a.id, next);
      },
    },
    { id: "view.markdown", title: "Switch to Markdown", category: "View", icon: "mode-markdown",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "markdown"); }) },
    { id: "view.rich",     title: "Switch to Rich Text", category: "View", icon: "mode-rich",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "rich"); }) },
    { id: "view.html",     title: "Switch to HTML Preview", category: "View", icon: "mode-html",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "html"); }) },
    { id: "view.svg",      title: "Switch to SVG Editor", category: "View", icon: "mode-svg",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "svg"); }) },
    { id: "view.code",     title: "Switch to Code",      category: "View", icon: "mode-code",
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "code"); }) },
    { id: "view.image",    title: "Switch to Image Viewer", category: "View", icon: "mode-image",
      keywords: ["picture", "photo", "png", "jpeg", "preview"],
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "image"); }) },
    { id: "view.imageEdit", title: "Switch to Image Editor", category: "View", icon: "mode-imageedit",
      keywords: ["paint", "retouch", "layers", "photoshop", "brush"],
      run: runIfActive((a) => { useDocs.getState().setMode(a.id, "imageedit"); }) },

    {
      id: "file.new", title: "New Document", category: "File",
      icon: "plus", shortcut: mod("N"),
      run: () => { docs.open({ name: "Untitled", mode: "markdown", raw: "" }); },
    },
    {
      id: "file.newImage", title: "New Image", category: "File",
      icon: "mode-imageedit",
      keywords: ["canvas", "paint", "draw", "png", "blank"],
      run: () => {
        useDocs.getState().open({ name: "Untitled.png", mode: "imageedit", raw: "", binary: true });
      },
    },
    {
      id: "file.newAnimation", title: "New Animation", category: "File",
      icon: "mode-animation",
      keywords: ["timeline", "keyframe", "motion", "sparkanim"],
      run: () => {
        useDocs.getState().open({
          name: "Untitled.sparkanim",
          mode: "animation",
          raw: serializeScene(emptyScene()),
        });
      },
    },
    {
      id: "file.open", title: "Open File…", category: "File",
      icon: "open", shortcut: mod("O"),
      run: async () => {
        const result = await openFileDialog({ multiple: false });
        if (result == null) return;
        const path = Array.isArray(result) ? result[0] : result;
        if (!path) return;
        await openPath(path);
      },
    },
    {
      id: "file.openFolder", title: "Open Folder…", category: "File",
      icon: "folder-open", shortcut: mod("Shift+O"),
      keywords: ["folder", "directory", "workspace"],
      run: async () => {
        const path = await openFolderDialog();
        if (!path) return;
        setCurrentRoot(path);
        window.dispatchEvent(new CustomEvent("spark:folder:open", { detail: { path } }));
      },
    },
    {
      id: "project.switch", title: "Switch Project…", category: "File",
      icon: "folder", shortcut: mod("Shift+E"),
      keywords: ["project", "workspace", "switch", "recent", "folder"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:projects:open")); },
    },
    {
      id: "project.close", title: "Close Project", category: "File",
      icon: "close",
      keywords: ["project", "workspace", "close folder"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:project:close")); },
    },
    {
      id: "project.quickOpen", title: "Go to File…", category: "File",
      icon: "search", shortcut: mod("P"),
      keywords: ["quick open", "file", "find file", "fuzzy", "go to", "jump"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:project:picker", { detail: { mode: "files" } })); },
    },
    {
      id: "project.findInFiles", title: "Find in Files…", category: "Edit",
      icon: "search", shortcut: mod("Shift+F"),
      keywords: ["search", "grep", "project", "find", "text", "across"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:project:picker", { detail: { mode: "search" } })); },
    },
    {
      id: "project.runTask", title: "Run Task…", category: "Terminal",
      icon: "terminal", shortcut: mod("Shift+B"),
      keywords: ["task", "script", "npm", "make", "cargo", "build", "test", "run"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:project:picker", { detail: { mode: "tasks" } })); },
    },
    {
      id: "project.rerunTask", title: "Rerun Last Task", category: "Terminal",
      icon: "refresh",
      keywords: ["task", "again", "repeat", "rerun", "build", "test"],
      run: () => {
        const root = projectRoot();
        const last = root ? lastTaskFor(root) : null;
        if (root && last) runTask(root, last);
        else window.dispatchEvent(new CustomEvent("spark:project:picker", { detail: { mode: "tasks" } }));
      },
    },
    {
      id: "project.togglePin", title: "Pin / Unpin Current Project", category: "File",
      icon: "pin",
      keywords: ["project", "pin", "favourite", "favorite", "keep"],
      run: () => {
        const id = useProjects.getState().activeId;
        const updated = id ? useProjects.getState().togglePin(id) : null;
        if (updated) void mirrorProject(updated);
      },
    },
    {
      id: "file.recent", title: "Open Recent File", category: "File",
      icon: "refresh",
      keywords: ["recent", "history"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:sidebar:tab", { detail: { tab: "recents" } })); },
    },
    {
      id: "file.save", title: "Save", category: "File",
      icon: "save", shortcut: mod("S"),
      run: async () => {
        const a = active(); if (!a) return;
        if (!a.path) {
          window.dispatchEvent(new CustomEvent("spark:saveas:open", { detail: { docId: a.id } }));
          return;
        }
        const result = await useDocs.getState().saveDocument(a.id);
        if (result.ok) {
          window.dispatchEvent(new CustomEvent("spark:toast:success", { detail: { title: "File saved" } }));
        } else if (result.reason === "error") {
          const msg = result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error");
          window.dispatchEvent(new CustomEvent("spark:toast:error", { detail: { title: "Save failed", body: msg } }));
        }
      },
    },
    {
      id: "file.saveAs", title: "Save As…", category: "File",
      icon: "save", shortcut: mod("Shift+S"),
      run: async () => {
        const a = active(); if (!a) return;
        const result = await useDocs.getState().saveDocumentAs(a.id);
        if (result.ok) {
          window.dispatchEvent(new CustomEvent("spark:toast:success", { detail: { title: "File saved" } }));
        } else if (result.reason === "error") {
          const msg = result.error instanceof Error ? result.error.message : String(result.error ?? "Unknown error");
          window.dispatchEvent(new CustomEvent("spark:toast:error", { detail: { title: "Save failed", body: msg } }));
        }
      },
    },
    {
      id: "file.revert", title: "Revert File", category: "File",
      icon: "refresh",
      run: async () => {
        const a = active(); if (!a || !a.path) return;
        try {
          const text = await readFile(a.path);
          useDocs.getState().setRaw(a.id, text);
          useDocs.getState().markClean(a.id);
        } catch (e: unknown) {
          const err = e as { kind?: unknown };
          const msg = err?.kind != null
            ? String(err.kind)
            : e instanceof Error
              ? e.message
              : String(e ?? "Unknown error");
          window.dispatchEvent(new CustomEvent("spark:toast:error", { detail: { title: "Revert failed", body: msg } }));
        }
      },
    },
    {
      id: "tab.close", title: "Close Tab", category: "File",
      icon: "close", shortcut: mod("W"),
      run: () => { const a = active(); if (a) window.dispatchEvent(new CustomEvent("spark:tab:close:request", { detail: { id: a.id } })); },
    },

    /* The image editor keeps its own layer-stack history; the text store's
       raw-string undo cannot express it, so those modes get the event and
       everything else goes through the store as before. */
    { id: "edit.undo", title: "Undo", category: "Edit", icon: "undo",  shortcut: mod("Z"),
      run: runIfActive((a) => {
        if (a.mode === "imageedit") {
          window.dispatchEvent(new CustomEvent("spark:surface:undo", { detail: { docId: a.id } }));
          return;
        }
        useDocs.getState().undo(a.id);
      }) },
    { id: "edit.redo", title: "Redo", category: "Edit", icon: "redo",  shortcut: mod("Shift+Z"),
      run: runIfActive((a) => {
        if (a.mode === "imageedit") {
          window.dispatchEvent(new CustomEvent("spark:surface:redo", { detail: { docId: a.id } }));
          return;
        }
        useDocs.getState().redo(a.id);
      }) },
    {
      id: "code.goToLine", title: "Go to Line", category: "Edit",
      icon: "search", shortcut: mod("G"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:code:gotoLine")); },
    },
    {
      id: "code.toggleComment", title: "Toggle Line Comment", category: "Edit",
      icon: "quote", shortcut: mod("/"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:code:toggleComment")); },
    },
    {
      id: "code.format", title: "Format Code", category: "Edit",
      icon: "code", shortcut: mod("Shift+I"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:code:format")); },
    },
    {
      id: "edit.find", title: "Find", category: "Edit",
      icon: "search", shortcut: mod("F"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:edit:find")); },
    },
    {
      id: "edit.replace", title: "Replace", category: "Edit",
      icon: "search", shortcut: mod("H"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:edit:replace")); },
    },

    /* ---------- Selection ---------- */
    {
      id: "selection.selectAll", title: "Select All", category: "Selection",
      icon: "search", shortcut: mod("A"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:selectAll")); },
    },
    {
      id: "selection.copyLineUp", title: "Copy Line Up", category: "Selection",
      icon: "undo", shortcut: mod("Shift+Alt+Up"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:copyLineUp")); },
    },
    {
      id: "selection.copyLineDown", title: "Copy Line Down", category: "Selection",
      icon: "chevron-down", shortcut: mod("Shift+Alt+Down"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:copyLineDown")); },
    },
    {
      id: "selection.moveLineUp", title: "Move Line Up", category: "Selection",
      icon: "undo", shortcut: "Alt+Up",
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:moveLineUp")); },
    },
    {
      id: "selection.moveLineDown", title: "Move Line Down", category: "Selection",
      icon: "chevron-down", shortcut: "Alt+Down",
      run: () => { window.dispatchEvent(new CustomEvent("spark:selection:moveLineDown")); },
    },

    /* ---------- Format ---------- */
    { id: "format.bold",        title: "Toggle Bold",        category: "Format", icon: "bold",        shortcut: mod("B"),
      run: runIfActive((a) => emitFormat(a.mode, "bold")) },
    { id: "format.italic",      title: "Toggle Italic",      category: "Format", icon: "italic",      shortcut: mod("I"),
      run: runIfActive((a) => emitFormat(a.mode, "italic")) },
    { id: "format.inlineCode",  title: "Toggle Inline Code", category: "Format", icon: "code",
      shortcut: mod("E"),
      run: runIfActive((a) => emitFormat(a.mode, "inlineCode")) },
    { id: "format.link",        title: "Toggle Link",        category: "Format", icon: "link",        shortcut: mod("K"),
      run: runIfActive((a) => emitFormat(a.mode, "link")) },
    {
      id: "format.headingPromote", title: "Promote Heading", category: "Format",
      icon: "h1", shortcut: mod("["),
      run: runIfActive((a) => emitFormat(a.mode, "headingPromote")),
    },
    {
      id: "format.headingDemote", title: "Demote Heading", category: "Format",
      icon: "h3", shortcut: mod("]"),
      run: runIfActive((a) => emitFormat(a.mode, "headingDemote")),
    },
    {
      id: "format.listBullet", title: "Bullet List", category: "Format",
      icon: "list-ul", shortcut: mod("Shift+8"),
      run: runIfActive((a) => emitFormat(a.mode, "listBullet")),
    },
    {
      id: "format.listNumber", title: "Numbered List", category: "Format",
      icon: "list-ol", shortcut: mod("Shift+7"),
      run: runIfActive((a) => emitFormat(a.mode, "listNumber")),
    },
    {
      id: "format.quote", title: "Block Quote", category: "Format",
      icon: "quote", shortcut: mod("Shift+."),
      run: runIfActive((a) => emitFormat(a.mode, "quote")),
    },

    /* ---------- Window ---------- */
    {
      id: "window.new", title: "New Window", category: "Window",
      icon: "open", shortcut: mod("Shift+N"),
      keywords: ["window", "new", "second", "split", "project"],
      run: async () => {
        // The host allocates the label and seeds the new window's row
        // before the webview exists, so it opens straight into this
        // project rather than booting empty and then being told.
        try {
          await checkpointOpenWindow(useProjects.getState().activeId);
        } catch (e: unknown) {
          window.dispatchEvent(new CustomEvent("spark:toast:error", {
            detail: {
              title: "Could not open a new window",
              body: String((e as Error)?.message ?? e),
            },
          }));
        }
      },
    },
    {
      id: "window.minimize", title: "Minimize", category: "Window",
      icon: "minimize",
      run: () => { window.dispatchEvent(new CustomEvent("spark:window:minimize")); },
    },
    {
      id: "window.maximize", title: "Maximize", category: "Window",
      icon: "maximize",
      run: () => { window.dispatchEvent(new CustomEvent("spark:window:maximize")); },
    },
    {
      id: "window.close", title: "Close Window", category: "Window",
      icon: "close", shortcut: mod("Shift+W"),
      run: () => { window.dispatchEvent(new CustomEvent("spark:window:close:request")); },
    },

    /* ---------- Help ---------- */
    {
      id: "help.about", title: "About sparkBook", category: "Help",
      icon: "command",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:about", { detail: { silent: true } })); },
    },
    {
      id: "help.docs", title: "Documentation", category: "Help",
      icon: "file",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:docs", { detail: { silent: true } })); },
    },
    {
      id: "help.releaseNotes", title: "Release Notes", category: "Help",
      icon: "file",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:releaseNotes", { detail: { silent: true } })); },
    },
    {
      id: "help.reportIssue", title: "Report Issue", category: "Help",
      icon: "alert",
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:reportIssue", { detail: { silent: true } })); },
    },
    {
      id: "help.welcome", title: "Show Welcome Screen", category: "Help",
      icon: "eye",
      keywords: ["onboarding", "first run", "wizard", "theme"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:welcome")); },
    },
    {
      id: "help.checkForUpdates", title: "Check for Updates…", category: "Help",
      icon: "refresh",
      keywords: ["ota", "update", "updater"],
      run: () => { window.dispatchEvent(new CustomEvent("spark:help:checkForUpdates")); },
    },
  ];
}

type FormatKind =
  | "bold" | "italic" | "inlineCode" | "link"
  | "headingPromote" | "headingDemote" | "listBullet" | "listNumber" | "quote";

function emitFormat(mode: DocMode, kind: FormatKind) {
  const prefix = mode === "markdown" ? "spark:md:format"
               : mode === "rich"     ? "spark:rich:format"
               :                       "spark:code:format";
  window.dispatchEvent(new CustomEvent(`${prefix}:${kind}`));
}
