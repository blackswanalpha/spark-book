/* ============================================================
   sparkBook · src/editor/CodeEditor/editEvents.ts
   Edit → Find / Replace and the Selection menu, shared by the
   two CodeMirror surfaces (code and markdown). Only the active
   document's surface is mounted, so a window listener already
   reaches the right view.
   ============================================================ */
import type { EditorView } from "@codemirror/view";
import type { StateCommand } from "@codemirror/state";
import { selectAll, copyLineUp, copyLineDown, moveLineUp, moveLineDown } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";

/* Find and Replace share CodeMirror's single search panel; Replace
   only moves the caret to the panel's replace field. */
function openReplace(v: EditorView) {
  openSearchPanel(v);
  const field = v.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]");
  field?.focus();
  field?.select();
}

const SELECTION_COMMANDS: Record<string, StateCommand> = {
  "spark:selection:selectAll": selectAll,
  "spark:selection:copyLineUp": copyLineUp,
  "spark:selection:copyLineDown": copyLineDown,
  "spark:selection:moveLineUp": moveLineUp,
  "spark:selection:moveLineDown": moveLineDown,
};

/** Wire the edit/selection events to whatever view `getView` returns
    at the time; returns the cleanup for a React effect. */
export function bindEditEvents(getView: () => EditorView | null): () => void {
  const handlers: Array<[string, () => void]> = [
    ["spark:edit:find", () => { const v = getView(); if (v) openSearchPanel(v); }],
    ["spark:edit:replace", () => { const v = getView(); if (v) openReplace(v); }],
    ...Object.entries(SELECTION_COMMANDS).map(([name, cmd]): [string, () => void] => [
      name,
      () => {
        const v = getView();
        if (!v) return;
        // Menu clicks leave focus on the menu; hand it back first so the
        // selection the command produces is visible.
        v.focus();
        cmd(v);
      },
    ]),
  ];
  for (const [name, fn] of handlers) window.addEventListener(name, fn);
  return () => {
    for (const [name, fn] of handlers) window.removeEventListener(name, fn);
  };
}
