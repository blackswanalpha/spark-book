/* ============================================================
   sparkBook · src/store/explorer.test.ts
   Tests for the explorer store actions added for the
   context-menu (rename / delete / copy / clipboard paste).

   Note: the bridge mock has hardcoded children for `/` and `/docs`,
   so we use dynamically-resolved subdirectories (`/docs/audits`,
   `/docs/audits/inner`) for the assertions.
   ============================================================ */
import { describe, it, expect, beforeEach } from "vitest";
import { useExplorer, isUnder, compareNodes, describeError, validateName, type ExplorerNode } from "./explorer";
import { useDocs } from "./documents";

describe("explorer store — context menu actions", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("createFile + renamePath updates the cache and selection", async () => {
    const api = useExplorer.getState();
    const create = await api.createFile("/docs/audits", "alpha.md");
    expect(create.ok).toBe(true);

    await api.loadChildren("/docs/audits");
    const before = useExplorer.getState().children.get("/docs/audits")!;
    expect(before.find((n) => n.name === "alpha.md")).toBeTruthy();

    const renamed = await api.renamePath("/docs/audits/alpha.md", "beta.md");
    expect(renamed.ok).toBe(true);

    const after = useExplorer.getState().children.get("/docs/audits")!;
    expect(after.find((n) => n.name === "alpha.md")).toBeUndefined();
    expect(after.find((n) => n.name === "beta.md")).toBeTruthy();
  });

  it("createFolder + deletePath removes the entry from the parent's listing", async () => {
    const api = useExplorer.getState();
    const create = await api.createFolder("/docs/audits", "subdir");
    expect(create.ok).toBe(true);
    await api.loadChildren("/docs/audits");

    const del = await api.deletePath("/docs/audits/subdir");
    expect(del.ok).toBe(true);

    const after = useExplorer.getState().children.get("/docs/audits")!;
    expect(after.find((n) => n.name === "subdir")).toBeUndefined();
  });

  it("setClipboard + pasteInto with op=copy produces a 'name copy' entry", async () => {
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "inner");
    await api.createFile("/docs/audits/inner", "original.md");
    await api.loadChildren("/docs/audits/inner");

    api.setClipboard({ op: "copy", path: "/docs/audits/inner/original.md" });
    const res = await api.pasteInto("/docs/audits/inner");
    expect(res.ok).toBe(true);

    const listing = useExplorer.getState().children.get("/docs/audits/inner")!;
    expect(listing.find((n) => n.name === "original.md")).toBeTruthy();
    expect(listing.find((n) => n.name === "original copy.md")).toBeTruthy();
  });

  it("setClipboard + pasteInto with op=cut moves the entry and clears the clipboard", async () => {
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "src");
    await api.createFolder("/docs/audits", "dest");
    await api.createFile("/docs/audits/src", "movable.md");
    await api.loadChildren("/docs/audits/src");
    await api.loadChildren("/docs/audits/dest");

    api.setClipboard({ op: "cut", path: "/docs/audits/src/movable.md" });
    const res = await api.pasteInto("/docs/audits/dest");
    expect(res.ok).toBe(true);

    const src = useExplorer.getState().children.get("/docs/audits/src")!;
    expect(src.find((n) => n.name === "movable.md")).toBeUndefined();
    const dest = useExplorer.getState().children.get("/docs/audits/dest")!;
    expect(dest.find((n) => n.name === "movable.md")).toBeTruthy();
    expect(useExplorer.getState().clipboard).toBeNull();
  });

  it("renamePath rejects names containing path separators", async () => {
    const api = useExplorer.getState();
    await api.createFile("/docs/audits", "ok.md");
    await api.loadChildren("/docs/audits");
    const res = await api.renamePath("/docs/audits/ok.md", "bad/name.md");
    expect(res.ok).toBe(false);
  });
});

describe("explorer store — copy/paste correctness", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("pasting a copy into a different directory keeps the original name", async () => {
    // Previously every copy was suffixed " copy", so pasting into an empty
    // folder produced "notes copy.md" even with no collision.
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "src");
    await api.createFolder("/docs/audits", "dst");
    await api.createFile("/docs/audits/src", "notes.md");
    await api.loadChildren("/docs/audits/dst");

    api.setClipboard({ op: "copy", path: "/docs/audits/src/notes.md" });
    const res = await useExplorer.getState().pasteInto("/docs/audits/dst");
    expect(res.ok).toBe(true);

    await useExplorer.getState().loadChildren("/docs/audits/dst");
    const names = (useExplorer.getState().children.get("/docs/audits/dst") ?? []).map((n) => n.name);
    expect(names).toContain("notes.md");
    expect(names).not.toContain("notes copy.md");
  });

  it("falls back to 'name copy' only on a real collision", async () => {
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "coll");
    await api.createFile("/docs/audits/coll", "dup.md");
    await api.loadChildren("/docs/audits/coll");

    api.setClipboard({ op: "copy", path: "/docs/audits/coll/dup.md" });
    const res = await useExplorer.getState().pasteInto("/docs/audits/coll");
    expect(res.ok).toBe(true);

    await useExplorer.getState().loadChildren("/docs/audits/coll");
    const names = (useExplorer.getState().children.get("/docs/audits/coll") ?? []).map((n) => n.name);
    expect(names).toContain("dup.md");
    expect(names).toContain("dup copy.md");
  });

  it("a folder copied across directories stays a folder in the cache", async () => {
    // copyTo used to look the source up in the DESTINATION listing, find
    // nothing, and default isDir:false — the copy rendered as a file.
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "from");
    await api.createFolder("/docs/audits", "into");
    await api.createFolder("/docs/audits/from", "payload");
    await api.loadChildren("/docs/audits/from");
    await api.loadChildren("/docs/audits/into");

    const res = await useExplorer
      .getState()
      .copyTo("/docs/audits/from/payload", "/docs/audits/into/payload");
    expect(res.ok).toBe(true);

    const entry = (useExplorer.getState().children.get("/docs/audits/into") ?? []).find(
      (n) => n.name === "payload",
    );
    expect(entry).toBeDefined();
    expect(entry!.isDir).toBe(true);
    expect(entry!.isFile).toBe(false);
  });
});

describe("explorer store — navigation and loading state", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("goUp keeps a selection that is still inside the new root", async () => {
    await useExplorer.getState().setRoot("/docs/audits");
    useExplorer.getState().setSelected("/docs/audits");
    await useExplorer.getState().goUp();
    expect(useExplorer.getState().root).toBe("/docs");
    expect(useExplorer.getState().selectedPath).toBe("/docs/audits");
  });

  it("goUp drops a selection that falls outside the new root", async () => {
    await useExplorer.getState().setRoot("/docs/audits");
    useExplorer.getState().setSelected("/elsewhere/file.md");
    await useExplorer.getState().goUp();
    expect(useExplorer.getState().selectedPath).toBeNull();
  });

  it("leaves no path stuck in the loading set after a load", async () => {
    // A stale-generation result used to return early without clearing the
    // flag, leaving that row spinning forever.
    await useExplorer.getState().loadChildren("/docs/audits");
    expect(useExplorer.getState().loading.size).toBe(0);
  });

  it("clears loading even when the root changes mid-load", async () => {
    const pending = useExplorer.getState().loadChildren("/docs/audits");
    await useExplorer.getState().setRoot("/docs");
    await pending;
    expect(useExplorer.getState().loading.has("/docs/audits")).toBe(false);
  });
});

describe("explorer helpers", () => {
  it("treats everything as inside the root folder /", () => {
    // Appending "/" to an ancestor of "/" made nothing count as inside it.
    expect(isUnder("/docs", "/")).toBe(true);
    expect(isUnder("/docs/a.md", "/docs")).toBe(true);
    expect(isUnder("/docsx", "/docs")).toBe(false);
  });

  it("sorts folders first, then names naturally and case-insensitively", () => {
    const n = (name: string, isDir = false): ExplorerNode => ({ name, path: `/${name}`, isDir, isFile: !isDir });
    const sorted = [n("file10"), n("Zeta"), n("file2"), n("alpha"), n("src", true), n("Build", true)]
      .sort(compareNodes)
      .map((x) => x.name);
    expect(sorted).toEqual(["Build", "src", "alpha", "file2", "file10", "Zeta"]);
  });

  it("describes host errors instead of printing [object Object]", () => {
    expect(describeError({ kind: "AlreadyExists", data: { path: "/a/b.md" } })).toBe("“b.md” already exists here.");
    expect(describeError({ kind: "NotFound", path: "/x.md" })).toBe("“x.md” no longer exists.");
    expect(describeError({ kind: "Internal", data: { message: "disk full" } })).toBe("disk full");
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("validates names for create and rename", () => {
    expect(validateName("a.md", ["a.md"])).toMatch(/already exists/);
    expect(validateName("a.md", ["a.md"], { current: "a.md" })).toBeNull();
    expect(validateName("x/y.md", [])).toMatch(/cannot contain/);
    expect(validateName("x/y.md", [], { nested: true })).toBeNull();
    expect(validateName("x//y.md", [], { nested: true })).toMatch(/empty/);
    expect(validateName("../y.md", [], { nested: true })).toMatch(/not a valid name/);
    expect(validateName("   ", [])).toMatch(/required/);
  });
});

describe("explorer store — inline editing, reveal and transfer", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("creates the missing folders for a nested name and selects the file", async () => {
    const res = await useExplorer.getState().createFile("/docs/audits", "deep/er/note.md");
    expect(res).toEqual({ ok: true, path: "/docs/audits/deep/er/note.md" });
    const s = useExplorer.getState();
    expect(s.children.get("/docs/audits")?.find((n) => n.name === "deep")?.isDir).toBe(true);
    expect(s.children.get("/docs/audits/deep/er")?.map((n) => n.name)).toContain("note.md");
    expect(s.expanded.has("/docs/audits/deep/er")).toBe(true);
    expect(s.selectedPath).toBe("/docs/audits/deep/er/note.md");
  });

  it("beginCreate expands the target folder and opens an edit row", () => {
    useExplorer.getState().beginCreate("folder", "/docs/reference");
    const s = useExplorer.getState();
    expect(s.edit).toEqual({ kind: "new-folder", dir: "/docs/reference" });
    expect(s.expanded.has("/docs/reference")).toBe(true);
    s.cancelEdit();
    expect(useExplorer.getState().edit).toBeNull();
  });

  it("reveal expands every ancestor and selects the path", async () => {
    await useExplorer.getState().createFile("/docs/explanation", "hidden/away.md");
    useExplorer.getState().collapseAll();
    await useExplorer.getState().reveal("/docs/explanation/hidden/away.md");
    const s = useExplorer.getState();
    for (const d of ["/docs", "/docs/explanation", "/docs/explanation/hidden"]) {
      expect(s.expanded.has(d)).toBe(true);
    }
    expect(s.selectedPath).toBe("/docs/explanation/hidden/away.md");
  });

  it("renaming a file points its open tab at the new path", async () => {
    await useExplorer.getState().createFile("/docs/audits", "tabbed.md");
    const id = useDocs.getState().open({ name: "tabbed.md", path: "/docs/audits/tabbed.md", mode: "markdown", raw: "" });
    const res = await useExplorer.getState().renamePath("/docs/audits/tabbed.md", "renamed.md");
    expect(res.ok).toBe(true);
    expect(useDocs.getState().docs[id].path).toBe("/docs/audits/renamed.md");
    expect(useDocs.getState().docs[id].name).toBe("renamed.md");
    useDocs.getState().close(id);
  });

  it("transfer refuses to move a folder into itself", async () => {
    await useExplorer.getState().createFolder("/docs/audits", "box");
    await useExplorer.getState().createFolder("/docs/audits/box", "inner");
    const res = await useExplorer.getState().transfer("cut", "/docs/audits/box", "/docs/audits/box/inner");
    expect(res.ok).toBe(false);
  });

  it("duplicate places a copy beside the original", async () => {
    await useExplorer.getState().createFile("/docs/audits", "twin.md");
    const res = await useExplorer.getState().duplicate("/docs/audits/twin.md");
    expect(res.ok).toBe(true);
    expect(res.path).toMatch(/^\/docs\/audits\/twin copy( \(\d+\))?\.md$/);
  });
});

describe("explorer store — moving the root", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("navigateTo moves into a folder and back returns to the parent", async () => {
    await useExplorer.getState().navigateTo("/docs");
    expect(useExplorer.getState().root).toBe("/docs");
    expect(useExplorer.getState().canGoBack()).toBe(true);
    await useExplorer.getState().goBack();
    expect(useExplorer.getState().root).toBe("/");
    await useExplorer.getState().goForward();
    expect(useExplorer.getState().root).toBe("/docs");
  });

  it("moving to an ancestor opens the folders down to where the user was", async () => {
    await useExplorer.getState().navigateTo("/docs/audits");
    await useExplorer.getState().navigateTo("/");
    const s = useExplorer.getState();
    expect(s.root).toBe("/");
    expect(s.expanded.has("/docs")).toBe(true);
    expect(s.expanded.has("/docs/audits")).toBe(true);
  });

  it("navigating to the current root is a no-op", async () => {
    const before = useExplorer.getState().history.length;
    await useExplorer.getState().navigateTo("/");
    expect(useExplorer.getState().history.length).toBe(before);
  });
});
