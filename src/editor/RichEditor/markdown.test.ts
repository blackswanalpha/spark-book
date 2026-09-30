/* Markdown through the rich surface: what goes in comes back out. */
import { describe, it, expect } from "vitest";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { loadMarkdown, richFormat, toMarkdown } from "./markdown";

const EXTENSIONS = [StarterKit, Link];
const schema = getSchema(EXTENSIONS);

function roundTrip(md: string): string {
  const load = loadMarkdown(md, EXTENSIONS);
  expect(typeof load.content).toBe("object");
  return toMarkdown(PMNode.fromJSON(schema, load.content as object));
}

describe("richFormat", () => {
  it("picks the format from the name, and refuses what rich text cannot hold", () => {
    expect(richFormat("/a/notes.md", "")).toBe("markdown");
    expect(richFormat("/a/page.html", "")).toBe("html");
    expect(richFormat("Untitled", "")).toBe("markdown");
    expect(richFormat("Untitled", "<p>x</p>")).toBe("html");
    expect(richFormat(null, "# x")).toBe("markdown");
    for (const name of ["/a/data.json", "/a/main.rs", "/a/logo.svg", "/a/notes.txt"]) {
      expect(richFormat(name, "x")).toBeNull();
    }
  });
});

describe("loadMarkdown / toMarkdown", () => {
  it("round-trips everything the editor supports without changing a byte", () => {
    const md = [
      "# Title",
      "",
      "Some **bold**, *italic*, ~~gone~~, `code` and a [link](https://example.com).",
      "A second line of the same paragraph.",
      "",
      "- one",
      "- two",
      "  - nested",
      "",
      "3. three",
      "4. four",
      "",
      "> quoted",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "---",
      "",
      "end",
      "",
    ].join("\n");
    const load = loadMarkdown(md, EXTENSIONS);
    expect(load.readOnlyReason).toBeNull();
    expect(load.normalises).toBe(false);
    expect(roundTrip(md)).toBe(md);
  });

  it("flags formatting it will rewrite, without calling it read-only", () => {
    const md = "* star bullets\n* here\n\nUnder\n=====\n";
    const load = loadMarkdown(md, EXTENSIONS);
    expect(load.readOnlyReason).toBeNull();
    expect(load.normalises).toBe(true);
    expect(roundTrip(md)).toBe("- star bullets\n- here\n\n# Under\n");
  });

  it("opens content the editor cannot hold read-only, naming what it is", () => {
    const cases: [string, string][] = [
      ["![alt](a.png)\n", "images"],
      ["| a | b |\n|---|---|\n| 1 | 2 |\n", "tables"],
      ["<div>hi</div>\n", "HTML"],
      ["---\ntitle: x\n---\n\nbody\n", "front matter"],
      ["- [ ] todo\n", "task lists"],
      ["See[^1].\n\n[^1]: note\n", "footnotes"],
    ];
    for (const [md, what] of cases) {
      const load = loadMarkdown(md, EXTENSIONS);
      expect(load.readOnlyReason, md).toContain(what);
    }
  });

  it("still shows the text of a file it could not parse", () => {
    const load = loadMarkdown("Intro\n\n![alt](a.png)\n", EXTENSIONS);
    expect(typeof load.content).toBe("string");
    expect(load.content).toContain("Intro");
  });
});
