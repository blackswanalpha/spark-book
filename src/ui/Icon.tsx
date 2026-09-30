/* ============================================================
   sparkBook · src/ui/Icon.tsx
   Icon component backed by @phosphor-icons/react.
   All previous lucide-react + first-party core SVGs are now
   replaced by Phosphor icons. Legacy names are preserved via
   an alias map so existing `name="..."` usages keep working.
   Unknown names fall through to a Phosphor PascalCase lookup
   (kebab-case → PascalCase) for direct Phosphor usage.
   Icons inherit `currentColor` and respect the active theme.
   ============================================================ */
import { forwardRef, type SVGProps } from "react";
import type { IconWeight } from "@phosphor-icons/react";
import {
  Warning,
  TextB,
  Check,
  CaretDown,
  CaretRight,
  X,
  Code,
  Command,
  Minus,
  Dot,
  FileCode,
  File,
  Folder,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextItalic,
  Link,
  ListNumbers,
  ListBullets,
  CornersOut,
  MarkdownLogo,
  TextT,
  FolderOpen,
  Plus,
  Quotes,
  ArrowUUpRight,
  ArrowClockwise,
  ArrowUp,
  CornersIn,
  FloppyDisk,
  MagnifyingGlass,
  Gear,
  Sidebar,
  ArrowUUpLeft,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeSlash,
  EyeClosed,
  FilePlus,
  FolderPlus,
  FolderSimplePlus,
  Scissors,
  Copy,
  Clipboard,
  PencilSimple,
  Terminal,
  ArrowSquareOut,
  Trash,
  ArrowsClockwise,
  DeviceMobile,
  Monitor,
  Palette,
  TextAa,
  SlidersHorizontal,
  ArrowCounterClockwise,
  Image,
  PaintBrush,
  Eraser,
  PaintBucket,
  Square,
  Circle,
  Eyedropper,
  Crop,
  ArrowsOutCardinal,
  FilePdf,
  FilmStrip,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Stack,
  Diamond,
  Repeat,
  LineSegment,
  Selection,
  MagicWand,
  CaretLeft,
  CaretUp,
  FlipHorizontal,
  FlipVertical,
  Export,
  Textbox,
  Cursor,
  GridFour,
  Sun,
  Drop,
  Lock,
  LockOpen,
  DotsThree,
  ArrowsInLineVertical,
  ClipboardText,
  House,
  PushPin,
  PushPinSlash,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX,
  ClockClockwise,
  ClockCounterClockwise,
  PictureInPicture,
  ClosedCaptioning,
  GearSix,
  MusicNotes,
  VideoCamera,
  Keyboard,
  Info,
} from "@phosphor-icons/react";
import { DartIcon } from "./DartIcon";

type PhosphorComp = React.ComponentType<any>;

const PHOSPHOR_MAP: Record<string, PhosphorComp> = {
  Warning,
  TextB,
  Check,
  CaretDown,
  CaretRight,
  X,
  Code,
  Command,
  Minus,
  Dot,
  FileCode,
  File,
  Folder,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextItalic,
  Link,
  ListNumbers,
  ListBullets,
  CornersOut,
  MarkdownLogo,
  TextT,
  FolderOpen,
  Plus,
  Quotes,
  ArrowUUpRight,
  ArrowClockwise,
  ArrowUp,
  CornersIn,
  FloppyDisk,
  MagnifyingGlass,
  Gear,
  Sidebar,
  ArrowUUpLeft,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeSlash,
  EyeClosed,
  FilePlus,
  FolderPlus,
  FolderSimplePlus,
  Scissors,
  Copy,
  Clipboard,
  PencilSimple,
  Terminal,
  ArrowSquareOut,
  Trash,
  ArrowsClockwise,
  DeviceMobile,
  Monitor,
  Palette,
  TextAa,
  SlidersHorizontal,
  ArrowCounterClockwise,
  Image,
  PaintBrush,
  Eraser,
  PaintBucket,
  Square,
  Circle,
  Eyedropper,
  Crop,
  ArrowsOutCardinal,
  FilePdf,
  FilmStrip,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Stack,
  Diamond,
  Repeat,
  LineSegment,
  Selection,
  MagicWand,
  CaretLeft,
  CaretUp,
  FlipHorizontal,
  FlipVertical,
  Export,
  Textbox,
  Cursor,
  GridFour,
  Sun,
  Drop,
  Lock,
  LockOpen,
  DotsThree,
  ArrowsInLineVertical,
  ClipboardText,
  House,
  PushPin,
  PushPinSlash,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX,
  ClockClockwise,
  ClockCounterClockwise,
  PictureInPicture,
  ClosedCaptioning,
  GearSix,
  MusicNotes,
  VideoCamera,
  Keyboard,
  Info,
};

const CUSTOM_MAP: Record<string, PhosphorComp> = {
  DartIcon,
};

/** Legacy → Phosphor (or custom) component key */
const ALIAS: Record<string, keyof typeof PHOSPHOR_MAP | keyof typeof CUSTOM_MAP> = {
  alert: "Warning",
  bold: "TextB",
  check: "Check",
  "chevron-down": "CaretDown",
  "chevron-right": "CaretRight",
  close: "X",
  code: "Code",
  command: "Command",
  divider: "Minus",
  dot: "Dot",
  "file-code": "FileCode",
  "lang-dart": "DartIcon",
  file: "File",
  folder: "Folder",
  h1: "TextHOne",
  h2: "TextHTwo",
  h3: "TextHThree",
  italic: "TextItalic",
  link: "Link",
  "list-ol": "ListNumbers",
  "list-ul": "ListBullets",
  maximize: "CornersOut",
  minimize: "Minus",
  "mode-code": "Code",
  "mode-markdown": "MarkdownLogo",
  "mode-rich": "TextT",
  "mode-html": "Code",
  "mode-svg": "FileCode",
  open: "FolderOpen",
  plus: "Plus",
  quote: "Quotes",
  redo: "ArrowUUpRight",
  refresh: "ArrowClockwise",
  "arrow-up": "ArrowUp",
  "arrow-left": "ArrowLeft",
  "arrow-right": "ArrowRight",
  "eye": "Eye",
  "eye-closed": "EyeClosed",
  "eye-slash": "EyeSlash",
  "file-plus": "FilePlus",
  "folder-plus": "FolderPlus",
  restore: "CornersIn",
  save: "FloppyDisk",
  search: "MagnifyingGlass",
  settings: "Gear",
  "sidebar-toggle": "Sidebar",
  undo: "ArrowUUpLeft",
  scissors: "Scissors",
  copy: "Copy",
  clipboard: "Clipboard",
  pencil: "PencilSimple",
  terminal: "Terminal",
  external: "ArrowSquareOut",
  trash: "Trash",
  "arrows-clockwise": "ArrowsClockwise",
  mobile: "DeviceMobile",
  desktop: "Monitor",
  palette: "Palette",
  typography: "TextAa",
  sliders: "SlidersHorizontal",
  reset: "ArrowCounterClockwise",

  /* Binary + timeline surfaces */
  "mode-image": "Image",
  "mode-imageedit": "PaintBrush",
  "mode-animation": "FilmStrip",
  "mode-pdf": "FilePdf",
  "mode-video": "VideoCamera",
  "mode-audio": "MusicNotes",

  /* Image-editor tools */
  "tool-move": "ArrowsOutCardinal",
  "tool-select": "Selection",
  "tool-brush": "PaintBrush",
  "tool-eraser": "Eraser",
  "tool-bucket": "PaintBucket",
  "tool-rect": "Square",
  "tool-ellipse": "Circle",
  "tool-line": "LineSegment",
  "tool-text": "Textbox",
  "tool-eyedropper": "Eyedropper",
  "tool-crop": "Crop",
  "tool-wand": "MagicWand",
  "tool-cursor": "Cursor",

  /* Transport + timeline */
  play: "Play",
  pause: "Pause",
  "skip-back": "SkipBack",
  "skip-forward": "SkipForward",
  keyframe: "Diamond",
  loop: "Repeat",
  layers: "Stack",
  grid: "GridFour",
  export: "Export",
  lock: "Lock",
  unlock: "LockOpen",
  brightness: "Sun",
  saturation: "Drop",
  "flip-h": "FlipHorizontal",
  "flip-v": "FlipVertical",
  "chevron-left": "CaretLeft",
  "chevron-up": "CaretUp",
  /* Explorer toolbar */
  more: "DotsThree",
  "collapse-all": "ArrowsInLineVertical",
  "copy-path": "ClipboardText",
  home: "House",
  pin: "PushPin",
  unpin: "PushPinSlash",
};

export type LegacyIconName = keyof typeof ALIAS;
export type IconName = LegacyIconName | string;

type IconProps = Omit<SVGProps<SVGSVGElement>, "weight"> & {
  name: string;
  size?: number | string;
  weight?: IconWeight;
  color?: string;
};

function kebabToPascal(kebab: string): string {
  return kebab
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** Resolve a `name` prop to a Phosphor (or custom) component, if any. */
function resolvePhosphor(name: string): PhosphorComp | undefined {
  // 1) Legacy alias
  const aliasKey = ALIAS[name];
  if (aliasKey) return PHOSPHOR_MAP[aliasKey] ?? CUSTOM_MAP[aliasKey];
  // 2) Direct Phosphor / custom name (kebab-case → PascalCase)
  const pascal = kebabToPascal(name);
  return PHOSPHOR_MAP[pascal] ?? CUSTOM_MAP[pascal];
}

/** Renders a Phosphor icon. Falls back to an empty 24×24 SVG if unresolved. */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, size = 18, weight = "regular", color = "currentColor", className, ...rest },
  ref,
) {
  const Comp = resolvePhosphor(name);

  if (Comp) {
    return (
      <Comp
        size={Number(size) || 18}
        weight={weight}
        color={color}
        className={["icon", className].filter(Boolean).join(" ")}
        aria-hidden
      />
    );
  }

  // Fallback: empty 24×24 so layout doesn't break for unknown names
  return (
    <svg
      ref={ref}
      className={["icon", className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      {...rest}
    />
  );
});

export const ICON_SET = {
  legacy: Object.keys(ALIAS),
  phosphor: Object.keys(PHOSPHOR_MAP),
  custom: Object.keys(CUSTOM_MAP),
} as const;
