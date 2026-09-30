/* Run Task: reading the commands a project already declares. */
import { describe, it, expect, beforeEach } from "vitest";
import { justTasks, makeTargets, npmTasks, packageManager, runTask, lastTaskFor } from "./tasks";
import { useTerminal } from "@store/terminal";

describe("packageManager", () => {
  it("follows the lockfile", () => {
    expect(packageManager(new Set(["pnpm-lock.yaml"]))).toBe("pnpm");
    expect(packageManager(new Set(["yarn.lock"]))).toBe("yarn");
    expect(packageManager(new Set(["bun.lock"]))).toBe("bun");
    expect(packageManager(new Set(["package-lock.json"]))).toBe("npm");
  });
});

describe("npmTasks", () => {
  it("turns scripts into runnable commands", () => {
    const tasks = npmTasks(JSON.stringify({ scripts: { build: "vite build", test: "vitest" } }), "pnpm");
    expect(tasks.map((t) => t.command)).toEqual(["pnpm run build", "pnpm run test"]);
    expect(tasks[0].detail).toBe("vite build");
  });

  it("survives broken or script-less package.json", () => {
    expect(npmTasks("{not json", "npm")).toEqual([]);
    expect(npmTasks("{}", "npm")).toEqual([]);
    expect(npmTasks(JSON.stringify({ scripts: { odd: 3 } }), "npm")).toEqual([]);
  });
});

describe("makeTargets", () => {
  it("lists named targets and skips assignments, special and pattern rules", () => {
    const mk = [
      ".PHONY: build test",
      "CC := gcc",
      "FLAGS ?= -O2",
      "build: main.o",
      "\tgcc -o app main.o",
      "test lint: build",
      "%.o: %.c",
      "# comment: not a target",
      "build: again",
    ].join("\n");
    expect(makeTargets(mk)).toEqual(["build", "test", "lint"]);
  });
});

describe("justTasks", () => {
  it("lists recipes, including ones with parameters, and skips settings", () => {
    const jf = ["set shell := [\"bash\", \"-c\"]", "alias b := build", "build target='x':", "  cargo build", "@test:", "  cargo test"].join("\n");
    expect(justTasks(jf).map((t) => t.command)).toEqual(["just build", "just test"]);
  });
});

describe("runTask", () => {
  beforeEach(() => {
    useTerminal.setState({ isOpen: false, sessions: [], activeId: null, nextOrdinal: 1, statuses: {} });
  });

  it("opens a named tab at the root that types the command, and remembers it", () => {
    const task = { id: "npm:build", label: "npm: build", command: "npm run build", source: "npm" };
    runTask("/proj", task);
    const s = useTerminal.getState();
    expect(s.isOpen).toBe(true);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ cwd: "/proj", name: "npm: build", initialInput: "npm run build\r" });
    expect(lastTaskFor("/proj")).toBe(task);
    expect(lastTaskFor("/other")).toBeNull();
  });
});
