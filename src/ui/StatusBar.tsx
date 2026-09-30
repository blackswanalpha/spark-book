/* ============================================================
   sparkBook · src/ui/StatusBar.tsx
   Status bar segments: mode, language, encoding, Ln:Col.

   The mode chip opens a menu of the surfaces this document can be
   shown in. It used to render as a button with no handler, so it
   looked clickable and did nothing.
   ============================================================ */
import "./StatusBar.css";

import type { DocMode } from "@store/documents";
import { DropdownContent, DropdownRoot, DropdownTrigger } from "./Dropdown";

export const MODE_LABELS: Record<DocMode, string> = {
  markdown: "Markdown",
  rich: "Rich text",
  code: "Code",
  html: "HTML preview",
  svg: "SVG editor",
  image: "Image viewer",
  imageedit: "Image editor",
  animation: "Animation",
  pdf: "PDF",
  video: "Video",
  audio: "Audio",
};

export function StatusBar({
  mode, language, encoding, line, col, dirty, modes = [], onModeSelect,
}: {
  mode: DocMode;
  language?: string;
  encoding?: string;
  line: number;
  col: number;
  dirty?: boolean;
  /** Surfaces the document can switch to, its current one included. */
  modes?: DocMode[];
  onModeSelect?: (mode: DocMode) => void;
}) {
  const chip = (
    <>
      <span className={`status__chip status__chip--${mode}`}>{mode}</span>
      {language && <span className="status__lang">{language}</span>}
    </>
  );
  const switchable = modes.length > 1 && onModeSelect;

  return (
    <footer className="statusbar" role="contentinfo">
      {switchable ? (
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button
              type="button"
              className="status__seg status__mode"
              aria-label={`Mode: ${MODE_LABELS[mode]}. Switch mode`}
              title="Switch mode"
            >
              {chip}
            </button>
          </DropdownTrigger>
          <DropdownContent
            align="start"
            entries={modes.map((m) => ({
              id: m,
              label: MODE_LABELS[m],
              icon: m === mode ? "check" : `mode-${m}`,
            }))}
            onSelect={(id) => onModeSelect(id as DocMode)}
          />
        </DropdownRoot>
      ) : (
        <span className="status__seg" aria-label={`Mode: ${MODE_LABELS[mode]}`}>
          {chip}
        </span>
      )}
      <span className="status__spacer" />
      <span className="status__seg">{encoding ?? "UTF-8"}</span>
      <span className="status__seg">Ln {line}, Col {col}</span>
      {dirty && <span className="status__seg status__seg--dirty">●</span>}
    </footer>
  );
}
