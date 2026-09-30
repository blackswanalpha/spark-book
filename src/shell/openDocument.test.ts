/* sparkBook · src/shell/openDocument.test.ts
   Reading a path with the right host command is the whole job of this
   module: a PNG read as UTF-8 text is silently unrecoverable. */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@bridge/commands", async (importOriginal) => {
  // pickMode / isBinaryPath are pure; only the host reads are faked.
  const actual = await importOriginal<typeof import("@bridge/commands")>();
  return {
    ...actual,
    readFile: vi.fn(async (p: string) => `text:${p}`),
    readFileBase64: vi.fn(async (p: string) => `b64:${p}`),
    recentsAdd: vi.fn(async () => []),
    stat: vi.fn(async (p: string) => ({ path: p, isFile: true, isDir: false, size: 1, mtime: "" })),
  };
});

import { readFile, readFileBase64, recentsAdd } from "@bridge/commands";
import { useDocs } from "@store/documents";
import { openPath, findOpenDoc } from "./openDocument";

const mockedReadFile = vi.mocked(readFile);
const mockedReadBase64 = vi.mocked(readFileBase64);
const mockedRecentsAdd = vi.mocked(recentsAdd);

beforeEach(() => {
  useDocs.setState({ docs: {}, order: [], active: null, history: {} });
  vi.clearAllMocks();
});

const doc = (id: string) => useDocs.getState().docs[id];

describe("openPath", () => {
  it("reads a markdown file as text", async () => {
    const { id, mode } = await openPath("/notes.md");
    expect(mode).toBe("markdown");
    expect(mockedReadFile).toHaveBeenCalledWith("/notes.md");
    expect(mockedReadBase64).not.toHaveBeenCalled();
    expect(doc(id).binary).toBe(false);
    expect(doc(id).raw).toBe("text:/notes.md");
  });

  it("reads a PNG as base64 and opens the viewer", async () => {
    const { id, mode } = await openPath("/pic.PNG");
    expect(mode).toBe("image");
    expect(mockedReadBase64).toHaveBeenCalledWith("/pic.PNG");
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(doc(id).binary).toBe(true);
    expect(doc(id).raw).toBe("b64:/pic.PNG");
  });

  it("reads a PDF as base64 and opens the reader", async () => {
    const { id, mode } = await openPath("/report.pdf");
    expect(mode).toBe("pdf");
    expect(mockedReadBase64).toHaveBeenCalledWith("/report.pdf");
    expect(doc(id).binary).toBe(true);
  });

  it("opens a .sparkanim scene as text", async () => {
    const { id, mode } = await openPath("/intro.sparkanim");
    expect(mode).toBe("animation");
    expect(mockedReadFile).toHaveBeenCalledWith("/intro.sparkanim");
    expect(doc(id).binary).toBe(false);
  });

  it("opens video and audio without reading their bytes", async () => {
    const v = await openPath("/films/Clip.MKV");
    const a = await openPath("/music/song.flac");
    expect(v.mode).toBe("video");
    expect(a.mode).toBe("audio");
    expect(mockedReadBase64).not.toHaveBeenCalled();
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(doc(v.id).raw).toBe("");
    expect(doc(v.id).binary).toBe(true);
  });

  it("rejects a missing media file instead of opening an empty player", async () => {
    const { stat } = await import("@bridge/commands");
    vi.mocked(stat).mockRejectedValueOnce({ kind: "NotFound", path: "/gone.mp4" });
    await expect(openPath("/gone.mp4")).rejects.toMatchObject({ kind: "NotFound" });
    expect(useDocs.getState().order).toHaveLength(0);
  });

  it("keeps .ts on the code surface, not the video player", async () => {
    const { mode } = await openPath("/src/app.ts");
    expect(mode).toBe("code");
  });

  it("keeps SVG on the vector surface rather than the raster one", async () => {
    const { mode } = await openPath("/logo.svg");
    expect(mode).toBe("svg");
    expect(mockedReadFile).toHaveBeenCalledWith("/logo.svg");
  });

  it("names the tab after the file and records it in recents", async () => {
    const { id } = await openPath("/a/b/photo.jpeg");
    expect(doc(id).name).toBe("photo.jpeg");
    expect(doc(id).path).toBe("/a/b/photo.jpeg");
    expect(mockedRecentsAdd).toHaveBeenCalledWith("/a/b/photo.jpeg");
  });

  it("still opens the tab when the recents write fails", async () => {
    mockedRecentsAdd.mockRejectedValueOnce(new Error("no store"));
    const { id } = await openPath("/x.md");
    expect(doc(id)).toBeDefined();
  });

  it("propagates a read failure instead of opening an empty tab", async () => {
    mockedReadFile.mockRejectedValueOnce({ kind: "NotFound", path: "/gone.md" });
    await expect(openPath("/gone.md")).rejects.toMatchObject({ kind: "NotFound" });
    expect(useDocs.getState().order).toHaveLength(0);
  });
});

describe("openPath — one tab per file", () => {
  it("focuses the open tab instead of reading the file into a second one", async () => {
    const first = await openPath("/notes.md");
    await openPath("/other.md");
    mockedReadFile.mockClear();
    const again = await openPath("/notes.md");
    expect(again.id).toBe(first.id);
    expect(useDocs.getState().order).toHaveLength(2);
    expect(useDocs.getState().active).toBe(first.id);
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(findOpenDoc("/other.md")).not.toBeNull();
    expect(findOpenDoc("/nope.md")).toBeNull();
  });
});
