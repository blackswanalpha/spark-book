/* Session helpers shared by the docked panel and the pop-out window. */
import { describe, it, expect } from "vitest";
import { cleanName, createSession, currentCwd, cycleFrom, displayName, sessionTooltip } from "./sessions";

describe("displayName", () => {
  it("prefers the user's name, then where the shell is now, then the label", () => {
    const s = createSession("/home/me/proj", "user", 1);
    expect(displayName(s)).toBe("proj");
    expect(displayName({ ...s, liveCwd: "/home/me/proj/src" })).toBe("src");
    expect(displayName({ ...s, liveCwd: "/tmp", name: "logs" })).toBe("logs");
    expect(displayName({ ...s, cwd: "/" })).toBe("Terminal 1");
  });
});

describe("currentCwd / sessionTooltip", () => {
  it("reports the live directory once the shell has moved", () => {
    const s = { ...createSession("/a", "user", 1), liveCwd: "/a/b", title: "vim" };
    expect(currentCwd(s)).toBe("/a/b");
    expect(sessionTooltip(s)).toBe("/a/b\nvim");
    expect(currentCwd(createSession("/a", "user", 2))).toBe("/a");
  });
});

describe("cycleFrom", () => {
  const list = [1, 2, 3].map((n) => createSession("/", "user", n));
  it("wraps at both ends and recovers from an unknown active id", () => {
    expect(cycleFrom(list, list[2].id, 1)).toBe(list[0].id);
    expect(cycleFrom(list, list[0].id, -1)).toBe(list[2].id);
    expect(cycleFrom(list, "gone", 1)).toBe(list[0].id);
    expect(cycleFrom([], null, 1)).toBeNull();
  });
});

describe("cleanName", () => {
  it("collapses whitespace, caps length and treats blank as none", () => {
    expect(cleanName("  a   b ")).toBe("a b");
    expect(cleanName("")).toBeNull();
    expect(cleanName(null)).toBeNull();
    expect(cleanName("x".repeat(100))).toHaveLength(60);
  });
});
