/* sparkBook — terminal key/paste encoding
   These run without a DOM terminal because encoding is pure: a
   KeyboardEvent-shaped input in, tty bytes out. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@bridge/commands", () => ({ isTauri: false }));

import {
  appShortcut,
  clipboardIntent,
  ctrlVBytes,
  decodeClipboard,
  encodeKey,
  encodeMouseButton,
  encodePaste,
  type KeyContext,
} from "./pty";

const NORMAL: KeyContext = { applicationCursor: false };
const APP: KeyContext = { applicationCursor: true };

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("encodeKey", () => {
  it("passes printable characters straight through", () => {
    expect(encodeKey(key({ key: "a" }), NORMAL)).toBe("a");
    expect(encodeKey(key({ key: "Z" }), NORMAL)).toBe("Z");
    expect(encodeKey(key({ key: " " }), NORMAL)).toBe(" ");
    expect(encodeKey(key({ key: "é" }), NORMAL)).toBe("é");
  });

  it("sends CR for Enter, not LF", () => {
    // A tty line discipline expects CR; sending LF submits nothing in bash.
    expect(encodeKey(key({ key: "Enter" }), NORMAL)).toBe("\r");
  });

  it("sends DEL for Backspace", () => {
    expect(encodeKey(key({ key: "Backspace" }), NORMAL)).toBe("\x7f");
    expect(encodeKey(key({ key: "Backspace", ctrlKey: true }), NORMAL)).toBe("\x1b\x7f");
  });

  it("maps ctrl+letter to its control code", () => {
    expect(encodeKey(key({ key: "c", ctrlKey: true }), NORMAL)).toBe("\x03"); // SIGINT
    expect(encodeKey(key({ key: "d", ctrlKey: true }), NORMAL)).toBe("\x04"); // EOF
    expect(encodeKey(key({ key: "z", ctrlKey: true }), NORMAL)).toBe("\x1a"); // SIGTSTP
    expect(encodeKey(key({ key: "a", ctrlKey: true }), NORMAL)).toBe("\x01");
    // Case must not matter: shift+ctrl+C still produces ^C.
    expect(encodeKey(key({ key: "C", ctrlKey: true }), NORMAL)).toBe("\x03");
  });

  it("switches arrow encoding with DECCKM", () => {
    expect(encodeKey(key({ key: "ArrowUp" }), NORMAL)).toBe("\x1b[A");
    expect(encodeKey(key({ key: "ArrowUp" }), APP)).toBe("\x1bOA");
    expect(encodeKey(key({ key: "ArrowLeft" }), NORMAL)).toBe("\x1b[D");
    expect(encodeKey(key({ key: "ArrowRight" }), APP)).toBe("\x1bOC");
  });

  it("encodes modified arrows in xterm's CSI 1 ; mod form", () => {
    expect(encodeKey(key({ key: "ArrowLeft", ctrlKey: true }), NORMAL)).toBe("\x1b[1;5D");
    expect(encodeKey(key({ key: "ArrowRight", altKey: true }), NORMAL)).toBe("\x1b[1;3C");
    expect(encodeKey(key({ key: "ArrowUp", shiftKey: true }), NORMAL)).toBe("\x1b[1;2A");
  });

  it("ESC-prefixes alt combinations (readline meta)", () => {
    expect(encodeKey(key({ key: "b", altKey: true }), NORMAL)).toBe("\x1bb");
    expect(encodeKey(key({ key: "f", altKey: true }), NORMAL)).toBe("\x1bf");
  });

  it("encodes navigation and function keys", () => {
    expect(encodeKey(key({ key: "Tab" }), NORMAL)).toBe("\t");
    expect(encodeKey(key({ key: "Tab", shiftKey: true }), NORMAL)).toBe("\x1b[Z");
    // WebKitGTK: Shift+Tab is ISO_Left_Tab, which its keyval table does
    // not name — `key` is "Unidentified" and only code/keyCode say Tab.
    expect(encodeKey(key({ key: "Unidentified", code: "Tab", keyCode: 9, shiftKey: true }), NORMAL)).toBe("\x1b[Z");
    expect(encodeKey(key({ key: "Unidentified", keyCode: 9, shiftKey: true }), NORMAL)).toBe("\x1b[Z");
    // A genuinely unidentified key is still nothing.
    expect(encodeKey(key({ key: "Unidentified" }), NORMAL)).toBeNull();
    expect(encodeKey(key({ key: "Delete" }), NORMAL)).toBe("\x1b[3~");
    expect(encodeKey(key({ key: "PageUp" }), NORMAL)).toBe("\x1b[5~");
    expect(encodeKey(key({ key: "F1" }), NORMAL)).toBe("\x1bOP");
    expect(encodeKey(key({ key: "F12" }), NORMAL)).toBe("\x1b[24~");
    expect(encodeKey(key({ key: "Escape" }), NORMAL)).toBe("\x1b");
  });

  it("produces nothing for bare modifiers", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(encodeKey(key({ key: k }), NORMAL)).toBeNull();
    }
  });

  it("leaves Cmd/Super shortcuts to the app", () => {
    // Cmd+W must close the tab, not type a 'w' into the shell.
    expect(encodeKey(key({ key: "w", metaKey: true }), NORMAL)).toBeNull();
    expect(encodeKey(key({ key: "c", metaKey: true }), NORMAL)).toBeNull();
  });

  it("returns null for unhandled named keys", () => {
    expect(encodeKey(key({ key: "ScrollLock" }), NORMAL)).toBeNull();
  });
});

describe("encodePaste", () => {
  it("normalises CRLF and LF to CR", () => {
    // Pasting "a\r\nb" as-is submits twice: once for CR, once for LF.
    expect(encodePaste("a\r\nb", false)).toBe("a\rb");
    expect(encodePaste("a\nb", false)).toBe("a\rb");
  });

  it("wraps in bracketed-paste markers when the program asked for them", () => {
    expect(encodePaste("ls", true)).toBe("\x1b[200~ls\x1b[201~");
  });

  it("normalises inside the brackets too", () => {
    expect(encodePaste("a\nb", true)).toBe("\x1b[200~a\rb\x1b[201~");
  });

  it("handles empty input", () => {
    expect(encodePaste("", false)).toBe("");
  });
});

/* ---------- Regressions the terminal shipped with ---------- */

describe("encodeKey — keys that reached the shell as the wrong bytes", () => {
  it("passes AltGr characters through instead of ESC-prefixing them", () => {
    /* X11 and Windows both report AltGr as ctrl+alt. The meta rule below
       it turned the `@` on a German layout into `ESC @`, so non-US
       keyboards could not type half their symbols. */
    expect(encodeKey(key({ key: "@", ctrlKey: true, altKey: true }), NORMAL)).toBe("@");
    expect(encodeKey(key({ key: "{", ctrlKey: true, altKey: true }), NORMAL)).toBe("{");
    // A plain alt combination is still readline's meta.
    expect(encodeKey(key({ key: "b", altKey: true }), NORMAL)).toBe("\x1bb");
  });

  it("stays silent while an IME is composing", () => {
    // Otherwise every candidate is typed twice: once raw, once composed.
    expect(encodeKey(key({ key: "a", isComposing: true }), NORMAL)).toBeNull();
    expect(encodeKey(key({ key: "Process" }), NORMAL)).toBeNull();
    expect(encodeKey(key({ key: "a", keyCode: 229 } as never), NORMAL)).toBeNull();
  });

  it("carries the modifier on a modified function key", () => {
    // Shift+F3 used to send plain F3, silently doing the wrong thing.
    expect(encodeKey(key({ key: "F3", shiftKey: true }), NORMAL)).toBe("\x1b[1;2R");
    expect(encodeKey(key({ key: "F5", ctrlKey: true }), NORMAL)).toBe("\x1b[15;5~");
    expect(encodeKey(key({ key: "F1" }), NORMAL)).toBe("\x1bOP");
  });

  it("encodes modified Home/End/Delete", () => {
    expect(encodeKey(key({ key: "Home", ctrlKey: true }), NORMAL)).toBe("\x1b[1;5H");
    expect(encodeKey(key({ key: "End", shiftKey: true }), NORMAL)).toBe("\x1b[1;2F");
    expect(encodeKey(key({ key: "Delete", ctrlKey: true }), NORMAL)).toBe("\x1b[3;5~");
  });

  it("treats alt+enter and alt+backspace as meta, like readline does", () => {
    expect(encodeKey(key({ key: "Enter", altKey: true }), NORMAL)).toBe("\x1b\r");
    expect(encodeKey(key({ key: "Backspace", altKey: true }), NORMAL)).toBe("\x1b\x7f");
  });

  it("keeps the clipboard bindings away from the tty", () => {
    // Ctrl+V used to send ^V (readline's quoted-insert) AND suppress the
    // browser's paste, so nothing could be pasted with the keyboard.
    for (const e of [
      key({ key: "v", ctrlKey: true }),
      key({ key: "V", ctrlKey: true, shiftKey: true }),
      key({ key: "C", ctrlKey: true, shiftKey: true }),
      key({ key: "Insert", shiftKey: true }),
      key({ key: "Insert", ctrlKey: true }),
    ]) {
      expect(encodeKey(e, NORMAL)).toBeNull();
    }
    // Ctrl+C is still SIGINT — that is the whole reason copy moved.
    expect(encodeKey(key({ key: "c", ctrlKey: true }), NORMAL)).toBe("\x03");
    expect(encodeKey(key({ key: "Insert" }), NORMAL)).toBe("\x1b[2~");
  });

  it("passes an emoji through, which a UTF-16 length check dropped", () => {
    expect(encodeKey(key({ key: "😀" }), NORMAL)).toBe("😀");
  });
});

describe("clipboardIntent", () => {
  const k = (init: Partial<KeyboardEvent> & { key: string }) => key(init);

  it("recognises the terminal and X11 bindings", () => {
    expect(clipboardIntent(k({ key: "C", ctrlKey: true, shiftKey: true }))).toBe("copy");
    expect(clipboardIntent(k({ key: "Insert", ctrlKey: true }))).toBe("copy");
    expect(clipboardIntent(k({ key: "V", ctrlKey: true, shiftKey: true }))).toBe("paste");
    expect(clipboardIntent(k({ key: "v", ctrlKey: true }))).toBe("paste");
    expect(clipboardIntent(k({ key: "Insert", shiftKey: true }))).toBe("paste");
  });

  it("leaves everything else to the shell", () => {
    expect(clipboardIntent(k({ key: "c", ctrlKey: true }))).toBeNull();
    expect(clipboardIntent(k({ key: "v" }))).toBeNull();
    expect(clipboardIntent(k({ key: "Insert" }))).toBeNull();
    // Ctrl+Alt+V is an AltGr character on some layouts, not a paste.
    expect(clipboardIntent(k({ key: "v", ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe("encodePaste — bracketed paste cannot be escaped", () => {
  it("strips an embedded terminator out of the payload", () => {
    /* Clipboard content is often copied off a web page. An embedded
       ESC[201~ ends paste mode early, so everything after it is read as
       typed input — a paste that runs a command the user never saw. */
    expect(encodePaste("ls\x1b[201~\rrm -rf /", true)).toBe(
      "\x1b[200~ls\rrm -rf /\x1b[201~",
    );
  });

  it("leaves the payload alone when the program is not bracketing", () => {
    // Nothing to break out of, and a terminal must carry escape codes.
    expect(encodePaste("ls\x1b[201~", false)).toBe("ls\x1b[201~");
  });
});

describe("encodeMouseButton", () => {
  const at = (over: Partial<Parameters<typeof encodeMouseButton>[0]> = {}) => ({
    button: 0,
    col: 4,
    row: 2,
    kind: "press" as const,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  });

  it("reports a press and a release in SGR, keeping the button on release", () => {
    // SGR marks a release with a final `m`; the legacy form cannot say
    // which button was released at all, which is why programs ask for it.
    expect(encodeMouseButton(at(), "sgr")).toBe("\x1b[<0;5;3M");
    expect(encodeMouseButton(at({ kind: "release" }), "sgr")).toBe("\x1b[<0;5;3m");
    expect(encodeMouseButton(at({ button: 2 }), "sgr")).toBe("\x1b[<2;5;3M");
  });

  it("adds the motion bit for a drag", () => {
    expect(encodeMouseButton(at({ kind: "motion" }), "sgr")).toBe("\x1b[<32;5;3M");
  });

  it("carries the modifier bits", () => {
    expect(encodeMouseButton(at({ shift: true }), "sgr")).toBe("\x1b[<4;5;3M");
    expect(encodeMouseButton(at({ ctrl: true, alt: true }), "sgr")).toBe("\x1b[<24;5;3M");
  });

  it("uses button 3 for any release in the legacy encoding", () => {
    expect(encodeMouseButton(at(), "default")).toBe(`\x1b[M${" "}%#`);
    expect(encodeMouseButton(at({ kind: "release" }), "default")).toBe("\x1b[M#%#");
  });

  it("clamps legacy coordinates so the report stays six bytes", () => {
    // Past 95 a coordinate would encode as two UTF-8 bytes and desync
    // the program's mouse parser.
    const report = encodeMouseButton(at({ col: 400, row: 400 }), "default");
    expect(report).toHaveLength(6);
  });
});

describe("encodeKey — kitty keyboard protocol (disambiguate)", () => {
  const KITTY: KeyContext = { applicationCursor: false, kittyFlags: 1 };

  it("tells Shift+Enter from Enter, which is what Claude Code's newline needs", () => {
    expect(encodeKey(key({ key: "Enter" }), KITTY)).toBe("\r");
    expect(encodeKey(key({ key: "Enter", shiftKey: true }), KITTY)).toBe("\x1b[13;2u");
    expect(encodeKey(key({ key: "Enter", ctrlKey: true }), KITTY)).toBe("\x1b[13;5u");
    // Without the flag nothing changes.
    expect(encodeKey(key({ key: "Enter", shiftKey: true }), NORMAL)).toBe("\r");
  });

  it("reports Esc and control chords as CSI u", () => {
    expect(encodeKey(key({ key: "Escape" }), KITTY)).toBe("\x1b[27u");
    expect(encodeKey(key({ key: "c", ctrlKey: true }), KITTY)).toBe("\x1b[99;5u");
    expect(encodeKey(key({ key: "A", ctrlKey: true, shiftKey: true, code: "KeyA" }), KITTY)).toBe(
      "\x1b[97;6u",
    );
    expect(encodeKey(key({ key: "x", altKey: true }), KITTY)).toBe("\x1b[120;3u");
    expect(encodeKey(key({ key: "!", altKey: true, shiftKey: true, code: "Digit1" }), KITTY)).toBe(
      "\x1b[49;4u",
    );
    expect(encodeKey(key({ key: "Tab", shiftKey: true }), KITTY)).toBe("\x1b[9;2u");
  });

  it("leaves text and navigation keys in their legacy form", () => {
    expect(encodeKey(key({ key: "a" }), KITTY)).toBe("a");
    expect(encodeKey(key({ key: "A", shiftKey: true }), KITTY)).toBe("A");
    expect(encodeKey(key({ key: "ArrowUp" }), KITTY)).toBe("\x1b[A");
    expect(encodeKey(key({ key: "ArrowUp", ctrlKey: true }), KITTY)).toBe("\x1b[1;5A");
    expect(encodeKey(key({ key: "Backspace" }), KITTY)).toBe("\x7f");
  });
});

describe("ctrlVBytes", () => {
  it("forwards Ctrl+V in whichever encoding the program asked for", () => {
    expect(ctrlVBytes()).toBe("\x16");
    expect(ctrlVBytes(0)).toBe("\x16");
    expect(ctrlVBytes(1)).toBe("\x1b[118;5u");
  });
});

describe("decodeClipboard", () => {
  it("decodes OSC 52 base64 as UTF-8", () => {
    expect(decodeClipboard("aGVsbG8=")).toBe("hello");
    expect(decodeClipboard(btoa(String.fromCharCode(...new TextEncoder().encode("é→"))))).toBe("é→");
    expect(decodeClipboard("%%%")).toBe("");
  });
});

describe("appShortcut — keys a focused terminal must not swallow", () => {
  const k = (init: Partial<KeyboardEvent> & { key: string }) => key({ code: "", ...init });

  it("hands the terminal toggles, palette and project switcher to the app", () => {
    expect(appShortcut(k({ key: "`", code: "Backquote", ctrlKey: true }))).toBe("app");
    expect(appShortcut(k({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }))).toBe("app");
    expect(appShortcut(k({ key: "P", ctrlKey: true, shiftKey: true }))).toBe("app");
    expect(appShortcut(k({ key: "E", ctrlKey: true, shiftKey: true }))).toBe("app");
  });

  it("maps Ctrl+PageUp/PageDown to tab switching", () => {
    expect(appShortcut(k({ key: "PageDown", ctrlKey: true }))).toBe("next-tab");
    expect(appShortcut(k({ key: "PageUp", ctrlKey: true }))).toBe("prev-tab");
  });

  it("leaves readline's own chords to the shell", () => {
    expect(appShortcut(k({ key: "p", ctrlKey: true }))).toBeNull();
    expect(appShortcut(k({ key: "e", ctrlKey: true }))).toBeNull();
    expect(appShortcut(k({ key: "PageDown" }))).toBeNull();
    expect(appShortcut(k({ key: "`", code: "Backquote", ctrlKey: true, altKey: true }))).toBeNull();
  });
});
