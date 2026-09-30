/* The window half of the checkpoint: claiming the restore plan once,
   mirroring without leaking, and never writing after teardown.

   The bridge is wrapped rather than replaced — every call runs the real
   fallback host (the same reducers Rust mirrors), and the wrapper only
   counts calls. A stub would have proved the test's own arithmetic. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@bridge/checkpoint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bridge/checkpoint")>();
  return {
    ...actual,
    checkpointLoad: vi.fn(actual.checkpointLoad),
    checkpointClaimRestore: vi.fn(actual.checkpointClaimRestore),
    checkpointOpenWindow: vi.fn(actual.checkpointOpenWindow),
    checkpointSaveWindow: vi.fn(actual.checkpointSaveWindow),
    checkpointSaveProject: vi.fn(actual.checkpointSaveProject),
    checkpointRemoveProject: vi.fn(actual.checkpointRemoveProject),
  };
});

import * as bridge from "@bridge/checkpoint";
import {
  CHECKPOINT_DEBOUNCE_MS,
  __resetCheckpointManager,
  bootCheckpoint,
  flushCheckpoint,
  seedProjects,
  startCheckpointMirror,
  stopCheckpointMirror,
} from "@shell/checkpointManager";
import { restoreWorkspace, __resetWorkspaceGuards } from "@shell/workspace";
import { useProjects, EMPTY_WORKSPACE, SCHEMA_VERSION } from "@store/projects";
import { useDocs } from "@store/documents";
import { useExplorer } from "@store/explorer";
import { useTerminal, DEFAULT_PANEL } from "@store/terminal";

const mocked = bridge as unknown as {
  checkpointLoad: ReturnType<typeof vi.fn>;
  checkpointClaimRestore: ReturnType<typeof vi.fn>;
  checkpointOpenWindow: ReturnType<typeof vi.fn>;
  checkpointSaveWindow: ReturnType<typeof vi.fn>;
  checkpointSaveProject: ReturnType<typeof vi.fn>;
  checkpointRemoveProject: ReturnType<typeof vi.fn>;
};

const DISK_KEY = "spark.checkpoint";

/** Write a previous run's checkpoint, the way the last quit would have. */
function seedDisk(windows: unknown[], projects: unknown[] = []) {
  bridge.__resetCheckpointHost();
  localStorage.setItem(
    DISK_KEY,
    JSON.stringify({ version: 1, projects, windows, updatedAt: 1 }),
  );
}

function windowRow(label: string, projectId: string, order: number) {
  return { label, projectId, geometry: null, rev: 1, order };
}

function projectRow(id: string) {
  return {
    id,
    rootPath: id,
    name: id,
    lastOpened: 1_000,
    rev: 1,
    writer: "main",
    workspace: { ...EMPTY_WORKSPACE, tabs: [] },
  };
}

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
  useProjects.setState({ version: SCHEMA_VERSION, activeId: null, projects: [], hydrated: true });
}

/** Put one project in front, the way opening a folder would. */
function openProject(id: string) {
  useProjects.setState({
    activeId: id,
    projects: [
      {
        id,
        rootPath: id,
        name: id,
        lastOpened: 1_000,
        workspace: { ...EMPTY_WORKSPACE, tabs: [] },
      },
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  bridge.__resetCheckpointHost();
  __resetCheckpointManager();
  __resetWorkspaceGuards();
  resetStores();
  vi.clearAllMocks();
});

afterEach(() => {
  stopCheckpointMirror();
  vi.useRealTimers();
});

/* ---------- Boot ---------- */

describe("bootCheckpoint", () => {
  it("reopens one window per row after the first and keeps the first for itself", async () => {
    seedDisk(
      [windowRow("main", "/a", 1), windowRow("editor-1", "/b", 2), windowRow("editor-2", "/c", 3)],
      [projectRow("/a"), projectRow("/b"), projectRow("/c")],
    );

    const boot = await bootCheckpoint("main");

    expect(boot.claimed).toBe(true);
    expect(boot.projectId).toBe("/a");
    expect(boot.openedWindows).toHaveLength(2);
    expect(mocked.checkpointOpenWindow).toHaveBeenCalledTimes(2);
    expect(mocked.checkpointOpenWindow.mock.calls.map((c) => c[0])).toEqual(["/b", "/c"]);
    expect(boot.projects.map((p) => p.id)).toEqual(["/a", "/b", "/c"]);
  });

  it("claims once no matter how many callers race", async () => {
    seedDisk([windowRow("main", "/a", 1), windowRow("editor-1", "/b", 2)]);

    const results = await Promise.all([
      bootCheckpoint("main"),
      bootCheckpoint("main"),
      bootCheckpoint("main"),
      bootCheckpoint("main"),
    ]);

    expect(mocked.checkpointClaimRestore).toHaveBeenCalledTimes(1);
    expect(mocked.checkpointOpenWindow).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toBe(results[0]);
  });

  it("opens nothing when the last run left no windows", async () => {
    const boot = await bootCheckpoint("main");
    expect(boot.claimed).toBe(false);
    expect(boot.projectId).toBeNull();
    expect(mocked.checkpointOpenWindow).not.toHaveBeenCalled();
  });

  it("registers this window's own row", async () => {
    await bootCheckpoint("main");
    expect(mocked.checkpointSaveWindow).toHaveBeenCalledTimes(1);
    expect(mocked.checkpointSaveWindow.mock.calls[0][0]).toMatchObject({ label: "main" });
    const cp = await bridge.checkpointLoad();
    expect(cp.windows.map((w) => w.label)).toEqual(["main"]);
  });

  it("a window the host opened reads its own project and never claims", async () => {
    seedDisk([windowRow("main", "/a", 1)]);
    // The host seeds the row under its lock before the webview exists.
    await bridge.checkpointOpenWindow("/b");
    mocked.checkpointClaimRestore.mockClear();

    const boot = await bootCheckpoint("editor-1");

    expect(boot.projectId).toBe("/b");
    expect(boot.claimed).toBe(false);
    expect(mocked.checkpointClaimRestore).not.toHaveBeenCalled();

    // The row the host seeded is now owned by the window it named, not
    // still sitting at the revision the host wrote it with.
    const cp = await bridge.checkpointLoad();
    expect(cp.windows.find((w) => w.label === "editor-1")?.rev).toBe(1);
  });

  it("a window that will not open costs that window, not the boot", async () => {
    seedDisk([
      windowRow("main", "/a", 1),
      windowRow("editor-1", "/b", 2),
      windowRow("editor-2", "/c", 3),
    ]);
    mocked.checkpointOpenWindow.mockRejectedValueOnce(new Error("no window for you"));

    const boot = await bootCheckpoint("main");

    expect(mocked.checkpointOpenWindow).toHaveBeenCalledTimes(2);
    expect(boot.openedWindows).toHaveLength(1);
  });

  it("seeds the projects store from the rows it read", async () => {
    seedDisk([windowRow("main", "/a", 1)], [projectRow("/a"), projectRow("/b")]);
    const boot = await bootCheckpoint("main");
    seedProjects(boot.projects, boot.projectId);

    const s = useProjects.getState();
    expect(s.projects.map((p) => p.id).sort()).toEqual(["/a", "/b"]);
    expect(s.activeId).toBe("/a");
  });

  it("keeps the local copy of a project when it is newer than the checkpoint's", () => {
    const row = (lastOpened: number, name: string) => ({
      id: "/a", rootPath: "/a", name, lastOpened, workspace: EMPTY_WORKSPACE,
    });
    useProjects.setState({ projects: [row(200, "local")] });
    seedProjects([row(100, "stale")], "/a");
    expect(useProjects.getState().projects[0].name).toBe("local");
    seedProjects([row(300, "fresh")], "/a");
    expect(useProjects.getState().projects[0].name).toBe("fresh");
  });
});

/* ---------- A full launch cycle ---------- */

describe("quit and relaunch", () => {
  it("comes back as the same windows, each on its own project", async () => {
    // Run 1. This window mirrors itself; the second window's writes are
    // what its own manager would send — one webview, one mirror, so the
    // second one is driven through the host directly.
    startCheckpointMirror("main");
    openProject("/a");
    await flushCheckpoint();

    const label = await bridge.checkpointOpenWindow("/b");
    await bridge.checkpointSaveProject({
      id: "/b",
      rootPath: "/b",
      name: "b",
      lastOpened: 2_000,
      rev: 1,
      writer: label,
      workspace: { ...EMPTY_WORKSPACE, tabs: [] },
    });
    stopCheckpointMirror();

    // Quit, then launch again against what the last run left on disk.
    const disk = localStorage.getItem(DISK_KEY);
    expect(disk).toBeTruthy();
    bridge.__resetCheckpointHost();
    localStorage.setItem(DISK_KEY, disk as string);
    __resetCheckpointManager();
    resetStores();

    const first = await bootCheckpoint("main");
    expect(first.projectId).toBe("/a");
    expect(first.openedWindows).toEqual([label]);
    expect(first.projects.map((p) => p.id).sort()).toEqual(["/a", "/b"]);

    // The window the host just opened boots into its own project.
    __resetCheckpointManager();
    const second = await bootCheckpoint(label);
    expect(second.projectId).toBe("/b");
    expect(second.claimed).toBe(false);
  });
});

/* ---------- Mirror ---------- */

describe("the mirror", () => {
  it("coalesces a burst of changes into one write", async () => {
    startCheckpointMirror("main");
    openProject("/a");
    for (let i = 0; i < 5; i++) {
      useProjects.setState({ projects: [{ ...useProjects.getState().projects[0], lastOpened: i }] });
    }

    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);

    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(1);
  });

  it("writes strictly increasing revisions", async () => {
    startCheckpointMirror("main");
    openProject("/a");
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);
    useDocs.getState().open({ name: "a.ts", path: "/a.ts", mode: "code", raw: "a" });
    await flushCheckpoint();

    const revs = [
      ...mocked.checkpointSaveWindow.mock.calls.map((c) => c[0].rev),
      ...mocked.checkpointSaveProject.mock.calls.map((c) => c[0].rev),
    ].sort((a, b) => a - b);
    expect(new Set(revs).size).toBe(revs.length);
    expect(revs.every((r, i) => i === 0 || r > revs[i - 1])).toBe(true);
  });

  it("does not rewrite a state it already wrote", async () => {
    startCheckpointMirror("main");
    openProject("/a");
    await flushCheckpoint();
    await flushCheckpoint();
    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while a restore is replaying into the stores", async () => {
    startCheckpointMirror("main");
    openProject("/a");
    await flushCheckpoint();
    mocked.checkpointSaveProject.mockClear();

    const inFlight = restoreWorkspace({
      ...EMPTY_WORKSPACE,
      tabs: [
        { path: "/welcome.md", mode: "markdown", cursor: { line: 1, col: 1 }, scrollTop: 0 },
      ],
    });
    await flushCheckpoint();
    expect(mocked.checkpointSaveProject).not.toHaveBeenCalled();

    await inFlight;
  });

  it("sends a rejected write again on the next tick", async () => {
    startCheckpointMirror("main");
    openProject("/a");
    mocked.checkpointSaveProject.mockResolvedValueOnce({
      accepted: false,
      rev: 0,
      reason: "host busy",
    });
    await flushCheckpoint();
    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(1);

    await flushCheckpoint();
    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(2);

    // Settled now, so a third flush of the same state sends nothing.
    await flushCheckpoint();
    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(2);
  });

  it("does not retry a workspace the host will never take", async () => {
    startCheckpointMirror("main");
    openProject("/a");
    mocked.checkpointSaveProject.mockResolvedValue({
      accepted: false,
      rev: 0,
      reason: "too-large",
    });

    await flushCheckpoint();
    await flushCheckpoint();
    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(1);
  });

  it("carries the live workspace, not the projects cache's stale copy", async () => {
    startCheckpointMirror("main");
    openProject("/a");
    useDocs.getState().open({ name: "a.ts", path: "/a.ts", mode: "code", raw: "a" });
    await flushCheckpoint();

    const save = mocked.checkpointSaveProject.mock.calls.at(-1)?.[0];
    expect(save.workspace.tabs.map((t: { path: string }) => t.path)).toEqual(["/a.ts"]);
    expect(save.writer).toBe("main");
  });
});

/* ---------- Teardown ---------- */

describe("teardown", () => {
  it("removes every listener it added", () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const add = vi.spyOn(window, "addEventListener").mockImplementation(((t: string, f: unknown) => {
      added.push([t, f]);
    }) as never);
    const remove = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation(((t: string, f: unknown) => {
        removed.push([t, f]);
      }) as never);

    const stop = startCheckpointMirror("main");
    stop();

    add.mockRestore();
    remove.mockRestore();
    expect(added.length).toBeGreaterThan(0);
    expect(removed).toEqual(added);
  });

  it("drops a tick that was already queued", async () => {
    const stop = startCheckpointMirror("main");
    openProject("/a");
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS - 50);

    stop();
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS * 2);

    expect(mocked.checkpointSaveProject).not.toHaveBeenCalled();
    expect(mocked.checkpointSaveWindow).not.toHaveBeenCalled();
  });

  it("stops listening to the store", async () => {
    const stop = startCheckpointMirror("main");
    stop();

    openProject("/a");
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS * 2);

    expect(mocked.checkpointSaveProject).not.toHaveBeenCalled();
  });

  it("gives back every store subscription it took", () => {
    const unsubs: Array<ReturnType<typeof vi.fn>> = [];
    const real = useProjects.subscribe.bind(useProjects);
    const spy = vi
      .spyOn(useProjects, "subscribe")
      .mockImplementation(((fn: never) => {
        const tracked = vi.fn(real(fn));
        unsubs.push(tracked);
        return tracked;
      }) as never);

    for (let i = 0; i < 10; i++) startCheckpointMirror("main")();

    spy.mockRestore();
    expect(unsubs).toHaveLength(10);
    for (const off of unsubs) expect(off).toHaveBeenCalledTimes(1);
  });

  it("abandons a write already in flight when the window tears down", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocked.checkpointSaveWindow.mockImplementationOnce(async (save: { rev: number }) => {
      await gate;
      return { accepted: true, rev: save.rev };
    });

    startCheckpointMirror("main");
    openProject("/a");
    const inFlight = flushCheckpoint();
    stopCheckpointMirror();
    release();
    await inFlight;

    expect(mocked.checkpointSaveWindow).toHaveBeenCalledTimes(1);
    expect(mocked.checkpointSaveProject).not.toHaveBeenCalled();
  });

  it("does not accumulate across start/stop cycles", async () => {
    for (let i = 0; i < 50; i++) startCheckpointMirror("main")();
    startCheckpointMirror("main");

    openProject("/a");
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);

    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(1);
    expect(mocked.checkpointSaveWindow).toHaveBeenCalledTimes(1);
  });

  it("replaces a mirror rather than running two, and the old teardown is inert", async () => {
    const first = startCheckpointMirror("main");
    startCheckpointMirror("main");
    first(); // the mirror it belonged to is already gone

    openProject("/a");
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 10);

    expect(mocked.checkpointSaveProject).toHaveBeenCalledTimes(1);
  });

  it("flushing after teardown writes nothing and still resolves", async () => {
    const stop = startCheckpointMirror("main");
    openProject("/a");
    stop();

    await expect(flushCheckpoint()).resolves.toBeUndefined();
    expect(mocked.checkpointSaveProject).not.toHaveBeenCalled();
  });
});

/* ---------- Host ordering ---------- */

describe("the host queue", () => {
  it("applies concurrent saves in the order they were made", async () => {
    const acks = await Promise.all(
      [1, 2, 3, 4, 5].map((rev) =>
        bridge.checkpointSaveWindow({ label: "main", projectId: `/p${rev}`, geometry: null, rev }),
      ),
    );

    expect(acks.every((a) => a.accepted)).toBe(true);
    const cp = await bridge.checkpointLoad();
    expect(cp.windows[0].rev).toBe(5);
    expect(cp.windows[0].projectId).toBe("/p5");
  });

  it("rejects a write that arrives behind a newer one", async () => {
    await bridge.checkpointSaveWindow({ label: "main", projectId: "/new", geometry: null, rev: 4 });
    const late = await bridge.checkpointSaveWindow({
      label: "main",
      projectId: "/old",
      geometry: null,
      rev: 3,
    });

    expect(late.accepted).toBe(false);
    expect(late.reason).toBe("stale");
    const cp = await bridge.checkpointLoad();
    expect(cp.windows[0].projectId).toBe("/new");
  });

  it("keeps serving after a call rejects", async () => {
    mocked.checkpointSaveProject.mockRejectedValueOnce(new Error("host went away"));
    await expect(
      bridge.checkpointSaveProject({
        id: "/a",
        rootPath: "/a",
        name: "a",
        lastOpened: 1,
        rev: 1,
        writer: "main",
        workspace: { ...EMPTY_WORKSPACE, tabs: [] },
      }),
    ).rejects.toThrow();

    const ack = await bridge.checkpointSaveWindow({
      label: "main",
      projectId: "/a",
      geometry: null,
      rev: 1,
    });
    expect(ack.accepted).toBe(true);
  });
});
