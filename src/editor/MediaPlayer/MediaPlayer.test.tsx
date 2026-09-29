/* sparkBook · MediaPlayer.test.tsx
   The players are read-only views over a media element. These tests
   pin the wiring: keys reach the element, errors become words, sidecar
   subtitles are found, tags are shown, and the document is never
   touched. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
vi.stubGlobal("URL", Object.assign(URL, {
  createObjectURL: vi.fn(() => "blob:mock"),
  revokeObjectURL: vi.fn(),
}));

vi.mock("@bridge/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bridge/commands")>();
  return {
    ...actual,
    readDir: vi.fn(async () => [
      { name: "clip.webm", isFile: true, isDir: false },
      { name: "clip.en.srt", isFile: true, isDir: false },
      { name: "notes.md", isFile: true, isDir: false },
    ]),
    readFileBase64: vi.fn(async () => btoa("1\n00:00:01,000 --> 00:00:03,000\nHello <i>there</i>\n")),
    stat: vi.fn(async (p: string) => ({ path: p, isFile: true, isDir: false, size: 10, mtime: "" })),
    openWithOS: vi.fn(async () => undefined),
  };
});

import { useDocs } from "@store/documents";
import { readDir } from "@bridge/commands";
import { MediaPlayer } from "./index";

const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
  Object.defineProperty(this, "paused", { configurable: true, value: false });
  this.dispatchEvent(new Event("play"));
  return Promise.resolve();
});
const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
  Object.defineProperty(this, "paused", { configurable: true, value: true });
  this.dispatchEvent(new Event("pause"));
});
vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});

function openMedia(name: string, mode: "video" | "audio", raw = "AAAA") {
  return useDocs.getState().open({ name, path: `/media/${name}`, mode, raw });
}

/** Render and let the async source, sidecar and tag effects settle. */
async function mount(id: string) {
  let out!: ReturnType<typeof render>;
  await act(async () => { out = render(<MediaPlayer docId={id} />); });
  return out;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useDocs.setState({ docs: {}, order: [], active: null, history: {} });
  play.mockClear();
  pause.mockClear();
});

describe("VideoPlayer", () => {
  it("renders the transport and plays from the keyboard", async () => {
    const id = openMedia("clip.webm", "video");
    const { container } = await mount(id);
    expect(container.querySelector("video")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeTruthy();
    expect(screen.getByLabelText("Fullscreen")).toBeTruthy();

    const root = screen.getByLabelText("Video player: clip.webm");
    fireEvent.keyDown(root, { key: " " });
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(root, { key: "k" });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl/Cmd shortcuts to the app", async () => {
    const id = openMedia("clip.webm", "video");
    await mount(id);
    const root = screen.getByLabelText("Video player: clip.webm");
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("mutes with M and remembers it", async () => {
    const id = openMedia("clip.webm", "video");
    const { container } = await mount(id);
    const video = container.querySelector("video")!;
    fireEvent.keyDown(screen.getByLabelText("Video player: clip.webm"), { key: "m" });
    expect(video.muted).toBe(true);
    fireEvent(video, new Event("volumechange"));
    expect(JSON.parse(localStorage.getItem("spark.media.prefs")!).muted).toBe(true);
  });

  it("opens and closes the shortcut sheet", async () => {
    const id = openMedia("clip.webm", "video");
    await mount(id);
    fireEvent.keyDown(screen.getByLabelText("Video player: clip.webm"), { key: "?" });
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(sheet.textContent).toContain("Previous / next frame");
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("finds sidecar subtitles and lists them in the CC menu", async () => {
    const id = openMedia("clip.webm", "video");
    await mount(id);
    await waitFor(() => expect(vi.mocked(readDir)).toHaveBeenCalledWith("/media"));
    fireEvent.click(screen.getByLabelText("Subtitles"));
    expect(await screen.findByText("en")).toBeTruthy();
  });

  it("turns an unsupported format into an explanation", async () => {
    const id = openMedia("clip.mkv", "video");
    const { container } = await mount(id);
    const video = container.querySelector("video")!;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    act(() => { video.dispatchEvent(new Event("error")); });
    expect(screen.getByRole("alert").textContent).toContain("This MKV file cannot be played here.");
  });

  it("never marks the document dirty or changes its bytes", async () => {
    const id = openMedia("clip.webm", "video");
    await mount(id);
    const root = screen.getByLabelText("Video player: clip.webm");
    for (const key of [" ", "ArrowRight", "ArrowUp", ">", "b", "r", "c"]) fireEvent.keyDown(root, { key });
    expect(useDocs.getState().docs[id].dirty).toBe(false);
    expect(useDocs.getState().docs[id].raw).toBe("AAAA");
  });
});

describe("AudioPlayer", () => {
  function id3Title(title: string): string {
    const text = [3, ...new TextEncoder().encode(title)];
    const frame = [..."TIT2"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, text.length, 0, 0], text);
    const size = frame.length;
    const bytes = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (size >> 7) & 0x7f, size & 0x7f, ...frame];
    return btoa(String.fromCharCode(...bytes));
  }

  it("shows the title from the file's tags", async () => {
    const id = openMedia("track01.mp3", "audio", id3Title("Blue in Green"));
    await mount(id);
    expect(await screen.findByRole("heading", { name: "Blue in Green" })).toBeTruthy();
    expect(screen.getByText(/MP3/)).toBeTruthy();
  });

  it("falls back to the file name and has no picture controls", async () => {
    const id = openMedia("take 3.wav", "audio");
    await mount(id);
    expect(screen.getByRole("heading", { name: "take 3" })).toBeTruthy();
    expect(screen.queryByLabelText("Fullscreen")).toBeNull();
    const root = screen.getByLabelText("Audio player: take 3.wav");
    fireEvent.keyDown(root, { key: "f" });
    fireEvent.keyDown(root, { key: " " });
    expect(play).toHaveBeenCalledTimes(1);
  });
});
