import { describe, expect, it } from "vitest";
import {
  initialMatch,
  offsetForLine,
  stepMatch,
  visibleMatches,
} from "./search";

describe("offsetForLine", () => {
  it("puts the line a third of the way down, clamped to the buffer", () => {
    // 100 lines of history, 24 rows: line 50 at row 8.
    const off = offsetForLine(50, 100, 24);
    expect(off).toBe(58);
    expect(50 - (100 - off)).toBe(8);
    expect(offsetForLine(0, 100, 24)).toBe(100);
    expect(offsetForLine(120, 100, 24)).toBe(0);
  });
});

describe("visibleMatches", () => {
  it("maps history lines to viewport rows", () => {
    const matches = [
      { line: 10, col: 1, len: 3 },
      { line: 110, col: 0, len: 2 },
      { line: 123, col: 4, len: 1 },
    ];
    // Live bottom: lines 100..123 are on screen.
    expect(visibleMatches(matches, 100, 0, 24)).toEqual([
      { index: 1, row: 10, col: 0, len: 2 },
      { index: 2, row: 23, col: 4, len: 1 },
    ]);
    // Scrolled all the way back: lines 0..23.
    expect(visibleMatches(matches, 100, 100, 24)).toEqual([
      { index: 0, row: 10, col: 1, len: 3 },
    ]);
  });
});

describe("stepMatch", () => {
  it("wraps in both directions and starts from the newest", () => {
    expect(
      initialMatch([
        { line: 1, col: 0, len: 1 },
        { line: 2, col: 0, len: 1 },
      ]),
    ).toBe(1);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
