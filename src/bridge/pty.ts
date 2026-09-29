/* ============================================================
   sparkBook · src/bridge/pty.ts

   Typed bridge to the Rust PTY host (src-tauri/src/pty.rs).

   The host owns terminal emulation: it runs the shell, parses the
   VT stream and pushes resolved cell grids. This module only moves
   bytes and frames across the IPC boundary — there is no terminal
   emulator in the renderer.

   Outside Tauri every call rejects with `PtyUnavailable` so the
   terminal UI can show one honest message instead of pretending a
   shell exists in the browser.
   ============================================================ */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@bridge/commands";

/* ---------- Wire types (mirror pty.rs) ---------- */

export type PtyPrivilege = "user" | "root";

/** Mouse reporting the running program asked for. */
export type PtyMouseMode = "none" | "press" | "pressRelease" | "buttonMotion" | "anyMotion";
/** How a mouse report must be framed. */
export type PtyMouseEncoding = "default" | "utf8" | "sgr";

export interface PtySpan {
  /** Column this run starts at (0-based). */
  col: number;
  text: string;
  /** `#rrggbb`, or absent for the theme default. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  /** SGR 2 (faint). */
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface PtyRow {
  y: number;
  spans: PtySpan[];
}

export interface PtyFrame {
  id: string;
  rows: number;
  cols: number;
  /** Changed rows only, unless `full`. */
  lines: PtyRow[];
  full: boolean;
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
  title?: string;
  applicationCursor: boolean;
  bracketedPaste: boolean;
  /** Rows the viewport is currently scrolled back by. */
  scrollback: number;
  /** Largest `scrollback` the buffer can take — 0 means no history yet. */
  scrollbackMax: number;
  /** True while a full-screen program owns the screen (no scrollback exists). */
  alternateScreen: boolean;
  mouseMode: PtyMouseMode;
  mouseEncoding: PtyMouseEncoding;
  /** DEC 1004: report focus changes as `CSI I` / `CSI O`. */
  focusReporting?: boolean;
  /** Kitty keyboard flags in force; bit 0 = disambiguate escape codes. */
  kittyFlags?: number;
  seq: number;
}

/** An OSC 52 clipboard write from the program. */
export interface PtyClipboard {
  id: string;
  /** Base64 of the text to copy. */
  data: string;
}

/** A bell, or a notification OSC — the program wants attention. */
export interface PtyBell {
  id: string;
}

export interface PtyExit {
  id: string;
  code: number;
  message?: string;
}

export interface PtySessionInfo {
  id: string;
  shell: string;
  cwd: string;
  privilege: PtyPrivilege;
  rows: number;
  cols: number;
}

export interface RootSupport {
  available: boolean;
  /** "pkexec" | "sudo" | "none" */
  method: string;
  alreadyRoot: boolean;
}

export class PtyUnavailable extends Error {
  constructor() {
    super("Terminal sessions need the desktop app — there is no shell in a browser tab.");
    this.name = "PtyUnavailable";
  }
}

function host<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return Promise.reject(new PtyUnavailable());
  return invoke<T>(cmd, args);
}

/* ---------- Commands ---------- */

export function ptySpawn(opts: {
  cwd: string;
  rows?: number;
  cols?: number;
  shell?: string;
  privilege?: PtyPrivilege;
}): Promise<PtySessionInfo> {
  return host<PtySessionInfo>("pty_spawn", {
    cwd: opts.cwd,
    rows: opts.rows,
    cols: opts.cols,
    shell: opts.shell,
    privilege: opts.privilege ?? "user",
  });
}

export const ptyWrite = (id: string, data: string) => host<void>("pty_write", { id, data });
export const ptyResize = (id: string, rows: number, cols: number) =>
  host<void>("pty_resize", { id, rows, cols });
export const ptyRefresh = (id: string) => host<void>("pty_refresh", { id });
export const ptyKill = (id: string) => host<void>("pty_kill", { id });
/** Take over a live session from another window (the pop-out path). */
export const ptyAdopt = (id: string) => host<PtySessionInfo>("pty_adopt", { id });
export const ptyList = () => host<PtySessionInfo[]>("pty_list");
export const ptyRootSupport = () => host<RootSupport>("pty_root_support");
export const ptyDefaultShell = () => host<string>("pty_default_shell");
/** One hit of `ptySearch`. `line` counts from the oldest line of history. */
export interface PtyMatch {
  line: number;
  col: number;
  /** Width in cells. */
  len: number;
}

export interface PtySearchResult {
  matches: PtyMatch[];
  /** History length the line numbers count against. */
  scrollbackMax: number;
  truncated: boolean;
}

/** Search the whole buffer — scrollback and screen — for plain text. */
export const ptySearch = (id: string, query: string, caseSensitive = false) =>
  host<PtySearchResult>("pty_search", { id, query, caseSensitive });

/** Tell the host the theme's terminal colours, for OSC 10/11/12 queries. */
export const ptySetPalette = (fg: string, bg: string, cursor?: string) =>
  host<void>("pty_set_palette", { fg, bg, cursor });

/**
 * Scroll the viewport into scrollback. Positive `delta` = older output.
 * Pass `absolute` to jump to a fixed offset (0 = the live bottom); the
 * host clamps both forms and returns the offset it settled on.
 */
export const ptyScroll = (id: string, delta: number, absolute?: number) =>
  host<number>("pty_scroll", { id, delta: Math.trunc(delta), absolute });

/* ---------- Events ---------- */

async function subscribe<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  try {
    return await listen<T>(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}

/* ---------- Fan-out ----------

   The host broadcasts one event per frame to the window, not one per
   subscriber, but every `listen` call deserialises that payload again on
   its own. With four tabs open and a ~125Hz frame pump that is four
   decodes of the same grid 125 times a second, three of which are thrown
   away by an id check. So each event is listened to ONCE per window and
   dispatched from a table keyed by session id.

   The listener is torn down when the last subscriber leaves, which is
   what keeps a closed terminal panel from holding an IPC channel open.
*/

class Fanout<T extends { id: string }> {
  private readonly handlers = new Map<string, Set<(p: T) => void>>();
  private unlisten: UnlistenFn | null = null;
  private starting: Promise<void> | null = null;
  /** Bumped whenever the listener is torn down, so an attach that is
      still in flight knows it has been superseded. */
  private generation = 0;

  constructor(private readonly events: string[]) {}

  async add(id: string, handler: (p: T) => void): Promise<UnlistenFn> {
    let set = this.handlers.get(id);
    if (!set) {
      set = new Set();
      this.handlers.set(id, set);
    }
    set.add(handler);
    await this.start();
    return () => this.remove(id, handler);
  }

  private remove(id: string, handler: (p: T) => void) {
    const set = this.handlers.get(id);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(id);
    if (this.handlers.size === 0) {
      this.generation += 1;
      this.unlisten?.();
      this.unlisten = null;
      this.starting = null;
    }
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;

    /* The generation is what keeps a fast unsubscribe/resubscribe from
       leaking a listener: without it, an attach still in flight when the
       last subscriber left would resolve after the NEXT one arrived, see
       a non-empty table, and overwrite `unlisten` — orphaning its own
       pair of listeners for the life of the window. */
    const gen = (this.generation += 1);

    this.starting = (async () => {
      const stops = await Promise.all(
        this.events.map((e) =>
          subscribe<T>(e, (payload) => {
            // Copy before iterating: a handler may unsubscribe itself.
            const set = this.handlers.get(payload?.id);
            if (!set) return;
            for (const fn of [...set]) fn(payload);
          }),
        ),
      );
      // Superseded, or everything unsubscribed while we were attaching.
      if (gen !== this.generation || this.handlers.size === 0) {
        for (const stop of stops) stop();
        return;
      }
      this.unlisten = () => stops.forEach((stop) => stop());
    })();
    return this.starting;
  }
}

const frames = new Fanout<PtyFrame>(["pty://frame", "pty://cursor"]);
const exits = new Fanout<PtyExit>(["pty://exit"]);
const clipboards = new Fanout<PtyClipboard>(["pty://clipboard"]);
const bells = new Fanout<PtyBell>(["pty://bell"]);

/**
 * Frames for one session. `pty://cursor` delivers the cheaper cursor-only
 * updates; both are handed to the same handler because the renderer
 * applies them identically.
 *
 * Subscribing by id rather than filtering in the handler is what lets the
 * fan-out above decode each frame once no matter how many tabs are open.
 */
export const onPtyFrame = (id: string, handler: (f: PtyFrame) => void): Promise<UnlistenFn> =>
  frames.add(id, handler);

export const onPtyExit = (id: string, handler: (e: PtyExit) => void): Promise<UnlistenFn> =>
  exits.add(id, handler);

export const onPtyClipboard = (
  id: string,
  handler: (e: PtyClipboard) => void,
): Promise<UnlistenFn> => clipboards.add(id, handler);

export const onPtyBell = (id: string, handler: (e: PtyBell) => void): Promise<UnlistenFn> =>
  bells.add(id, handler);

/** Decode an OSC 52 payload. Invalid base64 decodes to "". */
export function decodeClipboard(data: string): string {
  try {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/* ---------- Key encoding ----------

   Translating a DOM KeyboardEvent into the bytes a real tty expects.
   Kept here (not in the component) so it is testable without a DOM
   renderer, and so the popped-out terminal window shares one
   implementation.
*/

const CSI = "\x1b[";
const SS3 = "\x1bO";

const FN_KEYS: Record<string, string> = {
  F1: `${SS3}P`,
  F2: `${SS3}Q`,
  F3: `${SS3}R`,
  F4: `${SS3}S`,
  F5: `${CSI}15~`,
  F6: `${CSI}17~`,
  F7: `${CSI}18~`,
  F8: `${CSI}19~`,
  F9: `${CSI}20~`,
  F10: `${CSI}21~`,
  F11: `${CSI}23~`,
  F12: `${CSI}24~`,
};

const ARROWS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
};

export interface KeyContext {
  /** DECCKM — from the latest frame. */
  applicationCursor: boolean;
  /** Kitty keyboard flags from the latest frame; absent means legacy. */
  kittyFlags?: number;
}

/**
 * The bytes for Ctrl+V, for when the surface forwards it instead of
 * pasting.
 *
 * Ctrl+V is the surface's paste. But the clipboard can hold something that
 * is not text — a screenshot — and there is nothing to paste then. The
 * program in the terminal may know what to do with it: Claude Code, like
 * other TUIs, reads an image straight off the system clipboard when it
 * sees Ctrl+V. Swallowing the key there is why pasting an image did
 * nothing, so it is forwarded as the key a plain terminal would send.
 */
export function ctrlVBytes(kittyFlags = 0): string {
  return kittyFlags & 1 ? `${CSI}118;5u` : "\x16";
}

/** US-layout unshifted keys, for a shifted symbol pressed with Ctrl/Alt. */
const UNSHIFTED_BY_CODE: Record<string, string> = {
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** The kitty key number for a text key: its unshifted codepoint. */
function kittyKeyCode(e: Pick<KeyboardEvent, "shiftKey" | "code">, key: string): number | null {
  const chars = [...key];
  if (chars.length !== 1) return null;
  const lower = key.toLowerCase();
  // A letter in any script: lower case is the unshifted key.
  if (lower !== key.toUpperCase()) return lower.codePointAt(0) ?? null;
  const unshifted = e.shiftKey ? UNSHIFTED_BY_CODE[e.code] : undefined;
  return (unshifted ?? key).codePointAt(0) ?? null;
}

/**
 * Encode a press under the kitty keyboard protocol's "disambiguate escape
 * codes" flag, or return `undefined` for a key whose legacy encoding is
 * already unambiguous (plain text, arrows, function keys).
 *
 * This is what lets a program tell Shift+Enter from Enter and Esc from
 * the start of a sequence. Programs opt in — Claude Code asks with
 * `CSI ? u` and pushes the flag — so a shell that never does keeps the
 * legacy bytes.
 */
function encodeKitty(e: KeyboardEvent, key: string): string | null | undefined {
  const mods = modifier(e);
  switch (key) {
    case "Escape":
      return mods > 1 ? `${CSI}27;${mods}u` : `${CSI}27u`;
    // Unmodified Enter/Tab/Backspace stay legacy, so `reset` can still be
    // typed after a program that set the mode crashed without clearing it.
    case "Enter":
      return mods > 1 ? `${CSI}13;${mods}u` : "\r";
    case "Tab":
      return mods > 1 ? `${CSI}9;${mods}u` : "\t";
    case "Backspace":
      return mods > 1 ? `${CSI}127;${mods}u` : "\x7f";
    default:
      break;
  }
  if (!e.ctrlKey && !e.altKey) return undefined;
  if (e.getModifierState?.("AltGraph")) return undefined;
  const code = kittyKeyCode(e, key);
  if (code === null) return undefined;
  return `${CSI}${code};${mods}u`;
}

/** xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
function modifier(e: Pick<KeyboardEvent, "shiftKey" | "altKey" | "ctrlKey">): number {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
}

/**
 * Whether this key press is one of the clipboard bindings the surface
 * handles itself, so it must never reach the tty.
 *
 * Ctrl+Shift+C/V are the terminal conventions (Ctrl+C has to stay
 * SIGINT); Ctrl+Insert / Shift+Insert are the X11 ones, which is what a
 * lot of muscle memory on Linux actually uses.
 */
export type ClipboardIntent = "copy" | "paste" | null;

export function clipboardIntent(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
): ClipboardIntent {
  if (e.altKey || e.metaKey) return null;
  const key = e.key;
  if (e.ctrlKey && e.shiftKey) {
    if (key === "C" || key === "c") return "copy";
    if (key === "V" || key === "v") return "paste";
  }
  // Plain Ctrl+V: a terminal's ^V is readline's quoted-insert, which
  // almost nobody reaches for deliberately and everybody hits expecting a
  // paste. The shell keeps ^Q for the same job.
  if (e.ctrlKey && !e.shiftKey && (key === "V" || key === "v")) return "paste";
  if (key === "Insert") {
    if (e.ctrlKey && !e.shiftKey) return "copy";
    if (e.shiftKey && !e.ctrlKey) return "paste";
  }
  return null;
}

/**
 * Encode a key press as terminal input, or return `null` when the key
 * carries no bytes (a bare modifier, or a shortcut the UI handles).
 */
/**
 * The DOM `key` for a press, with the one WebKitGTK gap patched.
 *
 * Shift+Tab reaches GTK as the keysym `ISO_Left_Tab`, and WebKitGTK's
 * keyval table only names `Tab` and `KP_Tab`, so the event arrives with
 * `key: "Unidentified"` — while `code` is still "Tab" and the legacy
 * `keyCode` is still 9. Dropped as IME noise, the press sent nothing and
 * cancelled nothing, so the webview ran its own default for the key and
 * moved focus to the previous tab stop. That is the "Shift+Tab is an app
 * shortcut" report: it was never a shortcut, just an unhandled key.
 */
function keyOf(e: Pick<KeyboardEvent, "key" | "code" | "keyCode">): string {
  if (e.key === "Unidentified" && (e.code === "Tab" || e.keyCode === 9)) return "Tab";
  return e.key;
}

export function encodeKey(e: KeyboardEvent, ctx: KeyContext): string | null {
  const { ctrlKey, altKey, metaKey, shiftKey } = e;
  const key = keyOf(e);

  /* An IME is mid-composition: the characters it is assembling arrive
     later as one `input`/composition result, and forwarding the raw keys
     as well types every candidate twice. `keyCode === 229` is the older
     signal for the same thing, and WebKitGTK still uses it. */
  if (e.isComposing || key === "Process" || key === "Unidentified" || e.keyCode === 229) {
    return null;
  }

  // Bare modifiers produce nothing.
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta" || key === "CapsLock") {
    return null;
  }

  // Cmd/Super shortcuts belong to the app (copy, paste, close), never the tty.
  if (metaKey) return null;

  // Clipboard bindings are the surface's, not the shell's.
  if (clipboardIntent(e)) return null;

  if ((ctx.kittyFlags ?? 0) & 1) {
    const kitty = encodeKitty(e, key);
    if (kitty !== undefined) return kitty;
  }

  const arrow = ARROWS[key];
  if (arrow) {
    if (ctrlKey || altKey || shiftKey) {
      // xterm's modifyOtherKeys form: CSI 1 ; <mod> <final>
      return `${CSI}1;${modifier(e)}${arrow}`;
    }
    return ctx.applicationCursor ? `${SS3}${arrow}` : `${CSI}${arrow}`;
  }

  const fn = FN_KEYS[key];
  if (fn) {
    if (!ctrlKey && !altKey && !shiftKey) return fn;
    /* A modified function key carries the modifier as a parameter. The
       two families are shaped differently: F1-F4 are SS3 sequences and
       become CSI 1 ; mod <final>, while F5+ are already CSI n ~ and take
       the modifier as a second parameter. Sending the unmodified form
       instead — which is what happened before — made Shift+F3 do whatever
       F3 does, silently. */
    const mod = modifier(e);
    if (fn.startsWith(SS3)) return `${CSI}1;${mod}${fn.slice(SS3.length)}`;
    return `${fn.slice(0, -1)};${mod}~`;
  }

  switch (key) {
    case "Enter":
      // Alt+Enter is ESC CR, the same meta convention as Alt+<char>.
      return altKey ? "\x1b\r" : "\r";
    case "Tab":
      return shiftKey ? `${CSI}Z` : "\t";
    case "Backspace":
      // ctrl/alt+backspace deletes the previous word (readline's ESC DEL).
      return ctrlKey || altKey ? "\x1b\x7f" : "\x7f";
    case "Escape":
      return "\x1b";
    case "Delete":
      return ctrlKey || altKey || shiftKey ? `${CSI}3;${modifier(e)}~` : `${CSI}3~`;
    case "Insert":
      return `${CSI}2~`;
    case "Home":
      if (ctrlKey || altKey || shiftKey) return `${CSI}1;${modifier(e)}H`;
      return ctx.applicationCursor ? `${SS3}H` : `${CSI}H`;
    case "End":
      if (ctrlKey || altKey || shiftKey) return `${CSI}1;${modifier(e)}F`;
      return ctx.applicationCursor ? `${SS3}F` : `${CSI}F`;
    case "PageUp":
      return `${CSI}5~`;
    case "PageDown":
      return `${CSI}6~`;
    default:
      break;
  }

  /* AltGr. X11 and Windows both report it as ctrl+alt, so the two checks
     below would have turned the `@` on a German layout — or the `#` on a
     UK one — into `ESC @`. A ctrl+alt press that still produced a
     printable character IS that character: no real Ctrl+Alt binding
     yields one. */
  if (ctrlKey && altKey && key.length === 1) return key;

  // Ctrl+<letter> and the ctrl punctuation range.
  if (ctrlKey && !altKey && key.length === 1) {
    const c = key.toLowerCase();
    if (c >= "a" && c <= "z") {
      return String.fromCharCode(c.charCodeAt(0) - 96);
    }
    const punct: Record<string, string> = {
      "@": "\x00",
      "[": "\x1b",
      "\\": "\x1c",
      "]": "\x1d",
      "^": "\x1e",
      _: "\x1f",
      "-": "\x1f",
      "/": "\x1f",
      " ": "\x00",
      "2": "\x00",
      "?": "\x7f",
    };
    if (punct[key]) return punct[key];
    return null;
  }

  // Alt+<char> is ESC-prefixed (readline's meta).
  if (altKey && key.length === 1) return `\x1b${key}`;

  /* Whatever is left is either a named key or a printable character. The
     DOM spec names every non-character key with a capitalised identifier
     ("Enter", "F13", "AudioVolumeUp"), so anything that is not shaped
     like one is text to type — which is how a dead-key composition or an
     emoji (two UTF-16 units, so `length === 1` misses it) gets through. */
  if (/^[A-Z][A-Za-z0-9]+$/.test(key)) return null;
  return key;
}

/** Arrow-key bytes, for translating a wheel where there is no scrollback. */
export function encodeArrow(dir: "up" | "down", applicationCursor: boolean): string {
  const final = dir === "up" ? "A" : "B";
  return applicationCursor ? `${SS3}${final}` : `${CSI}${final}`;
}

/** A mouse button press, drag or release, for a program that asked. */
export interface ButtonReport {
  /** 0 = left, 1 = middle, 2 = right. */
  button: number;
  /** 0-based cell under the pointer. */
  col: number;
  row: number;
  kind: "press" | "release" | "motion";
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * Encode a button event as an xterm mouse report.
 *
 * Without this a click inside a full-screen program did nothing at all:
 * the surface declined to select (the program owns the pointer) and had
 * nothing to hand the program either, so menus and buttons in a TUI were
 * unreachable with the mouse.
 *
 * Legacy encoding has no way to say *which* button was released — every
 * release is button 3 — which is exactly why SGR exists and why any
 * program that cares asks for it.
 */
export function encodeMouseButton(e: ButtonReport, encoding: PtyMouseEncoding): string {
  const mods = (e.shift ? 4 : 0) + (e.alt ? 8 : 0) + (e.ctrl ? 16 : 0);
  const motion = e.kind === "motion" ? 32 : 0;
  const base = Math.max(0, Math.min(2, e.button));
  const col = Math.max(0, e.col) + 1;
  const row = Math.max(0, e.row) + 1;

  if (encoding === "sgr") {
    // SGR keeps the button on release and marks it with a final `m`.
    const button = base + mods + motion;
    return `${CSI}<${button};${col};${row}${e.kind === "release" ? "m" : "M"}`;
  }

  const button = (e.kind === "release" ? 3 : base) + mods + motion;
  // See encodeWheelMouse: the legacy forms offset every field by 32 and
  // this report crosses IPC as UTF-8, so the coordinates are clamped to
  // stay one byte wide.
  const cap = encoding === "utf8" ? 2015 : 95;
  const cell = (v: number) => String.fromCharCode(32 + Math.min(v, cap));
  return `${CSI}M${String.fromCharCode(32 + button)}${cell(col)}${cell(row)}`;
}

export interface WheelReport {
  up: boolean;
  /** 0-based cell under the pointer. */
  col: number;
  row: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * Encode a wheel notch as an xterm mouse report.
 *
 * Wheel buttons are 64 (up) and 65 (down) with the usual modifier bits.
 * A program that turned mouse reporting on scrolls itself from these —
 * which is the only way to scroll inside a full-screen TUI, since the
 * alternate screen keeps no scrollback for the terminal to move through.
 */
export function encodeWheelMouse(e: WheelReport, encoding: PtyMouseEncoding): string {
  const button = (e.up ? 64 : 65) + (e.shift ? 4 : 0) + (e.alt ? 8 : 0) + (e.ctrl ? 16 : 0);
  const col = Math.max(0, e.col) + 1;
  const row = Math.max(0, e.row) + 1;

  if (encoding === "sgr") return `${CSI}<${button};${col};${row}M`;

  // The legacy encodings offset every field by 32. X10 puts each field in
  // one raw byte, but this report crosses the IPC boundary as a UTF-8
  // string, so anything past 127 would arrive as two bytes and desync the
  // program's mouse parser. Clamping the column keeps the report six
  // bytes wide and well formed; the UTF-8 encoding has no such limit, and
  // any program that cares about exact coordinates asks for SGR.
  const cap = encoding === "utf8" ? 2015 : 95;
  const cell = (v: number) => String.fromCharCode(32 + Math.min(v, cap));
  return `${CSI}M${String.fromCharCode(32 + button)}${cell(col)}${cell(row)}`;
}

/** Wrap pasted text for bracketed-paste-aware programs (vim, fish, zsh). */
export function encodePaste(text: string, bracketed: boolean): string {
  // Normalise line endings: a tty expects CR, and a stray CRLF would
  // submit twice.
  let normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");

  /* Strip the paste terminator out of the payload. Clipboard content is
     attacker-controlled often enough (a copied code block on a web page)
     and an embedded ESC[201~ ends bracketed-paste mode early, so the
     rest of the text is read as typed input — a paste that runs a
     command the user never saw. Everything else passes through: a
     terminal is supposed to carry escape sequences. */
  // Split/join rather than a regex: an escape byte in a character class
  // is exactly what `no-control-regex` exists to flag, and this says the
  // same thing without one.
  if (bracketed) normalized = normalized.split(`${CSI}201~`).join("");

  return bracketed ? `${CSI}200~${normalized}${CSI}201~` : normalized;
}
