/* sparkBook · subtitles.test.ts
   Subtitle files come from everywhere; the parser has to survive the
   common damage (CRLF, BOMs, 1252 text, stray markup) without losing
   cues that are fine. */
import { describe, it, expect } from "vitest";
import {
  parseSubtitles, parseTimestamp, parseCueLine, cuesAt, decodeSubtitleBytes, findSidecars,
} from "./subtitles";

describe("parseTimestamp", () => {
  it("reads SRT and VTT forms", () => {
    expect(parseTimestamp("01:02:03,450")).toBeCloseTo(3723.45);
    expect(parseTimestamp("00:00:01.000")).toBe(1);
    expect(parseTimestamp("02:03.5")).toBeCloseTo(123.5);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("nonsense")).toBeNull();
  });
});

describe("parseSubtitles", () => {
  it("parses SRT with CRLF line endings and a BOM", () => {
    const srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nworld\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n";
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBe(1);
    expect(cues[0].end).toBe(2.5);
    expect(cues[0].lines.map((l) => l.map((s) => s.text).join(""))).toEqual(["Hello", "world"]);
  });

  it("parses WebVTT and skips its header, NOTE and STYLE blocks", () => {
    const vtt = [
      "WEBVTT - demo", "",
      "NOTE a comment", "",
      "STYLE", "::cue { color: red }", "",
      "intro", "00:01.000 --> 00:02.000 align:start line:0", "<v Roger>Hi there</v>", "",
      "00:00:03.000 --> 00:00:05.000", "Second",
    ].join("\n");
    const cues = parseSubtitles(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].lines[0][0].text).toBe("Hi there");
    expect(cues[1].start).toBe(3);
  });

  it("drops malformed blocks but keeps the rest", () => {
    const srt = "1\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n2\ngarbage line\n\n3\n00:00:06,000 --> 00:00:07,000\nok\n";
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0].lines[0][0].text).toBe("ok");
  });

  it("sorts cues that arrive out of order", () => {
    const srt = "1\n00:00:09,000 --> 00:00:10,000\nlate\n\n2\n00:00:01,000 --> 00:00:02,000\nearly\n";
    expect(parseSubtitles(srt).map((c) => c.start)).toEqual([1, 9]);
  });
});

describe("parseCueLine", () => {
  it("keeps i/b/u and drops every other tag and ASS override", () => {
    const spans = parseCueLine('{\\an8}<font color="red">A <i>b</i> <b>c</b></font> &amp; <c.x>d</c>');
    expect(spans.map((s) => s.text).join("")).toBe("A b c & d");
    expect(spans.find((s) => s.text === "b")?.i).toBe(true);
    expect(spans.find((s) => s.text === "c")?.b).toBe(true);
    expect(spans.find((s) => s.text === "A ")?.i).toBeUndefined();
  });

  it("never produces markup from cue text", () => {
    const spans = parseCueLine("<script>alert(1)</script>");
    expect(spans.map((s) => s.text).join("")).toBe("alert(1)");
  });
});

describe("cuesAt", () => {
  const cues = parseSubtitles(
    "1\n00:00:01,000 --> 00:00:05,000\nlong\n\n2\n00:00:02,000 --> 00:00:03,000\nshort\n",
  );
  it("returns every overlapping cue", () => {
    expect(cuesAt(cues, 2.5).map((c) => c.lines[0][0].text)).toEqual(["long", "short"]);
  });
  it("treats end as exclusive", () => {
    expect(cuesAt(cues, 5)).toEqual([]);
    expect(cuesAt(cues, 0.5)).toEqual([]);
  });
});

describe("decodeSubtitleBytes", () => {
  it("falls back to Windows-1252 when the bytes are not UTF-8", () => {
    // "café" in 1252: é = 0xE9, which is invalid as a lone UTF-8 byte.
    expect(decodeSubtitleBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
  });
  it("honours a UTF-16LE BOM", () => {
    expect(decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe("hi");
  });
  it("reads plain UTF-8", () => {
    expect(decodeSubtitleBytes(new TextEncoder().encode("naïve"))).toBe("naïve");
  });
});

describe("findSidecars", () => {
  it("matches the exact stem first, then language variants, case-insensitively", () => {
    const found = findSidecars("Film.mp4", ["film.en.srt", "Film.srt", "other.srt", "Film.mp4", "film.fr.vtt", "Film.txt"]);
    expect(found).toEqual([
      { name: "Film.srt", label: "SRT" },
      { name: "film.en.srt", label: "en" },
      { name: "film.fr.vtt", label: "fr" },
    ]);
  });
  it("does not match a longer name that merely starts with the stem", () => {
    expect(findSidecars("a.mp4", ["ab.srt", "a-b.srt"])).toEqual([]);
  });
});
