/* Terminal store: the pieces workspace restore depends on. */
import { describe, it, expect, beforeEach } from "vitest";
import { useTerminal, DEFAULT_PANEL } from "./terminal";

beforeEach(() => {
  useTerminal.setState({
    isOpen: false,
    sessions: [],
    activeId: null,
    nextOrdinal: 1,
    statuses: {},
    restoredOpen: false,
    mobile: false,
    panel: { ...DEFAULT_PANEL },
    panelPlaced: false,
  });
});

describe("restoreTabs", () => {
  it("rebuilds tabs at their saved cwd and privilege with fresh shells", () => {
    useTerminal.getState().restoreTabs(
      [
        { cwd: "/one", privilege: "user", label: "Terminal 1" },
        { cwd: "/two", privilege: "root", label: "Terminal 2" },
      ],
      1,
      3,
      true,
    );
    const s = useTerminal.getState();
    expect(s.sessions.map((x) => x.cwd)).toEqual(["/one", "/two"]);
    expect(s.sessions.map((x) => x.privilege)).toEqual(["user", "root"]);
    // A restored tab is a new pty — there is nothing on the host to reattach.
    expect(s.sessions.every((x) => x.restartKey === 0)).toBe(true);
    expect(s.sessions.every((x) => x.title === null)).toBe(true);
    expect(s.activeId).toBe(s.sessions[1].id);
    expect(s.isOpen).toBe(true);
  });

  it("keeps nextOrdinal past the restored tabs so a new tab cannot reuse a name", () => {
    useTerminal.getState().restoreTabs(
      [
        { cwd: "/a", privilege: "user", label: "Terminal 1" },
        { cwd: "/b", privilege: "user", label: "Terminal 2" },
      ],
      0,
      1,
      true,
    );
    expect(useTerminal.getState().nextOrdinal).toBe(3);
  });

  it("preserves the saved labels", () => {
    useTerminal.getState().restoreTabs([{ cwd: "/a", privilege: "user", label: "build" }], 0, 2, true);
    expect(useTerminal.getState().sessions[0].label).toBe("build");
  });

  it("refuses to open the panel with nothing in it", () => {
    useTerminal.getState().restoreTabs([], -1, 1, true);
    const s = useTerminal.getState();
    expect(s.isOpen).toBe(false);
    expect(s.activeId).toBeNull();
  });

  it("pulls an out-of-range activeIndex back to the first tab", () => {
    useTerminal.getState().restoreTabs([{ cwd: "/a", privilege: "user", label: "Terminal 1" }], 7, 2, true);
    const s = useTerminal.getState();
    expect(s.activeId).toBe(s.sessions[0].id);
  });

  it("leaves ensureSession a no-op, so a StrictMode remount adds no shell", () => {
    useTerminal.getState().restoreTabs([{ cwd: "/a", privilege: "user", label: "Terminal 1" }], 0, 2, true);
    useTerminal.getState().ensureSession("/somewhere-else");
    expect(useTerminal.getState().sessions).toHaveLength(1);
  });
});

describe("restoredOpen", () => {
  it("is raised by a restore that opens the panel and dropped by the first user action", () => {
    const t = useTerminal.getState();
    t.restoreTabs([{ cwd: "/a", privilege: "user", label: "Terminal 1" }], 0, 2, true);
    expect(useTerminal.getState().restoredOpen).toBe(true);
    t.setActiveSession("term-1");
    expect(useTerminal.getState().restoredOpen).toBe(false);
  });

  it("stays down when the restore leaves the panel closed", () => {
    useTerminal.getState().restoreTabs([{ cwd: "/a", privilege: "user", label: "Terminal 1" }], 0, 2, false);
    expect(useTerminal.getState().restoredOpen).toBe(false);
  });
});

describe("openAt", () => {
  it("lands on the live shell already at that directory", () => {
    const t = useTerminal.getState();
    t.addSession("/a");
    t.addSession("/b");
    t.openAt("/a");
    const after = useTerminal.getState();
    expect(after.sessions).toHaveLength(2);
    expect(after.activeId).toBe("term-1");
    expect(after.isOpen).toBe(true);
  });

  it("opens a new tab rather than landing on a shell that has exited", () => {
    /* "Open in Terminal" on a folder whose only tab had `exit` typed into
       it used to focus that dead tab, which cannot take a command. */
    const t = useTerminal.getState();
    t.addSession("/a");
    t.setStatus("term-1", { phase: "exited", code: 0 });
    t.openAt("/a");
    const after = useTerminal.getState();
    expect(after.sessions.map((s) => s.id)).toEqual(["term-1", "term-2"]);
    expect(after.activeId).toBe("term-2");
  });
});

describe("setStatus", () => {
  it("records a status only for a session the panel still has", () => {
    const t = useTerminal.getState();
    t.addSession("/a");
    t.setStatus("term-1", { phase: "starting" });
    // A view tearing down after its tab closed reports once more.
    t.setStatus("term-9", { phase: "exited", code: 0 });
    expect(Object.keys(useTerminal.getState().statuses)).toEqual(["term-1"]);
  });

  it("forgets the status of a closed tab", () => {
    const t = useTerminal.getState();
    t.addSession("/a");
    t.addSession("/b");
    t.setStatus("term-1", { phase: "starting" });
    t.setStatus("term-2", { phase: "starting" });
    t.closeSession("term-1");
    expect(Object.keys(useTerminal.getState().statuses)).toEqual(["term-2"]);
  });
});

describe("reset", () => {
  it("drops every session, closes the panel and restarts the ordinals", () => {
    const t = useTerminal.getState();
    t.addSession("/a");
    t.addSession("/b");
    t.reset();
    const after = useTerminal.getState();
    expect(after.sessions).toEqual([]);
    expect(after.activeId).toBeNull();
    expect(after.isOpen).toBe(false);
    expect(after.nextOrdinal).toBe(1);
    // The panel keeps its place: geometry is the user's, not the project's.
    expect(after.panel).toEqual(t.panel);
  });
});

describe("setPanelRect", () => {
  it("patches only the given axes", () => {
    useTerminal.getState().setPanelRect({ x: 30, y: 40 });
    expect(useTerminal.getState().panel).toEqual({ ...DEFAULT_PANEL, x: 30, y: 40 });
  });

  it("records that the panel has been placed, and only when told to", () => {
    useTerminal.getState().setPanelRect({ x: 1 });
    expect(useTerminal.getState().panelPlaced).toBe(false);
    useTerminal.getState().setPanelRect({ x: 2 }, true);
    expect(useTerminal.getState().panelPlaced).toBe(true);
    useTerminal.getState().setPanelRect({ x: 3 });
    expect(useTerminal.getState().panelPlaced).toBe(true);
  });
});

describe("live cwd, names and navigation", () => {
  const three = () =>
    useTerminal.getState().restoreTabs(
      [
        { cwd: "/a", privilege: "user", label: "Terminal 1" },
        { cwd: "/b", privilege: "user", label: "Terminal 2", name: "server" },
        { cwd: "/c", privilege: "user", label: "Terminal 3" },
      ],
      0,
      4,
      true,
    );

  it("restores a tab's name", () => {
    three();
    expect(useTerminal.getState().sessions.map((s) => s.name ?? null)).toEqual([null, "server", null]);
  });

  it("records where a shell moved without touching the spawn cwd", () => {
    three();
    const id = useTerminal.getState().sessions[0].id;
    useTerminal.getState().setSessionCwd(id, "/a/sub");
    const s = useTerminal.getState().sessions[0];
    expect(s.liveCwd).toBe("/a/sub");
    expect(s.cwd).toBe("/a");
  });

  it("does not notify subscribers when a frame repeats the same cwd or title", () => {
    three();
    const id = useTerminal.getState().sessions[0].id;
    useTerminal.getState().setSessionCwd(id, "/a/sub");
    useTerminal.getState().setSessionTitle(id, "bash");
    let calls = 0;
    const unsub = useTerminal.subscribe(() => calls++);
    useTerminal.getState().setSessionCwd(id, "/a/sub");
    useTerminal.getState().setSessionTitle(id, "bash");
    unsub();
    expect(calls).toBe(0);
  });

  it("cycles through tabs in both directions, wrapping", () => {
    three();
    const ids = useTerminal.getState().sessions.map((s) => s.id);
    useTerminal.getState().cycleSession(-1);
    expect(useTerminal.getState().activeId).toBe(ids[2]);
    useTerminal.getState().cycleSession(1);
    expect(useTerminal.getState().activeId).toBe(ids[0]);
  });

  it("renames a tab and clears the name with a blank", () => {
    three();
    const id = useTerminal.getState().sessions[0].id;
    useTerminal.getState().renameSession(id, "  build   watcher ");
    expect(useTerminal.getState().sessions[0].name).toBe("build watcher");
    useTerminal.getState().renameSession(id, "   ");
    expect(useTerminal.getState().sessions[0].name).toBeNull();
  });

  it("drops a task's command when the shell flips to root", () => {
    useTerminal.getState().addSession("/p", { name: "npm: build", initialInput: "npm run build\r" });
    const id = useTerminal.getState().sessions[0].id;
    useTerminal.getState().setPrivilege(id, "root");
    expect(useTerminal.getState().sessions[0].initialInput).toBeUndefined();
  });

  it("lands Open-in-Terminal on a shell that is still in the folder, not one that left", () => {
    three();
    const [first] = useTerminal.getState().sessions;
    useTerminal.getState().setSessionCwd(first.id, "/elsewhere");
    useTerminal.getState().openAt("/a");
    const s = useTerminal.getState();
    expect(s.sessions).toHaveLength(4);
    expect(s.activeId).toBe(s.sessions[3].id);
    useTerminal.getState().openAt("/elsewhere");
    expect(useTerminal.getState().activeId).toBe(first.id);
  });
});
