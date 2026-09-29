/* ============================================================
   sparkBook · src/shell/ExplorerContextMenu.tsx
   Right-click menu for the file explorer, plus the delete
   confirmation it shares with the keyboard.
     • New File / New Folder      • Cut / Copy / Paste / Duplicate
     • Open as Root Folder        • Copy Path / Copy Relative Path
     • Open in Terminal
     • Reveal in File Manager     • Rename (F2) / Delete (Del)
   Create and rename happen in an inline row in the tree; this
   menu only starts them through the explorer store. Actions that
   need the pane (open a file, confirm a delete, toasts) come from
   ExplorerActionsContext, provided by the explorer.
   ============================================================ */
import { createContext, useCallback, useContext, useMemo } from "react";
import { ContextMenu, type ContextMenuEntry } from "@ui/ContextMenu";
import { Dialog, DialogFooter } from "@ui/Dialog";
import { Button } from "@ui/Button";
import { useExplorer, baseName, dirName } from "@store/explorer";
import { openTerminalAt } from "@store/terminal";
import { writeClipboardText } from "@bridge/clipboard";

export interface DeleteTarget {
  path: string;
  name: string;
  isDir: boolean;
  /** Skip the OS trash (Shift+Delete). */
  permanent: boolean;
}

export interface ExplorerActions {
  root: string;
  onOpen: (path: string) => void;
  requestDelete: (target: DeleteTarget) => void;
  onInfo?: (message: string) => void;
  onError?: (title: string, detail?: string) => void;
}

export const ExplorerActionsContext = createContext<ExplorerActions | null>(null);

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`);

/** `path` relative to the explorer root, for "Copy Relative Path". */
export function relativePath(path: string, root: string): string {
  if (path === root) return ".";
  const prefix = root.endsWith("/") || root.endsWith("\\") ? root : root + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Run an explorer action against `path`. Shared by the context menu
 * and the tree's keyboard handler so the two cannot drift apart.
 */
export async function runExplorerAction(
  id: string,
  target: { path: string; isDir: boolean },
  actions: ExplorerActions,
  opts: { permanent?: boolean } = {},
): Promise<void> {
  const api = useExplorer.getState();
  const { path, isDir } = target;
  const name = baseName(path) || path;
  const targetDir = isDir ? path : dirName(path);
  switch (id) {
    case "new-file":
      api.beginCreate("file", targetDir);
      return;
    case "new-folder":
      api.beginCreate("folder", targetDir);
      return;
    case "open-in-terminal":
      openTerminalAt(targetDir);
      actions.onInfo?.(`Terminal: ${targetDir}`);
      return;
    case "open-as-root":
      if (isDir && path !== actions.root) void api.navigateTo(path);
      return;
    case "reveal-in-os": {
      const res = await api.revealInOS(path);
      if (!res.ok) actions.onError?.("Reveal failed", res.error);
      return;
    }
    case "cut":
    case "copy":
      if (path === actions.root) return;
      api.setClipboard({ op: id, path });
      actions.onInfo?.(`${id === "cut" ? "Cut" : "Copied"}: ${name}`);
      return;
    case "paste": {
      if (!api.clipboard) return;
      const res = await api.pasteInto(targetDir);
      if (!res.ok) actions.onError?.("Paste failed", res.error);
      return;
    }
    case "duplicate": {
      if (path === actions.root) return;
      const res = await api.duplicate(path);
      if (!res.ok) actions.onError?.("Duplicate failed", res.error);
      return;
    }
    case "copy-path":
    case "copy-relative-path": {
      const text = id === "copy-path" ? path : relativePath(path, actions.root);
      const ok = await writeClipboardText(text);
      if (ok) actions.onInfo?.(`Copied ${text}`);
      else actions.onError?.("Copy failed", "The clipboard is not available.");
      return;
    }
    case "rename":
      api.beginRename(path);
      return;
    case "delete":
      if (path === actions.root) return;
      actions.requestDelete({ path, name, isDir, permanent: Boolean(opts.permanent) });
      return;
  }
}

export interface ExplorerContextMenuProps {
  /** The path the right-click landed on: a row, or the explorer root
   *  for the blank area below the rows. */
  path: string;
  isDir: boolean;
  /** The element that receives right-clicks. */
  children: React.ReactElement;
}

export function ExplorerContextMenu({ path, isDir, children }: ExplorerContextMenuProps) {
  const actions = useContext(ExplorerActionsContext);
  const hasClipboard = useExplorer((s) => s.clipboard !== null);
  const isRoot = actions?.root === path;

  const entries = useMemo<ContextMenuEntry[]>(() => {
    const list: ContextMenuEntry[] = [
      { id: "new-file",   label: "New File…",   icon: "file-plus" },
      { id: "new-folder", label: "New Folder…", icon: "folder-plus" },
      { separator: true, id: "sep-open" },
    ];
    if (isDir && !isRoot) list.push({ id: "open-as-root", label: "Open as Root Folder", icon: "folder-open", shortcut: "Alt+↓" });
    if (isDir) list.push({ id: "open-in-terminal", label: "Open in Terminal", icon: "terminal" });
    list.push({ id: "reveal-in-os", label: "Reveal in File Manager", icon: "external" });
    list.push({ separator: true, id: "sep-clip" });
    if (!isRoot) {
      list.push({ id: "cut",  label: "Cut",  icon: "scissors", shortcut: key("X") });
      list.push({ id: "copy", label: "Copy", icon: "copy",     shortcut: key("C") });
    }
    list.push({ id: "paste", label: "Paste", icon: "clipboard", shortcut: key("V"), disabled: !hasClipboard });
    if (!isRoot) list.push({ id: "duplicate", label: "Duplicate", icon: "copy" });
    list.push({ separator: true, id: "sep-path" });
    list.push({ id: "copy-path", label: "Copy Path", icon: "copy-path" });
    list.push({ id: "copy-relative-path", label: "Copy Relative Path", icon: "copy-path" });
    if (!isRoot) {
      list.push({ separator: true, id: "sep-edit" });
      list.push({ id: "rename", label: "Rename…", icon: "pencil", shortcut: "F2" });
      list.push({ id: "delete", label: "Delete", icon: "trash", destructive: true, shortcut: isMac ? "⌘⌫" : "Del" });
    }
    return list;
  }, [isDir, isRoot, hasClipboard]);

  const onSelect = useCallback((id: string) => {
    if (actions) void runExplorerAction(id, { path, isDir }, actions);
  }, [actions, path, isDir]);

  return (
    <ContextMenu entries={entries} onSelect={onSelect}>
      {children}
    </ContextMenu>
  );
}

/* ---------- Delete confirm dialog ---------- */
export function DeleteDialog({
  target, onOpenChange, onConfirm, busy,
}: {
  target: DeleteTarget | null;
  onOpenChange: (o: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const what = target?.isDir ? "folder" : "file";
  const description = !target
    ? ""
    : target.permanent
      ? `“${target.name}”${target.isDir ? " and everything in it" : ""} will be deleted permanently. This cannot be undone.`
      : `“${target.name}”${target.isDir ? " and everything in it" : ""} will be moved to the Trash. You can restore it from there.`;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={target?.permanent ? `Delete ${what} permanently?` : `Move ${what} to Trash?`}
      description={description}
      size="sm"
    >
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy} autoFocus>
          {target?.permanent ? "Delete" : "Move to Trash"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
