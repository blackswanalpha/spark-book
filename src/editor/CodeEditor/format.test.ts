/* Format Code: Prettier in the renderer, per language. */
import { describe, it, expect } from "vitest";
import { canFormat, formatErrorMessage, formatSource } from "./format";

describe("formatSource", () => {
  it("formats TypeScript and carries the caret across", async () => {
    const src = "const  a={b:1}\n";
    const res = await formatSource(src, "ts", src.indexOf("b"), 2);
    expect(res?.text).toBe("const a = { b: 1 };\n");
    expect(res && res.text[res.cursor]).toBe("b");
  });

  it("formats JSON, CSS and YAML with the given tab width", async () => {
    expect((await formatSource('{"a":[1,2]}', "json", 0, 4))?.text).toBe('{ "a": [1, 2] }\n');
    expect((await formatSource("a{color:red}", "css", 0, 2))?.text).toBe("a {\n  color: red;\n}\n");
    expect((await formatSource("a:   1", "yaml", 0, 2))?.text).toBe("a: 1\n");
  });

  it("has no formatter for languages Prettier does not parse", async () => {
    expect(canFormat("rs")).toBe(false);
    expect(await formatSource("fn main(){}", "rs", 0, 2)).toBeNull();
  });

  it("rejects text that does not parse, with a one-line reason", async () => {
    const err = await formatSource("const = ;", "ts", 0, 2).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(formatErrorMessage(err)).not.toContain("\n");
    expect(formatErrorMessage(err).length).toBeGreaterThan(0);
  });
});
