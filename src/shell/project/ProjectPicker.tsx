/* ============================================================
   sparkBook · src/shell/project/ProjectPicker.tsx

   One picker, three project-wide jobs:

     · files  — Quick Open (Ctrl+P). Fuzzy file names across the
                project; `name:42` opens at line 42.
     · search — Find in Files (Ctrl+Shift+F). Literal text across
                the project, walked by the host.
     · tasks  — Run Task (Ctrl+Shift+B). Scripts and targets the
                project declares, run in a terminal tab of their own.

   Opened by `spark:project:picker` with `{ mode }`, like every other
   shell dialog. Styled with the command palette's classes so the two
   read as one family.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as RD from "@radix-ui/react-dialog";
import { motion, AnimatePresence, overlayBackdropVariants, modalVariants } from "@motion/index";
import { Input } from "@ui/Input";
import { Icon } from "@ui/Icon";
import { listProjectFiles, searchProject, type SearchHit } from "@bridge/commands";
import { useDocs } from "@store/documents";
import { useExplorer } from "@store/explorer";
import { useProjects } from "@store/projects";
import { openPathAt } from "@shell/openDocument";
import { fuzzyMatch, highlightRuns, parseQuickOpen, rankFiles } from "./fuzzy";
import { detectTasks, lastTaskFor, runTask, type ProjectTask } from "./tasks";
import "../CommandPalette.css";
import "./ProjectPicker.css";

export type PickerMode = "files" | "search" | "tasks";

const PLACEHOLDER: Record<PickerMode, string> = {
  files: "Go to file…  (add :line to jump to a line)",
  search: "Find in files…",
  tasks: "Run a task…",
};

const SEARCH_DEBOUNCE_MS = 180;
const MAX_ROWS = 200;

/** The folder project-wide actions apply to: the project, else the tree. */
export function projectRoot(): string | null {
  return useProjects.getState().active()?.rootPath ?? useExplorer.getState().root ?? null;
}

function rel(root: string, path: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function abs(root: string, relPath: string): string {
  return root.endsWith("/") ? `${root}${relPath}` : `${root}/${relPath}`;
}

interface Row {
  key: string;
  icon: string;
  title: { text: string; hit: boolean }[];
  detail?: { text: string; hit: boolean }[];
  run: () => void;
}

function Runs({ runs }: { runs: { text: string; hit: boolean }[] }) {
  return (
    <>
      {runs.map((r, i) => (r.hit ? <mark key={i} className="pp__hl">{r.text}</mark> : <span key={i}>{r.text}</span>))}
    </>
  );
}

/** Mark the first case-folded occurrence of `needle` in `text`. */
function markLiteral(text: string, needle: string, caseSensitive: boolean) {
  const i = caseSensitive ? text.indexOf(needle) : text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0 || !needle) return [{ text, hit: false }];
  return [
    { text: text.slice(0, i), hit: false },
    { text: text.slice(i, i + needle.length), hit: true },
    { text: text.slice(i + needle.length), hit: false },
  ].filter((r) => r.text);
}

export default function ProjectPicker() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PickerMode>("files");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [root, setRoot] = useState<string | null>(null);

  const [files, setFiles] = useState<{ root: string; list: string[]; truncated: boolean } | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [hits, setHits] = useState<{ hits: SearchHit[]; truncated: boolean; files: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [tasks, setTasks] = useState<ProjectTask[] | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);

  /* ---------- Opening ---------- */

  useEffect(() => {
    const onOpen = (e: Event) => {
      const next = (e as CustomEvent<{ mode?: PickerMode }>).detail?.mode ?? "files";
      const r = projectRoot();
      setMode(next);
      setRoot(r);
      setQuery("");
      setActive(0);
      setOpen(true);
      if (next === "search") setHits(null);
      if (next === "tasks") {
        setTasks(null);
        if (r) void detectTasks(r).then(setTasks);
      }
      if (next === "files" && r) {
        setFilesError(null);
        // Listed afresh on every open (the tree changes under us); the
        // previous list stays up meanwhile when it is for this root.
        void listProjectFiles(r)
          .then((res) => setFiles({ root: r, list: res.files, truncated: res.truncated }))
          .catch((err: { kind?: string }) => setFilesError(err?.kind ?? "Could not list files"));
      }
    };
    window.addEventListener("spark:project:picker", onOpen);
    return () => window.removeEventListener("spark:project:picker", onOpen);
  }, []);

  /* ---------- Find in Files ---------- */

  useEffect(() => {
    if (!open || mode !== "search" || !root) return;
    const q = query;
    const seq = ++searchSeq.current;
    if (q.trim().length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      searchProject(root, q, caseSensitive)
        .then((res) => {
          if (seq !== searchSeq.current) return;
          setHits({ hits: res.hits, truncated: res.truncated, files: res.filesSearched });
          setActive(0);
        })
        .catch(() => {
          if (seq === searchSeq.current) setHits({ hits: [], truncated: false, files: 0 });
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, mode, root, query, caseSensitive]);

  /* ---------- Rows ---------- */

  const close = useCallback(() => setOpen(false), []);

  const rows = useMemo<Row[]>(() => {
    if (!root) return [];
    if (mode === "files") {
      if (!files || files.root !== root) return [];
      const { text, line, col } = parseQuickOpen(query);
      // Open tabs rank first on an empty query, most recent first.
      const { docs, order, active: activeDoc } = useDocs.getState();
      const recent = [activeDoc, ...[...order].reverse()]
        .map((id) => (id ? docs[id]?.path : null))
        .filter((p): p is string => Boolean(p))
        .map((p) => rel(root, p));
      return rankFiles(text, files.list, recent, MAX_ROWS).map(({ path, positions }) => {
        const slash = path.lastIndexOf("/");
        const name = path.slice(slash + 1);
        const dir = slash >= 0 ? path.slice(0, slash) : "";
        return {
          key: path,
          icon: "file",
          title: highlightRuns(name, positions.filter((p) => p > slash).map((p) => p - slash - 1)),
          detail: dir ? highlightRuns(dir, positions.filter((p) => p < slash)) : undefined,
          run: () => void openPathAt(abs(root, path), line, col),
        };
      });
    }
    if (mode === "search") {
      if (!hits) return [];
      return hits.hits.slice(0, MAX_ROWS * 2).map((h) => ({
        key: `${h.path}:${h.line}:${h.col}`,
        icon: "search",
        title: markLiteral(h.text, query, caseSensitive),
        detail: [{ text: `${rel(root, h.path)}:${h.line}`, hit: false }],
        run: () => void openPathAt(h.path, h.line, h.col),
      }));
    }
    // tasks
    if (!tasks) return [];
    const out: Row[] = [];
    const last = lastTaskFor(root);
    const q = query.trim();
    if (last && (!q || fuzzyMatch(q, last.label))) {
      out.push({
        key: `rerun:${last.id}`,
        icon: "refresh",
        title: [{ text: `Rerun ${last.label}`, hit: false }],
        detail: [{ text: last.command, hit: false }],
        run: () => runTask(root, last),
      });
    }
    for (const task of tasks) {
      const m = q ? fuzzyMatch(q, task.label) : { score: 0, positions: [] };
      if (!m) continue;
      out.push({
        key: task.id,
        icon: "terminal",
        title: highlightRuns(task.label, m.positions),
        detail: [{ text: task.detail ?? task.command, hit: false }],
        run: () => runTask(root, task),
      });
    }
    return out;
  }, [mode, root, files, hits, tasks, query, caseSensitive]);

  useEffect(() => {
    if (mode !== "search") setActive(0);
  }, [query, mode]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      close();
      row.run();
    },
    [close],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = rows.length - 1;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(last, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "PageDown") { e.preventDefault(); setActive((i) => Math.min(last, i + 10)); }
    else if (e.key === "PageUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 10)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(rows[active]); }
    else if (mode === "search" && e.altKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      setCaseSensitive((v) => !v);
    }
  };

  /* ---------- Empty and status text ---------- */

  let empty: string | null = null;
  if (!root) empty = "Open a folder first — project-wide actions work inside a project.";
  else if (rows.length === 0) {
    if (mode === "files") {
      empty = filesError ? `Could not list files: ${filesError}` : !files || files.root !== root ? "Listing files…" : `No file matches “${query}”.`;
    } else if (mode === "search") {
      empty = query.trim().length < 2 ? "Type at least two characters." : searching ? "Searching…" : `No results for “${query}”.`;
    } else {
      empty = tasks === null
        ? "Looking for tasks…"
        : tasks.length === 0
          ? "No tasks found. sparkBook reads package.json scripts, Makefile and justfile targets, Cargo.toml and go.mod."
          : `No task matches “${query}”.`;
    }
  }

  let status = "";
  if (root && mode === "files" && files?.root === root) {
    status = `${files.list.length.toLocaleString()} files${files.truncated ? " (listing cut short)" : ""}`;
  } else if (root && mode === "search" && hits) {
    status = `${hits.hits.length.toLocaleString()} match${hits.hits.length === 1 ? "" : "es"} in ${hits.files.toLocaleString()} files${hits.truncated ? " — showing the first" : ""}`;
  }

  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <AnimatePresence>
        {open && (
          <RD.Portal forceMount>
            <RD.Overlay asChild>
              <motion.div className="cp__backdrop" variants={overlayBackdropVariants} initial="initial" animate="animate" exit="exit" />
            </RD.Overlay>
            <RD.Content asChild aria-describedby={undefined}>
              <motion.div
                className="cp pp"
                variants={modalVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <RD.Title className="visually-hidden">
                  {mode === "files" ? "Go to file" : mode === "search" ? "Find in files" : "Run task"}
                </RD.Title>
                <div className="cp__search pp__search">
                  <Input
                    autoFocus
                    leadingIcon={mode === "tasks" ? "terminal" : "search"}
                    placeholder={PLACEHOLDER[mode]}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    aria-label={PLACEHOLDER[mode]}
                    aria-controls="pp-list"
                    aria-activedescendant={rows[active] ? `pp-item-${active}` : undefined}
                  />
                  {mode === "search" && (
                    <button
                      type="button"
                      className={`pp__toggle ${caseSensitive ? "is-on" : ""}`}
                      aria-pressed={caseSensitive}
                      title="Match case (Alt+C)"
                      onClick={() => setCaseSensitive((v) => !v)}
                    >
                      Aa
                    </button>
                  )}
                </div>
                <div className="cp__list" ref={listRef} role="listbox" id="pp-list">
                  <ul>
                    {empty && <li className="cp__empty">{empty}</li>}
                    {rows.map((r, i) => (
                      <li
                        key={r.key}
                        id={`pp-item-${i}`}
                        data-index={i}
                        role="option"
                        aria-selected={i === active}
                        className={`cp__item pp__item ${i === active ? "is-active" : ""}`}
                        onMouseMove={() => setActive(i)}
                        onClick={() => choose(r)}
                      >
                        <Icon name={r.icon} size={14} className="cp__icon" />
                        <span className="cp__title pp__title"><Runs runs={r.title} /></span>
                        {r.detail && <span className="pp__detail"><Runs runs={r.detail} /></span>}
                      </li>
                    ))}
                  </ul>
                </div>
                <footer className="cp__foot">
                  <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                  <span><kbd>↵</kbd> {mode === "tasks" ? "run" : "open"}</span>
                  <span><kbd>Esc</kbd> close</span>
                  {status && <span className="pp__status">{status}</span>}
                </footer>
              </motion.div>
            </RD.Content>
          </RD.Portal>
        )}
      </AnimatePresence>
    </RD.Root>
  );
}
