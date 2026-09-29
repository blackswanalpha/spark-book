/* ============================================================
   sparkBook · src/editor/RichEditor/index.tsx
   TipTap-based rich-text surface. Headless, schema-driven.
   Now includes a top toolbar, a slash-menu block-type picker,
   an inline link editor, and listeners for the global format,
   word-wrap, and Select All command events.
   ============================================================ */
import { useEditor, EditorContent, BubbleMenu } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDocs } from "@store/documents";
import { Icon } from "@ui/Icon";
import { Button } from "@ui/Button";
import { Input } from "@ui/Input";
import { Popover, PopoverContent } from "@ui/Popover";
import { motion } from "@motion/index";
import "../editor.css";
import "./RichEditor.css";
import { restoreElementScroll, trackElementScroll } from "@editor/CodeEditor/viewState";

/* ----------------------------------------------------------------
   Slash menu definition. A flat list of block transforms the
   user can apply from an empty paragraph.
   ---------------------------------------------------------------- */
type SlashItem = {
  id: string;
  label: string;
  icon: string;
  apply: (e: ReturnType<typeof useEditor>) => void;
  isActive?: (e: ReturnType<typeof useEditor>) => boolean;
};

const SLASH_ITEMS: SlashItem[] = [
  {
    id: "h1",
    label: "Heading 1",
    icon: "h1",
    apply: (e) => e?.chain().focus().toggleHeading({ level: 1 }).run(),
    isActive: (e) => !!e?.isActive("heading", { level: 1 }),
  },
  {
    id: "h2",
    label: "Heading 2",
    icon: "h2",
    apply: (e) => e?.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (e) => !!e?.isActive("heading", { level: 2 }),
  },
  {
    id: "h3",
    label: "Heading 3",
    icon: "h3",
    apply: (e) => e?.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (e) => !!e?.isActive("heading", { level: 3 }),
  },
  {
    id: "text",
    label: "Text",
    icon: "file",
    apply: (e) => e?.chain().focus().setParagraph().run(),
  },
  {
    id: "ul",
    label: "Bulleted list",
    icon: "list-ul",
    apply: (e) => e?.chain().focus().toggleBulletList().run(),
    isActive: (e) => !!e?.isActive("bulletList"),
  },
  {
    id: "ol",
    label: "Numbered list",
    icon: "list-ol",
    apply: (e) => e?.chain().focus().toggleOrderedList().run(),
    isActive: (e) => !!e?.isActive("orderedList"),
  },
  {
    id: "quote",
    label: "Quote",
    icon: "quote",
    apply: (e) => e?.chain().focus().toggleBlockquote().run(),
    isActive: (e) => !!e?.isActive("blockquote"),
  },
  {
    id: "code",
    label: "Code",
    icon: "code",
    apply: (e) => e?.chain().focus().toggleCodeBlock().run(),
    isActive: (e) => !!e?.isActive("codeBlock"),
  },
  {
    id: "divider",
    label: "Divider",
    icon: "divider",
    apply: (e) => e?.chain().focus().setHorizontalRule().run(),
  },
];

export function RichEditor({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  const setRaw = useDocs((s) => s.setRaw);
  const setScroll = useDocs((s) => s.setScroll);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: { HTMLAttributes: { class: "rich-code" } } }),
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: "noreferrer noopener" } }),
    ],
    content: tryParseHtml(doc?.raw) || "<p>Start writing…</p>",
    onUpdate: ({ editor }) => {
      setRaw(docId, editor.getHTML());
    },
  });

  // Local UI state
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashPos, setSlashPos] = useState<{ x: number; y: number } | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState("");
  const [wrapped, setWrapped] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  /* Persisted scroll offset, read through a ref so the effect below is
     keyed on docId alone rather than re-running on every keystroke. */
  const scrollRef = useRef(doc?.scrollTop);
  scrollRef.current = doc?.scrollTop;

  /* Restore and then track the offset of the element that actually
     scrolls — .editor, which EditorContent carries. It only exists once
     the editor has mounted, hence the editor dependency. */
  useEffect(() => {
    if (!editor) return;
    const el = containerRef.current?.querySelector<HTMLElement>(".editor--rich");
    if (!el) return;
    const cancelRestore = restoreElementScroll(el, scrollRef.current);
    const stopTracking = trackElementScroll(el, (top) => setScroll(docId, top));
    return () => {
      cancelRestore();
      stopTracking();
      // Last read before this surface unmounts — an inactive tab is not
      // rendered, so there is no later chance.
      setScroll(docId, Math.round(el.scrollTop));
    };
  }, [editor, docId, setScroll]);

  // Keep editor in sync if the doc is reset externally
  useEffect(() => {
    if (!editor || !doc) return;
    if (doc.raw && doc.raw !== editor.getHTML()) {
      // do not clobber; only if the doc was just opened
    }
  }, [docId]);

  /* ----------------------------------------------------------------
     Slash menu: detect a `/` typed at the start of an empty block
     and position the picker near the cursor.
     ---------------------------------------------------------------- */
  useEffect(() => {
    if (!editor) return;
    const root = editor.view.dom as HTMLElement;
    const onKey = (event: KeyboardEvent): void => {
      // Close on Esc
      if (event.key === "Escape" && slashOpen) {
        event.preventDefault();
        setSlashOpen(false);
        return;
      }
      // Enter / arrows only matter when the menu is open
      if (!slashOpen) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIdx((i) => (i + 1) % SLASH_ITEMS.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIdx((i) => (i - 1 + SLASH_ITEMS.length) % SLASH_ITEMS.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const item = SLASH_ITEMS[activeIdx];
        if (item) {
          // Remove the typed "/" before applying the transform
          const { from } = editor.state.selection;
          editor.chain().focus().deleteRange({ from: from - 1, to: from }).run();
          item.apply(editor);
        }
        setSlashOpen(false);
      } else if (event.key === "Backspace") {
        // If the user deletes the `/`, close the menu
        const { $from } = editor.state.selection;
        const parentText = $from.parent.textContent;
        if (!parentText || !parentText.includes("/")) {
          setSlashOpen(false);
        }
      }
    };
    const onInput = (): void => {
      const { $from } = editor.state.selection;
      const parent = $from.parent;
      const text = parent.textContent;
      // Only show on a freshly-typed "/" at the start of an empty-ish block
      if (parent.type.name !== "paragraph" && parent.type.name !== "heading") {
        setSlashOpen(false);
        return;
      }
      if (text === "/") {
        const coords = editor.view.coordsAtPos(editor.state.selection.from);
        setSlashPos({ x: coords.left, y: coords.bottom });
        setActiveIdx(0);
        setSlashOpen(true);
      } else if (slashOpen && !text.startsWith("/")) {
        setSlashOpen(false);
      }
    };
    const onBlur = (): void => {
      // Defer so click-on-item still registers
      setTimeout(() => setSlashOpen(false), 120);
    };

    root.addEventListener("keydown", onKey);
    root.addEventListener("input", onInput);
    root.addEventListener("blur", onBlur);
    return () => {
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("input", onInput);
      root.removeEventListener("blur", onBlur);
    };
  }, [editor, slashOpen, activeIdx]);

  /* ----------------------------------------------------------------
     Click outside closes the slash menu
     ---------------------------------------------------------------- */
  useEffect(() => {
    if (!slashOpen) return;
    const onDown = (e: MouseEvent): void => {
      const root = containerRef.current;
      if (!root) return;
      if (e.target instanceof Node && !root.contains(e.target)) {
        setSlashOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [slashOpen]);

  /* ----------------------------------------------------------------
     Global format events — wired by the command palette / shortcuts
     ---------------------------------------------------------------- */
  useEffect(() => {
    if (!editor) return;
    const onBold = () => editor.chain().focus().toggleBold().run();
    const onItalic = () => editor.chain().focus().toggleItalic().run();
    const onCode = () => editor.chain().focus().toggleCode().run();
    const onLink = () => openLinkEditor();
    window.addEventListener("spark:rich:format:bold", onBold);
    window.addEventListener("spark:rich:format:italic", onItalic);
    window.addEventListener("spark:rich:format:inlineCode", onCode);
    window.addEventListener("spark:rich:format:link", onLink);
    return () => {
      window.removeEventListener("spark:rich:format:bold", onBold);
      window.removeEventListener("spark:rich:format:italic", onItalic);
      window.removeEventListener("spark:rich:format:inlineCode", onCode);
      window.removeEventListener("spark:rich:format:link", onLink);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  /* ----------------------------------------------------------------
     Block formats + Select All. Promote/demote step the heading level
     the same way the markdown surface does: promote lowers the level
     number (H1 falls back to a paragraph), demote raises it up to H6.
     ---------------------------------------------------------------- */
  useEffect(() => {
    if (!editor) return;
    const shiftHeading = (delta: 1 | -1) => {
      const cur = editor.isActive("heading") ? (editor.getAttributes("heading").level as number) : 0;
      const next = Math.max(0, Math.min(6, cur + delta));
      if (next === cur) return;
      if (next === 0) editor.chain().focus().setParagraph().run();
      else editor.chain().focus().setHeading({ level: next as 1 | 2 | 3 | 4 | 5 | 6 }).run();
    };
    const onPromote = () => shiftHeading(-1);
    const onDemote = () => shiftHeading(1);
    const onBullet = () => editor.chain().focus().toggleBulletList().run();
    const onNumber = () => editor.chain().focus().toggleOrderedList().run();
    const onQuote = () => editor.chain().focus().toggleBlockquote().run();
    const onSelectAll = () => editor.chain().focus().selectAll().run();
    window.addEventListener("spark:rich:format:headingPromote", onPromote);
    window.addEventListener("spark:rich:format:headingDemote", onDemote);
    window.addEventListener("spark:rich:format:listBullet", onBullet);
    window.addEventListener("spark:rich:format:listNumber", onNumber);
    window.addEventListener("spark:rich:format:quote", onQuote);
    window.addEventListener("spark:selection:selectAll", onSelectAll);
    return () => {
      window.removeEventListener("spark:rich:format:headingPromote", onPromote);
      window.removeEventListener("spark:rich:format:headingDemote", onDemote);
      window.removeEventListener("spark:rich:format:listBullet", onBullet);
      window.removeEventListener("spark:rich:format:listNumber", onNumber);
      window.removeEventListener("spark:rich:format:quote", onQuote);
      window.removeEventListener("spark:selection:selectAll", onSelectAll);
    };
  }, [editor]);

  /* ----------------------------------------------------------------
     Word-wrap toggle (view.toggleWordWrap command)
     ---------------------------------------------------------------- */
  useEffect(() => {
    const onToggle = () => setWrapped((w) => !w);
    window.addEventListener("spark:view:toggleWordWrap", onToggle);
    return () => window.removeEventListener("spark:view:toggleWordWrap", onToggle);
  }, []);

  /* ----------------------------------------------------------------
     Link editor
     ---------------------------------------------------------------- */
  const openLinkEditor = useCallback(() => {
    if (!editor) return;
    const prev = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkHref(prev);
    setLinkOpen(true);
  }, [editor]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const href = linkHref.trim();
    if (href === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
  }, [editor, linkHref]);

  const blockCount = editor?.state.doc.childCount ?? 0;

  const slashStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!slashPos) return undefined;
    return { left: slashPos.x, top: slashPos.y + 4 };
  }, [slashPos]);

  if (!editor) return <div className="editor editor--rich" />;

  return (
    <div
      ref={containerRef}
      className={["rich-editor", wrapped ? "rich-editor--wrap" : ""].filter(Boolean).join(" ")}
    >
      {/* ---- Top toolbar -------------------------------------- */}
      <div className="rich-toolbar" role="toolbar" aria-label="Rich text formatting">
        <Button size="sm" variant="ghost" icon="bold"
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold (⌘B)" />
        <Button size="sm" variant="ghost" icon="italic"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic (⌘I)" />
        <Button size="sm" variant="ghost" icon="code"
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code" />
        <span className="rich-toolbar__divider" />
        <Button size="sm" variant="ghost" icon="link"
          onClick={openLinkEditor}
          title="Link (⌘K)" />
        <span className="rich-toolbar__divider" />
        <Button size="sm" variant="ghost" icon="h1"
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Heading 1" />
        <Button size="sm" variant="ghost" icon="h2"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading 2" />
        <Button size="sm" variant="ghost" icon="h3"
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title="Heading 3" />
        <span className="rich-toolbar__divider" />
        <Button size="sm" variant="ghost" icon="list-ul"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bulleted list" />
        <Button size="sm" variant="ghost" icon="list-ol"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list" />
        <Button size="sm" variant="ghost" icon="quote"
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Blockquote" />
        <Button size="sm" variant="ghost" icon="code"
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title="Code block" />
        <span className="rich-toolbar__divider" />
        <Button size="sm" variant="ghost" icon="divider"
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Horizontal rule" />
        <span className="rich-toolbar__spacer" />
        <span className="rich-toolbar__status" aria-live="polite">
          {blockCount} {blockCount === 1 ? "block" : "blocks"}
        </span>
      </div>

      {/* ---- Bubble menu ------------------------------------- */}
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }}>
          <motion.div
            className="rich-bubble"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.1 }}
          >
            <button
              className={`rich-bubble__btn ${editor.isActive("bold") ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleBold().run()}
              aria-label="Bold"
            ><Icon name="bold" size={14} /></button>
            <button
              className={`rich-bubble__btn ${editor.isActive("italic") ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              aria-label="Italic"
            ><Icon name="italic" size={14} /></button>
            <button
              className={`rich-bubble__btn ${editor.isActive("code") ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleCode().run()}
              aria-label="Inline code"
            ><Icon name="code" size={14} /></button>
            <span className="rich-bubble__sep" />
            <button
              className={`rich-bubble__btn ${editor.isActive("heading", { level: 1 }) ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              aria-label="Heading 1"
            ><Icon name="h1" size={14} /></button>
            <button
              className={`rich-bubble__btn ${editor.isActive("heading", { level: 2 }) ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              aria-label="Heading 2"
            ><Icon name="h2" size={14} /></button>
            <button
              className={`rich-bubble__btn ${editor.isActive("blockquote") ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              aria-label="Blockquote"
            ><Icon name="quote" size={14} /></button>
            <button
              className={`rich-bubble__btn ${editor.isActive("bulletList") ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              aria-label="Bulleted list"
            ><Icon name="list-ul" size={14} /></button>
            <button
              className={`rich-bubble__btn ${editor.isActive("orderedList") ? "is-active" : ""}`}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              aria-label="Numbered list"
            ><Icon name="list-ol" size={14} /></button>
            <span className="rich-bubble__sep" />
            <button
              className={`rich-bubble__btn ${editor.isActive("link") ? "is-active" : ""}`}
              onClick={openLinkEditor}
              aria-label="Link"
            ><Icon name="link" size={14} /></button>
          </motion.div>
        </BubbleMenu>
      )}

      {/* ---- Link popover (anchored to the bubble trigger) ---- */}
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverContent
          className="rich-linkpop"
          side="bottom"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Input
            className="rich-linkpop__field"
            inputSize="sm"
            leadingIcon="link"
            placeholder="https://…"
            value={linkHref}
            onChange={(e) => setLinkHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinkOpen(false);
              }
            }}
            autoFocus
          />
          <button
            type="button"
            className="rich-linkpop__btn rich-linkpop__btn--danger"
            title="Remove link"
            onClick={() => { setLinkHref(""); applyLink(); }}
          >
            <Icon name="close" size={12} />
          </button>
        </PopoverContent>
      </Popover>

      {/* ---- Surface ----------------------------------------- */}
      <EditorContent editor={editor} className="editor editor--rich" />

      {/* ---- Slash menu -------------------------------------- */}
      {slashOpen && slashStyle && (
        <div
          className="rich-slash"
          style={slashStyle}
          role="listbox"
          aria-label="Block type"
          onMouseDown={(e) => e.preventDefault()}
        >
          {SLASH_ITEMS.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              className={["rich-slash__item", i === activeIdx ? "is-active" : ""].filter(Boolean).join(" ")}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => {
                if (!editor) return;
                const { from } = editor.state.selection;
                editor.chain().focus().deleteRange({ from: from - 1, to: from }).run();
                item.apply(editor);
                setSlashOpen(false);
              }}
            >
              <span className="rich-slash__icon"><Icon name={item.icon} size={14} /></span>
              <span className="rich-slash__label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function tryParseHtml(s?: string): string | null {
  if (!s) return null;
  if (s.trim().startsWith("<")) return s;
  return null;
}
