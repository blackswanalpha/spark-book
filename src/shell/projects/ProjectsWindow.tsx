/* ============================================================
   sparkBook · src/shell/projects/ProjectsWindow.tsx

   The Projects window (`index.html?projects=1&opener=<label>`): every
   project sparkBook knows, with New, Open and Clone.

   Opening follows one rule set (see planOpen): a project already on
   screen is focused, never opened twice; otherwise it goes to a new
   window, or to "this window" — the editor window whose rail opened
   this one — when asked, preferred, or when that window is empty.
   The window closes itself once the project is on screen.

   The list is re-read whenever this window gains focus, so what it
   says is open, missing or renamed is never older than the last
   time the user looked at it.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@ui/Input";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { useToast } from "@ui/Toast";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuSurface, type ContextMenuEntry } from "@ui/ContextMenu";
import { DropdownRoot, DropdownTrigger, DropdownContent } from "@ui/Dropdown";
import { highlightRuns } from "@shell/project/fuzzy";
import { relativeTime } from "@shell/ProjectSwitcher";
import {
  checkpointLoad,
  checkpointOpenWindow,
  checkpointRemoveProject,
  hostErrorMessage,
  isTauriHost,
} from "@bridge/checkpoint";
import { openFolderDialog, projectGitBranches, revealInOS, stat } from "@bridge/commands";
import { writeClipboardText } from "@bridge/clipboard";
import { defaultName, forgetPersistedProject, projectId, readPersistedProjects, type Project } from "@store/projects";
import { normalizeRoot } from "@store/explorer";
import type { Checkpoint } from "@store/checkpoint";
import {
  avatarIndex,
  buildRows,
  filterRows,
  freshWorkspace,
  initials,
  openerOf,
  planOpen,
  suggestedLocation,
  tildify,
  type OpenHow,
  type OpenTarget,
  type Opener,
  type ProjectRow,
} from "./model";
import {
  OPENER_EVENT,
  broadcastEdit,
  closeSelf,
  focusWindow,
  liveLabels,
  sendOpenHere,
  writeRow,
  type ProjectPayload,
} from "./windowBridge";
import { CloneDialog, NewProjectDialog } from "./CreateDialogs";
import "./ProjectsWindow.css";

const PREF_KEY = "spark.projects.openIn";
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

function readPref(): OpenTarget {
  try {
    return localStorage.getItem(PREF_KEY) === "here" ? "here" : "new";
  } catch {
    return "new";
  }
}

function writePref(v: OpenTarget) {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* private mode — the choice lasts for this window */
  }
}

interface Loaded {
  rows: ProjectRow[];
  opener: Opener | null;
}

/** The row as a payload, taking the checkpoint's copy where there is one. */
function payloadFor(row: ProjectRow, cp: Checkpoint): ProjectPayload {
  const rec = cp.projects.find((p) => p.id === row.id);
  const ws = rec?.workspace ?? row.workspace;
  return {
    id: row.id,
    rootPath: row.rootPath,
    name: rec?.name ?? row.name,
    lastOpened: rec?.lastOpened ?? row.lastOpened,
    pinned: rec?.pinned ?? row.pinned,
    // A project never opened past its first moment has no tree root;
    // start it rooted at its folder rather than as an empty window.
    workspace: ws.explorer.root || ws.tabs.length ? ws : freshWorkspace(row.rootPath),
  };
}

export default function ProjectsWindow() {
  const toast = useToast();
  const openerRef = useRef<string | null>(
    (() => {
      try {
        return new URLSearchParams(window.location.search).get("opener");
      } catch {
        return null;
      }
    })(),
  );
  const [data, setData] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const [branches, setBranches] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [home, setHome] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pref, setPref] = useState<OpenTarget>(readPref);
  const [dialog, setDialog] = useState<null | "new" | "clone">(null);
  const seq = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  /* ---------- Loading ---------- */

  const reload = useCallback(async () => {
    const my = ++seq.current;
    let cp: Checkpoint;
    let live: Set<string>;
    let local: Project[];
    try {
      [cp, live, local] = await Promise.all([checkpointLoad(), liveLabels(), readPersistedProjects()]);
    } catch {
      return;
    }
    if (my !== seq.current) return;
    const rows = buildRows(cp, local, live);
    setData({ rows, opener: openerOf(cp, openerRef.current, live) });
    // A folder deleted or unmounted since it was last opened must not
    // look like one that is fine.
    void Promise.all(
      rows.map((r) => stat(r.rootPath).then((st) => (st.isDir ? null : r.id), () => r.id)),
    ).then((ids) => {
      if (my === seq.current) setMissing(new Set(ids.filter((id): id is string => id !== null)));
    });
    void projectGitBranches(rows.map((r) => r.rootPath)).then(
      (list) => {
        if (my === seq.current) setBranches(new Map(rows.map((r, i) => [r.id, list[i] ?? null])));
      },
      () => {},
    );
  }, []);

  useEffect(() => {
    void reload();
    if (isTauriHost) {
      void import("@tauri-apps/api/path")
        .then((m) => m.homeDir())
        .then(setHome, () => {});
    }
    const onFocus = () => void reload();
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  // Another editor window asked for this window: it is "this window" now.
  useEffect(() => {
    if (!isTauriHost) return;
    let off: (() => void) | null = null;
    let disposed = false;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().listen<{ label?: string }>(OPENER_EVENT, (e) => {
          if (typeof e.payload?.label === "string") {
            openerRef.current = e.payload.label;
            void reload();
          }
        }),
      )
      .then((un) => (disposed ? un() : (off = un)), () => {});
    return () => {
      disposed = true;
      off?.();
    };
  }, [reload]);

  useEffect(() => {
    document.title = "Projects — sparkBook";
  }, []);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const matches = useMemo(() => filterRows(rows, query, branches), [rows, query, branches]);
  const pinnedCount = useMemo(() => matches.filter((m) => m.row.pinned).length, [matches]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, matches.length - 1)));
  }, [matches.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  /* ---------- Opening ---------- */

  const openRow = useCallback(
    async (row: ProjectRow, how: OpenHow) => {
      if (busy) return;
      setBusy(row.id);
      try {
        // Decided on fresh state: the list can be a whole focus old.
        const [cp, live, local] = await Promise.all([checkpointLoad(), liveLabels(), readPersistedProjects()]);
        const fresh = buildRows(cp, local, live).find((r) => r.id === row.id) ?? { ...row, openIn: null };
        const opener = openerOf(cp, openerRef.current, live);
        let plan = planOpen(fresh, how, opener, pref);
        if (!isTauriHost && plan.kind === "new") {
          // A browser tab cannot open another editor window.
          if (!opener?.live) throw new Error("Opening a project in a new window needs the desktop app.");
          plan = { kind: "here", label: opener.label, mode: "replace" };
        }

        if (plan.kind === "focus") {
          if (!(await focusWindow(plan.label))) throw new Error("That window has just closed. Try again.");
        } else {
          const ok = await stat(fresh.rootPath).then((st) => st.isDir, () => false);
          if (!ok) {
            setMissing((m) => new Set(m).add(row.id));
            throw new Error(`${fresh.rootPath} no longer exists.`);
          }
          const project = { ...payloadFor(fresh, cp), lastOpened: Date.now() };
          if (!(await writeRow(project))) {
            // Too large for the checkpoint: open it rooted at its folder,
            // which is what a first open would have shown anyway.
            project.workspace = freshWorkspace(fresh.rootPath);
            await writeRow(project);
          }
          if (plan.kind === "here") await sendOpenHere({ target: plan.label, mode: plan.mode, project });
          else await checkpointOpenWindow(project.id);
        }
        await closeSelf();
      } catch (e) {
        toast.error(`Could not open ${row.name}`, hostErrorMessage(e));
        setBusy(null);
        void reload();
      }
    },
    [busy, pref, reload, toast],
  );

  /** Open a folder picked, created or cloned here: an existing project if it is one. */
  const openPath = useCallback(
    async (path: string) => {
      const id = projectId(path);
      const known = rows.find((r) => r.id === id);
      const root = normalizeRoot(path);
      await openRow(
        known ?? {
          id,
          rootPath: root,
          name: defaultName(root),
          lastOpened: 0,
          pinned: false,
          workspace: freshWorkspace(root),
          openIn: null,
        },
        "auto",
      );
    },
    [rows, openRow],
  );

  const pickFolder = useCallback(async () => {
    const path = await openFolderDialog();
    if (path) await openPath(path);
  }, [openPath]);

  /* ---------- Edits ---------- */

  const updateRow = useCallback(
    async (row: ProjectRow, patch: Partial<Pick<ProjectPayload, "name" | "pinned">>) => {
      // Fresh copy: writing a workspace read a focus ago would roll back
      // whatever the project's own window saved since.
      const cp = await checkpointLoad();
      await writeRow({ ...payloadFor(row, cp), ...patch });
    },
    [],
  );

  const togglePin = useCallback(
    async (row: ProjectRow) => {
      try {
        await updateRow(row, { pinned: !row.pinned });
        await broadcastEdit({ kind: "pin", id: row.id, pinned: !row.pinned });
      } catch (e) {
        toast.error(`Could not ${row.pinned ? "unpin" : "pin"} ${row.name}`, hostErrorMessage(e));
      }
      void reload();
    },
    [updateRow, reload, toast],
  );

  const commitRename = useCallback(async () => {
    const row = rows.find((r) => r.id === renaming);
    setRenaming(null);
    searchRef.current?.focus();
    const name = draft.trim();
    if (!row || !name || name === row.name) return;
    try {
      await updateRow(row, { name });
      await broadcastEdit({ kind: "rename", id: row.id, name });
    } catch (e) {
      toast.error(`Could not rename ${row.name}`, hostErrorMessage(e));
    }
    void reload();
  }, [rows, renaming, draft, updateRow, reload, toast]);

  const remove = useCallback(
    async (row: ProjectRow) => {
      if (row.openIn) {
        toast.info(`${row.name} is open`, "Close its window first, then remove it from the list.");
        return;
      }
      try {
        await checkpointRemoveProject(row.id);
        await forgetPersistedProject(row.id);
        await broadcastEdit({ kind: "remove", id: row.id });
        toast.success(`Removed ${row.name} from the list`, "The folder on disk was not touched.");
      } catch (e) {
        toast.error(`Could not remove ${row.name}`, hostErrorMessage(e));
      }
      void reload();
    },
    [reload, toast],
  );

  const startRename = useCallback((row: ProjectRow) => {
    setDraft(row.name);
    setRenaming(row.id);
  }, []);

  /* ---------- Menus ---------- */

  const openerLive = data?.opener?.live === true;

  const entriesFor = useCallback(
    (row: ProjectRow): ContextMenuEntry[] => {
      const gone = missing.has(row.id);
      return [
        { id: "open", label: row.openIn ? "Switch to Window" : "Open", icon: "open", shortcut: "↵", disabled: gone },
        { id: "new", label: "Open in New Window", icon: "app-window", shortcut: "⇧↵", disabled: gone || Boolean(row.openIn) || !isTauriHost },
        { id: "here", label: "Open in This Window", icon: "arrow-right", shortcut: `${MOD}↵`, disabled: gone || Boolean(row.openIn) || !openerLive },
        { separator: true, id: "s1" },
        { id: "pin", label: row.pinned ? "Unpin" : "Pin to Top", icon: row.pinned ? "unpin" : "pin" },
        { id: "rename", label: "Rename…", icon: "pencil", shortcut: "F2" },
        { id: "copy", label: "Copy Path", icon: "copy-path" },
        { id: "reveal", label: "Reveal in File Manager", icon: "external", disabled: gone },
        { separator: true, id: "s2" },
        {
          id: "remove",
          label: row.openIn ? "Remove from List (close it first)" : "Remove from List",
          icon: "trash",
          shortcut: "Del",
          destructive: true,
          disabled: Boolean(row.openIn),
        },
      ];
    },
    [missing, openerLive],
  );

  const onMenu = useCallback(
    (row: ProjectRow, id: string) => {
      switch (id) {
        case "open": return void openRow(row, "auto");
        case "new": return void openRow(row, "new");
        case "here": return void openRow(row, "here");
        case "pin": return void togglePin(row);
        case "rename": return startRename(row);
        case "copy":
          return void writeClipboardText(row.rootPath).then((ok) =>
            ok ? toast.success("Path copied", row.rootPath) : toast.error("Could not copy the path"),
          );
        case "reveal":
          return void revealInOS(row.rootPath).catch((e) => toast.error("Could not open the file manager", hostErrorMessage(e)));
        case "remove": return void remove(row);
      }
    },
    [openRow, togglePin, startRename, remove, toast],
  );

  /* ---------- Keyboard ---------- */

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = matches.length - 1;
    const row = matches[cursor]?.row;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(last, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === "PageDown") { e.preventDefault(); setCursor((c) => Math.min(last, c + 8)); }
    else if (e.key === "PageUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 8)); }
    else if (e.key === "Home" && !query) { e.preventDefault(); setCursor(0); }
    else if (e.key === "End" && !query) { e.preventDefault(); setCursor(Math.max(0, last)); }
    else if (e.key === "Enter" && row) {
      e.preventDefault();
      if (missing.has(row.id)) toast.error("Folder not found", `${row.rootPath} no longer exists. Remove it from the list if it is gone for good.`);
      else void openRow(row, e.shiftKey ? "new" : mod ? "here" : "auto");
    }
    else if (e.key === "F2" && row) { e.preventDefault(); startRename(row); }
    else if (e.key === "Delete" && !query && row) { e.preventDefault(); void remove(row); }
  };

  // Window-wide: Escape clears the search, then closes the window;
  // Ctrl+N / Ctrl+O / Ctrl+F reach the header actions from anywhere.
  // Capture phase, so an open menu is still in the DOM when this looks:
  // the menu's own Escape handler unmounts it before bubbling gets here,
  // and that Escape would otherwise close the window too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || renaming) return;
      if (document.querySelector('[role="menu"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (query) setQuery("");
        else void closeSelf();
      } else if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        setDialog("new");
      } else if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        void pickFolder();
      } else if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog, renaming, query, pickFolder]);

  /* ---------- Render ---------- */

  const location = suggestedLocation(rows, home);
  const openCount = rows.filter((r) => r.openIn).length;

  const renderRow = (row: ProjectRow, nameHits: number[], index: number) => {
    const gone = missing.has(row.id);
    const branch = branches.get(row.id) ?? null;
    const tabs = row.workspace.tabs.length;
    return (
      <ContextMenuRoot key={row.id}>
        <ContextMenuTrigger asChild>
          <li
            data-index={index}
            role="option"
            aria-selected={index === cursor}
            className={[
              "pw-row",
              index === cursor && "is-cursor",
              gone && "is-missing",
              row.openIn && "is-open",
              busy === row.id && "is-busy",
            ].filter(Boolean).join(" ")}
            onMouseMove={() => setCursor(index)}
            onDoubleClick={() => !gone && renaming !== row.id && void openRow(row, "auto")}
          >
            <button
              type="button"
              className="pw-row__main"
              tabIndex={-1}
              disabled={gone || renaming === row.id}
              onClick={(e) => void openRow(row, e.shiftKey ? "new" : e.metaKey || e.ctrlKey ? "here" : "auto")}
              title={gone ? `${row.rootPath} no longer exists` : row.openIn ? "Switch to its window" : `Open ${row.name}`}
            >
              <span className={`pw-avatar pw-avatar--c${avatarIndex(row.id)}`} aria-hidden>
                {initials(row.name)}
              </span>
              <span className="pw-row__text">
                <span className="pw-row__line">
                  {renaming === row.id ? (
                    <Input
                      ref={renameRef}
                      className="pw-row__rename"
                      value={draft}
                      inputSize="sm"
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                        if (e.key === "Escape") { e.preventDefault(); setRenaming(null); searchRef.current?.focus(); }
                      }}
                      aria-label={`Rename ${row.name}`}
                    />
                  ) : (
                    <span className="pw-row__name">
                      {highlightRuns(row.name, nameHits).map((r, i) =>
                        r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>,
                      )}
                    </span>
                  )}
                  {branch && (
                    <span className="pw-chip pw-chip--branch" title={`On ${branch}`}>
                      <Icon name="git-branch" size={11} />
                      {branch}
                    </span>
                  )}
                  {row.openIn && <span className="pw-chip pw-chip--open">Open</span>}
                  {gone && <span className="pw-chip pw-chip--missing">Folder not found</span>}
                </span>
                <span className="pw-row__sub">
                  <span className="pw-row__path" title={row.rootPath}><bdi>{tildify(row.rootPath, home)}</bdi></span>
                  {tabs > 0 && <span className="pw-row__tabs">· {tabs} tab{tabs === 1 ? "" : "s"}</span>}
                </span>
              </span>
              <span className="pw-row__when">{busy === row.id ? "Opening…" : relativeTime(row.lastOpened)}</span>
            </button>
            <span className="pw-row__actions">
              {gone ? (
                <Button variant="ghost" size="sm" icon="trash" onClick={() => void remove(row)}>
                  Remove
                </Button>
              ) : (
                <>
                  <Button
                    variant="icon"
                    size="sm"
                    aria-label={`${row.pinned ? "Unpin" : "Pin"} ${row.name}`}
                    aria-pressed={row.pinned}
                    title={row.pinned ? "Unpin" : "Pin to top"}
                    onClick={() => void togglePin(row)}
                  >
                    <Icon name={row.pinned ? "unpin" : "pin"} size={14} />
                  </Button>
                  {isTauriHost && !row.openIn && (
                    <Button
                      variant="icon"
                      size="sm"
                      aria-label={`Open ${row.name} in a new window`}
                      title="Open in new window (Shift+Enter)"
                      onClick={() => void openRow(row, "new")}
                    >
                      <Icon name="app-window" size={14} />
                    </Button>
                  )}
                </>
              )}
              <DropdownRoot>
                <DropdownTrigger asChild>
                  <Button variant="icon" size="sm" aria-label={`More actions for ${row.name}`} title="More actions">
                    <Icon name="more" size={14} />
                  </Button>
                </DropdownTrigger>
                <DropdownContent align="end" entries={entriesFor(row)} onSelect={(id) => onMenu(row, id)} />
              </DropdownRoot>
            </span>
          </li>
        </ContextMenuTrigger>
        <ContextMenuSurface entries={entriesFor(row)} onSelect={(id) => onMenu(row, id)} />
      </ContextMenuRoot>
    );
  };

  let body: React.ReactNode;
  if (!data) {
    body = <p className="pw-empty" aria-live="polite">Loading projects…</p>;
  } else if (rows.length === 0) {
    body = (
      <div className="pw-empty pw-empty--first">
        <Icon name="projects" size={40} />
        <h2>No projects yet</h2>
        <p>Create a project, open a folder, or clone a repository. sparkBook remembers each one with its tabs, tree and terminals.</p>
        <div className="pw-empty__actions">
          <Button variant="primary" icon="folder-plus" onClick={() => setDialog("new")}>New Project</Button>
          <Button icon="open" onClick={() => void pickFolder()}>Open…</Button>
          {isTauriHost && <Button icon="clone" onClick={() => setDialog("clone")}>Clone…</Button>}
        </div>
      </div>
    );
  } else if (matches.length === 0) {
    body = <p className="pw-empty">No project matches “{query.trim()}”.</p>;
  } else {
    body = (
      <ul className="pw-list" role="listbox" aria-label="Projects" ref={listRef}>
        {pinnedCount > 0 && !query.trim() && <li className="pw-group" role="presentation">Pinned</li>}
        {matches.map((m, i) => (
          <FragmentWithHeader
            key={m.row.id}
            header={!query.trim() && pinnedCount > 0 && i === pinnedCount ? "Recent" : null}
          >
            {renderRow(m.row, m.nameHits, i)}
          </FragmentWithHeader>
        ))}
      </ul>
    );
  }

  return (
    <div className="pw">
      <header className="pw-head">
        <div className="pw-head__brand">
          <img src="/spark-mark.svg" alt="" width={22} height={22} />
          <h1>Projects</h1>
          {rows.length > 0 && (
            <span className="pw-head__count">
              {rows.length}
              {openCount > 0 && ` · ${openCount} open`}
            </span>
          )}
        </div>
        <div className="pw-head__actions">
          <Button variant="primary" icon="folder-plus" onClick={() => setDialog("new")} title={`New project (${MOD}+N)`}>
            New Project
          </Button>
          <Button icon="open" onClick={() => void pickFolder()} title={`Open a folder (${MOD}+O)`}>
            Open…
          </Button>
          {isTauriHost && (
            <Button icon="clone" onClick={() => setDialog("clone")} title="Clone a Git repository">
              Clone…
            </Button>
          )}
        </div>
      </header>

      {rows.length > 0 && (
        <div className="pw-search">
          <Input
            ref={searchRef}
            leadingIcon="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search by name, path or branch"
            aria-label="Search projects"
            aria-controls="pw-list"
            autoFocus
            spellCheck={false}
          />
        </div>
      )}

      <main className="pw-body" id="pw-list">{body}</main>

      <footer className="pw-foot">
        <span className="pw-foot__keys">
          <span><kbd>↵</kbd> open</span>
          {isTauriHost && <span><kbd>⇧↵</kbd> new window</span>}
          <span><kbd>{MOD}↵</kbd> this window</span>
          <span><kbd>F2</kbd> rename</span>
          <span><kbd>Esc</kbd> close</span>
        </span>
        {isTauriHost && (
          <span className="pw-foot__pref" role="radiogroup" aria-label="Open projects in">
            <span className="pw-foot__prefLabel">Open in</span>
            {(["new", "here"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={pref === v}
                className={`pw-seg ${pref === v ? "is-on" : ""}`}
                onClick={() => {
                  setPref(v);
                  writePref(v);
                }}
                title={v === "new"
                  ? "Each project gets its own window (an empty window is reused)"
                  : "Replace the project in the window this was opened from"}
              >
                {v === "new" ? "New window" : "This window"}
              </button>
            ))}
          </span>
        )}
      </footer>

      <NewProjectDialog
        open={dialog === "new"}
        onOpenChange={(o) => setDialog(o ? "new" : null)}
        defaultLocation={location}
        onCreated={(path) => void openPath(path)}
      />
      <CloneDialog
        open={dialog === "clone"}
        onOpenChange={(o) => setDialog(o ? "clone" : null)}
        defaultLocation={location}
        onCloned={(path) => void openPath(path)}
      />
    </div>
  );
}

function FragmentWithHeader({ header, children }: { header: string | null; children: React.ReactNode }) {
  return (
    <>
      {header && <li className="pw-group" role="presentation">{header}</li>}
      {children}
    </>
  );
}
