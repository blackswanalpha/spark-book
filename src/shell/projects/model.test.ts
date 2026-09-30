import { describe, expect, it } from "vitest";
import type { Checkpoint, ProjectRecord, WindowRecord } from "@store/checkpoint";
import { EMPTY_WORKSPACE, LOOSE_ID, type Project } from "@store/projects";
import {
  avatarIndex,
  buildRows,
  filterRows,
  folderNameProblem,
  initials,
  openerOf,
  parentOf,
  planOpen,
  repoName,
  suggestedLocation,
  tildify,
  AVATAR_COLORS,
} from "./model";

const ws = EMPTY_WORKSPACE;

function rec(id: string, lastOpened: number, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id, rootPath: id, name: id.split("/").pop() ?? id, lastOpened, rev: 1, writer: "main", workspace: ws, ...extra };
}

function win(label: string, projectId: string | null): WindowRecord {
  return { label, projectId, geometry: null, rev: 1, order: 1 };
}

function cp(projects: ProjectRecord[], windows: WindowRecord[] = []): Checkpoint {
  return { version: 1, projects, windows, updatedAt: 0 };
}

const local = (id: string, lastOpened: number, extra: Partial<Project> = {}): Project => ({
  id, rootPath: id, name: `local-${id.split("/").pop()}`, lastOpened, workspace: ws, ...extra,
});

describe("buildRows", () => {
  it("merges the checkpoint with the local cache, newest copy winning", () => {
    const rows = buildRows(
      cp([rec("/a", 10), rec("/b", 5)]),
      [local("/a", 5), local("/b", 9), local("/c", 1)],
      new Set(),
    );
    expect(rows.map((r) => [r.id, r.name])).toEqual([
      ["/a", "a"],
      ["/b", "local-b"],
      ["/c", "local-c"],
    ]);
  });

  it("drops the no-folder bucket and puts pinned projects first", () => {
    const rows = buildRows(
      cp([rec("/old", 1, { pinned: true }), rec("/new", 9), rec(LOOSE_ID, 20, { rootPath: null })]),
      [],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["/old", "/new"]);
    expect(rows[0].pinned).toBe(true);
  });

  it("marks a project open only when its window is still alive", () => {
    const table = cp([rec("/a", 1), rec("/b", 2)], [win("main", "/a"), win("editor-2", "/b")]);
    const rows = buildRows(table, [], new Set(["editor-2"]));
    expect(rows.find((r) => r.id === "/a")?.openIn).toBeNull();
    expect(rows.find((r) => r.id === "/b")?.openIn).toBe("editor-2");
  });
});

describe("openerOf", () => {
  it("reports the opener's project and whether it is still open", () => {
    const table = cp([], [win("main", "/a"), win("editor-1", null)]);
    expect(openerOf(table, "main", new Set(["main"]))).toEqual({ label: "main", live: true, projectId: "/a" });
    expect(openerOf(table, "editor-1", new Set())).toEqual({ label: "editor-1", live: false, projectId: null });
    expect(openerOf(table, null, new Set())).toBeNull();
  });
});

describe("planOpen", () => {
  const busy = { label: "main", live: true, projectId: "/x" };
  const empty = { label: "main", live: true, projectId: null };
  const gone = { label: "main", live: false, projectId: null };

  it("focuses a project that is already open, whatever was asked", () => {
    for (const how of ["auto", "new", "here"] as const) {
      expect(planOpen({ openIn: "editor-3" }, how, busy, "new")).toEqual({ kind: "focus", label: "editor-3" });
    }
  });

  it("opens a new window from a busy window, and reuses an empty one", () => {
    expect(planOpen({ openIn: null }, "auto", busy, "new")).toEqual({ kind: "new" });
    expect(planOpen({ openIn: null }, "auto", empty, "new")).toEqual({ kind: "here", label: "main", mode: "auto" });
  });

  it("honours an explicit new window even when the opener is empty", () => {
    expect(planOpen({ openIn: null }, "new", empty, "here")).toEqual({ kind: "new" });
  });

  it("replaces the opener's project when asked or preferred", () => {
    expect(planOpen({ openIn: null }, "here", busy, "new")).toEqual({ kind: "here", label: "main", mode: "replace" });
    expect(planOpen({ openIn: null }, "auto", busy, "here")).toEqual({ kind: "here", label: "main", mode: "replace" });
  });

  it("falls back to a new window once the opener has closed", () => {
    expect(planOpen({ openIn: null }, "here", gone, "here")).toEqual({ kind: "new" });
    expect(planOpen({ openIn: null }, "auto", null, "here")).toEqual({ kind: "new" });
  });
});

describe("filterRows", () => {
  const rows = buildRows(
    cp([
      rec("/home/me/code/spark-book", 3),
      rec("/home/me/work/api", 2),
      rec("/srv/sites/blog", 1),
    ]),
    [],
    new Set(),
  );

  it("returns everything for an empty query", () => {
    expect(filterRows(rows, "  ")).toHaveLength(3);
  });

  it("ranks name matches before path and branch matches", () => {
    const branches = new Map([["/srv/sites/blog", "sb-redesign"]]);
    const out = filterRows(rows, "sb", branches).map((m) => m.row.id);
    expect(out[0]).toBe("/home/me/code/spark-book");
    expect(out).toContain("/srv/sites/blog");
    expect(out).not.toContain("/home/me/work/api");
  });

  it("matches a path segment", () => {
    expect(filterRows(rows, "work").map((m) => m.row.id)).toEqual(["/home/me/work/api"]);
  });
});

describe("presentation", () => {
  it("derives two-letter initials", () => {
    expect(initials("spark-book")).toBe("SB");
    expect(initials("sparkEditor")).toBe("SE");
    expect(initials("API")).toBe("AP");
    expect(initials("x")).toBe("X");
    expect(initials("---")).toBe("?");
    expect(initials("my great app")).toBe("MG");
  });

  it("keeps avatar colours stable and in range", () => {
    const i = avatarIndex("/home/me/app");
    expect(i).toBe(avatarIndex("/home/me/app"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(AVATAR_COLORS);
  });

  it("shortens paths under home", () => {
    expect(tildify("/home/me/code", "/home/me")).toBe("~/code");
    expect(tildify("/home/me", "/home/me/")).toBe("~");
    expect(tildify("/home/meow/x", "/home/me")).toBe("/home/meow/x");
    expect(tildify("/srv/x", null)).toBe("/srv/x");
  });

  it("finds the parent folder", () => {
    expect(parentOf("/home/me/app")).toBe("/home/me");
    expect(parentOf("/home/me/app/")).toBe("/home/me");
    expect(parentOf("/app")).toBe("/");
  });

  it("suggests the latest project's parent, else home", () => {
    const rows = buildRows(cp([rec("/a/one", 1), rec("/b/two", 5, { pinned: false })]), [], new Set());
    expect(suggestedLocation(rows, "/home/me")).toBe("/b");
    expect(suggestedLocation([], "/home/me")).toBe("/home/me");
    expect(suggestedLocation([], null)).toBe("/");
  });
});

describe("names", () => {
  it("rejects names that are not one folder", () => {
    expect(folderNameProblem("app")).toBeNull();
    expect(folderNameProblem(" ")).not.toBeNull();
    expect(folderNameProblem("..")).not.toBeNull();
    expect(folderNameProblem("a/b")).not.toBeNull();
    expect(folderNameProblem("a\\b")).not.toBeNull();
    expect(folderNameProblem("x".repeat(256))).not.toBeNull();
  });

  it("picks the folder git would clone into", () => {
    expect(repoName("https://github.com/a/spark-book.git")).toBe("spark-book");
    expect(repoName("git@github.com:a/b.git")).toBe("b");
    expect(repoName("https://github.com/a/b/")).toBe("b");
    expect(repoName("")).toBe("");
  });
});
