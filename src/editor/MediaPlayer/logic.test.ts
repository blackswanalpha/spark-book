/* sparkBook · logic.test.ts
   Pure pieces of the media players: clock formatting, key map, peaks,
   tag reading and the remembered state. */
import { describe, it, expect, beforeEach } from "vitest";
import { formatTime, formatRate, stepRate, snapFps } from "./time";
import { keyToAction } from "./keymap";
import { computePeaks, resamplePeaks } from "./peaks";
import { readTags } from "./tags";
import { loadPrefs, savePrefs, loadResume, saveResume, RESUME_LIMIT } from "./prefs";
import { describeMediaError } from "./source";
import { dirOf } from "./videoHooks";

describe("formatTime", () => {
  it("formats minutes and hours", () => {
    expect(formatTime(7)).toBe("0:07");
    expect(formatTime(245)).toBe("4:05");
    expect(formatTime(3723)).toBe("1:02:03");
  });
  it("keeps the hour column when the reference duration has one", () => {
    expect(formatTime(65, 4000)).toBe("0:01:05");
  });
  it("handles unknown and negative values", () => {
    expect(formatTime(NaN)).toBe("--:--");
    expect(formatTime(Infinity)).toBe("--:--");
    expect(formatTime(-5)).toBe("-0:05");
  });
});

describe("rates", () => {
  it("steps through the list and clamps at the ends", () => {
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
    expect(stepRate(4, 1)).toBe(4);
    expect(stepRate(0.25, -1)).toBe(0.25);
    expect(stepRate(1.1, 1)).toBe(1.25);
  });
  it("formats", () => {
    expect(formatRate(1)).toBe("1×");
    expect(formatRate(0.25)).toBe("0.25×");
  });
  it("snaps measured frame rates", () => {
    expect(snapFps(29.8)).toBe(29.97);
    expect(snapFps(24.2)).toBe(24);
    expect(snapFps(12)).toBe(12);
  });
});

describe("keyToAction", () => {
  it("maps the YouTube-style keys", () => {
    expect(keyToAction({ key: " " }, "video")).toEqual({ type: "toggle" });
    expect(keyToAction({ key: "K" }, "video")).toEqual({ type: "toggle" });
    expect(keyToAction({ key: "ArrowRight" }, "video")).toEqual({ type: "seekBy", seconds: 5 });
    expect(keyToAction({ key: "ArrowLeft", shiftKey: true }, "video")).toEqual({ type: "seekBy", seconds: -1 });
    expect(keyToAction({ key: "l" }, "audio")).toEqual({ type: "seekBy", seconds: 10 });
    expect(keyToAction({ key: "7" }, "video")).toEqual({ type: "seekFraction", fraction: 0.7 });
    expect(keyToAction({ key: ">" }, "video")).toEqual({ type: "rate", dir: 1 });
  });
  it("leaves app shortcuts alone", () => {
    expect(keyToAction({ key: "s", ctrlKey: true }, "video")).toBeNull();
    expect(keyToAction({ key: "k", metaKey: true }, "video")).toBeNull();
    expect(keyToAction({ key: "ArrowLeft", altKey: true }, "video")).toBeNull();
  });
  it("gives audio no picture controls", () => {
    expect(keyToAction({ key: "f" }, "audio")).toBeNull();
    expect(keyToAction({ key: "c" }, "audio")).toBeNull();
    expect(keyToAction({ key: "." }, "audio")).toBeNull();
    expect(keyToAction({ key: "f" }, "video")).toEqual({ type: "fullscreen" });
  });
});

describe("peaks", () => {
  it("keeps min and max per bucket across channels", () => {
    const l = new Float32Array([0.1, -0.5, 0.2, 0.9]);
    const r = new Float32Array([-0.8, 0.3, 0.0, 0.1]);
    const p = computePeaks([l, r], 2);
    expect(Array.from(p)).toEqual([expect.closeTo(-0.8), expect.closeTo(0.3), 0, expect.closeTo(0.9)]);
  });
  it("resamples by keeping extremes", () => {
    const p = new Float32Array([-0.1, 0.1, -0.9, 0.2, -0.3, 0.8, 0, 0]);
    expect(Array.from(resamplePeaks(p, 2))).toEqual([expect.closeTo(-0.9), expect.closeTo(0.2), expect.closeTo(-0.3), expect.closeTo(0.8)]);
  });
  it("returns the input when asked for more pairs than it has", () => {
    const p = new Float32Array([0, 1]);
    expect(resamplePeaks(p, 10)).toBe(p);
  });
});

/* ---------- Tag fixtures ---------- */

function synchsafe(n: number) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}
function be32(n: number) {
  return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function le32(n: number) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}
const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const latin1 = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function id3v23(frames: Array<[string, number[]]>): Uint8Array {
  const body: number[] = [];
  for (const [id, data] of frames) body.push(...latin1(id), ...be32(data.length), 0, 0, ...data);
  body.push(0, 0, 0, 0); // padding
  return new Uint8Array([...latin1("ID3"), 3, 0, 0, ...synchsafe(body.length), ...body]);
}

describe("readTags", () => {
  it("reads ID3v2.3 text frames in each encoding and prefers the front cover", () => {
    const utf16 = [1, 0xff, 0xfe, ...Array.from("Artïst", (c) => [c.charCodeAt(0), 0]).flat()];
    const bytes = id3v23([
      ["TIT2", [3, ...enc("Tïtle")]],
      ["TPE1", utf16],
      ["TALB", [0, ...latin1("Album")]],
      ["TYER", [0, ...latin1("1999")]],
      ["APIC", [0, ...latin1("image/png"), 0, 0, ...latin1("back"), 0, 1, 2]],
      ["APIC", [0, ...latin1("image/jpeg"), 0, 3, 0, 9, 9, 9]],
    ]);
    const tags = readTags(bytes)!;
    expect(tags.title).toBe("Tïtle");
    expect(tags.artist).toBe("Artïst");
    expect(tags.album).toBe("Album");
    expect(tags.year).toBe("1999");
    expect(tags.picture?.mime).toBe("image/jpeg");
    expect(Array.from(tags.picture!.data)).toEqual([9, 9, 9]);
  });

  it("reads FLAC Vorbis comments and the picture block", () => {
    const vendor = enc("ref");
    const comments = ["TITLE=Song", "ARTIST=Band", "ALBUM=Record", "DATE=2021-05-01"].map(enc);
    const vc = [...le32(vendor.length), ...vendor, ...le32(comments.length), ...comments.flatMap((c) => [...le32(c.length), ...c])];
    const mime = latin1("image/png");
    const pic = [...be32(3), ...be32(mime.length), ...mime, ...be32(0), ...be32(1), ...be32(1), ...be32(24), ...be32(0), ...be32(2), 7, 7];
    const block = (type: number, data: number[], last = false) =>
      [(last ? 0x80 : 0) | type, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff, ...data];
    const streaminfo = new Array(34).fill(0);
    const bytes = new Uint8Array([...latin1("fLaC"), ...block(0, streaminfo), ...block(4, vc), ...block(6, pic, true)]);
    const tags = readTags(bytes)!;
    expect(tags).toMatchObject({ title: "Song", artist: "Band", album: "Record", year: "2021" });
    expect(tags.picture?.mime).toBe("image/png");
    expect(Array.from(tags.picture!.data)).toEqual([7, 7]);
  });

  it("returns null for untagged or truncated input instead of throwing", () => {
    expect(readTags(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBeNull();
    const truncated = id3v23([["TIT2", [3, ...enc("Cut")]]]).subarray(0, 14);
    expect(() => readTags(truncated)).not.toThrow();
  });
});

describe("prefs", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips volume and rejects out-of-range values", () => {
    savePrefs({ volume: 0.4, muted: true });
    expect(loadPrefs()).toMatchObject({ volume: 0.4, muted: true });
    localStorage.setItem("spark.media.prefs", JSON.stringify({ volume: 7 }));
    expect(loadPrefs().volume).toBe(1);
    localStorage.setItem("spark.media.prefs", "{not json");
    expect(loadPrefs().volume).toBe(1);
  });

  it("remembers a mid-file position and forgets it at either end", () => {
    saveResume("/a.mp4", 120, 600);
    expect(loadResume("/a.mp4", 600)).toBe(120);
    saveResume("/a.mp4", 598, 600);
    expect(loadResume("/a.mp4", 600)).toBeNull();
    saveResume("/a.mp4", 2, 600);
    expect(loadResume("/a.mp4", 600)).toBeNull();
  });

  it("caps how many files it remembers", () => {
    for (let i = 0; i < RESUME_LIMIT + 5; i++) saveResume(`/f${i}.mp4`, 60, 600);
    const map = JSON.parse(localStorage.getItem("spark.media.resume")!);
    expect(Object.keys(map)).toHaveLength(RESUME_LIMIT);
  });
});

describe("describeMediaError", () => {
  it("names the format when the engine cannot play it", () => {
    expect(describeMediaError(4, "/x/clip.mkv").title).toBe("This MKV file cannot be played here.");
    expect(describeMediaError(2, "/x/clip.mp4").title).toMatch(/could not be read/);
  });
});

describe("dirOf", () => {
  it("handles POSIX, root and Windows paths", () => {
    expect(dirOf("/a/b/c.mp4")).toBe("/a/b");
    expect(dirOf("/c.mp4")).toBe("/");
    expect(dirOf("C:\\Videos\\c.mp4")).toBe("C:\\Videos");
    expect(dirOf("C:\\c.mp4")).toBe("C:\\");
  });
});
