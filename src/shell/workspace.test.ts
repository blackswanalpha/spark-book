/* Capture -> restore round-trip.
   No bridge mock, on purpose: outside Tauri @bridge/commands routes
   every call to its in-memory MEMORY_FS, the same approach
   store/explorer.test.ts takes. That fallback is what makes readFile
   resolve for "/welcome.md" and reject for a path that is not there. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  captureWorkspace,
  restoreWorkspace,
  registerLayoutBridge,
  markHydrated,
  isRestoring,
  flushWorkspace,
  startWorkspaceAutosave,
  __resetWorkspaceGuards,
} from "./workspace";
import { useDocs } from "@store/documents";
import { useExplorer } from "@store/explorer";
import { useTerminal } from "@store/terminal";
import { useProjects, coerce, EMPTY_WORKSPACE, SCHEMA_VERSION } from "@store/projects";
import { DEFAULT_PANEL } from "@store/terminal";

function resetStores() {
  useDocs.setState({ docs: {}, order: [], active: null, history: {} });
  useExplorer.setState({
    root: null,
    explicitRoot: false,
    expanded: new Set<string>(),
    children: new Map(),
    loading: new Set<string>(),
    errors: new Map(),
    selectedPath: null,
    showHidden: false,
    history: [],
    historyIndex: -1,
    clipboard: null,
  });
  useTerminal.setState({
    isOpen: false,
    sessions: [],
    activeId: null,
    nextOrdinal: 1,
    mobile: false,
    panel: { ...DEFAULT_PANEL },
    panelPlaced: false,
    restoredOpen: false,
    statuses: {},
  });
  useProjects.setState({ version: SCHEMA_VERSION, activeId: null, projects: [], hydrated: false });
}

beforeEach(() => {
  localStorage.clear();
  __resetWorkspaceGuards();
  registerLayoutBridge(null);
  resetStores();
});

describe("captureWorkspace", () => {
  it("keeps saved documents in tab order and drops untitled buffers", () => {
    const d = useDocs.getState();
    d.open({ name: "a.ts", path: "/a.ts", mode: "code", raw: "a" });
    d.open({ name: "Untitled", mode: "markdown", raw: "" });
    d.open({ name: "b.md", path: "/b.md", mode: "markdown", raw: "b" });

    const ws = captureWorkspace();
    expect(ws.tabs.map((t) => t.path)).toEqual(["/a.ts", "/b.md"]);
  });

  it("points activeIndex at the active document's position in the filtered list", () => {
    const d = useDocs.getState();
    d.open({ name: "a.ts", path: "/a.ts", mode: "code", raw: "a" });
    const bId = d.open({ name: "b.md", path: "/b.md", mode: "markdown", raw: "b" });
    useDocs.getState().setActive(bId);
    expect(captureWorkspace().activeIndex).toBe(1);
  });

  it("falls back to the first tab when the active document is untitled", () => {
    const d = useDocs.getState();
    d.open({ name: "a.ts", path: "/a.ts", mode: "code", raw: "a" });
    d.open({ name: "Untitled", mode: "markdown", raw: "" });
    expect(captureWorkspace().activeIndex).toBe(0);
  });

  it("captures cursor and scroll per tab", () => {
    const id = useDocs.getState().open({ name: "a.ts", path: "/a.ts", mode: "code", raw: "a" });
    useDocs.getState().setCursor(id, { line: 42, col: 7 });
    useDocs.getState().setScroll(id, 640);
    const [tab] = captureWorkspace().tabs;
    expect(tab.cursor).toEqual({ line: 42, col: 7 });
    expect(tab.scrollTop).toBe(640);
  });

  it("captures the explorer tree state", () => {
    useExplorer.setState({
      root: "/proj",
      expanded: new Set(["/proj", "/proj/src"]),
      showHidden: true,
      selectedPath: "/proj/src/a.ts",
    });
    const ws = captureWorkspace();
    expect(ws.explorer.root).toBe("/proj");
    expect(ws.explorer.expanded.sort()).toEqual(["/proj", "/proj/src"]);
    expect(ws.explorer.showHidden).toBe(true);
    expect(ws.explorer.selectedPath).toBe("/proj/src/a.ts");
  });

  it("captures terminal tabs with their cwd and privilege", () => {
    const t = useTerminal.getState();
    t.restoreTabs(
      [
        { cwd: "/one", privilege: "user", label: "Terminal 1" },
        { cwd: "/two", privilege: "root", label: "Terminal 2" },
      ],
      1,
      3,
      true,
    );
    const ws = captureWorkspace();
    expect(ws.terminal.tabs.map((s) => s.cwd)).toEqual(["/one", "/two"]);
    expect(ws.terminal.tabs[1].privilege).toBe("root");
    expect(ws.terminal.activeIndex).toBe(1);
    expect(ws.terminal.isOpen).toBe(true);
  });

  it("reads layout through the registered bridge and defaults without one", () => {
    expect(captureWorkspace().layout).toEqual(EMPTY_WORKSPACE.layout);
    registerLayoutBridge({
      getWidth: () => 410,
      getCollapsed: () => true,
      getShowStatus: () => false,
      setWidth: () => {},
      setCollapsed: () => {},
      setShowStatus: () => {},
    });
    expect(captureWorkspace().layout).toEqual({
      sidebarWidth: 410,
      sidebarCollapsed: true,
      showStatus: false,
    });
  });
});

describe("captureWorkspace — terminals", () => {
  it("saves where each shell is now, and its name, so a relaunch lands there", () => {
    useTerminal.getState().restoreTabs(
      [
        { cwd: "/proj", privilege: "user", label: "Terminal 1" },
        { cwd: "/proj", privilege: "user", label: "Terminal 2" },
      ],
      0,
      3,
      true,
    );
    const [a, b] = useTerminal.getState().sessions;
    useTerminal.getState().setSessionCwd(a.id, "/proj/src/deep");
    useTerminal.getState().renameSession(b.id, "server");
    const tabs = captureWorkspace().terminal.tabs;
    expect(tabs[0]).toEqual({ cwd: "/proj/src/deep", privilege: "user", label: "Terminal 1" });
    expect(tabs[1]).toEqual({ cwd: "/proj", privilege: "user", label: "Terminal 2", name: "server" });
  });
});

describe("restoreWorkspace", () => {
  it("reopens tabs in order and focuses the saved one", async () => {
    const result = await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [
        { path: "/welcome.md", mode: "markdown", cursor: { line: 1, col: 1 }, scrollTop: 0 },
        { path: "/notes.md", mode: "markdown", cursor: { line: 3, col: 2 }, scrollTop: 120 },
      ],
      activeIndex: 1,
    });

    expect(result.opened).toBe(2);
    expect(result.missing).toEqual([]);
    const d = useDocs.getState();
    expect(d.order.map((id) => d.docs[id].path)).toEqual(["/welcome.md", "/notes.md"]);
    // open() focuses each doc as it lands, so this asserts the explicit
    // setActive at the end rather than "whatever opened last".
    expect(d.docs[d.active!].path).toBe("/notes.md");
  });

  it("restores cursor and scroll onto the reopened tab", async () => {
    await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [{ path: "/notes.md", mode: "markdown", cursor: { line: 9, col: 4 }, scrollTop: 250 }],
      activeIndex: 0,
    });
    const d = useDocs.getState();
    const doc = d.docs[d.order[0]];
    expect(doc.cursor).toEqual({ line: 9, col: 4 });
    expect(doc.scrollTop).toBe(250);
  });

  it("reports a file that no longer exists instead of throwing", async () => {
    const result = await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [
        { path: "/welcome.md", mode: "markdown", cursor: { line: 1, col: 1 }, scrollTop: 0 },
        { path: "/deleted-by-someone.md", mode: "code", cursor: { line: 1, col: 1 }, scrollTop: 0 },
      ],
      activeIndex: 0,
    });
    expect(result.opened).toBe(1);
    expect(result.missing).toEqual(["/deleted-by-someone.md"]);
    expect(useDocs.getState().order).toHaveLength(1);
  });

  it("clamps the active tab when the saved one was the missing file", async () => {
    const result = await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [
        { path: "/welcome.md", mode: "markdown", cursor: { line: 1, col: 1 }, scrollTop: 0 },
        { path: "/gone.md", mode: "code", cursor: { line: 1, col: 1 }, scrollTop: 0 },
      ],
      activeIndex: 1,
    });
    expect(result.opened).toBe(1);
    const d = useDocs.getState();
    expect(d.docs[d.active!].path).toBe("/welcome.md");
  });

  it("sets the explorer root before any tab opens", async () => {
    const events: string[] = [];
    const offDocs = useDocs.subscribe(() => events.push("doc"));
    const offTree = useExplorer.subscribe((s, prev) => {
      if (s.root !== prev.root) events.push("root");
    });
    await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [{ path: "/welcome.md", mode: "markdown", cursor: { line: 1, col: 1 }, scrollTop: 0 }],
      activeIndex: 0,
      explorer: { root: "/", expanded: ["/docs"], showHidden: false, selectedPath: null },
    });
    offDocs();
    offTree();
    expect(events.indexOf("root")).toBeLessThan(events.indexOf("doc"));
  });

  it("replays expanded directories after the root reset clears them", async () => {
    await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      explorer: { root: "/", expanded: ["/docs"], showHidden: false, selectedPath: null },
    });
    const e = useExplorer.getState();
    expect(e.root).toBe("/");
    expect(e.expanded.has("/docs")).toBe(true);
  });

  it("restores showHidden and the tree selection", async () => {
    await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      explorer: { root: "/", expanded: [], showHidden: true, selectedPath: "/welcome.md" },
    });
    const e = useExplorer.getState();
    expect(e.showHidden).toBe(true);
    expect(e.selectedPath).toBe("/welcome.md");
  });

  it("restores the terminal panel rect even though shells need Tauri", async () => {
    await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      terminal: { ...EMPTY_WORKSPACE.terminal, panel: { x: 40, y: 60, w: 900, h: 500 }, mobile: true },
    });
    const t = useTerminal.getState();
    expect(t.panel).toEqual({ x: 40, y: 60, w: 900, h: 500 });
    expect(t.mobile).toBe(true);
    // No PTY outside Tauri, so tabs are deliberately not recreated.
    expect(t.sessions).toEqual([]);
  });

  it("drops the previous project's shells when the incoming snapshot has none", async () => {
    /* Switching projects closes every document tab but used to leave the
       terminal sessions in place, and the next autosave wrote the old
       project's shells into the new project's workspace. */
    const t = useTerminal.getState();
    t.open();
    t.addSession("/old-project");
    t.addSession("/old-project/src");
    expect(useTerminal.getState().sessions).toHaveLength(2);

    await restoreWorkspace({ ...EMPTY_WORKSPACE });

    expect(useTerminal.getState().sessions).toEqual([]);
    expect(useTerminal.getState().isOpen).toBe(false);
    expect(captureWorkspace().terminal.tabs).toEqual([]);
  });

  it("pushes layout back through the bridge", async () => {
    const calls: Record<string, unknown> = {};
    registerLayoutBridge({
      getWidth: () => 260,
      getCollapsed: () => false,
      getShowStatus: () => true,
      setWidth: (px) => { calls.width = px; },
      setCollapsed: (v) => { calls.collapsed = v; },
      setShowStatus: (v) => { calls.status = v; },
    });
    await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      layout: { sidebarWidth: 333, sidebarCollapsed: true, showStatus: false },
    });
    expect(calls).toEqual({ width: 333, collapsed: true, status: false });
  });

  it("clears the restoring flag when a step throws", async () => {
    expect(isRestoring()).toBe(false);
    await restoreWorkspace({ ...EMPTY_WORKSPACE, explorer: { ...EMPTY_WORKSPACE.explorer, root: "/nope" } });
    expect(isRestoring()).toBe(false);
  });
});

describe("autosave guards", () => {
  it("does not write before hydration", () => {
    useProjects.getState().openProject("/proj");
    const spy = vi.spyOn(useProjects.getState(), "saveWorkspace");
    flushWorkspace();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("writes the live stores into the active project once hydrated", () => {
    useProjects.getState().openProject("/proj");
    markHydrated();
    useDocs.getState().open({ name: "a.ts", path: "/proj/a.ts", mode: "code", raw: "a" });
    flushWorkspace();
    expect(useProjects.getState().get("/proj")!.workspace.tabs.map((t) => t.path)).toEqual([
      "/proj/a.ts",
    ]);
  });

  it("does not write while a restore is in flight", async () => {
    useProjects.getState().openProject("/proj");
    markHydrated();
    const teardown = startWorkspaceAutosave();
    // A restore both mutates the stores and must leave the stored
    // snapshot alone until it finishes.
    await restoreWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [{ path: "/welcome.md", mode: "markdown", cursor: { line: 1, col: 1 }, scrollTop: 0 }],
      activeIndex: 0,
    });
    expect(useProjects.getState().get("/proj")!.workspace.tabs).toEqual([]);
    teardown();
  });

  it("is a no-op with no active project", () => {
    markHydrated();
    useDocs.getState().open({ name: "a.ts", path: "/a.ts", mode: "code", raw: "a" });
    expect(() => flushWorkspace()).not.toThrow();
    expect(useProjects.getState().projects).toEqual([]);
  });
});

describe("quit and relaunch", () => {
  it("brings back tabs, tree, layout and the active tab from the persisted cache alone", async () => {
    /* --- first run --- */
    useProjects.getState().openProject("/");
    markHydrated();
    registerLayoutBridge({
      getWidth: () => 402,
      getCollapsed: () => false,
      getShowStatus: () => false,
      setWidth: () => {},
      setCollapsed: () => {},
      setShowStatus: () => {},
    });

    await useExplorer.getState().setRoot("/");
    await useExplorer.getState().setExpanded("/docs", true);

    const d = useDocs.getState();
    d.open({ name: "welcome.md", path: "/welcome.md", mode: "markdown", raw: "w" });
    const notesId = d.open({ name: "notes.md", path: "/notes.md", mode: "markdown", raw: "n" });
    useDocs.getState().setActive(notesId);
    useDocs.getState().setCursor(notesId, { line: 5, col: 2 });
    useDocs.getState().setScroll(notesId, 900);

    flushWorkspace();

    /* --- quit: everything in memory goes, only localStorage survives --- */
    const persisted = localStorage.getItem("spark.projects");
    expect(persisted).toBeTruthy();
    __resetWorkspaceGuards();
    registerLayoutBridge(null);
    resetStores();
    expect(useDocs.getState().order).toEqual([]);

    /* --- relaunch: seed the store the way readLocal() does on boot --- */
    const cache = coerce(JSON.parse(persisted!));
    useProjects.setState({ version: cache.version, activeId: cache.activeId, projects: cache.projects });

    const project = useProjects.getState().active();
    expect(project).not.toBeNull();
    expect(project!.name).toBe("/");

    const layoutSeen: Record<string, unknown> = {};
    registerLayoutBridge({
      getWidth: () => 260,
      getCollapsed: () => false,
      getShowStatus: () => true,
      setWidth: (px) => { layoutSeen.width = px; },
      setCollapsed: (v) => { layoutSeen.collapsed = v; },
      setShowStatus: (v) => { layoutSeen.status = v; },
    });

    const result = await restoreWorkspace(project!.workspace);

    expect(result.opened).toBe(2);
    const after = useDocs.getState();
    expect(after.order.map((id) => after.docs[id].path)).toEqual(["/welcome.md", "/notes.md"]);
    expect(after.docs[after.active!].path).toBe("/notes.md");
    expect(after.docs[after.active!].cursor).toEqual({ line: 5, col: 2 });
    expect(after.docs[after.active!].scrollTop).toBe(900);
    expect(useExplorer.getState().root).toBe("/");
    expect(useExplorer.getState().expanded.has("/docs")).toBe(true);
    expect(layoutSeen).toEqual({ width: 402, collapsed: false, status: false });
  });

  it("keeps two projects' workspaces apart", async () => {
    markHydrated();

    useProjects.getState().openProject("/docs");
    useDocs.getState().open({ name: "README.md", path: "/docs/README.md", mode: "markdown", raw: "r" });
    flushWorkspace();

    // Switching projects is: flush, clear, open the next, restore its own.
    for (const id of [...useDocs.getState().order]) useDocs.getState().close(id);
    useProjects.getState().openProject("/");
    useDocs.getState().open({ name: "notes.md", path: "/notes.md", mode: "markdown", raw: "n" });
    flushWorkspace();

    expect(useProjects.getState().get("/docs")!.workspace.tabs.map((t) => t.path)).toEqual([
      "/docs/README.md",
    ]);
    expect(useProjects.getState().get("/")!.workspace.tabs.map((t) => t.path)).toEqual(["/notes.md"]);

    // Going back restores the first project's tabs, not the second's.
    for (const id of [...useDocs.getState().order]) useDocs.getState().close(id);
    await restoreWorkspace(useProjects.getState().get("/docs")!.workspace);
    const d = useDocs.getState();
    expect(d.order.map((id) => d.docs[id].path)).toEqual(["/docs/README.md"]);
  });
});

describe("restoreWorkspace — one tab per file", () => {
  it("drops duplicate paths from an old snapshot and keeps the active one in front", async () => {
    const tab = (path: string) => ({ path, mode: "code" as const, cursor: { line: 1, col: 1 }, scrollTop: 0 });
    const ws = {
      ...EMPTY_WORKSPACE,
      tabs: [tab("/hello.ts"), tab("/hello.ts"), tab("/notes.md"), tab("/hello.ts")],
      activeIndex: 3,
    };
    const res = await restoreWorkspace(ws);
    const d = useDocs.getState();
    expect(res.opened).toBe(2);
    expect(d.order.map((id) => d.docs[id].path)).toEqual(["/hello.ts", "/notes.md"]);
    expect(d.docs[d.active as string].path).toBe("/hello.ts");
  });
});
