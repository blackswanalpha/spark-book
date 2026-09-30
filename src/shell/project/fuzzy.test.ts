/* Quick Open ranking: what people type should find what they meant. */
import { describe, it, expect } from "vitest";
import { fuzzyMatch, highlightRuns, parseQuickOpen, rankFiles } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence case-insensitively and rejects the rest", () => {
    expect(fuzzyMatch("apts", "src/App.tsx")).not.toBeNull();
    expect(fuzzyMatch("xyz", "src/App.tsx")).toBeNull();
  });

  it("ignores spaces in the query", () => {
    expect(fuzzyMatch("src app", "src/App.tsx")).not.toBeNull();
  });

  it("prefers word starts over the first occurrence", () => {
    const m = fuzzyMatch("ts", "tab_store.ts");
    expect(m?.positions).toEqual([0, 4]);
  });

  it("falls back to the first occurrence when a word start cannot finish", () => {
    // Jumping to "s"tore would leave no "a" after it.
    const m = fuzzyMatch("sa", "xsa_store");
    expect(m?.positions).toEqual([1, 2]);
  });
});

describe("rankFiles", () => {
  const files = ["docs/app-notes.md", "src/App.tsx", "src/shell/SideBar.tsx", "src/store/app.ts"];

  it("ranks a file-name match above a path-spread one", () => {
    const [first] = rankFiles("sidebar", files);
    expect(first.path).toBe("src/shell/SideBar.tsx");
  });

  it("puts shorter, tighter matches first on ties", () => {
    const ranked = rankFiles("app", files).map((r) => r.path);
    expect(ranked.slice(0, 2).sort()).toEqual(["src/App.tsx", "src/store/app.ts"]);
    expect(ranked).toContain("docs/app-notes.md");
  });

  it("leads with recent files on an empty query and dedupes them", () => {
    const ranked = rankFiles("", files, ["src/store/app.ts"], 3).map((r) => r.path);
    expect(ranked).toEqual(["src/store/app.ts", "docs/app-notes.md", "src/App.tsx"]);
  });

  it("respects the limit", () => {
    expect(rankFiles("s", files, [], 2)).toHaveLength(2);
  });
});

describe("parseQuickOpen", () => {
  it("splits a trailing line and column", () => {
    expect(parseQuickOpen("App.tsx:42")).toEqual({ text: "App.tsx", line: 42 });
    expect(parseQuickOpen("App.tsx:42:7")).toEqual({ text: "App.tsx", line: 42, col: 7 });
  });

  it("leaves a plain query alone", () => {
    expect(parseQuickOpen(" app ")).toEqual({ text: "app" });
    expect(parseQuickOpen(":12")).toEqual({ text: ":12" });
  });
});

describe("highlightRuns", () => {
  it("groups adjacent characters into runs", () => {
    expect(highlightRuns("abcd", [1, 2])).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
      { text: "d", hit: false },
    ]);
  });
});
