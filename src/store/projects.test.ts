/* Projects cache: coercion hardening and cache mutations.
   No bridge mock — projects.ts imports only normalizeRoot, and
   LazyStore is never constructed under jsdom (no __TAURI_INTERNALS__). */
import { describe, it, expect, beforeEach } from "vitest";
import {
  coerce,
  coerceWorkspace,
  projectId,
  defaultName,
  useProjects,
  EMPTY_WORKSPACE,
  LOOSE_ID,
  MAX_PROJECTS,
  MAX_RESTORE_TABS,
  MAX_EXPANDED,
  SCHEMA_VERSION,
  byPinThenRecency,
  type ProjectsCache,
} from "./projects";

const STORE_KEY = "spark.projects";

function makeProject(id: string, lastOpened = 0) {
  return {
    id,
    rootPath: id,
    name: id.split("/").pop() || id,
    lastOpened,
    workspace: EMPTY_WORKSPACE,
  };
}

function cacheOf(projects: unknown[], activeId: string | null = null) {
  return { version: SCHEMA_VERSION, activeId, projects };
}

beforeEach(() => {
  localStorage.clear();
  useProjects.setState({ version: SCHEMA_VERSION, activeId: null, projects: [], hydrated: false });
});

describe("coerce — untrusted input", () => {
  it("returns an empty cache for null, a non-object, and an empty object", () => {
    for (const raw of [null, undefined, 42, "nope", {}]) {
      expect(coerce(raw)).toEqual({ version: 1, activeId: null, projects: [] });
    }
  });

  it("discards the whole cache on a version mismatch", () => {
    const raw = cacheOf([makeProject("/a")], "/a");
    raw.version = 99 as never;
    expect(coerce(raw).projects).toHaveLength(0);
  });

  it("drops a project with no id and one with no rootPath", () => {
    const out = coerce(cacheOf([
      { rootPath: "/a", name: "a", workspace: {} },
      { id: "/b", name: "b", workspace: {} },
      makeProject("/c"),
    ]));
    expect(out.projects.map((p) => p.id)).toEqual(["/c"]);
  });

  it("keeps the loose bucket even though it has no rootPath", () => {
    const out = coerce(cacheOf([{ id: LOOSE_ID, name: "No folder", workspace: {} }]));
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].rootPath).toBeNull();
  });

  it("de-duplicates by id and sorts most-recent-first", () => {
    const out = coerce(cacheOf([
      makeProject("/a", 100),
      makeProject("/b", 300),
      makeProject("/a", 999),
      makeProject("/c", 200),
    ]));
    expect(out.projects.map((p) => p.id)).toEqual(["/b", "/c", "/a"]);
  });

  it("caps the project list", () => {
    const many = Array.from({ length: MAX_PROJECTS + 12 }, (_, i) => makeProject(`/p${i}`, i));
    expect(coerce(cacheOf(many)).projects).toHaveLength(MAX_PROJECTS);
  });

  it("nulls an activeId that names no surviving project", () => {
    expect(coerce(cacheOf([makeProject("/a")], "/gone")).activeId).toBeNull();
    expect(coerce(cacheOf([makeProject("/a")], "/a")).activeId).toBe("/a");
  });
});

describe("coerceWorkspace", () => {
  it("drops a tab with no path — that is how untitled buffers stay out", () => {
    const ws = coerceWorkspace({ tabs: [{ mode: "code" }, { path: "/a.ts", mode: "code" }] });
    expect(ws.tabs.map((t) => t.path)).toEqual(["/a.ts"]);
  });

  it("falls back to code for an unknown mode", () => {
    expect(coerceWorkspace({ tabs: [{ path: "/a", mode: "hologram" }] }).tabs[0].mode).toBe("code");
  });

  it("clamps a cursor at or below zero to line 1 col 1", () => {
    const ws = coerceWorkspace({ tabs: [{ path: "/a", cursor: { line: 0, col: -5 } }] });
    expect(ws.tabs[0].cursor).toEqual({ line: 1, col: 1 });
  });

  it("clamps a negative or non-numeric scrollTop to 0", () => {
    const ws = coerceWorkspace({
      tabs: [{ path: "/a", scrollTop: -20 }, { path: "/b", scrollTop: "high" }],
    });
    expect(ws.tabs.map((t) => t.scrollTop)).toEqual([0, 0]);
  });

  it("caps tabs and expanded directories", () => {
    const ws = coerceWorkspace({
      tabs: Array.from({ length: MAX_RESTORE_TABS + 9 }, (_, i) => ({ path: `/f${i}` })),
      explorer: { expanded: Array.from({ length: MAX_EXPANDED + 40 }, (_, i) => `/d${i}`) },
    });
    expect(ws.tabs).toHaveLength(MAX_RESTORE_TABS);
    expect(ws.explorer.expanded).toHaveLength(MAX_EXPANDED);
  });

  it("pulls an out-of-range activeIndex back into the tab list", () => {
    expect(coerceWorkspace({ tabs: [{ path: "/a" }], activeIndex: 7 }).activeIndex).toBe(0);
    expect(coerceWorkspace({ tabs: [], activeIndex: 3 }).activeIndex).toBe(-1);
  });

  it("keeps nextOrdinal past the restored tab count so labels cannot collide", () => {
    const ws = coerceWorkspace({
      terminal: { tabs: [{ cwd: "/a" }, { cwd: "/b" }, { cwd: "/c" }], nextOrdinal: 1 },
    });
    expect(ws.terminal.nextOrdinal).toBe(4);
  });

  it("drops a terminal tab with no cwd and defaults a bogus privilege to user", () => {
    const ws = coerceWorkspace({ terminal: { tabs: [{ privilege: "root" }, { cwd: "/x", privilege: "wizard" }] } });
    expect(ws.terminal.tabs).toEqual([{ cwd: "/x", privilege: "user", label: "Terminal 1" }]);
  });

  it("refuses to report the terminal open with no tabs to show", () => {
    expect(coerceWorkspace({ terminal: { tabs: [], isOpen: true } }).terminal.isOpen).toBe(false);
  });
});

describe("identity", () => {
  it("normalizes away trailing slashes, file:// and backslashes", () => {
    expect(projectId("/a/b/")).toBe("/a/b");
    expect(projectId("file:///a/b")).toBe("/a/b");
    expect(projectId("\\a\\b")).toBe("/a/b");
  });

  it("maps a null root to the loose bucket", () => {
    expect(projectId(null)).toBe(LOOSE_ID);
    expect(defaultName(null)).toBe("No folder");
  });

  it("names a project after its folder", () => {
    expect(defaultName("/home/me/spark/")).toBe("spark");
  });
});

describe("store mutations", () => {
  it("openProject de-duplicates by normalized path and moves it to the front", () => {
    const s = useProjects.getState();
    s.openProject("/a");
    s.openProject("/b");
    s.openProject("/a/");
    const after = useProjects.getState();
    expect(after.projects.map((p) => p.id)).toEqual(["/a", "/b"]);
    expect(after.activeId).toBe("/a");
  });

  it("saveWorkspace writes onto the active project only", () => {
    const s = useProjects.getState();
    s.openProject("/a");
    s.openProject("/b");
    useProjects.getState().saveWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [{ path: "/b/x.ts", mode: "code", cursor: { line: 2, col: 3 }, scrollTop: 40 }],
      activeIndex: 0,
    });
    const after = useProjects.getState();
    expect(after.get("/b")!.workspace.tabs).toHaveLength(1);
    expect(after.get("/a")!.workspace.tabs).toHaveLength(0);
  });

  it("saveWorkspace is a no-op with no active project", () => {
    useProjects.getState().openProject("/a");
    useProjects.getState().clearActive();
    useProjects.getState().saveWorkspace({ ...EMPTY_WORKSPACE, tabs: [{ path: "/x", mode: "code", cursor: { line: 1, col: 1 }, scrollTop: 0 }] });
    expect(useProjects.getState().get("/a")!.workspace.tabs).toHaveLength(0);
  });

  it("ignores a blank rename and keeps a trimmed one", () => {
    useProjects.getState().openProject("/a");
    useProjects.getState().renameProject("/a", "   ");
    expect(useProjects.getState().get("/a")!.name).toBe("a");
    useProjects.getState().renameProject("/a", "  Spark  ");
    expect(useProjects.getState().get("/a")!.name).toBe("Spark");
  });

  it("removeProject clears activeId when it removed the active one", () => {
    useProjects.getState().openProject("/a");
    useProjects.getState().removeProject("/a");
    const after = useProjects.getState();
    expect(after.projects).toHaveLength(0);
    expect(after.activeId).toBeNull();
  });
});

describe("localStorage mirror", () => {
  it("writes the cache under spark.projects on every mutation", () => {
    useProjects.getState().openProject("/a");
    const raw = JSON.parse(localStorage.getItem(STORE_KEY)!) as ProjectsCache;
    expect(raw.version).toBe(SCHEMA_VERSION);
    expect(raw.activeId).toBe("/a");
    expect(raw.projects[0].name).toBe("a");
  });

  it("survives a malformed mirror rather than throwing", () => {
    localStorage.setItem(STORE_KEY, "{not json");
    expect(() => coerce(JSON.parse("null"))).not.toThrow();
    expect(coerce(null).projects).toEqual([]);
  });

  it("round-trips a saved workspace through JSON unchanged", () => {
    useProjects.getState().openProject("/a");
    const ws = {
      ...EMPTY_WORKSPACE,
      tabs: [{ path: "/a/x.ts", mode: "code" as const, cursor: { line: 12, col: 4 }, scrollTop: 320 }],
      activeIndex: 0,
      explorer: { root: "/a", expanded: ["/a/src"], showHidden: true, selectedPath: "/a/x.ts" },
    };
    useProjects.getState().saveWorkspace(ws);
    const raw = JSON.parse(localStorage.getItem(STORE_KEY)!);
    expect(coerce(raw).projects[0].workspace).toEqual(coerceWorkspace(ws));
  });
});

describe("pinning", () => {
  it("lists pinned projects first and keeps the pin through coercion", () => {
    const c = coerce(cacheOf([makeProject("/new", 30), { ...makeProject("/old", 10), pinned: true }, makeProject("/mid", 20)]));
    expect(c.projects.map((p) => p.id)).toEqual(["/old", "/new", "/mid"]);
    expect(c.projects[0].pinned).toBe(true);
    expect("pinned" in c.projects[1]).toBe(false);
  });

  it("never evicts a pinned project for age", () => {
    const many = Array.from({ length: MAX_PROJECTS + 5 }, (_, i) => makeProject(`/p${i}`, 100 + i));
    const c = coerce(cacheOf([...many, { ...makeProject("/ancient", 1), pinned: true }]));
    expect(c.projects).toHaveLength(MAX_PROJECTS);
    expect(c.projects[0].id).toBe("/ancient");
  });

  it("toggles a pin and re-sorts", () => {
    useProjects.setState({ projects: [makeProject("/a", 20), makeProject("/b", 10)] });
    const pinned = useProjects.getState().togglePin("/b");
    expect(pinned?.pinned).toBe(true);
    expect(useProjects.getState().projects.map((p) => p.id)).toEqual(["/b", "/a"]);
    const unpinned = useProjects.getState().togglePin("/b");
    expect(unpinned?.pinned).toBeUndefined();
    expect(useProjects.getState().projects.map((p) => p.id)).toEqual(["/a", "/b"]);
    expect(useProjects.getState().togglePin("/missing")).toBeNull();
  });

  it("orders by pin, then recency", () => {
    const list = [makeProject("/x", 5), { ...makeProject("/y", 1), pinned: true }, makeProject("/z", 9)];
    expect([...list].sort(byPinThenRecency).map((p) => p.id)).toEqual(["/y", "/z", "/x"]);
  });
});

describe("terminal tab names", () => {
  it("keeps a tab's name through coercion and drops a blank one", () => {
    const ws = coerceWorkspace({
      terminal: { tabs: [{ cwd: "/a", privilege: "user", label: "Terminal 1", name: "server" }, { cwd: "/b", label: "Terminal 2", name: "" }] },
    });
    expect(ws.terminal.tabs[0].name).toBe("server");
    expect("name" in ws.terminal.tabs[1]).toBe(false);
  });
});
