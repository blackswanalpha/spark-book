import { describe, expect, it } from "vitest";
import { linkAt, linksIn } from "./links";

const row = (text: string, col = 0) => ({ y: 0, spans: [{ col, text }] });

describe("linksIn", () => {
  it("finds web links and trims sentence punctuation", () => {
    const links = linksIn(
      row("see https://example.com/a?b=1. and http://x.io/y"),
      80,
    );
    expect(links.map((l) => l.url)).toEqual([
      "https://example.com/a?b=1",
      "http://x.io/y",
    ]);
    expect(links[0].start).toBe(4);
  });

  it("keeps a bracket the URL opened and drops one it did not", () => {
    expect(
      linksIn(row("https://en.wikipedia.org/wiki/Rust_(language)"), 80)[0].url,
    ).toBe("https://en.wikipedia.org/wiki/Rust_(language)");
    expect(linksIn(row("(see https://a.com/b)"), 80)[0].url).toBe(
      "https://a.com/b",
    );
  });
});

describe("linkAt", () => {
  it("hits only the columns the link covers", () => {
    const r = row("go https://a.com now", 2);
    expect(linkAt(r, 5, 80)?.url).toBe("https://a.com");
    expect(linkAt(r, 17, 80)?.url).toBe("https://a.com");
    expect(linkAt(r, 19, 80)).toBeNull();
    expect(linkAt(r, 3, 80)).toBeNull();
  });
});
