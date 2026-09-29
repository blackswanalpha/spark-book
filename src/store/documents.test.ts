/* sparkBook · src/store/documents.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@bridge/commands", () => ({
  writeFile: vi.fn(async (_path, _contents) => ({
    path: _path,
    bytes: _contents.length,
    mtime: new Date().toISOString(),
    device: 0,
    inode: 0,
  })),
  writeFileBase64: vi.fn(async (_path, _contents) => ({
    path: _path,
    bytes: _contents.length,
    mtime: new Date().toISOString(),
    device: 0,
    inode: 0,
  })),
  saveFileDialog: vi.fn(async () => null),
  recentsAdd: vi.fn(async (p) => ["/welcome.md", p]),
  copyPath: vi.fn(async () => undefined),
}));

import { useDocs, basename, isBinaryMode, isStreamMode } from "./documents";
import { writeFile, writeFileBase64, saveFileDialog, recentsAdd, copyPath } from "@bridge/commands";

const mockedWriteFile = vi.mocked(writeFile);
const mockedWriteFileBase64 = vi.mocked(writeFileBase64);
const mockedSaveFileDialog = vi.mocked(saveFileDialog);
const mockedRecentsAdd = vi.mocked(recentsAdd);

const resetStore = () => {
  useDocs.setState({ docs: {}, order: [], active: null, history: {} });
};

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe("basename", () => {
  it("posix", () => expect(basename("/a/b/c.md")).toBe("c.md"));
  it("windows", () => expect(basename("C:\\Users\\foo\\bar.txt")).toBe("bar.txt"));
  it("root", () => expect(basename("/")).toBe(""));
  it("empty", () => expect(basename("")).toBe(""));
  it("trailing slash", () => expect(basename("/a/b/")).toBe("b"));
});

describe("saveDocument", () => {
  it("happy path", async () => {
    const id = useDocs.getState().open({ name: "c.md", path: "/a/b/c.md", raw: "hello" });
    useDocs.getState().setRaw(id, "hello world");
    const r = await useDocs.getState().saveDocument(id);
    expect(r).toEqual({ ok: true, path: "/a/b/c.md" });
    expect(mockedWriteFile).toHaveBeenCalledWith("/a/b/c.md", "hello world");
    expect(mockedRecentsAdd).toHaveBeenCalledWith("/a/b/c.md");
    const doc = useDocs.getState().docs[id];
    expect(doc.dirty).toBe(false);
    expect(doc.path).toBe("/a/b/c.md");
    expect(doc.name).toBe("c.md");
  });

  it("no active doc", async () => {
    const r = await useDocs.getState().saveDocument("nope");
    expect(r).toEqual({ ok: false, reason: "no-active-doc" });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("no path", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    const r = await useDocs.getState().saveDocument(id);
    expect(r).toEqual({ ok: false, reason: "no-path" });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });

  it("error keeps dirty", async () => {
    const id = useDocs.getState().open({ name: "c.md", path: "/a/b/c.md", raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    mockedWriteFile.mockRejectedValueOnce(new Error("boom"));
    const r = await useDocs.getState().saveDocument(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("error");
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });
});

describe("saveDocumentAs", () => {
  it("happy path with dialog", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "hi" });
    useDocs.getState().setRaw(id, "hi there");
    mockedSaveFileDialog.mockResolvedValueOnce("/foo/bar.md");
    const r = await useDocs.getState().saveDocumentAs(id);
    expect(r).toEqual({ ok: true, path: "/foo/bar.md" });
    expect(mockedWriteFile).toHaveBeenCalledWith("/foo/bar.md", "hi there");
    expect(mockedRecentsAdd).toHaveBeenCalledWith("/foo/bar.md");
    const doc = useDocs.getState().docs[id];
    expect(doc.dirty).toBe(false);
    expect(doc.path).toBe("/foo/bar.md");
    expect(doc.name).toBe("bar.md");
  });

  it("cancel", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    mockedSaveFileDialog.mockResolvedValueOnce(null);
    const r = await useDocs.getState().saveDocumentAs(id);
    expect(r).toEqual({ ok: false, reason: "cancelled" });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });

  it("error after picking", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    mockedSaveFileDialog.mockResolvedValueOnce("/x.md");
    mockedWriteFile.mockRejectedValueOnce(new Error("disk full"));
    const r = await useDocs.getState().saveDocumentAs(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("error");
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });
});

describe("saveAllDirty", () => {
  it("saves both with dialog for unpathed", async () => {
    const id1 = useDocs.getState().open({ name: "a.md", path: "/a.md", raw: "a" });
    useDocs.getState().setRaw(id1, "a body");
    const id2 = useDocs.getState().open({ name: "b.md", path: null, raw: "b" });
    useDocs.getState().setRaw(id2, "b body");
    mockedSaveFileDialog.mockResolvedValueOnce("/b.md");
    const r = await useDocs.getState().saveAllDirty();
    expect(r.cancelled).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.saved.sort()).toEqual(["/a.md", "/b.md"].sort());
    expect(mockedWriteFile).toHaveBeenCalledWith("/a.md", "a body");
    expect(mockedWriteFile).toHaveBeenCalledWith("/b.md", "b body");
    expect(useDocs.getState().docs[id1].dirty).toBe(false);
    expect(useDocs.getState().docs[id2].dirty).toBe(false);
  });

  it("cancel mid-batch stops subsequent saves", async () => {
    const id1 = useDocs.getState().open({ name: "a.md", path: "/a.md", raw: "a" });
    useDocs.getState().setRaw(id1, "a body");
    const id2 = useDocs.getState().open({ name: "b.md", path: null, raw: "b" });
    useDocs.getState().setRaw(id2, "b body");
    const id3 = useDocs.getState().open({ name: "c.md", path: null, raw: "c" });
    useDocs.getState().setRaw(id3, "c body");
    mockedSaveFileDialog.mockResolvedValueOnce(null);
    mockedSaveFileDialog.mockResolvedValueOnce("/c.md");
    const r = await useDocs.getState().saveAllDirty();
    expect(r.cancelled).toBe(true);
    expect(r.saved).toEqual(["/a.md"]);
    expect(r.errors).toEqual([]);
    expect(useDocs.getState().docs[id1].dirty).toBe(false);
    expect(useDocs.getState().docs[id2].dirty).toBe(true);
    expect(useDocs.getState().docs[id3].dirty).toBe(true);
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith("/a.md", "a body");
  });
});

describe("scroll position", () => {
  it("defaults to 0 on open", () => {
    const id = useDocs.getState().open({ name: "a.ts", path: "/a.ts", raw: "x" });
    expect(useDocs.getState().docs[id].scrollTop).toBe(0);
  });

  it("seeds from the init object, so a restored tab lands where it was left", () => {
    const id = useDocs.getState().open({ name: "a.ts", path: "/a.ts", raw: "x", scrollTop: 480 });
    expect(useDocs.getState().docs[id].scrollTop).toBe(480);
  });

  it("updates only the target document", () => {
    const a = useDocs.getState().open({ name: "a.ts", path: "/a.ts", raw: "x" });
    const b = useDocs.getState().open({ name: "b.ts", path: "/b.ts", raw: "y" });
    useDocs.getState().setScroll(a, 120);
    expect(useDocs.getState().docs[a].scrollTop).toBe(120);
    expect(useDocs.getState().docs[b].scrollTop).toBe(0);
  });

  it("never marks the document dirty — scroll is view state, not content", () => {
    const id = useDocs.getState().open({ name: "a.ts", path: "/a.ts", raw: "x" });
    useDocs.getState().setScroll(id, 200);
    expect(useDocs.getState().docs[id].dirty).toBe(false);
  });

  it("is a no-op for an unknown id", () => {
    const before = useDocs.getState().docs;
    useDocs.getState().setScroll("doc-does-not-exist", 50);
    expect(useDocs.getState().docs).toBe(before);
  });
});

describe("document store — lifecycle races", () => {
  beforeEach(() => {
    useDocs.setState({ docs: {}, order: [], active: null, history: {} });
  });

  it("ignores writes to a document that was already closed", () => {
    // An editor's debounced onChange can land after the tab closed. The
    // unguarded spread used to resurrect a half-built ghost document.
    const id = useDocs.getState().open({ name: "a.md", raw: "one" });
    useDocs.getState().close(id);

    useDocs.getState().setRaw(id, "two");
    useDocs.getState().setCursor(id, { line: 9, col: 9 });
    useDocs.getState().setMode(id, "code");
    useDocs.getState().markClean(id);
    useDocs.getState().setName(id, "ghost");
    useDocs.getState().setPath(id, "/ghost");

    expect(useDocs.getState().docs[id]).toBeUndefined();
    expect(useDocs.getState().order).toEqual([]);
  });

  it("does not crash when history was dropped but the doc remains", () => {
    const id = useDocs.getState().open({ name: "a.md", raw: "one" });
    // Simulate a torn state: doc present, history gone.
    useDocs.setState((s) => ({ ...s, history: {} }));
    expect(() => useDocs.getState().setRaw(id, "two")).not.toThrow();
    expect(useDocs.getState().docs[id].raw).toBe("two");
  });

  it("setActive refuses an id that is not open", () => {
    const id = useDocs.getState().open({ name: "a.md" });
    useDocs.getState().setActive("doc-does-not-exist");
    expect(useDocs.getState().active).toBe(id);
  });

  it("closing a middle tab focuses its neighbour, not the last tab", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    const b = useDocs.getState().open({ name: "b.md" });
    const c = useDocs.getState().open({ name: "c.md" });
    useDocs.getState().setActive(b);
    useDocs.getState().close(b);
    expect(useDocs.getState().active).toBe(c);
    expect(useDocs.getState().order).toEqual([a, c]);
  });

  it("closing the last tab falls back to the new last", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    const b = useDocs.getState().open({ name: "b.md" });
    useDocs.getState().setActive(b);
    useDocs.getState().close(b);
    expect(useDocs.getState().active).toBe(a);
  });

  it("closing the only tab clears the active id", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    useDocs.getState().close(a);
    expect(useDocs.getState().active).toBeNull();
  });

  it("closing twice is a no-op", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    useDocs.getState().close(a);
    expect(() => useDocs.getState().close(a)).not.toThrow();
    expect(useDocs.getState().order).toEqual([]);
  });
});

describe("binary documents", () => {
  it("marks image and pdf modes binary and leaves text modes alone", () => {
    expect(isBinaryMode("image")).toBe(true);
    expect(isBinaryMode("imageedit")).toBe(true);
    expect(isBinaryMode("pdf")).toBe(true);
    expect(isBinaryMode("animation")).toBe(false);
    expect(isBinaryMode("markdown")).toBe(false);
  });

  it("derives the binary flag from the mode at open time", () => {
    const imgId = useDocs.getState().open({ name: "a.png", mode: "image", raw: "AAA" });
    const mdId = useDocs.getState().open({ name: "a.md", mode: "markdown", raw: "# hi" });
    expect(useDocs.getState().docs[imgId].binary).toBe(true);
    expect(useDocs.getState().docs[mdId].binary).toBe(false);
  });

  it("saves a binary document through the base64 writer", async () => {
    const id = useDocs.getState().open({ name: "a.png", path: "/a.png", mode: "image", raw: "QUJD" });
    const result = await useDocs.getState().saveDocument(id);
    expect(result).toEqual({ ok: true, path: "/a.png" });
    expect(mockedWriteFileBase64).toHaveBeenCalledWith("/a.png", "QUJD");
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("saves a text document through the text writer", async () => {
    const id = useDocs.getState().open({ name: "a.md", path: "/a.md", mode: "markdown", raw: "# hi" });
    await useDocs.getState().saveDocument(id);
    expect(mockedWriteFile).toHaveBeenCalledWith("/a.md", "# hi");
    expect(mockedWriteFileBase64).not.toHaveBeenCalled();
  });

  it("uses the base64 writer for Save As on a binary document", async () => {
    // clearAllMocks in beforeEach clears calls but not queued one-shot
    // results, so reset this mock before queuing our own.
    mockedSaveFileDialog.mockReset();
    mockedSaveFileDialog.mockResolvedValue("/out.png");
    const id = useDocs.getState().open({ name: "a.png", mode: "imageedit", raw: "QUJD" });
    const result = await useDocs.getState().saveDocumentAs(id);
    expect(result).toEqual({ ok: true, path: "/out.png" });
    expect(mockedWriteFileBase64).toHaveBeenCalledWith("/out.png", "QUJD");
  });

  it("refuses a mode switch that would reinterpret the bytes", () => {
    const id = useDocs.getState().open({ name: "a.png", mode: "image", raw: "QUJD" });
    useDocs.getState().setMode(id, "code");
    expect(useDocs.getState().docs[id].mode).toBe("image");
    useDocs.getState().setMode(id, "imageedit");
    expect(useDocs.getState().docs[id].mode).toBe("imageedit");
  });

  it("refuses a text document switching into a binary surface", () => {
    const id = useDocs.getState().open({ name: "a.md", mode: "markdown", raw: "# hi" });
    useDocs.getState().setMode(id, "pdf");
    expect(useDocs.getState().docs[id].mode).toBe("markdown");
  });
});

describe("streamed documents (video, audio)", () => {
  it("are binary and streamed", () => {
    expect(isBinaryMode("video")).toBe(true);
    expect(isStreamMode("audio")).toBe(true);
    expect(isStreamMode("pdf")).toBe(false);
  });

  it("never write on Save: the empty buffer would truncate the file", async () => {
    const id = useDocs.getState().open({ name: "a.mp4", path: "/a.mp4", mode: "video", raw: "" });
    const result = await useDocs.getState().saveDocument(id);
    expect(result).toEqual({ ok: true, path: "/a.mp4" });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedWriteFileBase64).not.toHaveBeenCalled();
  });

  it("copy the file on Save As and follow the copy", async () => {
    mockedSaveFileDialog.mockReset();
    mockedSaveFileDialog.mockResolvedValue("/b.mp3");
    const id = useDocs.getState().open({ name: "a.mp3", path: "/a.mp3", mode: "audio", raw: "" });
    const result = await useDocs.getState().saveDocumentAs(id);
    expect(result).toEqual({ ok: true, path: "/b.mp3" });
    expect(vi.mocked(copyPath)).toHaveBeenCalledWith("/a.mp3", "/b.mp3");
    expect(mockedWriteFileBase64).not.toHaveBeenCalled();
    expect(useDocs.getState().docs[id].path).toBe("/b.mp3");
    expect(useDocs.getState().docs[id].name).toBe("b.mp3");
  });

  it("report an existing Save As target in words", async () => {
    mockedSaveFileDialog.mockReset();
    mockedSaveFileDialog.mockResolvedValue("/taken.mp3");
    vi.mocked(copyPath).mockRejectedValueOnce({ kind: "AlreadyExists", data: { path: "/taken.mp3" } });
    const id = useDocs.getState().open({ name: "a.mp3", path: "/a.mp3", mode: "audio", raw: "" });
    const result = await useDocs.getState().saveDocumentAs(id);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error instanceof Error && result.error.message).toMatch(/already exists/);
    expect(useDocs.getState().docs[id].path).toBe("/a.mp3");
  });

  it("cannot switch to another binary surface", () => {
    const id = useDocs.getState().open({ name: "a.mp4", path: "/a.mp4", mode: "video", raw: "" });
    useDocs.getState().setMode(id, "image");
    useDocs.getState().setMode(id, "audio");
    expect(useDocs.getState().docs[id].mode).toBe("video");
    const img = useDocs.getState().open({ name: "a.png", mode: "image", raw: "QUJD" });
    useDocs.getState().setMode(img, "video");
    expect(useDocs.getState().docs[img].mode).toBe("image");
  });
});
