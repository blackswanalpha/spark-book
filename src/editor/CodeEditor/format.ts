/* ============================================================
   sparkBook · src/editor/CodeEditor/format.ts

   Format Code. Prettier's standalone build runs in the renderer, so
   formatting needs no host command and no tool on the user's PATH.
   Each language's parser plugin is imported on first use, keeping
   Prettier out of the startup bundle.

   Languages Prettier does not parse (Rust, Python, Go …) have no
   formatter here; the caller says so rather than silently doing
   nothing, which is what the old stub did.
   ============================================================ */
import type { Plugin } from "prettier";

interface Formatter {
  parser: string;
  plugins: () => Promise<Plugin[]>;
}

const estree = () => import("prettier/plugins/estree").then((m) => m.default as Plugin);
const babel = async () => [(await import("prettier/plugins/babel")).default as Plugin, await estree()];
const typescript = async () => [(await import("prettier/plugins/typescript")).default as Plugin, await estree()];
const postcss = async () => [(await import("prettier/plugins/postcss")).default as Plugin];
const html = async () => [(await import("prettier/plugins/html")).default as Plugin];
const yaml = async () => [(await import("prettier/plugins/yaml")).default as Plugin];
const markdown = async () => [(await import("prettier/plugins/markdown")).default as Plugin];
const graphql = async () => [(await import("prettier/plugins/graphql")).default as Plugin];

/** Language id (see languages.ts) → Prettier parser. */
const FORMATTERS: Record<string, Formatter> = {
  js: { parser: "babel", plugins: babel },
  mjs: { parser: "babel", plugins: babel },
  cjs: { parser: "babel", plugins: babel },
  jsx: { parser: "babel", plugins: babel },
  ts: { parser: "typescript", plugins: typescript },
  mts: { parser: "typescript", plugins: typescript },
  cts: { parser: "typescript", plugins: typescript },
  tsx: { parser: "typescript", plugins: typescript },
  json: { parser: "json", plugins: babel },
  jsonc: { parser: "jsonc", plugins: babel },
  css: { parser: "css", plugins: postcss },
  scss: { parser: "scss", plugins: postcss },
  less: { parser: "less", plugins: postcss },
  html: { parser: "html", plugins: html },
  htm: { parser: "html", plugins: html },
  vue: { parser: "vue", plugins: html },
  yaml: { parser: "yaml", plugins: yaml },
  yml: { parser: "yaml", plugins: yaml },
  md: { parser: "markdown", plugins: markdown },
  markdown: { parser: "markdown", plugins: markdown },
  graphql: { parser: "graphql", plugins: graphql },
  gql: { parser: "graphql", plugins: graphql },
};

export function canFormat(langId: string): boolean {
  return langId in FORMATTERS;
}

export interface FormatResult {
  text: string;
  /** Where the caret belongs in the formatted text. */
  cursor: number;
}

/**
 * Format `text` as `langId`, carrying the caret across. Resolves to null
 * for a language with no formatter; rejects with Prettier's own error
 * (a syntax error, usually) when the text does not parse.
 */
export async function formatSource(
  text: string,
  langId: string,
  cursor: number,
  tabWidth: number,
): Promise<FormatResult | null> {
  const f = FORMATTERS[langId];
  if (!f) return null;
  const [prettier, plugins] = await Promise.all([import("prettier/standalone"), f.plugins()]);
  const out = await prettier.formatWithCursor(text, {
    parser: f.parser,
    plugins,
    cursorOffset: Math.max(0, Math.min(cursor, text.length)),
    tabWidth,
  });
  return { text: out.formatted, cursor: Math.max(0, out.cursorOffset) };
}

/** First line of a Prettier error, without the code frame it appends. */
export function formatErrorMessage(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.split("\n")[0].trim() || "The file could not be parsed.";
}
