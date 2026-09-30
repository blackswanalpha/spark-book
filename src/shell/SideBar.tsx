/* ============================================================
   sparkBook · src/shell/SideBar.tsx
   Left pane: folder explorer (Files) + recents tab.
   The explorer follows VS Code's and the WAI-ARIA tree view:
     - Lazy read_dir per directory; folders first, natural order
     - Keyboard: ↑↓ move, → expand / first child, ← collapse /
       parent, Home / End, Enter / Space open, F2 rename, Del
       trash (Shift+Del permanent), Ctrl+C/X/V, * expand
       siblings, type-ahead, Shift+F10 menu; one Tab stop
     - Inline create / rename rows ("a/b/c.md" makes folders)
     - Filter box that lists the folder and matches by name
     - Drag and drop to move (Ctrl/Alt to copy)
     - Reveals the active file; marks unsaved and cut entries
   ============================================================ */
import {
  Component, Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { motion, AnimatePresence } from "@motion/index";
import { Icon } from "@ui/Icon";
import { LangLogo } from "@ui/LangLogo";
import { Spinner as Loader } from "@ui/Loader";
import { Popover, PopoverTrigger, PopoverContent } from "@ui/Popover";
import {
  useExplorer, directoryOf, isUnder, baseName, dirName, validateName, normalizeRoot,
  type ExplorerNode, type ExplorerEdit,
} from "@store/explorer";
import { useDocs } from "@store/documents";
import { useProjects } from "@store/projects";
import { langIdOf } from "@editor/CodeEditor/languages";
import {
  ExplorerContextMenu, ExplorerActionsContext, DeleteDialog, runExplorerAction,
  type ExplorerActions, type DeleteTarget,
} from "./ExplorerContextMenu";
import { openTerminalAt } from "@store/terminal";
import "./SideBar.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/* Lightweight error boundary for the file tree — satisfies React's
   "Consider adding an error boundary" suggestion and prevents a single
   bad icon from crashing the whole explorer. */
class TreeErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: unknown) {
    console.error("[SideBar] Tree render error:", err);
  }
  render() {
    if (this.state.hasError) {
      return <div className="tree-empty">Explorer error — see console</div>;
    }
    return this.props.children;
  }
}

export interface RecentsEntry { path: string; name: string; }

export interface SideBarProps {
  recents: RecentsEntry[];
  onOpen: (path: string) => void;
  activePath?: string;
  onRequestOpenFolder?: () => void;
  onInfo?: (message: string) => void;
  onError?: (message: string, detail?: string) => void;
  /** Hide the pane. Rendered as a header affordance next to the tabs. */
  onCollapse?: () => void;
}

export function SideBar({
  recents, onOpen, activePath, onRequestOpenFolder, onInfo, onError, onCollapse,
}: SideBarProps) {
  const [tab, setTab] = useState<"files" | "recents">("files");

  /* "Open Recent File" in the palette/menu points here rather than at a
     second file picker — the recents list already lives in this pane. */
  useEffect(() => {
    const onTab = (e: Event) => {
      const want = (e as CustomEvent<{ tab?: "files" | "recents" }>).detail?.tab;
      if (want === "files" || want === "recents") setTab(want);
    };
    window.addEventListener("spark:sidebar:tab", onTab);
    return () => window.removeEventListener("spark:sidebar:tab", onTab);
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "files"}
          className={`sidebar__tab ${tab === "files" ? "is-active" : ""}`}
          onClick={() => setTab("files")}
        >
          <Icon name="folder" size={14} />
          <span>Explorer</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "recents"}
          className={`sidebar__tab ${tab === "recents" ? "is-active" : ""}`}
          onClick={() => setTab("recents")}
        >
          <Icon name="refresh" size={14} />
          <span>Recents</span>
        </button>
        {onCollapse && (
          <button
            type="button"
            className="sidebar__collapse"
            aria-label="Hide explorer"
            title="Hide explorer (Ctrl+B)"
            onClick={onCollapse}
          >
            <Icon name="sidebar-toggle" size={14} />
          </button>
        )}
      </div>

      <div className="sidebar__body">
        <AnimatePresence mode="wait">
          {tab === "files" ? (
            <motion.div
              key="files"
              className="sidebar__list"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.12 }}
            >
              <ExplorerPane
                onOpen={onOpen}
                activePath={activePath}
                onRequestOpenFolder={onRequestOpenFolder}
                onInfo={onInfo}
                onError={onError}
              />
            </motion.div>
          ) : (
            <motion.ul
              key="recents"
              className="sidebar__list"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.12 }}
            >
              {recents.length ? recents.map((r) => (
                <li key={r.path}>
                  <button
                    className={`sidebar__entry ${activePath === r.path ? "is-active" : ""}`}
                    onClick={() => onOpen(r.path)}
                  >
                    <Icon name="file" size={14} />
                    <span className="sidebar__entry-name">{r.name}</span>
                    <span className="sidebar__entry-path">{r.path}</span>
                  </button>
                </li>
              )) : (
                <div className="sidebar__empty">No recent files.</div>
              )}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
}

/* ---------- Explorer pane ---------- */
function ExplorerPane({
  onOpen, activePath, onRequestOpenFolder, onInfo, onError,
}: Pick<SideBarProps, "onOpen" | "activePath" | "onRequestOpenFolder" | "onInfo" | "onError">) {
  const root = useExplorer((s) => s.root);
  if (!root) {
    return (
      <div className="sidebar__empty explorer-empty">
        <p>No folder open.</p>
        <button
          type="button"
          className="sidebar__open-btn"
          onClick={() => onRequestOpenFolder?.()}
        >
          Open Folder…
        </button>
      </div>
    );
  }
  return (
    <Explorer
      root={root}
      onOpen={onOpen}
      activePath={activePath}
      onRequestOpenFolder={onRequestOpenFolder}
      onInfo={onInfo}
      onError={onError}
    />
  );
}

/* ---------- Explorer (toolbar + filter + tree) ---------- */
function Explorer({
  root, onOpen, activePath, onRequestOpenFolder, onInfo, onError,
}: {
  root: string;
  onOpen: (path: string) => void;
  activePath?: string;
  onRequestOpenFolder?: () => void;
  onInfo?: (message: string) => void;
  onError?: (message: string, detail?: string) => void;
}) {
  /* Selecting each field separately. Returning an object literal from a
     zustand selector allocates a new object on every store read, so the
     default Object.is comparison never matches and the entire tree
     re-renders on any store write — including ones this pane ignores. */
  const expanded = useExplorer((s) => s.expanded);
  const children = useExplorer((s) => s.children);
  const loading = useExplorer((s) => s.loading);
  const errors = useExplorer((s) => s.errors);
  const showHidden = useExplorer((s) => s.showHidden);
  const selectedPath = useExplorer((s) => s.selectedPath);
  const history = useExplorer((s) => s.history);
  const historyIndex = useExplorer((s) => s.historyIndex);
  const edit = useExplorer((s) => s.edit);
  const filter = useExplorer((s) => s.filter);
  const indexing = useExplorer((s) => s.indexing);
  const clipboard = useExplorer((s) => s.clipboard);

  /* Paths of tabs with unsaved changes, joined into one string so the
     selector returns a stable value and the tree re-renders only when
     the set actually changes. */
  const dirtyKey = useDocs((s) => {
    const out: string[] = [];
    for (const id of s.order) {
      const d = s.docs[id];
      if (d?.dirty && d.path) out.push(d.path);
    }
    return out.join("\n");
  });
  const dirty = useMemo(() => new Set(dirtyKey ? dirtyKey.split("\n") : []), [dirtyKey]);

  const query = filter.trim().toLowerCase();
  const view = useMemo(
    () => (query ? computeFilter(root, children, query, showHidden) : null),
    [root, children, query, showHidden],
  );

  const slice = useMemo<Slice>(
    () => ({ expanded, children, loading, errors, showHidden, selectedPath, edit, view, query, dirty, cutPath: clipboard?.op === "cut" ? clipboard.path : null }),
    [expanded, children, loading, errors, showHidden, selectedPath, edit, view, query, dirty, clipboard],
  );

  /* The project's own folder is "home": navigating up, into or back
     changes what the tree shows, never which project is open. */
  const projectRoot = useProjects((s) => s.projects.find((p) => p.id === s.activeId)?.rootPath ?? null);
  const home = projectRoot ? normalizeRoot(projectRoot) : (history[0] ?? root);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;

  const treeRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Row to focus once a delete finishes — the neighbour of the removed one. */
  const afterDeleteRef = useRef<string | null>(null);

  /* New entries land in the selected folder, or beside the selected file. */
  const targetDir = selectedPath ? directoryOf(children, selectedPath) : root;

  const actions = useMemo<ExplorerActions>(() => ({
    root,
    onOpen,
    onInfo,
    onError,
    requestDelete: (t) => {
      const rows = visibleRows(treeRef.current);
      const i = rows.findIndex((r) => r.dataset.path === t.path);
      const next = rows.slice(i + 1).find((r) => !isUnder(r.dataset.path ?? "", t.path)) ?? rows[i - 1];
      afterDeleteRef.current = next?.dataset.path ?? null;
      setPendingDelete(t);
    },
  }), [root, onOpen, onInfo, onError]);

  const confirmDelete = useCallback(async () => {
    const t = pendingDelete;
    if (!t) return;
    setDeleting(true);
    const res = await useExplorer.getState().deletePath(t.path, t.permanent);
    setDeleting(false);
    setPendingDelete(null);
    if (!res.ok) {
      onError?.("Delete failed", res.error);
      return;
    }
    onInfo?.(t.permanent ? `Deleted ${t.name}` : `Moved ${t.name} to Trash`);
    const next = afterDeleteRef.current;
    if (next) {
      useExplorer.getState().setSelected(next);
      window.setTimeout(() => focusRow(treeRef.current, next), 0);
    }
  }, [pendingDelete, onInfo, onError]);

  /* Keep the open file visible: expand its folders, select its row and
     scroll to it, the way VS Code's "auto reveal" does. */
  useEffect(() => {
    if (!activePath || activePath === root || !isUnder(activePath, root)) return;
    let cancelled = false;
    void useExplorer.getState().reveal(activePath).then(() => {
      if (cancelled) return;
      requestAnimationFrame(() => rowFor(treeRef.current, activePath)?.scrollIntoView({ block: "nearest" }));
    });
    return () => { cancelled = true; };
  }, [activePath, root]);

  const runMore = (fn: () => void) => { setMoreOpen(false); fn(); };

  return (
    <ExplorerActionsContext.Provider value={actions}>
      <div className="explorer" aria-label="File explorer">
        <div className="explorer__header">
          <div className="explorer__nav" aria-label="Navigation">
            <button
              type="button"
              className="icon-btn"
              aria-label="Go back"
              title={canGoBack ? `Back to ${history[historyIndex - 1]} (Alt+←)` : "Go back (Alt+←)"}
              disabled={!canGoBack}
              onClick={() => { void useExplorer.getState().goBack(); }}
            >
              <Icon name="arrow-left" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Go forward"
              title={canGoForward ? `Forward to ${history[historyIndex + 1]} (Alt+→)` : "Go forward (Alt+→)"}
              disabled={!canGoForward}
              onClick={() => { void useExplorer.getState().goForward(); }}
            >
              <Icon name="arrow-right" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Up to parent folder"
              title="Up to Parent Folder (Alt+↑)"
              disabled={root === "/"}
              onClick={() => { void useExplorer.getState().goUp(); }}
            >
              <Icon name="arrow-up" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Back to project folder"
              title={`Back to Project Folder: ${home} (Alt+Home)`}
              disabled={root === home}
              onClick={() => { void useExplorer.getState().navigateTo(home); }}
            >
              <Icon name="home" size={14} />
            </button>
          </div>
          <span className="explorer__actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="New file"
              title="New File…"
              onClick={() => useExplorer.getState().beginCreate("file", targetDir)}
            >
              <Icon name="file-plus" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="New folder"
              title="New Folder…"
              onClick={() => useExplorer.getState().beginCreate("folder", targetDir)}
            >
              <Icon name="folder-plus" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Refresh explorer"
              title="Refresh"
              onClick={() => { void useExplorer.getState().refresh(); }}
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Collapse folders"
              title="Collapse Folders"
              onClick={() => useExplorer.getState().collapseAll()}
            >
              <Icon name="collapse-all" size={14} />
            </button>
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="icon-btn" aria-label="More actions" title="More actions">
                  <Icon name="more" size={14} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={6} className="explorer__bubble">
                <button type="button" className="explorer__bubble-item" onClick={() => runMore(() => onRequestOpenFolder?.())}>
                  <Icon name="folder-open" size={16} />
                  <span>Open Folder…</span>
                </button>
                <div className="explorer__bubble-sep" role="separator" />
                <button
                  type="button"
                  className="explorer__bubble-item"
                  role="menuitemcheckbox"
                  aria-checked={showHidden}
                  onClick={() => runMore(() => useExplorer.getState().toggleShowHidden())}
                >
                  <Icon name={showHidden ? "eye" : "eye-slash"} size={16} />
                  <span>Show Hidden Files</span>
                  {showHidden && <Icon name="check" size={14} className="explorer__bubble-check" />}
                </button>
                <div className="explorer__bubble-sep" role="separator" />
                <button
                  type="button"
                  className="explorer__bubble-item"
                  title={`Open internal terminal at ${targetDir}`}
                  onClick={() => runMore(() => { openTerminalAt(targetDir); onInfo?.(`Terminal: ${targetDir}`); })}
                >
                  <Icon name="terminal" size={16} />
                  <span>Open in Terminal</span>
                </button>
                <button
                  type="button"
                  className="explorer__bubble-item"
                  onClick={() => runMore(() => { void runExplorerAction("reveal-in-os", { path: root, isDir: true }, actions); })}
                >
                  <Icon name="external" size={16} />
                  <span>Reveal in File Manager</span>
                </button>
                <button
                  type="button"
                  className="explorer__bubble-item"
                  onClick={() => runMore(() => { void runExplorerAction("copy-path", { path: root, isDir: true }, actions); })}
                >
                  <Icon name="copy-path" size={16} />
                  <span>Copy Folder Path</span>
                </button>
              </PopoverContent>
            </Popover>
          </span>
        </div>

        <Breadcrumb root={root} home={home} />

        <div className="explorer__filter">
          <Icon name="search" size={13} className="explorer__filter-icon" />
          <input
            ref={filterRef}
            className="explorer__filter-input"
            type="text"
            spellCheck={false}
            placeholder="Filter files"
            aria-label="Filter files by name"
            value={filter}
            onChange={(e) => useExplorer.getState().setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (filter) useExplorer.getState().setFilter("");
                else focusFirstRow(treeRef.current);
              } else if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                focusFirstRow(treeRef.current);
              }
            }}
          />
          {query && (
            <span className="explorer__filter-count" aria-live="polite">
              {indexing ? "Searching…" : `${view?.count ?? 0}${(view?.count ?? 0) >= FILTER_MAX ? "+" : ""}`}
            </span>
          )}
          {filter && (
            <button
              type="button"
              className="icon-btn explorer__filter-clear"
              aria-label="Clear filter"
              title="Clear filter (Esc)"
              onClick={() => { useExplorer.getState().setFilter(""); filterRef.current?.focus(); }}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>

        <Tree root={root} home={home} activePath={activePath} slice={slice} treeRef={treeRef} filterRef={filterRef} />

        <DeleteDialog
          target={pendingDelete}
          busy={deleting}
          onOpenChange={(o) => { if (!o && !deleting) setPendingDelete(null); }}
          onConfirm={() => { void confirmDelete(); }}
        />
      </div>
    </ExplorerActionsContext.Provider>
  );
}

/* ---------- Breadcrumb ---------- */
/** The root's path, one button per folder. An ancestor shows that folder
 *  in the tree; the last crumb selects the root row. */
function Breadcrumb({ root, home }: { root: string; home: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const crumbs = useMemo(() => crumbsFor(root), [root]);
  // Long paths scroll; keep the current folder, at the end, in view.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [root]);
  return (
    <nav className="explorer__crumbs" aria-label="Folder path" ref={ref}>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={c.path}>
            {i > 0 && <Icon name="chevron-right" size={10} className="explorer__crumb-sep" aria-hidden />}
            <button
              type="button"
              className={`explorer__crumb ${last ? "is-current" : ""}`}
              aria-current={last ? "location" : undefined}
              title={c.path === home ? `${c.path} — project folder` : c.path}
              onClick={() => {
                const api = useExplorer.getState();
                if (!last) { void api.navigateTo(c.path); return; }
                api.setSelected(root);
                focusRow(document.querySelector<HTMLElement>(".explorer__tree"), root);
              }}
            >
              {c.path === home && <Icon name="home" size={11} />}
              <span>{c.label}</span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

function crumbsFor(root: string): { label: string; path: string }[] {
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const seg of root.split("/").filter(Boolean)) {
    acc += "/" + seg;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/* ---------- Filter ---------- */
/** Cap on matches shown, so a one-letter filter over a big tree stays fast. */
const FILTER_MAX = 500;

interface FilterView {
  /** Every row to show: matches and their ancestors. */
  show: Set<string>;
  /** Folders held open because a match lies inside them. */
  open: Set<string>;
  /** Folders whose own name matched; their contents show unfiltered
   *  when the user expands them. */
  matched: Set<string>;
  count: number;
}

/** Match `query` against every name already listed under `root`. */
function computeFilter(
  root: string,
  children: Map<string, ExplorerNode[]>,
  query: string,
  showHidden: boolean,
): FilterView {
  const show = new Set<string>();
  const open = new Set<string>();
  const matched = new Set<string>();
  let count = 0;
  const walk = (dir: string, depth: number): boolean => {
    const nodes = children.get(dir);
    if (!nodes || depth > 64) return false;
    let any = false;
    for (const n of nodes) {
      if (count >= FILTER_MAX) break;
      if (!showHidden && n.name.startsWith(".")) continue;
      const hit = n.name.toLowerCase().includes(query);
      if (hit) count++;
      const below = n.isDir ? walk(n.path, depth + 1) : false;
      if (!hit && !below) continue;
      show.add(n.path);
      if (hit && n.isDir) matched.add(n.path);
      if (below) open.add(n.path);
      any = true;
    }
    return any;
  };
  walk(root, 0);
  return { show, open, matched, count };
}

/* ---------- Tree ---------- */
type Slice = {
  expanded: Set<string>;
  children: Map<string, ExplorerNode[]>;
  loading: Set<string>;
  errors: Map<string, string>;
  showHidden: boolean;
  selectedPath: string | null;
  edit: ExplorerEdit | null;
  /** Non-null while a filter is typed. */
  view: FilterView | null;
  query: string;
  dirty: Set<string>;
  /** The entry marked by Cut, drawn faded until it is pasted. */
  cutPath: string | null;
};

interface TreeCtx {
  root: string;
  activePath?: string;
  slice: Slice;
  dropDir: string | null;
  setDropDir: (dir: string | null) => void;
}
const TreeContext = createContext<TreeCtx | null>(null);
function useTree(): TreeCtx {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error("Tree rows must render inside <Tree>");
  return ctx;
}

/** The path being dragged. Drag events expose data only on drop, and
 *  dragover needs the source to decide whether a folder accepts it. */
let dragSource: string | null = null;
let hoverTimer: number | null = null;
let hoverPath: string | null = null;
function clearHover() {
  if (hoverTimer !== null) window.clearTimeout(hoverTimer);
  hoverTimer = null;
  hoverPath = null;
}

/** Whether `dir` can take the dragged entry. Moving into the folder it
 *  is already in is a no-op, and a folder cannot move into itself. */
function acceptsDrop(dir: string, copy: boolean): boolean {
  return dragSource !== null && acceptsDropFrom(dragSource, dir, copy);
}

const TYPEAHEAD_MS = 700;

function Tree({
  root, home, activePath, slice, treeRef, filterRef,
}: {
  root: string;
  home: string;
  activePath?: string;
  slice: Slice;
  treeRef: React.MutableRefObject<HTMLDivElement | null>;
  filterRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  const actions = useContext(ExplorerActionsContext)!;
  const [dropDir, setDropDir] = useState<string | null>(null);
  const typeahead = useRef({ text: "", at: 0 });

  /* Roving tabindex: exactly one row is in the Tab order — the selected
     one, else the first. Done after render because which rows exist
     depends on expansion the rows themselves do not know about. */
  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".tree-item"));
    const stop = rows.find((r) => r.dataset.path === slice.selectedPath) ?? rows[0];
    for (const r of rows) r.tabIndex = r === stop ? 0 : -1;
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const rows = visibleRows(treeRef.current);
    if (rows.length === 0) return;
    const api = useExplorer.getState();
    const idx = rows.findIndex((r) => r === document.activeElement);
    const cur = idx >= 0 ? rows[idx] : null;
    const curPath = cur?.dataset.path ?? null;
    const curIsDir = cur?.dataset.dir === "true";
    const curOpen = cur?.getAttribute("aria-expanded") === "true";
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const moveTo = (row: HTMLElement | undefined) => {
      if (!row) return;
      row.focus();
      row.scrollIntoView({ block: "nearest" });
      api.setSelected(row.dataset.path ?? null);
    };
    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.altKey && e.key === "ArrowUp") {
      handled(); if (root !== "/") void api.goUp();
    } else if (e.altKey && e.key === "ArrowLeft") {
      handled(); void api.goBack();
    } else if (e.altKey && e.key === "ArrowRight") {
      handled(); void api.goForward();
    } else if (e.altKey && e.key === "Home") {
      handled(); void api.navigateTo(home);
    } else if (e.altKey && e.key === "ArrowDown") {
      // Move into the focused folder (or the folder holding the file).
      handled(); if (curPath) void api.navigateTo(curIsDir ? curPath : dirName(curPath));
    } else if (e.key === "ArrowDown") {
      handled(); moveTo(rows[idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1)]);
    } else if (e.key === "ArrowUp") {
      handled(); moveTo(rows[idx < 0 ? rows.length - 1 : Math.max(idx - 1, 0)]);
    } else if (e.key === "Home") {
      handled(); moveTo(rows[0]);
    } else if (e.key === "End") {
      handled(); moveTo(rows[rows.length - 1]);
    } else if (!cur || !curPath) {
      return;
    } else if (e.key === "ArrowRight") {
      handled();
      if (curIsDir && !curOpen) void api.setExpanded(curPath, true);
      else if (curIsDir) {
        const next = rows[idx + 1];
        if (next && Number(next.getAttribute("aria-level")) > Number(cur.getAttribute("aria-level"))) moveTo(next);
      }
    } else if (e.key === "ArrowLeft") {
      handled();
      if (curIsDir && curOpen) void api.setExpanded(curPath, false);
      else moveTo(rows.find((r) => r.dataset.path === dirName(curPath)));
    } else if (e.key === "Enter" || e.key === " ") {
      handled(); cur.click();
    } else if (e.key === "F2") {
      handled(); api.beginRename(curPath);
    } else if (e.key === "Delete" || (isMac && e.metaKey && e.key === "Backspace")) {
      handled(); void runExplorerAction("delete", { path: curPath, isDir: curIsDir }, actions, { permanent: e.shiftKey });
    } else if (mod && !e.shiftKey && (e.key === "c" || e.key === "x" || e.key === "v")) {
      handled();
      const id = e.key === "c" ? "copy" : e.key === "x" ? "cut" : "paste";
      void runExplorerAction(id, { path: curPath, isDir: curIsDir }, actions);
    } else if (e.key === "Escape" && slice.cutPath) {
      handled(); api.setClipboard(null);
    } else if (e.key === "*") {
      handled(); void api.expandSiblings(curPath);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      handled();
      const r = cur.getBoundingClientRect();
      cur.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom,
      }));
    } else if (mod && e.key === "f") {
      handled(); filterRef.current?.focus();
    } else if (e.key.length === 1 && !mod && !e.altKey && e.key !== " ") {
      // Type-ahead: jump to the next row whose name starts with what was typed.
      handled();
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.at > TYPEAHEAD_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const order = [...rows.slice(idx + (t.text.length > 1 ? 0 : 1)), ...rows.slice(0, idx + 1)];
      moveTo(order.find((r) => (r.dataset.name ?? "").toLowerCase().startsWith(t.text)));
    }
  };

  /* The blank area under the rows is the root folder: it takes drops
     and right-clicks for the root, like the space below VS Code's tree. */
  const onRootDragOver = (e: React.DragEvent) => {
    const copy = e.ctrlKey || e.altKey;
    if (!acceptsDrop(root, copy)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = copy ? "copy" : "move";
    setDropDir(root);
  };
  const onRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void dropInto(root, e.ctrlKey || e.altKey, actions);
    setDropDir(null);
  };

  const ctx = useMemo<TreeCtx>(
    () => ({ root, activePath, slice, dropDir, setDropDir }),
    [root, activePath, slice, dropDir],
  );

  return (
    <TreeContext.Provider value={ctx}>
      <div
        className={`explorer__tree ${dropDir === root ? "is-drop-target" : ""}`}
        ref={treeRef}
        onKeyDown={onKeyDown}
        onDragOver={onRootDragOver}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropDir(null); }}
        onDrop={onRootDrop}
        role="presentation"
      >
        <ExplorerContextMenu path={root} isDir>
          <div className="explorer__canvas">
            <TreeErrorBoundary>
              <div role="tree" aria-label="Files">
                <RootRow />
                <TreeLevel dirPath={root} depth={2} unfiltered={!slice.view} />
              </div>
            </TreeErrorBoundary>
          </div>
        </ExplorerContextMenu>
      </div>
    </TreeContext.Provider>
  );
}

async function dropInto(dir: string, copy: boolean, actions: ExplorerActions) {
  const src = dragSource;
  dragSource = null;
  clearHover();
  if (!src || !acceptsDropFrom(src, dir, copy)) return;
  const res = await useExplorer.getState().transfer(copy ? "copy" : "cut", src, dir);
  if (!res.ok) actions.onError?.(copy ? "Copy failed" : "Move failed", res.error);
  else actions.onInfo?.(`${copy ? "Copied" : "Moved"} ${baseName(src)} to ${baseName(dir) || dir}`);
}

function acceptsDropFrom(src: string, dir: string, copy: boolean): boolean {
  if (isUnder(dir, src)) return false;
  return copy || dirName(src) !== dir;
}

/** Indent for a row at `depth`, capped at half the row: at 12px a level a
 *  deeply nested name started past the pane's right edge and vanished. */
function indentFor(depth: number): string {
  return `min(${(depth - 1) * 12 + 6}px, 50%)`;
}

/** The open folder itself, as the tree's first row. Selecting it makes
 *  the root the target for New File, Paste and the terminal; its chevron
 *  (or a double-click) folds the whole tree. */
function RootRow() {
  const { root, slice, dropDir } = useTree();
  const expanded = Boolean(slice.view) || slice.expanded.has(root);
  const name = baseName(root) || root;
  const toggle = () => {
    if (!slice.view) void useExplorer.getState().setExpanded(root, !expanded);
  };
  return (
    <ExplorerContextMenu path={root} isDir>
      <button
        type="button"
        className={`tree-item tree-item--root ${dropDir === root ? "is-drop-target" : ""}`}
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        aria-selected={slice.selectedPath === root}
        data-path={root}
        data-name={name}
        data-dir="true"
        tabIndex={-1}
        title={root}
        style={{ paddingLeft: indentFor(1) }}
        onClick={(e) => {
          useExplorer.getState().setSelected(root);
          if ((e.target as HTMLElement).closest(".tree-item__chev")) toggle();
        }}
        onDoubleClick={toggle}
      >
        <span className="tree-item__chev" aria-hidden>
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="tree-item__icon" aria-hidden>
          <Icon name={expanded ? "folder-open" : "folder"} size={14} />
        </span>
        <span className="tree-item__name">{name}</span>
      </button>
    </ExplorerContextMenu>
  );
}

function TreeLevel({ dirPath, depth, unfiltered }: { dirPath: string; depth: number; unfiltered: boolean }) {
  const { root, slice } = useTree();
  const raw = slice.children.get(dirPath);
  const isLoading = slice.loading.has(dirPath);
  const error = slice.errors.get(dirPath);
  // The root folds like any folder, except that a filter always shows it.
  const open = dirPath === root ? (Boolean(slice.view) || slice.expanded.has(root)) : isOpen(slice, dirPath, unfiltered);
  const creating = slice.edit && slice.edit.kind !== "rename" && slice.edit.dir === dirPath ? slice.edit : null;

  const visible = useMemo(() => {
    if (!raw) return undefined;
    return raw.filter((n) =>
      (slice.showHidden || !n.name.startsWith(".")) && (unfiltered || !slice.view || slice.view.show.has(n.path)),
    );
  }, [raw, slice.showHidden, slice.view, unfiltered]);

  /* Kick off the lazy read_dir from an effect, not from render. Calling it
     during render is a side effect React is free to run twice (StrictMode)
     or discard, and it re-fired on every re-render while the request was in
     flight — a request storm on a slow directory. */
  const needsLoad = open && !raw && !isLoading && !error;
  useEffect(() => {
    if (needsLoad) void useExplorer.getState().loadChildren(dirPath);
  }, [needsLoad, dirPath]);

  if (!open) return null;

  const createRow = creating && (
    <InlineEdit
      kind={creating.kind === "new-file" ? "file" : "folder"}
      dir={dirPath}
      depth={depth}
      siblings={raw?.map((n) => n.name) ?? []}
    />
  );

  // The error comes first: a directory that failed to list has no
  // children, and checking for those first left it on "Loading…" forever
  // (a deleted project folder, a directory without read permission).
  if (error && !isLoading && (!visible || visible.length === 0)) {
    return <div role="group">{createRow}<div className="tree-empty" style={{ paddingLeft: indentFor(depth) }}>{error}</div></div>;
  }
  if (!visible || (isLoading && visible.length === 0)) {
    return <div role="group">{createRow}<LoadingRow depth={depth} /></div>;
  }
  if (visible.length === 0) {
    return (
      <div role="group">
        {createRow}
        {!creating && (
          <div className="tree-empty" style={{ paddingLeft: indentFor(depth + 1) }}>
            {unfiltered ? "Empty folder" : `No files match “${slice.query}”`}
          </div>
        )}
      </div>
    );
  }
  return (
    <div role="group">
      {createRow}
      {visible.map((node, i) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          unfiltered={unfiltered}
          posinset={i + 1}
          setsize={visible.length}
        />
      ))}
    </div>
  );
}

/** Whether a folder's contents are showing. While a filter is active,
 *  folders holding matches are held open; elsewhere it is the user's call. */
function isOpen(slice: Slice, path: string, unfiltered: boolean): boolean {
  if (unfiltered || !slice.view) return slice.expanded.has(path);
  return slice.view.open.has(path) || (slice.view.matched.has(path) && slice.expanded.has(path));
}

function TreeRow({
  node, depth, unfiltered, posinset, setsize,
}: {
  node: ExplorerNode;
  depth: number;
  unfiltered: boolean;
  posinset: number;
  setsize: number;
}) {
  const { activePath, slice, dropDir, setDropDir } = useTree();
  const actions = useContext(ExplorerActionsContext)!;
  const expanded = node.isDir && isOpen(slice, node.path, unfiltered);
  // Below a folder whose own name matched, the filter lets go.
  const childUnfiltered = unfiltered || Boolean(slice.view?.matched.has(node.path) && !slice.view.open.has(node.path));
  const isActive = activePath === node.path;
  const isSelected = slice.selectedPath === node.path;
  const isHidden = node.name.startsWith(".");
  const isDirty = !node.isDir && slice.dirty.has(node.path);
  const renaming = slice.edit?.kind === "rename" && slice.edit.path === node.path;
  const dropTarget = node.isDir ? node.path : dirName(node.path);

  const onClick = () => {
    useExplorer.getState().setSelected(node.path);
    if (node.isDir) {
      void useExplorer.getState().setExpanded(node.path, !expanded);
    } else {
      actions.onOpen(node.path);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    const copy = e.ctrlKey || e.altKey;
    // Stop here either way: letting a refused row fall through to the
    // tree would offer the root folder as the target instead.
    e.stopPropagation();
    if (!acceptsDrop(dropTarget, copy)) {
      if (dropDir !== null) setDropDir(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = copy ? "copy" : "move";
    if (dropDir !== dropTarget) setDropDir(dropTarget);
    // Hovering a closed folder while dragging opens it after a pause.
    if (node.isDir && !expanded && hoverPath !== node.path) {
      clearHover();
      hoverPath = node.path;
      hoverTimer = window.setTimeout(() => {
        void useExplorer.getState().setExpanded(node.path, true);
      }, 600);
    }
  };

  const row = renaming ? (
    <InlineEdit
      kind="rename"
      dir={dirName(node.path)}
      depth={depth}
      path={node.path}
      isDir={node.isDir}
      siblings={slice.children.get(dirName(node.path))?.map((n) => n.name) ?? []}
    />
  ) : (
    <ExplorerContextMenu path={node.path} isDir={node.isDir}>
      <button
        type="button"
        className={[
          "tree-item",
          isHidden ? "tree-item--hidden" : "",
          isActive ? "is-active" : "",
          slice.cutPath === node.path ? "is-cut" : "",
          node.isDir && dropDir === node.path ? "is-drop-target" : "",
        ].filter(Boolean).join(" ")}
        role="treeitem"
        aria-level={depth}
        aria-expanded={node.isDir ? expanded : undefined}
        aria-selected={isSelected}
        aria-posinset={posinset}
        aria-setsize={setsize}
        data-path={node.path}
        data-name={node.name}
        data-dir={node.isDir ? "true" : "false"}
        tabIndex={-1}
        title={node.path}
        style={{ paddingLeft: indentFor(depth) }}
        onClick={onClick}
        draggable
        onDragStart={(e) => {
          dragSource = node.path;
          e.dataTransfer.effectAllowed = "copyMove";
          e.dataTransfer.setData("text/plain", node.path);
        }}
        onDragEnd={() => { dragSource = null; clearHover(); setDropDir(null); }}
        onDragOver={onDragOver}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void dropInto(dropTarget, e.ctrlKey || e.altKey, actions);
          setDropDir(null);
        }}
      >
        <span className="tree-item__chev" aria-hidden>
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="tree-item__icon" aria-hidden>
          {node.isDir ? (
            <Icon name={expanded ? "folder-open" : "folder"} size={14} />
          ) : (
            <FileIcon name={node.name} />
          )}
        </span>
        <span className="tree-item__name">
          <Highlight text={node.name} query={slice.query} />
        </span>
        {isDirty && <span className="tree-item__dirty" aria-label="Unsaved changes" title="Unsaved changes" />}
      </button>
    </ExplorerContextMenu>
  );

  return (
    <>
      {row}
      {node.isDir && expanded && (
        <div className="tree-group" role="group">
          <TreeLevel dirPath={node.path} depth={depth + 1} unfiltered={childUnfiltered} />
        </div>
      )}
    </>
  );
}

/** `text` with the first occurrence of `query` marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="tree-item__match">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/* ---------- Inline create / rename row ---------- */
function InlineEdit({
  kind, dir, depth, siblings, path, isDir,
}: {
  kind: "file" | "folder" | "rename";
  dir: string;
  depth: number;
  siblings: string[];
  /** The entry being renamed. */
  path?: string;
  isDir?: boolean;
}) {
  const actions = useContext(ExplorerActionsContext)!;
  const initial = kind === "rename" && path ? baseName(path) : "";
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mountedAt = useRef(Date.now());
  const done = useRef(false);

  const problem = value.trim() === initial
    ? null
    : validateName(value, siblings, { nested: kind !== "rename", current: initial });
  const message = failure ?? (value.trim() ? problem : null);

  /* Focus after the context menu closes: Radix hands focus back to the
     row that opened it, which would otherwise take it from this input.
     A rename selects the name without its extension, like VS Code. */
  useEffect(() => {
    const t = window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = kind === "rename" && !isDir ? initial.lastIndexOf(".") : -1;
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, 30);
    return () => window.clearTimeout(t);
  }, [kind, isDir, initial]);

  const finish = () => {
    done.current = true;
    useExplorer.getState().cancelEdit();
    window.setTimeout(() => {
      const sel = useExplorer.getState().selectedPath;
      const tree = inputRef.current?.closest(".explorer__tree") ?? document.querySelector(".explorer__tree");
      if (sel) focusRow(tree as HTMLElement | null, sel);
    }, 0);
  };

  const commit = async () => {
    if (done.current || busy) return;
    const name = value.trim();
    if (!name || name === initial) { finish(); return; }
    if (problem) { inputRef.current?.focus(); return; }
    setBusy(true);
    const api = useExplorer.getState();
    const res = kind === "rename" && path
      ? await api.renamePath(path, name)
      : kind === "file"
        ? await api.createFile(dir, name)
        : await api.createFolder(dir, name);
    setBusy(false);
    if (!res.ok) {
      setFailure(res.error ?? "Failed");
      inputRef.current?.focus();
      return;
    }
    if (kind === "file" && res.path) actions.onOpen(res.path);
    finish();
  };

  return (
    <div className="tree-edit" style={{ paddingLeft: indentFor(depth) }}>
      <div className={`tree-edit__row ${message ? "is-invalid" : ""}`}>
        <span className="tree-item__chev" aria-hidden />
        <span className="tree-item__icon" aria-hidden>
          {kind === "folder" || (kind === "rename" && isDir)
            ? <Icon name="folder" size={14} />
            : <FileIcon name={value || "untitled"} />}
        </span>
        <input
          ref={inputRef}
          className="tree-edit__input"
          value={value}
          spellCheck={false}
          disabled={busy}
          aria-label={kind === "rename" ? `Rename ${initial}` : kind === "file" ? "New file name" : "New folder name"}
          aria-invalid={Boolean(message)}
          placeholder={kind === "folder" ? "folder name" : kind === "file" ? "file name — a/b/c.md makes folders" : ""}
          onChange={(e) => { setValue(e.target.value); setFailure(null); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); void commit(); }
            else if (e.key === "Escape") { e.preventDefault(); finish(); }
          }}
          onBlur={() => {
            // A blur right after mount is the context menu taking focus
            // back, not the user leaving: keep editing.
            if (Date.now() - mountedAt.current < 250) { inputRef.current?.focus(); return; }
            if (!value.trim() || value.trim() === initial || problem) finish();
            else void commit();
          }}
        />
      </div>
      {message && <div className="tree-edit__error" role="alert">{message}</div>}
    </div>
  );
}

/* ---------- File icons ---------- */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

function FileIcon({ name }: { name: string }) {
  if (IMAGE_EXT.test(name)) return <Icon name="mode-image" size={14} />;
  if (/\.pdf$/i.test(name)) return <Icon name="mode-pdf" size={14} />;
  if (/\.sparkanim$/i.test(name)) return <Icon name="mode-animation" size={14} />;
  let lid: string | undefined;
  try {
    lid = langIdOf(name);
  } catch {
    lid = undefined;
  }
  if (lid) {
    // LangLogo itself is now defensive; still guard with error boundary fallback
    try {
      return <LangLogo langId={lid} size={14} />;
    } catch {
      return <Icon name="file" size={14} />;
    }
  }
  return <Icon name="file" size={14} />;
}

/* ---------- helpers ---------- */
function LoadingRow({ depth }: { depth: number }) {
  return (
    <div className="loader-row" style={{ paddingLeft: indentFor(depth + 1) }}>
      <Loader size={14} />
      <span>Loading…</span>
    </div>
  );
}

/** Rows currently rendered and visible, in display order. */
function visibleRows(tree: HTMLElement | null): HTMLElement[] {
  if (!tree) return [];
  return Array.from(tree.querySelectorAll<HTMLElement>(".tree-item")).filter((r) => r.offsetParent !== null);
}

function rowFor(tree: HTMLElement | null, path: string): HTMLElement | null {
  return tree?.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(path)}"]`) ?? null;
}

function focusRow(tree: HTMLElement | null, path: string) {
  const row = rowFor(tree, path);
  if (!row) return;
  row.focus();
  row.scrollIntoView({ block: "nearest" });
}

function focusFirstRow(tree: HTMLElement | null) {
  const rows = visibleRows(tree);
  const target = rows.find((r) => r.tabIndex === 0) ?? rows[0];
  if (!target) return;
  target.focus();
  useExplorer.getState().setSelected(target.dataset.path ?? null);
}
