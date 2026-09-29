/* ============================================================
   sparkBook · src/store/documents.ts
   Document store. Holds open documents, active doc, dirty,
   per-doc history (undo/redo).  Backed by zustand + immer.
   ============================================================ */
import { create } from "zustand";
import { produce, enableMapSet } from "immer";
import type { Document } from "@ir/types";
import { newId } from "@ir/ids";
import { writeFile, writeFileBase64, saveFileDialog, recentsAdd, copyPath } from "@bridge/commands";
import type { DialogFilter } from "@bridge/commands";

enableMapSet();

export type DocMode =
  | "markdown"
  | "rich"
  | "code"
  | "html"
  | "svg"
  /** Read-only raster image surface: pan, zoom, inspect. */
  | "image"
  /** Layered raster editor over the same bytes as `image`. */
  | "imageedit"
  /** Keyframe timeline over a `.sparkanim` JSON scene. */
  | "animation"
  /** Paged PDF reader. */
  | "pdf"
  /** Streamed video player. Read-only. */
  | "video"
  /** Streamed audio player. Read-only. */
  | "audio";

/** Modes whose `raw` holds base64-encoded bytes rather than UTF-8 text. */
export const BINARY_MODES: readonly DocMode[] = ["image", "imageedit", "pdf", "video", "audio"];

/** Modes that play straight from disk. Their `raw` is normally empty: a
    two-hour film does not belong in a string. They are never written. */
export const STREAM_MODES: readonly DocMode[] = ["video", "audio"];

export interface OpenDoc {
  id: string;
  path: string | null;          // null = unsaved buffer
  name: string;
  mode: DocMode;
  language?: string;
  ir: Document;
  /** Raw text for text modes; base64 bytes when `binary` is true. */
  raw: string;
  /** True when `raw` is base64. Set from the mode at open time and kept
      across mode switches (image ⇄ imageedit both hold the same bytes). */
  binary: boolean;
  dirty: boolean;
  cursor: { line: number; col: number };
  /** Scroll offset of the editor surface, in px. Persisted per project
      so a restored tab lands where it was left. */
  scrollTop: number;
}

/** True when documents in `mode` are stored as base64 bytes. */
export function isBinaryMode(mode: DocMode): boolean {
  return BINARY_MODES.includes(mode);
}

/** True when documents in `mode` stream from their path and are read-only. */
export function isStreamMode(mode: DocMode): boolean {
  return STREAM_MODES.includes(mode);
}

/**
 * Return the basename of a path. Accepts both POSIX ("/") and Windows ("\\")
 * separators.  Trailing separators are ignored, so "a/b/" yields "b".
 * Empty input returns "".
 */
export function basename(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; reason: "no-active-doc" | "no-path" | "cancelled" | "error"; error?: unknown };

interface State {
  docs: Record<string, OpenDoc>;
  order: string[];
  active: string | null;
  history: Record<string, { past: Snapshot[]; future: Snapshot[] }>;
}
interface Snapshot { ir: Document; raw: string }

interface Actions {
  open: (init: Partial<OpenDoc> & { name: string }) => string;
  close: (id: string) => void;
  setActive: (id: string) => void;
  setMode: (id: string, mode: DocMode) => void;
  setRaw:  (id: string, raw: string) => void;
  setIr:   (id: string, ir: Document) => void;
  setCursor: (id: string, c: { line: number; col: number }) => void;
  setScroll: (id: string, scrollTop: number) => void;
  markClean: (id: string) => void;
  undo: (id: string) => void;
  redo: (id: string) => void;
  setName: (id: string, name: string) => void;
  setPath: (id: string, path: string) => void;
  saveDocument: (id: string) => Promise<SaveResult>;
  saveDocumentAs: (
    id: string,
    opts?: { defaultPath?: string; filters?: DialogFilter[] }
  ) => Promise<SaveResult>;
  saveAllDirty: () => Promise<{
    saved: string[];
    cancelled: boolean;
    errors: Array<{ id: string; error: unknown }>;
  }>;
}

export const useDocs = create<State & Actions>((set, get) => ({
  docs: {}, order: [], active: null,
  history: {},

  open: (init) => {
    const id = newId("doc");
    const doc: OpenDoc = {
      id,
      path: init.path ?? null,
      name: init.name,
      mode: init.mode ?? "markdown",
      language: init.language,
      ir: init.ir ?? { version: 1, blocks: [] },
      raw: init.raw ?? "",
      binary: init.binary ?? isBinaryMode(init.mode ?? "markdown"),
      dirty: false,
      cursor: init.cursor ?? { line: 1, col: 1 },
      scrollTop: init.scrollTop ?? 0,
    };
    set((s) => ({
      docs: { ...s.docs, [id]: doc },
      order: [...s.order, id],
      active: id,
      history: { ...s.history, [id]: { past: [], future: [] } },
    }));
    return id;
  },

  close: (id) => set((s) => {
    if (!s.docs[id]) return s;
    const { [id]: _unusedDoc, ...rest } = s.docs;
    const { [id]: _unusedHist, ...histRest } = s.history;
    const closedIndex = s.order.indexOf(id);
    const order = s.order.filter((x) => x !== id);
    // Focus the neighbour, the way every tabbed editor does. Jumping to
    // the last tab loses the user's place when they close a middle tab.
    const nextActive =
      s.active === id ? (order[Math.min(closedIndex, order.length - 1)] ?? null) : s.active;
    return { docs: rest, history: histRest, order, active: nextActive };
  }),

  setActive: (id) => set((s) => (s.docs[id] ? { active: id } : s)),

  /* Switching between a binary and a text mode would reinterpret base64
     bytes as source text (and back), so the two families are kept apart.
     image ⇄ imageedit and every text-mode pair stay free. A streamed
     document usually holds no bytes at all, so it cannot become an image
     or a PDF either. */
  setMode: (id, mode) => set((s) => {
    const doc = s.docs[id];
    if (!doc) return s;
    if (isBinaryMode(mode) !== doc.binary) return s;
    if ((isStreamMode(mode) || isStreamMode(doc.mode)) && mode !== doc.mode) return s;
    return { docs: { ...s.docs, [id]: { ...doc, mode } } };
  }),

  setRaw: (id, raw) => {
    const before = get().docs[id];
    if (!before || before.raw === raw) return;
    set((s) => {
      // Re-check inside the updater: the doc can be closed between the
      // read above and this commit (an editor's debounced onChange racing
      // a tab close).
      const current = s.docs[id];
      if (!current) return s;
      const past = s.history[id]?.past ?? [];
      return {
        docs: { ...s.docs, [id]: { ...current, raw, dirty: true } },
        history: {
          ...s.history,
          [id]: { past: [...past, { ir: current.ir, raw: current.raw }].slice(-100), future: [] },
        },
      };
    });
  },

  setIr: (id, ir) => {
    if (!get().docs[id]) return;
    set((s) => {
      const current = s.docs[id];
      if (!current) return s;
      const past = s.history[id]?.past ?? [];
      return {
        docs: { ...s.docs, [id]: { ...current, ir, dirty: true } },
        history: {
          ...s.history,
          [id]: { past: [...past, { ir: current.ir, raw: current.raw }].slice(-100), future: [] },
        },
      };
    });
  },

  setCursor: (id, c) => set((s) => (
    s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], cursor: c } } } : s
  )),

  // Scroll is not part of the undo snapshot and never marks the doc
  // dirty: it is view state, restored on the next launch.
  setScroll: (id, scrollTop) => set((s) => {
    const doc = s.docs[id];
    if (!doc || doc.scrollTop === scrollTop) return s;
    return { docs: { ...s.docs, [id]: { ...doc, scrollTop } } };
  }),

  markClean: (id) => set((s) => (
    s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], dirty: false } } } : s
  )),

  undo: (id) => set((s) => {
    const h = s.history[id];
    if (!h || !h.past.length) return s;
    const prev = h.past[h.past.length - 1];
    const cur = s.docs[id];
    return {
      docs: { ...s.docs, [id]: { ...cur, ir: prev.ir, raw: prev.raw, dirty: true } },
      history: { ...s.history, [id]: { past: h.past.slice(0, -1), future: [{ ir: cur.ir, raw: cur.raw }, ...h.future] } },
    };
  }),

  redo: (id) => set((s) => {
    const h = s.history[id];
    if (!h || !h.future.length) return s;
    const next = h.future[0];
    const cur = s.docs[id];
    return {
      docs: { ...s.docs, [id]: { ...cur, ir: next.ir, raw: next.raw, dirty: true } },
      history: { ...s.history, [id]: { past: [...h.past, { ir: cur.ir, raw: cur.raw }], future: h.future.slice(1) } },
    };
  }),

  setName: (id, name) => set((s) => (
    s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], name } } } : s
  )),
  setPath: (id, path) => set((s) => (
    s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], path } } } : s
  )),

  saveDocument: async (id) => {
    const doc = get().docs[id];
    if (!doc) return { ok: false, reason: "no-active-doc" };
    if (doc.path == null) return { ok: false, reason: "no-path" };
    const path = doc.path;
    // The file on disk is the whole document and `raw` is usually empty:
    // writing it would truncate the media file to zero bytes.
    if (isStreamMode(doc.mode)) return { ok: true, path };
    const written = doc.raw;
    try {
      await (doc.binary ? writeFileBase64(path, written) : writeFile(path, written));
      // Only clean when the buffer still matches what reached disk. Edits
      // made while the write was in flight must stay dirty, or they are
      // silently dropped on the next close.
      if (get().docs[id]?.raw === written) get().markClean(id);
      get().setName(id, basename(path));
      await recentsAdd(path).catch(() => {});
      return { ok: true, path };
    } catch (error) {
      return { ok: false, reason: "error", error };
    }
  },

  saveDocumentAs: async (id, opts) => {
    const doc = get().docs[id];
    if (!doc) return { ok: false, reason: "no-active-doc" };
    const path = await saveFileDialog({
      defaultPath: opts?.defaultPath ?? doc.path ?? doc.name,
      filters: opts?.filters,
    });
    if (path == null || path === "") return { ok: false, reason: "cancelled" };
    // A streamed document has no buffer to write, so Save As is a copy.
    if (isStreamMode(doc.mode)) {
      if (doc.path == null) return { ok: false, reason: "no-path" };
      try {
        if (path !== doc.path) await copyPath(doc.path, path);
        get().setPath(id, path);
        get().setName(id, basename(path));
        await recentsAdd(path).catch(() => {});
        return { ok: true, path };
      } catch (error) {
        // The host copy never overwrites, even when the dialog asked.
        const exists = (error as { kind?: string } | null)?.kind === "AlreadyExists";
        return {
          ok: false, reason: "error",
          error: exists ? new Error("A file already exists there. Save the copy under a new name.") : error,
        };
      }
    }
    // Read the buffer *after* the dialog resolves: the user may have kept
    // typing while it was open, and `doc` above is a pre-dialog snapshot.
    const written = get().docs[id]?.raw ?? doc.raw;
    try {
      await (doc.binary ? writeFileBase64(path, written) : writeFile(path, written));
      get().setPath(id, path);
      get().setName(id, basename(path));
      if (get().docs[id]?.raw === written) get().markClean(id);
      await recentsAdd(path).catch(() => {});
      return { ok: true, path };
    } catch (error) {
      return { ok: false, reason: "error", error };
    }
  },

  saveAllDirty: async () => {
    const saved: string[] = [];
    const errors: Array<{ id: string; error: unknown }> = [];
    let cancelled = false;
    const dirtyIds = Object.values(get().docs).filter((d) => d.dirty).map((d) => d.id);
    for (const id of dirtyIds) {
      if (cancelled) break;
      let result = await get().saveDocument(id);
      if (!result.ok && result.reason === "no-path") {
        result = await get().saveDocumentAs(id);
      }
      if (result.ok) {
        saved.push(result.path);
      } else if (result.reason === "cancelled") {
        cancelled = true;
      } else if (result.reason === "error") {
        errors.push({ id, error: result.error });
      }
    }
    return { saved, cancelled, errors };
  },
}));

/* helpers */
export const activeDoc = () => {
  const s = useDocs.getState();
  return s.active ? s.docs[s.active] : null;
};
