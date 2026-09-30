/* ============================================================
   sparkBook · src/editor/CodeEditor/index.tsx
   CodeMirror 6-based code surface with:
     • gutter
     • syntax highlighting (Shiki themes bridged through CM6)
     • autocomplete + lint gutter
     • per-doc mode (cursor position, dirty, line wrap)
     • language detection (extension + content heuristics)
     • top toolbar: go-to-line, toggle-comment, toggle-wrap, format
     • language chip in the corner
     • listens to global spark:code:*, spark:view:toggleWordWrap,
       and the Edit / Selection menu events (see editEvents.ts)
   ============================================================ */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  keymap,
  type ViewUpdate,
} from "@codemirror/view";
import {
  EditorState,
  Compartment,
  StateCommand,
  EditorSelection,
  type ChangeSpec,
  type Extension,
} from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
  isolateHistory,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from "@codemirror/language";
import { autocompletion } from "@codemirror/autocomplete";
import { lintGutter } from "@codemirror/lint";
import { tagExtension } from "./highlightBridge";
import {
  LANG_LOADERS,
  LANG_LABELS,
  LANG_COMMENT,
  detectLangFromExt,
  detectLangFromContent,
  langFor,
  langIdOf,
} from "./languages";
import { indentUnit } from "@codemirror/language";
import { useDocs } from "@store/documents";
import { useSettings } from "@store/settings";
import { useTheme } from "@theme/ThemeProvider";
import { Button } from "@ui/Button";
import { LangLogo } from "@ui/LangLogo";
import "../editor.css";
import "./CodeEditor.css";
import { onRevealRequest, restoreViewState, trackScroll } from "./viewState";
import { bindEditEvents } from "./editEvents";
import { canFormat, formatErrorMessage, formatSource } from "./format";

/* ----------------------------------------------------------------
   Per-doc word-wrap preference (module-level ref)
   Stores word-wrap prefs by docId, plus a "current language"
   key used by the fallback comment-toggle command.
   ---------------------------------------------------------------- */
type WrapMapValue = boolean | string;
const wordWrapByDoc: Map<string, WrapMapValue> = new Map();

/* ----------------------------------------------------------------
   Comment-toggle helper (uses CodeMirror's toggleComment when
   available; falls back to a small custom command that toggles
   a per-language prefix on each selected line, or the current
   line if no selection).
   ---------------------------------------------------------------- */
type LineEditSpec = { from: number; to: number; insert: string };

const lineCommentCmd: StateCommand = ({ state, dispatch }) => {
  if (toggleComment({ state, dispatch })) return true;

  const lang = wordWrapByDoc.get("__lang__");
  const langId = typeof lang === "string" ? lang : "js";
  const prefix = LANG_COMMENT[langId] || "// ";
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.from);
  const toLine = state.doc.lineAt(sel.to);
  const changes: LineEditSpec[] = [];

  for (let n = fromLine.number; n <= toLine.number; n++) {
    const line = state.doc.line(n);
    const trimmed = line.text.trimStart();
    const leadingWS = line.text.slice(0, line.text.length - trimmed.length);
    const isCommented = trimmed.startsWith(prefix);
    const body = isCommented ? trimmed.slice(prefix.length) : prefix + trimmed;
    const insert = `${leadingWS}${body}`;
    const replaceFrom = line.from;
    const replaceTo = line.from + leadingWS.length + trimmed.length;
    changes.push({ from: replaceFrom, to: replaceTo, insert });
  }

  if (changes.length && dispatch) {
    const tr = state.update({
      changes: changes.sort((a, b) => b.from - a.from),
      selection: state.selection,
    });
    dispatch(tr);
    return true;
  }
  return false;
};

/* ----------------------------------------------------------------
   Goto-line: tiny StateCommand used by both the toolbar and
   the inline input.
   ---------------------------------------------------------------- */
const goToLineCmd = (line: number): StateCommand => ({ state, dispatch }) => {
  const total = state.doc.lines;
  const target = Math.max(1, Math.min(total, Math.floor(line)));
  const pos = state.doc.line(target).from;
  if (dispatch) {
    const tr = state.update({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    dispatch(tr);
  }
  return true;
};

/* Font size has to reach the scroller and the gutter together, or the
   line numbers stop lining up with the lines they number. */
function typeTheme(fontSize: number): Extension {
  return EditorView.theme({
    "&": { fontSize: `${fontSize}px` },
    ".cm-scroller": { fontSize: `${fontSize}px`, lineHeight: "1.55" },
    ".cm-gutters": { fontSize: `${fontSize}px` },
  });
}

/* ----------------------------------------------------------------
   Component
   ---------------------------------------------------------------- */
interface Props {
  docId: string;
  onCursor?: (c: { line: number; col: number }) => void;
}

/** Key binding → the same event the Format Code command sends. */
function requestFormat(): boolean {
  window.dispatchEvent(new CustomEvent("spark:code:format"));
  return true;
}

export function CodeEditor({ docId, onCursor }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment()).current;
  const themeComp = useRef(new Compartment()).current;
  const wrapComp = useRef(new Compartment()).current;
  /* Settings-driven extensions get their own compartments so a
     preference change reconfigures the running view instead of
     rebuilding the editor and losing history and cursor. */
  const typeComp = useRef(new Compartment()).current;
  const gutterComp = useRef(new Compartment()).current;
  const indentComp = useRef(new Compartment()).current;

  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);
  const setCursor = useDocs((s) => s.setCursor);
  const setScroll = useDocs((s) => s.setScroll);
  const { isDark } = useTheme();

  const fontSize = useSettings((s) => s.settings.editor.fontSize);
  const tabSize = useSettings((s) => s.settings.editor.tabSize);
  const showLineNumbers = useSettings((s) => s.settings.editor.lineNumbers);
  const defaultWrap = useSettings((s) => s.settings.editor.wordWrap);

  /* The build effect below runs only on docId, so it must not close over
     a stale settings snapshot; the refs give it today's values without
     making it a dependency. */
  const initialRef = useRef({ fontSize, tabSize, showLineNumbers, defaultWrap });
  initialRef.current = { fontSize, tabSize, showLineNumbers, defaultWrap };

  /* Persisted caret and scroll for this doc, read through a ref for the
     same reason: depending on doc.cursor would rebuild the whole view on
     every keystroke. */
  const restoreRef = useRef({ cursor: doc?.cursor, scrollTop: doc?.scrollTop });
  restoreRef.current = { cursor: doc?.cursor, scrollTop: doc?.scrollTop };

  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");

  // Remember the current language so the fallback comment-toggle
  // command can pick the right prefix.
  // Content sniffing only matters for the first read of an extensionless
  // file, so this is keyed on name/language and re-runs when they change.
  const currentLangId = useMemo(
    () => langIdOf(doc?.name ?? "", doc?.language, doc?.raw ?? "") ?? "",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc?.name, doc?.language],
  );
  useEffect(() => {
    wordWrapByDoc.set("__lang__", currentLangId);
  }, [currentLangId]);

  /* -- Build the editor once per docId ------------------------ */
  useEffect(() => {
    if (!ref.current || !doc) return;
    const init = initialRef.current;
    const initialWrap = wordWrapByDoc.get(docId) ?? init.defaultWrap;
    const state = EditorState.create({
      doc: doc.raw,
      extensions: [
        gutterComp.of(init.showLineNumbers ? lineNumbers() : []),
        typeComp.of(typeTheme(init.fontSize)),
        indentComp.of([EditorState.tabSize.of(init.tabSize), indentUnit.of(" ".repeat(init.tabSize))]),
        highlightActiveLine(),
        highlightSelectionMatches(),
        history(),
        bracketMatching(),
        indentOnInput(),
        foldGutter(),
        autocompletion(),
        lintGutter(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(HighlightStyle.define([
          { tag: tagExtension.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
          { tag: tagExtension.string,  color: "var(--syn-string)" },
          { tag: tagExtension.number,  color: "var(--syn-number)" },
          { tag: tagExtension.comment, color: "var(--syn-comment)", fontStyle: "italic" },
          { tag: tagExtension.variableName, color: "var(--syn-func)" },
          { tag: tagExtension.typeName, color: "var(--syn-type)" },
          { tag: tagExtension.tagName, color: "var(--syn-tag)" },
          { tag: tagExtension.attributeName, color: "var(--syn-attr)" },
          { tag: tagExtension.atom, color: "var(--syn-keyword)" },
          { tag: tagExtension.operator, color: "var(--syn-tag)" },
          { tag: tagExtension.punctuation, color: "var(--text)" },
          { tag: tagExtension.meta, color: "var(--syn-comment)", fontStyle: "italic" },
          { tag: tagExtension.invalid, color: "var(--danger)", textDecoration: "underline wavy" },
          { tag: tagExtension.heading, color: "var(--syn-keyword)", fontWeight: "700" },
          { tag: tagExtension.propertyName, color: "var(--syn-attr)" },
          { tag: tagExtension.modifier, color: "var(--syn-keyword)" },
          { tag: tagExtension.bool, color: "var(--syn-keyword)" },
          { tag: tagExtension.null, color: "var(--syn-keyword)" },
          { tag: tagExtension.regexp, color: "var(--syn-regex)" },
          { tag: tagExtension.escape, color: "var(--syn-regex)" },
          { tag: tagExtension.url, color: "var(--syn-func)", textDecoration: "underline" },
          { tag: tagExtension.emphasis, fontStyle: "italic" },
          { tag: tagExtension.strong, fontWeight: "700" },
          { tag: tagExtension.link, color: "var(--syn-func)", textDecoration: "underline" },
          { tag: tagExtension.strikethrough, textDecoration: "line-through" },
          { tag: tagExtension.inserted, color: "var(--syn-string)" },
          { tag: tagExtension.deleted, color: "var(--syn-tag)" },
          { tag: tagExtension.changed, color: "var(--syn-keyword)" },
        ])),
        keymap.of([
          // Format Code: the chord the menu shows, and VS Code's Windows
          // one. Only the menu reached it before; the keys did nothing.
          { key: "Mod-Shift-i", run: requestFormat, preventDefault: true },
          { key: "Shift-Alt-f", run: requestFormat, preventDefault: true },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
          { key: "Mod-/", run: lineCommentCmd },
        ]),
        langComp.of(langFor(doc.name, doc.language, doc.raw)),
        themeComp.of(EditorView.theme({}, { dark: isDark })),
        wrapComp.of(initialWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((v: ViewUpdate) => {
          if (v.docChanged) setRaw(docId, v.state.doc.toString());
          if (v.selectionSet || v.docChanged) {
            const pos = v.state.selection.main.head;
            const line = v.state.doc.lineAt(pos);
            const c = { line: line.number, col: pos - line.from + 1 };
            setCursor(docId, c);
            onCursor?.(c);
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: ref.current });
    viewRef.current = v;
    const cancelRestore = restoreViewState(v, restoreRef.current.cursor, restoreRef.current.scrollTop);
    const stopTracking = trackScroll(v, (top) => setScroll(docId, top));
    const stopReveal = onRevealRequest(docId, () => viewRef.current);
    return () => {
      cancelRestore();
      stopTracking();
      stopReveal();
      // One last read before the view goes: an inactive tab is unmounted,
      // so this is the only chance to record where it was left.
      setScroll(docId, Math.round(v.scrollDOM.scrollTop));
      v.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /* -- Language swap when the doc's name or language changes --
     Deliberately NOT keyed on doc.raw: content is only a tie-breaker for
     extensionless files, and depending on it re-ran langFor() and
     reconfigured the language compartment on every keystroke, re-parsing
     the whole document each character. */
  useEffect(() => {
    const v = viewRef.current;
    if (!v || !doc) return;
    v.dispatch({
      effects: langComp.reconfigure(langFor(doc.name, doc.language, v.state.doc.toString())),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.language, doc?.name]);

  /* -- Adopt changes the store made behind the editor's back --
     undo/redo, Revert File, and any future external reload write to the
     store; without this the view kept showing the old text and the next
     keystroke wrote it straight back. */
  useEffect(() => {
    const v = viewRef.current;
    if (!v || doc?.raw == null) return;
    const current = v.state.doc.toString();
    if (current === doc.raw) return;
    // Hold the cursor where it was, clamped to the new length.
    const anchor = Math.min(v.state.selection.main.anchor, doc.raw.length);
    v.dispatch({
      changes: { from: 0, to: current.length, insert: doc.raw },
      selection: { anchor },
    });
  }, [doc?.raw]);

  /* -- Theme swap -------------------------------------------- */
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({
      effects: themeComp.reconfigure(EditorView.theme({}, { dark: isDark })),
    });
  }, [isDark]);

  /* -- Settings swaps ---------------------------------------- */
  useEffect(() => {
    viewRef.current?.dispatch({ effects: typeComp.reconfigure(typeTheme(fontSize)) });
  }, [fontSize, typeComp]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: gutterComp.reconfigure(showLineNumbers ? lineNumbers() : []),
    });
  }, [showLineNumbers, gutterComp]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: indentComp.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
      ]),
    });
  }, [tabSize, indentComp]);

  /* -- Toolbar handlers -------------------------------------- */
  const openGoTo = useCallback(() => {
    setGotoOpen(true);
    setGotoValue("");
    requestAnimationFrame(() => {
      const el = ref.current?.querySelector<HTMLInputElement>(".code-editor__goto input");
      el?.focus();
      el?.select();
    });
  }, []);

  const submitGoTo = useCallback(() => {
    const n = parseInt(gotoValue, 10);
    if (Number.isFinite(n) && n > 0) {
      const v = viewRef.current;
      v?.focus();
      goToLineCmd(n)({
        state: v!.state,
        dispatch: v!.dispatch.bind(v!),
      } as never);
    }
    setGotoOpen(false);
    setGotoValue("");
  }, [gotoValue]);

  const cancelGoTo = useCallback(() => {
    setGotoOpen(false);
    setGotoValue("");
    viewRef.current?.focus();
  }, []);

  const toggleCommentAction = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    v.focus();
    lineCommentCmd({ state: v.state, dispatch: v.dispatch.bind(v) } as never);
  }, []);

  const toggleWrapAction = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    const cur = wordWrapByDoc.get(docId);
    const next = typeof cur === "boolean" ? !cur : false;
    wordWrapByDoc.set(docId, next);
    v.dispatch({
      effects: wrapComp.reconfigure(next ? EditorView.lineWrapping : []),
    });
  }, [docId]);

  const formatAction = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    if (!canFormat(currentLangId)) {
      const name = LANG_LABELS[currentLangId] || currentLangId || "plain text";
      window.dispatchEvent(
        new CustomEvent("spark:toast:info", { detail: { title: `No formatter for ${name}` } }),
      );
      return;
    }
    const before = v.state.doc.toString();
    formatSource(before, currentLangId, v.state.selection.main.head, tabSize)
      .then((res) => {
        // The view went away, or the user typed while Prettier ran:
        // replacing the document now would throw that typing away.
        if (!res || viewRef.current !== v || v.state.doc.toString() !== before) return;
        if (res.text === before) return;
        // One transaction in its own history event, so a single undo
        // restores the original and never takes recent typing with it.
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: res.text },
          selection: EditorSelection.cursor(Math.min(res.cursor, res.text.length)),
          scrollIntoView: true,
          userEvent: "format",
          annotations: isolateHistory.of("full"),
        });
      })
      .catch((err) => {
        window.dispatchEvent(
          new CustomEvent("spark:toast:error", {
            detail: { title: "Could not format", body: formatErrorMessage(err) },
          }),
        );
      });
  }, [currentLangId, tabSize]);

  /* -- Global window events ---------------------------------- */
  useEffect(() => {
    const onGoto = () => openGoTo();
    const onToggle = () => toggleCommentAction();
    const onFormat = () => formatAction();
    const onToggleWrap = () => toggleWrapAction();
    window.addEventListener("spark:code:gotoLine", onGoto);
    window.addEventListener("spark:code:toggleComment", onToggle);
    window.addEventListener("spark:code:format", onFormat);
    window.addEventListener("spark:view:toggleWordWrap", onToggleWrap);
    return () => {
      window.removeEventListener("spark:code:gotoLine", onGoto);
      window.removeEventListener("spark:code:toggleComment", onToggle);
      window.removeEventListener("spark:code:format", onFormat);
      window.removeEventListener("spark:view:toggleWordWrap", onToggleWrap);
    };
  }, [openGoTo, toggleCommentAction, formatAction, toggleWrapAction]);

  /* -- Edit / Selection menu events -------------------------- */
  useEffect(() => bindEditEvents(() => viewRef.current), []);

  if (!doc) return null;

  const langLabel = LANG_LABELS[currentLangId] || (currentLangId ? currentLangId.toUpperCase() : "Plain");
  const cursor = doc.cursor;

  return (
    <div className="code-editor">
      <div className="code-editor__toolbar" role="toolbar" aria-label="Code editor toolbar">
        <Button
          size="sm"
          variant="ghost"
          icon="search"
          aria-label="Go to line"
          title="Go to line (Ctrl+G)"
          onClick={openGoTo}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="quote"
          aria-label="Toggle line comment"
          title="Toggle line comment (Ctrl+/)"
          onClick={toggleCommentAction}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="mode-rich"
          aria-label="Toggle word wrap"
          title="Toggle word wrap"
          onClick={toggleWrapAction}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="code"
          aria-label="Format document"
          title="Format document"
          onClick={formatAction}
        />
        <span className="code-editor__divider" />
        {gotoOpen ? (
          <span className="code-editor__goto">
            <span className="code-editor__goto-label">Go to line:</span>
            <input
              type="text"
              inputMode="numeric"
              value={gotoValue}
              onChange={(e) => setGotoValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitGoTo();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelGoTo();
                }
              }}
              onBlur={() => setGotoOpen(false)}
              placeholder="1"
            />
          </span>
        ) : null}
        <span className="code-editor__spacer" />
        <span className="code-editor__status" aria-live="polite">
          <span className="code-editor__langchip">
            {currentLangId ? <LangLogo langId={currentLangId} size={14} /> : null}
            <span>{langLabel}</span>
          </span>
          <span className="code-editor__status-sep" />
          <span>Ln {cursor.line}, Col {cursor.col}</span>
          <span className="code-editor__status-sep" />
          <span>UTF-8</span>
        </span>
      </div>
      <div className="code-editor__body">
        <div ref={ref} className="editor editor--code" />
      </div>
    </div>
  );
}
