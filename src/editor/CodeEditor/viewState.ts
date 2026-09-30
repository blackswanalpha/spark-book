/* ============================================================
   sparkBook · src/editor/CodeEditor/viewState.ts

   Restoring a persisted caret and scroll offset into a CodeMirror
   view. Kept out of the component and free of DOM access so the
   position maths is unit-testable — jsdom does no layout, so the
   pixel half can only be checked by hand.
   ============================================================ */
import type { EditorState } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface ViewCursor {
  line: number;
  col: number;
}

/**
 * Absolute document offset for a 1-based (line, col), clamped to the
 * document. A restored position can point past the end when the file
 * changed on disk between quit and relaunch, so every bound is checked
 * rather than trusted.
 */
export function posFromCursor(state: EditorState, cursor: ViewCursor | undefined): number {
  if (!cursor) return 0;
  const total = state.doc.lines;
  const lineNo = Math.min(Math.max(Math.trunc(cursor.line) || 1, 1), total);
  const line = state.doc.line(lineNo);
  const col = Math.max(Math.trunc(cursor.col) || 1, 1);
  return Math.min(line.from + col - 1, line.to);
}

/** Guard a persisted scroll offset before it reaches the DOM. */
export function safeScrollTop(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/**
 * Put the caret back and, on the next frame, the scroll offset.
 *
 * The rAF is required, not defensive: CodeMirror measures on the frame
 * after construction, and a scrollTop written before that measurement is
 * discarded. Returns a canceller so the build effect's cleanup can drop
 * a pending frame when the view is torn down first.
 */
export function restoreViewState(
  view: EditorView,
  cursor: ViewCursor | undefined,
  scrollTop: unknown,
): () => void {
  const pos = posFromCursor(view.state, cursor);
  if (pos > 0) {
    view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: false });
  }
  const top = safeScrollTop(scrollTop);
  if (top === 0) return () => {};
  const frame = requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = top;
  });
  return () => cancelAnimationFrame(frame);
}

/**
 * Move the caret to (line, col) and scroll it to the middle of the view.
 * Used when a search result or `file:line` jump lands in an open editor.
 */
export function revealCursor(view: EditorView, cursor: ViewCursor): void {
  const pos = posFromCursor(view.state, cursor);
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}

/**
 * Listen for `spark:editor:reveal` aimed at `docId`. Returns a teardown.
 */
export function onRevealRequest(docId: string, view: () => EditorView | null): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<{ id: string; line: number; col?: number }>).detail;
    const v = view();
    if (!v || !d || d.id !== docId) return;
    revealCursor(v, { line: d.line, col: d.col ?? 1 });
  };
  window.addEventListener("spark:editor:reveal", handler);
  return () => window.removeEventListener("spark:editor:reveal", handler);
}

/**
 * Report scroll changes to the store, coalesced to one write per frame
 * and gated on an integer change — a flick otherwise produces a store
 * write per scroll event. Returns a teardown.
 */
export function trackScroll(view: EditorView, onScroll: (top: number) => void): () => void {
  let frame = 0;
  let last = -1;
  const handler = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const top = Math.round(view.scrollDOM.scrollTop);
      if (top === last) return;
      last = top;
      onScroll(top);
    });
  };
  view.scrollDOM.addEventListener("scroll", handler, { passive: true });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    view.scrollDOM.removeEventListener("scroll", handler);
  };
}

/* ---------- Plain scrollers ----------
   The rich surface scrolls a DOM element rather than a CodeMirror view,
   but wants the same discipline: restore on the frame after mount, and
   report back coalesced. */

/** Apply a persisted offset to a scrolling element on the next frame. */
export function restoreElementScroll(el: HTMLElement, scrollTop: unknown): () => void {
  const top = safeScrollTop(scrollTop);
  if (top === 0) return () => {};
  const frame = requestAnimationFrame(() => {
    el.scrollTop = top;
  });
  return () => cancelAnimationFrame(frame);
}

/** Report an element's scroll offset, one write per frame at most. */
export function trackElementScroll(el: HTMLElement, onScroll: (top: number) => void): () => void {
  let frame = 0;
  let last = -1;
  const handler = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const top = Math.round(el.scrollTop);
      if (top === last) return;
      last = top;
      onScroll(top);
    });
  };
  el.addEventListener("scroll", handler, { passive: true });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    el.removeEventListener("scroll", handler);
  };
}
