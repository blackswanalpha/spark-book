/* The checkpoint rules, stated as tests.
   src-tauri/src/checkpoint.rs implements the same set behind a mutex;
   these cases and the ones in that module's `mod tests` are deliberately
   the same list, because the two run in the same product — Rust under
   Tauri, this module under vite and vitest. */
import { describe, it, expect } from "vitest";
import {
  MAX_CHECKPOINT_PROJECTS,
  MAX_WINDOWS,
  MAX_WORKSPACE_BYTES,
  allocateLabel,
  claimRestore,
  coerceCheckpoint,
  forgetWindow,
  markExiting,
  openSession,
  removeProject,
  saveProject,
  saveWindow,
  toDisk,
  workspaceBytes,
  type ProjectSave,
  type Session,
  type WindowSave,
} from "@store/checkpoint";
import { EMPTY_WORKSPACE, type Workspace } from "@store/projects";

const T = 1_000;

const ws = (): Workspace => ({ ...EMPTY_WORKSPACE, tabs: [] });

function win(label: string, projectId: string | null, rev: number): WindowSave {
  return { label, projectId, geometry: null, rev };
}

function proj(id: string, writer: string, rev: number, lastOpened = T): ProjectSave {
  return {
    id,
    rootPath: `/${id}`,
    name: id,
    lastOpened,
    rev,
    writer,
    workspace: ws(),
  };
}

function fresh(): Session {
  return openSession(null, T);
}

function withWindows(...labels: string[]): Session {
  return openSession(
    {
      version: 1,
      projects: [],
      windows: labels.map((label, i) => ({
        label,
        projectId: `/p${i}`,
        geometry: null,
        rev: 1,
        order: i + 1,
      })),
      updatedAt: 1,
    },
    T,
  );
}

/* ---------- Reading the file ---------- */

describe("coerceCheckpoint", () => {
  it("returns an empty checkpoint for anything that is not one", () => {
    for (const raw of [null, undefined, 7, "x", [], { version: 2 }]) {
      const cp = coerceCheckpoint(raw);
      expect(cp.projects).toEqual([]);
      expect(cp.windows).toEqual([]);
    }
  });

  it("drops rows with no key and keeps the first of a duplicate pair", () => {
    const cp = coerceCheckpoint({
      version: 1,
      projects: [{ id: "/a", name: "first" }, { id: "/a", name: "second" }, { name: "no id" }],
      windows: [{ label: "main" }, { label: "main" }, {}],
      updatedAt: 0,
    });
    expect(cp.projects.map((p) => p.name)).toEqual(["first"]);
    expect(cp.windows.map((w) => w.label)).toEqual(["main"]);
  });

  it("caps both tables", () => {
    const cp = coerceCheckpoint({
      version: 1,
      projects: Array.from({ length: 60 }, (_, i) => ({ id: `/p${i}`, lastOpened: i })),
      windows: Array.from({ length: 40 }, (_, i) => ({ label: `w${i}`, order: i })),
      updatedAt: 0,
    });
    expect(cp.projects).toHaveLength(MAX_CHECKPOINT_PROJECTS);
    expect(cp.windows).toHaveLength(MAX_WINDOWS);
  });

  it("drops a geometry that would open an invisible window", () => {
    const cp = coerceCheckpoint({
      version: 1,
      windows: [{ label: "main", geometry: { x: 1, y: 1, w: 0, h: 0 } }],
      projects: [],
      updatedAt: 0,
    });
    expect(cp.windows[0].geometry).toBeNull();
  });
});

/* ---------- The restore plan ---------- */

describe("the restore plan", () => {
  it("moves the saved windows out of the live table", () => {
    const s = withWindows("main", "editor-1");
    expect(s.file.windows).toEqual([]);
    expect(s.pending).toHaveLength(2);
  });

  it("is handed out exactly once", () => {
    const first = claimRestore(withWindows("main", "editor-1"));
    expect(first.plan).toHaveLength(2);
    const second = claimRestore(first.session);
    expect(second.plan).toBeNull();
  });

  it("is null when the last run left nothing", () => {
    expect(claimRestore(fresh()).plan).toBeNull();
  });

  it("survives a project write that lands before any window registers", () => {
    const s = saveProject(withWindows("main"), proj("/a", "main", 1), T).session;
    expect(toDisk(s).windows).toHaveLength(1);
  });

  it("is replaced by the live table once a window registers", () => {
    const claimed = claimRestore(withWindows("main")).session;
    const s = saveWindow(claimed, win("main", "/a", 1), T).session;
    expect(toDisk(s).windows.map((w) => w.label)).toEqual(["main"]);
  });
});

/* ---------- Window rows ---------- */

describe("window rows", () => {
  it("rejects a write at or below the stored rev", () => {
    const first = saveWindow(fresh(), win("main", "/a", 5), T);
    expect(first.accepted).toBe(true);

    const stale = saveWindow(first.session, win("main", "/stale", 4), T);
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe("stale");
    expect(stale.session.file.windows[0].projectId).toBe("/a");

    const repeat = saveWindow(first.session, win("main", "/stale", 5), T);
    expect(repeat.accepted).toBe(false);
  });

  it("keeps a window's place when it updates", () => {
    let s = saveWindow(fresh(), win("main", "/a", 1), T).session;
    s = saveWindow(s, win("editor-1", "/b", 1), T).session;
    s = saveWindow(s, win("main", "/c", 2), T).session;
    expect(s.file.windows.map((w) => w.label)).toEqual(["main", "editor-1"]);
  });

  it("caps the table by dropping the oldest window", () => {
    let s = fresh();
    for (let i = 0; i < MAX_WINDOWS + 3; i++) {
      s = saveWindow(s, win(`editor-${i}`, "/a", 1), T).session;
    }
    expect(s.file.windows).toHaveLength(MAX_WINDOWS);
    expect(s.file.windows[0].label).toBe("editor-3");
  });

  it("refuses a row with no label", () => {
    const res = saveWindow(fresh(), win("", "/a", 1), T);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("invalid");
  });

  it("forgets a window that closes while others are open", () => {
    let s = saveWindow(fresh(), win("main", "/a", 1), T).session;
    s = saveWindow(s, win("editor-1", "/b", 1), T).session;
    s = forgetWindow(s, "editor-1", T);
    expect(s.file.windows.map((w) => w.label)).toEqual(["main"]);
  });

  it("keeps the last window's row, because closing it is the quit", () => {
    const s = saveWindow(fresh(), win("main", "/a", 1), T).session;
    expect(forgetWindow(s, "main", T).file.windows).toHaveLength(1);
  });

  it("keeps every row once the app is quitting", () => {
    let s = saveWindow(fresh(), win("main", "/a", 1), T).session;
    s = saveWindow(s, win("editor-1", "/b", 1), T).session;
    s = markExiting(s);
    expect(forgetWindow(s, "editor-1", T).file.windows).toHaveLength(2);
  });

  it("restores only the last window when they were closed one at a time", () => {
    let s = fresh();
    for (const label of ["main", "editor-1", "editor-2"]) {
      s = saveWindow(s, win(label, `/${label}`, 1), T).session;
    }
    s = forgetWindow(s, "editor-1", T);
    s = forgetWindow(s, "main", T);
    s = forgetWindow(s, "editor-2", T); // the quit
    expect(toDisk(s).windows.map((w) => w.label)).toEqual(["editor-2"]);
  });

  it("drops the last closed window's row once a new window registers", () => {
    let s = saveWindow(fresh(), win("main", "/a", 1), T).session;
    // Closed while the Projects window keeps the app running.
    s = forgetWindow(s, "main", T);
    expect(toDisk(s).windows).toHaveLength(1);
    const { session, label } = allocateLabel(s);
    s = saveWindow(session, win(label, "/b", 0), T).session;
    expect(toDisk(s).windows.map((w) => w.label)).toEqual([label]);
  });

  it("hands out a fresh label every time", () => {
    const a = allocateLabel(fresh());
    const b = allocateLabel(a.session);
    expect(a.label).not.toBe(b.label);
    expect(a.label).toMatch(/^editor-\d+$/);
  });
});

/* ---------- Project rows ---------- */

describe("project rows", () => {
  it("rejects a window's own stale retry", () => {
    const first = saveProject(fresh(), proj("/a", "main", 7), T);
    const stale = saveProject(first.session, proj("/a", "main", 6), T);
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe("stale");
    expect(stale.rev).toBe(7);
  });

  it("lets a second window take the row over", () => {
    const first = saveProject(fresh(), proj("/a", "main", 7), T);
    const other = saveProject(first.session, proj("/a", "editor-1", 1), T);
    expect(other.accepted).toBe(true);
    expect(other.session.file.projects[0].writer).toBe("editor-1");
  });

  it("refuses a workspace past the byte ceiling and stores nothing", () => {
    const save = proj("/a", "main", 1);
    save.workspace = {
      ...ws(),
      explorer: { ...EMPTY_WORKSPACE.explorer, root: "x".repeat(MAX_WORKSPACE_BYTES + 1) },
    };
    expect(workspaceBytes(save.workspace)).toBeGreaterThan(MAX_WORKSPACE_BYTES);
    const res = saveProject(fresh(), save, T);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("too-large");
    expect(res.session.file.projects).toEqual([]);
  });

  it("never evicts the project a live window is showing", () => {
    let s = saveWindow(fresh(), win("main", "/pinned", 1), T).session;
    s = saveProject(s, proj("/pinned", "main", 1, 0), T).session;
    for (let i = 0; i < MAX_CHECKPOINT_PROJECTS + 5; i++) {
      s = saveProject(s, proj(`/p${i}`, "main", 1, 5_000 + i), T).session;
    }
    expect(s.file.projects.some((p) => p.id === "/pinned")).toBe(true);
    expect(s.file.projects.length).toBeLessThanOrEqual(MAX_CHECKPOINT_PROJECTS);
  });

  it("removes one row and treats a second removal as a no-op", () => {
    let s = saveProject(fresh(), proj("/a", "main", 1), T).session;
    s = saveProject(s, proj("/b", "main", 2), T).session;
    const after = removeProject(s, "/a", T);
    expect(after.file.projects.map((p) => p.id)).toEqual(["/b"]);
    expect(removeProject(after, "/a", T)).toBe(after);
  });

  it("refuses a row with no id or no writer", () => {
    expect(saveProject(fresh(), proj("", "main", 1), T).accepted).toBe(false);
    expect(saveProject(fresh(), proj("/a", "", 1), T).accepted).toBe(false);
  });
});

/* ---------- Round trip ---------- */

describe("round trip", () => {
  it("reopens into the same rows it wrote", () => {
    let s = saveWindow(fresh(), win("main", "/a", 1), T).session;
    s = saveProject(s, proj("/a", "main", 1), T).session;

    const back = openSession(JSON.parse(JSON.stringify(toDisk(s))), T);
    expect(back.file.projects).toHaveLength(1);
    expect(back.pending).toHaveLength(1);
    expect(claimRestore(back).plan?.[0].projectId).toBe("/a");
  });

  it("does not carry a window row across two runs unclaimed", () => {
    const first = saveWindow(fresh(), win("main", "/a", 1), T).session;
    const second = openSession(toDisk(first), T);
    expect(second.file.windows).toEqual([]);
    const third = openSession(toDisk(claimRestore(second).session), T);
    expect(third.pending).toBeNull();
  });
});

describe("pinned projects", () => {
  const rec = (id: string, lastOpened: number, pinned = false) => ({
    id, rootPath: id, name: id, lastOpened, rev: 1, writer: "main", pinned, workspace: EMPTY_WORKSPACE,
  });

  it("survive the load-time cap and keep their flag", () => {
    const rows = Array.from({ length: MAX_CHECKPOINT_PROJECTS + 3 }, (_, i) => rec(`/p${i}`, 100 + i));
    const cp = coerceCheckpoint({ version: 1, projects: [...rows, rec("/old", 1, true)], windows: [] });
    expect(cp.projects).toHaveLength(MAX_CHECKPOINT_PROJECTS);
    expect(cp.projects[0]).toMatchObject({ id: "/old", pinned: true });
  });

  it("are carried through a save", () => {
    const s = openSession(null, 1);
    const save: ProjectSave = { id: "/a", rootPath: "/a", name: "a", lastOpened: 5, rev: 1, writer: "main", pinned: true, workspace: EMPTY_WORKSPACE };
    const res = saveProject(s, save, 10);
    expect(res.accepted).toBe(true);
    expect(res.session.file.projects[0].pinned).toBe(true);
  });
});
