/* ============================================================
   sparkBook · src/editor/RichEditor/markdown.ts

   Markdown in and out of the rich-text surface.

   The rich editor used to accept only HTML. A markdown file switched
   to rich mode showed an empty page, and the first keystroke replaced
   the whole file with HTML. Now a markdown document is parsed into the
   editor's own schema and every edit is written back as markdown.

   Only what the editor can hold is editable. Markdown that carries
   anything else — images, tables, raw HTML, front matter, task lists,
   footnotes — opens read-only, because re-serialising it would drop
   that content from the file.

   Parsing and serialising use prosemirror-markdown (shipped with
   @tiptap/pm) over markdown-it, mapped onto TipTap's node names.
   ============================================================ */
import MarkdownIt from "markdown-it";
import { getSchema, type AnyExtension, type JSONContent } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
  type MarkdownSerializerState,
} from "@tiptap/pm/markdown";
import { renderMd } from "@editor/MarkdownEditor/renderMd";

/** What the rich surface stores for a document, from its name and text. */
export type RichFormat = "html" | "markdown";

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;
const HTML_EXT = /\.html?$/i;

/**
 * The format rich mode reads and writes for a document, or null when rich
 * text cannot represent it at all (JSON, source code, SVG, plain text…).
 * A document with no extension — a new, unsaved one — is markdown unless
 * it already holds HTML.
 */
export function richFormat(name: string | null, raw: string): RichFormat | null {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  if (HTML_EXT.test(base)) return "html";
  if (MARKDOWN_EXT.test(base)) return "markdown";
  if (!base.includes(".")) return raw.trimStart().startsWith("<") ? "html" : "markdown";
  return null;
}

/* ---------- Parsing ---------- */

const tokenizer = new MarkdownIt("commonmark", { html: true }).enable(["strikethrough", "table"]);

/** Constructs recognised in the source that the editor has no node for. */
const UNSUPPORTED_TOKENS: Record<string, string> = {
  image: "images",
  html_block: "HTML",
  html_inline: "HTML",
  table_open: "tables",
};

function makeParser(schema: Schema): MarkdownParser {
  const parser = new MarkdownParser(schema, tokenizer, {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList" },
    ordered_list: {
      block: "orderedList",
      getAttrs: (tok) => ({ start: Number(tok.attrGet("start")) || 1 }),
    },
    heading: { block: "heading", getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (tok) => ({ language: tok.info.trim() || null }),
      noCloseToken: true,
    },
    hr: { node: "horizontalRule" },
    hardbreak: { node: "hardBreak" },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    link: {
      mark: "link",
      getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }),
    },
    code_inline: { mark: "code", noCloseToken: true },
  });
  // A soft line break stays a newline, so a paragraph wrapped at 80
  // columns in the file is still wrapped there after an edit elsewhere.
  // `tokenHandlers` is a runtime field the typings mark internal.
  const handlers = (parser as unknown as {
    tokenHandlers: Record<string, (state: { addText: (t: string) => void }) => void>;
  }).tokenHandlers;
  handlers.softbreak = (state) => state.addText("\n");
  return parser;
}

/* ---------- Serialising ---------- */

const serializer = new MarkdownSerializer(
  {
    blockquote: defaultMarkdownSerializer.nodes.blockquote,
    paragraph: defaultMarkdownSerializer.nodes.paragraph,
    heading: defaultMarkdownSerializer.nodes.heading,
    listItem: defaultMarkdownSerializer.nodes.list_item,
    hardBreak: defaultMarkdownSerializer.nodes.hard_break,
    text: defaultMarkdownSerializer.nodes.text,
    horizontalRule(state: MarkdownSerializerState, node: PMNode) {
      state.write("---");
      state.closeBlock(node);
    },
    bulletList(state: MarkdownSerializerState, node: PMNode) {
      state.renderList(node, "  ", () => "- ");
    },
    orderedList(state: MarkdownSerializerState, node: PMNode) {
      const start = Number(node.attrs.start) || 1;
      const maxW = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxW + 2);
      state.renderList(node, space, (i: number) => {
        const n = String(start + i);
        return state.repeat(" ", maxW - n.length) + n + ". ";
      });
    },
    codeBlock(state: MarkdownSerializerState, node: PMNode) {
      // A fence longer than any backtick run inside the code.
      const runs = node.textContent.match(/`{3,}/gm);
      const fence = runs ? runs.sort().slice(-1)[0] + "`" : "```";
      state.write(fence + (node.attrs.language || "") + "\n");
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
  },
  {
    italic: defaultMarkdownSerializer.marks.em,
    bold: defaultMarkdownSerializer.marks.strong,
    link: defaultMarkdownSerializer.marks.link,
    code: defaultMarkdownSerializer.marks.code,
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  },
);

/** The editor's document as markdown. Lists are written tight. */
export function toMarkdown(doc: PMNode): string {
  const out = serializer.serialize(doc, { tightLists: true });
  return out.endsWith("\n") ? out : `${out}\n`;
}

/* ---------- Loading ---------- */

export interface MarkdownLoad {
  /** The document in the editor's schema — or, when it could not be
      parsed into it, HTML from the preview renderer so the read-only
      view still shows the text. */
  content: JSONContent | string;
  /** Why it cannot be edited here, or null when it can. */
  readOnlyReason: string | null;
  /** Editing will rewrite some of the file's markdown formatting (list
      markers, emphasis style, blank lines) though not its content. */
  normalises: boolean;
}

/* Recognised by pattern rather than by token: commonmark reads them as
   ordinary text, so the parse "succeeds" and the meaning is lost. */
const TEXT_LEVEL_UNSUPPORTED: [RegExp, string][] = [
  [/^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)\s*(\r?\n|$)/, "front matter"],
  [/^\s*[-*+]\s+\[[ xX]\]\s/m, "task lists"],
  [/\[\^[^\]\s]+\]/, "footnotes"],
];

const schemaCache = new WeakMap<readonly AnyExtension[], { schema: Schema; parser: MarkdownParser }>();

function parserFor(extensions: readonly AnyExtension[]) {
  let hit = schemaCache.get(extensions);
  if (!hit) {
    const schema = getSchema([...extensions]);
    hit = { schema, parser: makeParser(schema) };
    schemaCache.set(extensions, hit);
  }
  return hit;
}

function unsupportedIn(md: string): string[] {
  const found = new Set<string>();
  for (const [re, what] of TEXT_LEVEL_UNSUPPORTED) if (re.test(md)) found.add(what);
  const walk = (tokens: ReturnType<typeof tokenizer.parse>) => {
    for (const t of tokens) {
      const what = UNSUPPORTED_TOKENS[t.type];
      if (what) found.add(what);
      if (t.children) walk(t.children);
    }
  };
  walk(tokenizer.parse(md, {}));
  return [...found];
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Parse `md` for the editor built from `extensions`. Never throws: content
 * the editor cannot hold comes back read-only with the reason.
 */
export function loadMarkdown(md: string, extensions: readonly AnyExtension[]): MarkdownLoad {
  const { parser } = parserFor(extensions);
  const unsupported = unsupportedIn(md);
  let doc: PMNode | null = null;
  try {
    doc = parser.parse(md);
  } catch {
    if (unsupported.length === 0) unsupported.push("structure rich text cannot hold");
  }
  if (!doc) {
    return {
      content: renderMd(md),
      readOnlyReason: `This file has ${listOf(unsupported)}.`,
      normalises: false,
    };
  }
  const normalises = toMarkdown(doc).trimEnd() !== md.replace(/\r\n?/g, "\n").trimEnd();
  return {
    content: doc.toJSON() as JSONContent,
    readOnlyReason: unsupported.length ? `This file has ${listOf(unsupported)}.` : null,
    normalises,
  };
}
