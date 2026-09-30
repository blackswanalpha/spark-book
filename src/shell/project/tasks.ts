/* ============================================================
   sparkBook · src/shell/project/tasks.ts

   Run Task: the commands a project already declares — package.json
   scripts, Makefile and justfile targets, Cargo and Go defaults —
   offered in a picker and run in a terminal tab of their own at the
   project root.

   Nothing is written into the project: tasks are read from the files
   the project already has. The last task run in each project is
   remembered for "Rerun Last Task".
   ============================================================ */
import { readDir, readFile, type DirEntry } from "@bridge/commands";
import { useTerminal } from "@store/terminal";

export interface ProjectTask {
  /** Stable within a project: `source:name`. */
  id: string;
  label: string;
  /** Typed into the shell as-is. */
  command: string;
  /** Where it came from — "npm", "make", "cargo" … */
  source: string;
  /** The script body or a hint, shown under the label. */
  detail?: string;
}

/** The package manager a lockfile implies. npm when there is none. */
export function packageManager(names: ReadonlySet<string>): string {
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  return "npm";
}

export function npmTasks(pkgJson: string, pm: string): ProjectTask[] {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(pkgJson) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (!scripts || typeof scripts !== "object") return [];
  return Object.entries(scripts as Record<string, unknown>)
    .filter(([, body]) => typeof body === "string")
    .map(([name, body]) => ({
      id: `${pm}:${name}`,
      label: `${pm}: ${name}`,
      command: `${pm} run ${name}`,
      source: pm,
      detail: body as string,
    }));
}

/**
 * Targets a user would run by name: `name:` at the start of a line, not
 * a variable assignment (`X := y`), not a special or pattern target.
 */
export function makeTargets(makefile: string): string[] {
  const out: string[] = [];
  for (const line of makefile.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.\-/ ]*?)\s*:(?![:=])/.exec(line);
    if (!m) continue;
    for (const t of m[1].split(/\s+/)) {
      if (t && !t.includes("%") && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

export function makeTasks(makefile: string): ProjectTask[] {
  return makeTargets(makefile).map((t) => ({
    id: `make:${t}`,
    label: `make: ${t}`,
    command: `make ${t}`,
    source: "make",
  }));
}

/** justfile recipes: `name args…:` at column 0, excluding settings. */
export function justTasks(justfile: string): ProjectTask[] {
  const out: ProjectTask[] = [];
  for (const line of justfile.split(/\r?\n/)) {
    const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)[^:]*:(?!=)/.exec(line);
    if (!m || out.some((t) => t.id === `just:${m[1]}`)) continue;
    out.push({ id: `just:${m[1]}`, label: `just: ${m[1]}`, command: `just ${m[1]}`, source: "just" });
  }
  return out;
}

const CARGO = ["build", "test", "run", "check", "clippy"];
const GO: [string, string][] = [["build", "go build ./..."], ["test", "go test ./..."], ["run", "go run ."]];

function fixed(source: string, entries: [string, string][]): ProjectTask[] {
  return entries.map(([name, command]) => ({
    id: `${source}:${name}`,
    label: `${source}: ${name}`,
    command,
    source,
  }));
}

function join(root: string, name: string): string {
  return root.endsWith("/") ? `${root}${name}` : `${root}/${name}`;
}

/** Every task the project at `root` declares, in a stable order. */
export async function detectTasks(root: string): Promise<ProjectTask[]> {
  let entries: DirEntry[];
  try {
    entries = await readDir(root);
  } catch {
    return [];
  }
  const names = new Set(entries.filter((e) => e.isFile).map((e) => e.name));
  const read = (name: string) => readFile(join(root, name)).catch(() => "");
  const tasks: ProjectTask[] = [];

  if (names.has("package.json")) tasks.push(...npmTasks(await read("package.json"), packageManager(names)));
  const makefile = ["Makefile", "makefile", "GNUmakefile"].find((n) => names.has(n));
  if (makefile) tasks.push(...makeTasks(await read(makefile)));
  const justfile = ["justfile", "Justfile", ".justfile"].find((n) => names.has(n));
  if (justfile) tasks.push(...justTasks(await read(justfile)));
  if (names.has("Cargo.toml")) tasks.push(...fixed("cargo", CARGO.map((c) => [c, `cargo ${c}`])));
  if (names.has("go.mod")) tasks.push(...fixed("go", GO));
  return tasks;
}

/* ---------- Running ---------- */

const lastTask = new Map<string, ProjectTask>();

/** The task last run in the project at `root`. */
export function lastTaskFor(root: string): ProjectTask | null {
  return lastTask.get(root) ?? null;
}

/**
 * Run `task` in a new terminal tab at `root`, named after the task. A
 * tab of its own keeps the output apart from whatever the user was
 * doing in their shells, and restarting the tab runs it again.
 */
export function runTask(root: string, task: ProjectTask): void {
  lastTask.set(root, task);
  const t = useTerminal.getState();
  t.open();
  t.addSession(root, { name: task.label, initialInput: `${task.command}\r` });
}
