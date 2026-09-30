/* ============================================================
   sparkBook · src/store/explorer.races.test.ts
   Ordering of overlapping host calls: directory reads that answer
   out of order, and watch retargets fired faster than the host
   answers them.
   ============================================================ */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Pending<T> = { resolve: (v: T) => void; reject: (e: unknown) => void };
const reads = new Map<string, Pending<unknown>[]>();
const watches: Array<{ path: string } & Pending<string>> = [];
const unwatched: string[] = [];

vi.mock("@bridge/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bridge/commands")>();
  return {
    ...actual,
    readDir: (path: string) =>
      new Promise((resolve, reject) => {
        const list = reads.get(path) ?? [];
        list.push({ resolve, reject });
        reads.set(path, list);
      }),
    watchPath: (path: string) =>
      new Promise<string>((resolve, reject) => watches.push({ path, resolve, reject })),
    unwatchPath: async (id: string) => { unwatched.push(id); },
  };
});

const { useExplorer, stopWatching } = await import("./explorer");

const entry = (name: string) => ({ name, isDir: false, isFile: true });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("explorer — overlapping reads of one folder", () => {
  beforeEach(() => {
    reads.clear();
    useExplorer.setState({ root: "/p", children: new Map(), loading: new Set(), errors: new Map() });
  });

  it("keeps the newest listing when an older read answers last", async () => {
    const api = useExplorer.getState();
    const first = api.loadChildren("/p");
    const second = api.loadChildren("/p");
    const [older, newer] = reads.get("/p")!;

    newer.resolve([entry("new.md")]);
    await second;
    expect(useExplorer.getState().loading.has("/p")).toBe(false);

    older.resolve([entry("old.md")]);
    await first;
    expect(useExplorer.getState().children.get("/p")!.map((n) => n.name)).toEqual(["new.md"]);
  });

  it("a background re-read of an unchanged folder changes nothing", async () => {
    const api = useExplorer.getState();
    const first = api.loadChildren("/p");
    reads.get("/p")![0].resolve([entry("a.md")]);
    await first;
    const listing = useExplorer.getState().children.get("/p");

    const updates: string[] = [];
    const unsub = useExplorer.subscribe(() => updates.push("update"));
    const again = api.loadChildren("/p", { quiet: true });
    reads.get("/p")![1].resolve([entry("a.md")]);
    await again;
    unsub();

    // No update means no re-render of a folder that did not change.
    expect(updates).toEqual([]);
    expect(useExplorer.getState().children.get("/p")).toBe(listing);
  });

  it("an older read finishing first does not clear the newer read's spinner", async () => {
    const api = useExplorer.getState();
    const first = api.loadChildren("/p");
    void api.loadChildren("/p");
    const [older] = reads.get("/p")!;

    older.resolve([entry("old.md")]);
    await first;
    expect(useExplorer.getState().loading.has("/p")).toBe(true);
    expect(useExplorer.getState().children.has("/p")).toBe(false);
  });
});

describe("explorer — watch retargeting", () => {
  beforeEach(async () => {
    const stopped = stopWatching();
    for (const w of watches.splice(0)) w.resolve(`stale-${w.path}`);
    await stopped;
    watches.length = 0;
    unwatched.length = 0;
  });

  it("runs one host watch at a time and ends on the newest root", async () => {
    useExplorer.setState({ root: "/a", history: ["/a"], historyIndex: 0 });
    const api = useExplorer.getState();
    void api.navigateTo("/b");
    void api.navigateTo("/c");
    void api.navigateTo("/d");
    await flush();
    expect(watches.map((w) => w.path)).toEqual(["/b"]);

    watches[0].resolve("w-b");
    await flush();
    // /c was skipped: nobody is looking at it any more.
    expect(unwatched).toEqual(["w-b"]);
    expect(watches.map((w) => w.path)).toEqual(["/b", "/d"]);

    watches[1].resolve("w-d");
    await flush();
    expect(watches).toHaveLength(2);
    expect(unwatched).toEqual(["w-b"]);
  });

  it("a failed watch does not stop the next one", async () => {
    useExplorer.setState({ root: "/a", history: ["/a"], historyIndex: 0 });
    const api = useExplorer.getState();
    void api.navigateTo("/root-only");
    await flush();
    watches[0].reject({ kind: "PermissionDenied", data: { path: "/root-only" } });
    await flush();

    void api.navigateTo("/b");
    await flush();
    expect(watches.map((w) => w.path)).toEqual(["/root-only", "/b"]);
  });
});
