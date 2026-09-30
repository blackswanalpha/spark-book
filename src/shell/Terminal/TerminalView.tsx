/* ============================================================
   sparkBook · src/shell/Terminal/TerminalView.tsx

   The terminal surface. A real shell runs in the Rust host; this
   component owns four jobs and nothing else:

     1. Size — measure the box, convert to rows/cols, tell the host.
     2. Paint — apply row deltas from `pty://frame` into a grid.
     3. Input — encode key/paste events and post them to the pty.
     4. Select — track a selection in grid coordinates so copy has
        something correct to copy.

   There is no terminal emulator here. The host already resolved
   every cell's text and colour, so painting is a list of styled
   spans, and a frame that changes three rows repaints three rows.
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  appShortcut,
  clipboardIntent,
  ctrlVBytes,
  decodeClipboard,
  encodeArrow,
  encodeKey,
  encodeMouseButton,
  encodePaste,
  encodeWheelMouse,
  onPtyBell,
  onPtyClipboard,
  onPtyExit,
  onPtyFrame,
  ptyAdopt,
  ptyKill,
  ptyList,
  ptyRefresh,
  ptyResize,
  ptyScroll,
  ptySearch,
  ptySetPalette,
  ptySpawn,
  ptyWrite,
  PtyUnavailable,
  type PtyFrame,
  type PtyMouseEncoding,
  type PtyMouseMode,
  type PtyPrivilege,
  type PtySearchResult,
  type PtySpan,
} from "@bridge/pty";
import { readClipboardText, writeClipboardText } from "@bridge/clipboard";
import { ContextMenu, type ContextMenuEntry } from "@ui/ContextMenu";
import { Icon } from "@ui/Icon";
import { useSettings } from "@store/settings";
import { isTauri, openUrl } from "@bridge/commands";
import { linkAt } from "./links";
import { initialMatch, offsetForLine, stepMatch, visibleMatches } from "./search";
import { useCellMetrics } from "./useCellMetrics";
import { applyFrame as reduceFrame, emptyGrid, isFresh, type Grid } from "./grid";
import {
  isEmpty as selectionIsEmpty,
  lineAt,
  pointFromPixels,
  rowSegments,
  selectAll,
  selectionText,
  wordAt,
  type Selection,
} from "./selection";
import {
  offsetForThumbFraction,
  scrollIntentForKey,
  thumbGeometry,
  wheelRows,
} from "./scroll";
import "./TerminalView.css";

/* After the bundled face: fonts that carry the Powerline and Nerd Font
   private-use glyphs prompts and status lines draw with. The engine's own
   fallback skips the private-use area, so without naming them these
   painted as empty boxes. Each is only used if installed. */
const FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", "Symbols Nerd Font Mono", "Symbols Nerd Font", ' +
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "DejaVu Sans Mono for Powerline", ' +
  '"Noto Sans Symbols 2", ui-monospace, monospace';
const PADDING = 8;
/** Two clicks closer together than this widen the selection to a word. */
const MULTI_CLICK_MS = 400;

export type TerminalStatus =
  | { phase: "starting" }
  | { phase: "running"; id: string; shell: string; privilege: PtyPrivilege }
  | { phase: "exited"; code: number; message?: string }
  | { phase: "failed"; message: string };

interface Props {
  cwd: string;
  privilege: PtyPrivilege;
  /** Bumping this restarts the session — used by the Root toggle. */
  restartKey?: number;
  /** Attach to this live host session instead of spawning a shell. */
  adopt?: string;
  /** Take the keyboard when the surface comes into view. Off for a panel
      restored open at boot, which must not pull focus off the editor. */
  focusOnShow?: boolean;
  onStatus?: (s: TerminalStatus) => void;
  onTitle?: (title: string | null) => void;
  /** The shell's working directory, reported as it changes. */
  onCwd?: (cwd: string) => void;
  /** The program rang the bell or sent a notification. */
  onBell?: () => void;
  /** Typed into the shell once it is running — a task's command line. */
  initialInput?: string;
}

/* Sessions being handed to another window. A view unmounting normally
   ends its shell; one whose session is listed here leaves it running for
   the window that adopts it. Consumed by the unmount that finds it. */
const handedOff = new Set<string>();

/** Keep `id`'s shell alive through the next unmount of its view. */
export function detachOnUnmount(id: string) {
  handedOff.add(id);
}

export function TerminalView({
  cwd,
  privilege,
  restartKey = 0,
  adopt,
  focusOnShow = true,
  onStatus,
  onTitle,
  onCwd,
  onBell,
  initialInput,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

  /* Typography and scroll feel come from Settings → Terminal. Changing
     the font size changes the cell, which changes rows/cols, which the
     size effect below reports to the host — so the shell always agrees
     with what is on screen. */
  const fontSize = useSettings((s) => s.settings.terminal.fontSize);
  const lineHeight = useSettings((s) => s.settings.terminal.lineHeight);
  const cursorStyle = useSettings((s) => s.settings.terminal.cursorStyle);
  const cursorBlink = useSettings((s) => s.settings.terminal.cursorBlink);
  const scrollRows = useSettings((s) => s.settings.terminal.scrollRows);

  const cell = useCellMetrics(FONT_FAMILY, fontSize, lineHeight);

  const [grid, setGrid] = useState<Grid>(() => emptyGrid(24));
  const [size, setSize] = useState({ rows: 24, cols: 80 });
  const [cursor, setCursor] = useState({ row: 0, col: 0, visible: true });
  const [status, setStatus] = useState<TerminalStatus>({ phase: "starting" });
  const [focused, setFocused] = useState(false);
  const [scrolledBack, setScrolledBack] = useState(0);
  const [scrollMax, setScrollMax] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);

  const sessionRef = useRef<string | null>(null);
  const modesRef = useRef({
    applicationCursor: false,
    bracketedPaste: false,
    alternateScreen: false,
    mouseMode: "none" as PtyMouseMode,
    mouseEncoding: "default" as PtyMouseEncoding,
    focusReporting: false,
    kittyFlags: 0,
  });
  const seqRef = useRef(-1);
  /** Size the host has actually been told about, to avoid redundant IPC. */
  const sentSizeRef = useRef({ rows: 0, cols: 0 });
  /** Coalesced scroll intent — see the viewport scrolling section below. */
  const scrollRef = useRef<{ pending: number; absolute: number | null; busy: boolean }>({
    pending: 0,
    absolute: null,
    busy: false,
  });
  const scrollWarnedRef = useRef(false);

  /* Callbacks change identity on every parent render; holding them in a
     ref keeps the session effect from tearing down the shell. */
  const onStatusRef = useRef(onStatus);
  const onTitleRef = useRef(onTitle);
  const onCwdRef = useRef(onCwd);
  const onBellRef = useRef(onBell);
  const focusOnShowRef = useRef(focusOnShow);
  /* Read once per mount. A restart remounts the view, so a task's tab
     runs its command again; the session drops the command when the
     privilege flips, so a task is never re-run as root. */
  const initialInputRef = useRef(initialInput);
  useEffect(() => {
    onStatusRef.current = onStatus;
    onTitleRef.current = onTitle;
    onCwdRef.current = onCwd;
    onBellRef.current = onBell;
    focusOnShowRef.current = focusOnShow;
  });

  const publishStatus = useCallback((s: TerminalStatus) => {
    setStatus(s);
    onStatusRef.current?.(s);
  }, []);

  /* ---------- Size: box -> rows/cols ---------- */

  /** Whether the box had a size last time it was measured. */
  const visibleRef = useRef(false);

  const recomputeSize = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const usableW = box.width - PADDING * 2;
    const usableH = box.height - PADDING * 2;
    if (usableW <= 0 || usableH <= 0) {
      visibleRef.current = false;
      return;
    }
    // Inactive tabs are `hidden`, so a box going from nothing to
    // something is this session coming to the front — the moment the
    // surface has to take the keyboard, or typing lands nowhere and the
    // terminal looks dead.
    if (!visibleRef.current) {
      visibleRef.current = true;
      if (focusOnShowRef.current) screenRef.current?.focus({ preventScroll: true });
    }
    const cols = Math.max(2, Math.floor(usableW / cell.width));
    const rows = Math.max(1, Math.floor(usableH / cell.height));
    setSize((prev) => (prev.rows === rows && prev.cols === cols ? prev : { rows, cols }));
  }, [cell.width, cell.height]);

  useLayoutEffect(() => {
    recomputeSize();
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recomputeSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeSize]);

  /* ---------- Frame application ----------

     Declared above the session effect because that effect subscribes
     with it; `useCallback([])` keeps one identity for the component's
     life, so the subscription never has to be rebuilt.
  */

  const applyFrame = useCallback((frame: PtyFrame) => {
    if (!isFresh(frame, seqRef.current)) return;
    seqRef.current = frame.seq;

    modesRef.current = {
      applicationCursor: frame.applicationCursor,
      bracketedPaste: frame.bracketedPaste,
      alternateScreen: frame.alternateScreen ?? false,
      mouseMode: frame.mouseMode ?? "none",
      mouseEncoding: frame.mouseEncoding ?? "default",
      focusReporting: frame.focusReporting ?? false,
      kittyFlags: frame.kittyFlags ?? 0,
    };
    setCursor({ row: frame.cursorRow, col: frame.cursorCol, visible: frame.cursorVisible });
    setScrolledBack(frame.scrollback);
    // A host that predates `scrollbackMax` (a dev build mid-rebuild)
    // would otherwise poison the scrollbar geometry with NaN.
    setScrollMax(Number.isFinite(frame.scrollbackMax) ? frame.scrollbackMax : 0);
    onTitleRef.current?.(frame.title ?? null);
    if (frame.cwd) onCwdRef.current?.(frame.cwd);
    setGrid((prev) => reduceFrame(prev, frame));
  }, []);

  /* ---------- Session lifecycle ----------

     One effect owns the whole session: spawn, subscribe, and on
     teardown kill the shell. `cwd`/`privilege`/`restartKey` changing
     means a different session, so the old one is torn down first.
  */
  useEffect(() => {
    let disposed = false;
    let unlistenFrame: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenExtras: (() => void) | null = null;
    let spawnedId: string | null = null;

    seqRef.current = -1;
    sentSizeRef.current = { rows: 0, cols: 0 };
    setGrid(emptyGrid(size.rows));
    setScrolledBack(0);
    setScrollMax(0);
    setSelection(null);
    scrollRef.current = { pending: 0, absolute: null, busy: false };
    publishStatus({ phase: "starting" });

    (async () => {
      try {
        /* A tab moved here from another window brings its shell along:
           take it over rather than start another. The host answers with
           the session as it stands, and the resize below fits it to this
           box. Adoption is a one-time transfer, so a restart spawns. */
        const adopting = Boolean(adopt) && restartKey === 0;
        const session = adopting
          ? await ptyAdopt(adopt as string)
          : await ptySpawn({
              cwd,
              rows: size.rows,
              cols: size.cols,
              privilege,
            });
        if (disposed) {
          // A shell this effect started is its to end. One it was taking
          // over is not: StrictMode runs this effect twice, and the first
          // pass ending the shell would leave the second nothing to adopt.
          if (!adopting) void ptyKill(session.id).catch(() => {});
          return;
        }
        spawnedId = session.id;
        sessionRef.current = session.id;
        sentSizeRef.current = { rows: session.rows, cols: session.cols };

        /* Events are keyed by session id, so they can only be subscribed
           to once the spawn has answered with one. Frames the shell
           produced in between are not lost: they are deltas against rows
           the host considers painted, and the refresh below asks for the
           whole screen again. */
        const [uf, ue, uc, ub] = await Promise.all([
          onPtyFrame(session.id, applyFrame),
          onPtyExit(session.id, (e) =>
            publishStatus({ phase: "exited", code: e.code, message: e.message }),
          ),
          // OSC 52: a program (vim, tmux, anything over ssh) copying to the
          // system clipboard. Write-only — the host never answers reads.
          onPtyClipboard(session.id, (e) => {
            const text = decodeClipboard(e.data);
            if (text) void writeClipboardText(text);
          }),
          onPtyBell(session.id, () => onBellRef.current?.()),
        ]);
        if (disposed) {
          uf();
          ue();
          uc();
          ub();
          if (!adopting) void ptyKill(session.id).catch(() => {});
          return;
        }
        unlistenFrame = uf;
        unlistenExit = ue;
        unlistenExtras = () => {
          uc();
          ub();
        };
        publishStatus({
          phase: "running",
          id: session.id,
          shell: session.shell,
          privilege: session.privilege,
        });
        void ptyRefresh(session.id).catch(() => {});

        /* The tty buffers input until the shell reads it, so the command
           can go now rather than waiting for a prompt to appear. */
        const pending = initialInputRef.current;
        if (pending && !adopting) {
          initialInputRef.current = undefined;
          void ptyWrite(session.id, pending).catch(() => {});
        }

        /* A shell that died before the listener attached — a bad login
           shell, a pkexec the user cancelled — would otherwise sit on
           "running" forever with a blank screen. The host drops a session
           from its table when it ends, so absence is the signal. */
        const live = await ptyList().catch(() => null);
        if (!disposed && live && !live.some((s) => s.id === session.id)) {
          publishStatus({ phase: "exited", code: 0 });
        }
      } catch (err) {
        if (disposed) return;
        const message =
          err instanceof PtyUnavailable
            ? err.message
            : String((err as { message?: string })?.message ?? err);
        publishStatus({ phase: "failed", message });
      }
    })();

    return () => {
      disposed = true;
      unlistenFrame?.();
      unlistenExit?.();
      unlistenExtras?.();
      const id = spawnedId ?? sessionRef.current;
      if (id) {
        sessionRef.current = null;
        if (handedOff.delete(id)) return;
        void ptyKill(id).catch(() => {});
      }
    };
    // Size is read at spawn time only; later changes go through pty_resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, privilege, restartKey, adopt, publishStatus, applyFrame]);

  /* ---------- Push size changes to the host ---------- */

  useEffect(() => {
    const id = sessionRef.current;
    if (!id || status.phase !== "running") return;
    if (sentSizeRef.current.rows === size.rows && sentSizeRef.current.cols === size.cols) return;
    sentSizeRef.current = { rows: size.rows, cols: size.cols };
    // Reflow moves every cell; a selection in grid coordinates no longer
    // covers the text it was taken from.
    setSelection(null);
    void ptyResize(id, size.rows, size.cols).catch(() => {});
  }, [size.rows, size.cols, status.phase]);

  /* ---------- Input ----------

     `send` sits above the scrolling section because a wheel is input
     too whenever a full-screen program owns the screen. */

  const send = useCallback((data: string) => {
    const id = sessionRef.current;
    if (!id) return;
    void ptyWrite(id, data).catch(() => {});
  }, []);

  /* ---------- Clipboard ----------

     Copy reads the grid, not the DOM. The screen is a stack of
     absolutely positioned spans, so `window.getSelection().toString()`
     returns every row run together with no line breaks — three copied
     lines arrived as one. `selectionText` rebuilds them from the same
     rows that were painted. */

  const copySelection = useCallback(async () => {
    const text = selectionText(grid, selection, size.cols);
    if (!text) return false;
    return writeClipboardText(text);
  }, [grid, selection, size.cols]);

  /** Paste the clipboard's text. With `forwardKey`, a clipboard holding
      no text (an image) sends Ctrl+V to the program instead — see
      `ctrlVBytes` for why that is what makes image paste work. */
  const pasteClipboard = useCallback(
    async (forwardKey = false) => {
      if (!sessionRef.current) return;
      const text = await readClipboardText();
      if (text) send(encodePaste(text, modesRef.current.bracketedPaste));
      else if (forwardKey) send(ctrlVBytes(modesRef.current.kittyFlags));
    },
    [send],
  );

  /** Hand a link from the screen to the browser. */
  const openLink = useCallback((url: string) => {
    if (!isTauri) {
      window.open(url, "_blank", "noopener");
      return;
    }
    void openUrl(url).catch((err) => console.warn("[terminal] could not open link", err));
  }, []);

  /* ---------- Viewport scrolling ----------

     A step through history is a round trip: the host moves its window
     into vt100's scrollback and answers with a full frame. A trackpad
     produces those far faster than the channel can carry them, so
     gestures accumulate into one pending count with a single request in
     flight, and the sub-row remainder is kept so a slow drag still
     eventually moves a row. An absolute jump supersedes whatever
     relative movement was queued behind it.
  */
  const scrollFailed = useCallback((err: unknown) => {
    // One line, once per session: a scroll that cannot reach the host is
    // a real fault, and silently swallowing it is how "the terminal does
    // not scroll" becomes undiagnosable.
    if (scrollWarnedRef.current) return;
    scrollWarnedRef.current = true;
    console.warn("[terminal] scroll request failed", err);
  }, []);

  const pumpScroll = useCallback(() => {
    const st = scrollRef.current;
    if (st.busy) return;
    const id = sessionRef.current;
    if (!id) {
      st.pending = 0;
      st.absolute = null;
      return;
    }

    let call: Promise<number>;
    if (st.absolute !== null) {
      const target = st.absolute;
      st.absolute = null;
      st.pending = 0;
      call = ptyScroll(id, 0, target);
    } else {
      const whole = Math.trunc(st.pending);
      if (whole === 0) return;
      st.pending -= whole;
      call = ptyScroll(id, whole);
    }

    st.busy = true;
    void call
      .catch(scrollFailed)
      .finally(() => {
        st.busy = false;
        pumpScroll();
      });
  }, [scrollFailed]);

  const scrollBy = useCallback(
    (rows: number) => {
      if (!Number.isFinite(rows) || rows === 0) return;
      // The viewport is about to show different rows; a selection keyed
      // to the old ones would highlight the wrong text.
      setSelection(null);
      scrollRef.current.pending += rows;
      pumpScroll();
    },
    [pumpScroll],
  );

  const scrollTo = useCallback(
    (offset: number) => {
      if (!Number.isFinite(offset)) return;
      setSelection(null);
      scrollRef.current.absolute = Math.max(0, Math.round(offset));
      pumpScroll();
    },
    [pumpScroll],
  );

  /* A wheel notch has three possible destinations, and picking the wrong
     one is why scrolling appears dead inside a full-screen program:

       1. The program turned mouse reporting on — hand it the wheel and
          let it scroll itself. This is the only thing that works in a TUI.
       2. The alternate screen is up with no mouse reporting — send arrow
          keys, which is what xterm's alternateScroll does for `less`.
       3. Otherwise the normal screen has real scrollback to move through.

     Only case 3 has a viewport to move; the first two must reach the tty,
     because the alternate grid keeps no history for anyone to scroll. */
  const wheelAccumRef = useRef(0);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const rows = wheelRows(e.deltaY, e.deltaMode, {
        rowsPerNotch: scrollRows,
        cellHeight: cell.height,
        viewportRows: size.rows,
      });
      if (rows === 0) return;

      // Whole steps only, with the remainder carried, so a trackpad's
      // sub-row deltas still add up to movement instead of vanishing.
      wheelAccumRef.current += rows;
      const steps = Math.trunc(wheelAccumRef.current);
      if (steps === 0) return;
      wheelAccumRef.current -= steps;

      const modes = modesRef.current;
      if (!modes.alternateScreen && modes.mouseMode === "none") {
        scrollBy(steps);
        return;
      }

      // One event must not fire off a screenful of keystrokes.
      const count = Math.min(Math.abs(steps), Math.max(1, size.rows));
      const up = steps > 0;

      if (modes.mouseMode !== "none") {
        const box = screenRef.current?.getBoundingClientRect();
        const col = box ? Math.floor((e.clientX - box.left) / cell.width) : 0;
        const row = box ? Math.floor((e.clientY - box.top) / cell.height) : 0;
        const report = encodeWheelMouse(
          {
            up,
            col: Math.min(Math.max(col, 0), size.cols - 1),
            row: Math.min(Math.max(row, 0), size.rows - 1),
            shift: e.shiftKey,
            alt: e.altKey,
            ctrl: e.ctrlKey,
          },
          modes.mouseEncoding,
        );
        send(report.repeat(count));
        return;
      }

      send(encodeArrow(up ? "up" : "down", modes.applicationCursor).repeat(count));
    },
    [scrollBy, send, scrollRows, cell.height, cell.width, size.rows, size.cols],
  );

  /* Dragging the scrollbar: the pointer marks the middle of the thumb,
     so a grab does not jump the viewport by half a screen. */
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const dragTo = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (rect.height <= 0) return;
      const { height } = thumbGeometry(scrolledBack, scrollMax, size.rows);
      const raw = (clientY - rect.top) / rect.height - height / 2;
      const frac = Math.min(1 - height, Math.max(0, raw));
      scrollTo(offsetForThumbFraction(frac, scrollMax, size.rows));
    },
    [scrollTo, scrolledBack, scrollMax, size.rows],
  );

  /* ---------- Mouse selection ----------

     Grid coordinates, not DOM ranges: see selection.ts for why. The
     click counter is kept here rather than read off `event.detail`,
     which WebKit reports as 0 for pointer events. */
  const selectingRef = useRef(false);
  const clickRef = useRef({ time: 0, row: -1, col: -1, count: 0 });
  /** Button currently held down and being reported to the program. */
  const mouseDownRef = useRef<number | null>(null);

  const pointAt = useCallback(
    (clientX: number, clientY: number, edge: "round" | "floor" = "round") => {
      const box = screenRef.current?.getBoundingClientRect();
      if (!box) return { row: 0, col: 0 };
      return pointFromPixels(clientX - box.left, clientY - box.top, cell, size, edge);
    },
    [cell, size],
  );

  const onScreenPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      /* Middle click pastes, as it does in every terminal on this
         platform. It pastes the ordinary clipboard rather than X11's
         PRIMARY selection, which is what the OS bridge exposes — close
         enough to the muscle memory to be worth having, and it is the
         only paste that needs no keyboard at all. */
      if (e.button === 1) {
        e.preventDefault();
        void pasteClipboard();
        return;
      }
      if (e.button !== 0) return;

      /* Ctrl+click opens a link under the pointer — before mouse
         reporting, because a program rarely wants Ctrl+click on a URL and
         a terminal whose links cannot be followed inside a TUI is worse. */
      if (e.ctrlKey || e.metaKey) {
        const at = pointAt(e.clientX, e.clientY, "floor");
        const link = linkAt(grid[at.row], at.col, size.cols);
        if (link) {
          e.preventDefault();
          openLink(link.url);
          return;
        }
      }

      /* A program that asked for mouse reporting owns the pointer: a
         click is a click for it, not a selection for us. Shift is the
         standard override, which is how you select text inside vim.

         The click still has to be HANDED to the program. Returning here
         without doing that — which is what used to happen — left a
         full-screen program unclickable and, because selection was
         declined too, made copy impossible in exactly the applications
         people most want to copy out of. */
      const modes = modesRef.current;
      if (modes.mouseMode !== "none" && !e.shiftKey) {
        e.preventDefault();
        screenRef.current?.focus({ preventScroll: true });
        const at = pointAt(e.clientX, e.clientY, "floor");
        mouseDownRef.current = e.button;
        e.currentTarget.setPointerCapture(e.pointerId);
        send(
          encodeMouseButton(
            {
              button: e.button,
              col: at.col,
              row: at.row,
              kind: "press",
              shift: e.shiftKey,
              alt: e.altKey,
              ctrl: e.ctrlKey,
            },
            modes.mouseEncoding,
          ),
        );
        return;
      }

      e.preventDefault();
      screenRef.current?.focus({ preventScroll: true });

      const floor = pointAt(e.clientX, e.clientY, "floor");
      const now = Date.now();
      const prev = clickRef.current;
      const repeat =
        now - prev.time < MULTI_CLICK_MS && prev.row === floor.row && prev.col === floor.col;
      const count = repeat ? prev.count + 1 : 1;
      clickRef.current = { time: now, row: floor.row, col: floor.col, count };

      if (count >= 3) {
        setSelection(lineAt(floor, size.cols));
        return;
      }
      if (count === 2) {
        setSelection(wordAt(grid, floor, size.cols));
        return;
      }

      const at = pointAt(e.clientX, e.clientY);
      selectingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setSelection({ anchor: at, focus: at, mode: "char" });
    },
    [pointAt, pasteClipboard, grid, size.cols, openLink],
  );

  const onScreenPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const held = mouseDownRef.current;
      if (held !== null) {
        // Only 1002/1003 asked to hear about movement; 1000 did not, and
        // flooding it with reports it never requested confuses it.
        const modes = modesRef.current;
        if (modes.mouseMode !== "buttonMotion" && modes.mouseMode !== "anyMotion") return;
        const at = pointAt(e.clientX, e.clientY, "floor");
        send(
          encodeMouseButton(
            {
              button: held,
              col: at.col,
              row: at.row,
              kind: "motion",
              shift: e.shiftKey,
              alt: e.altKey,
              ctrl: e.ctrlKey,
            },
            modes.mouseEncoding,
          ),
        );
        return;
      }
      if (!selectingRef.current) return;
      const at = pointAt(e.clientX, e.clientY);
      setSelection((prev) =>
        prev && prev.focus.row === at.row && prev.focus.col === at.col
          ? prev
          : prev && { ...prev, focus: at },
      );
    },
    [pointAt],
  );

  const endSelecting = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const held = mouseDownRef.current;
      if (held !== null) {
        mouseDownRef.current = null;
        const modes = modesRef.current;
        // DEC 9 (press) reports presses only — it never wants a release.
        if (modes.mouseMode !== "none" && modes.mouseMode !== "press") {
          const at = pointAt(e.clientX, e.clientY, "floor");
          send(
            encodeMouseButton(
              {
                button: held,
                col: at.col,
                row: at.row,
                kind: "release",
                shift: e.shiftKey,
                alt: e.altKey,
                ctrl: e.ctrlKey,
              },
              modes.mouseEncoding,
            ),
          );
        }
      }
      if (!selectingRef.current) return;
      selectingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    },
    [pointAt, send],
  );

  /* ---------- Find in terminal ----------

     The host searches everything it holds — 5000 lines of scrollback and
     the screen — and the bar steps through the hits, scrolling each into
     view. Enter goes to the next older hit, Shift+Enter the next newer. */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [found, setFound] = useState<PtySearchResult | null>(null);
  const [current, setCurrent] = useState(-1);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findSeqRef = useRef(0);

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFound(null);
    setCurrent(-1);
    screenRef.current?.focus({ preventScroll: true });
  }, []);

  /** Scroll so match `index` is on screen, unless it already is. */
  const reveal = useCallback(
    (result: PtySearchResult, index: number) => {
      const m = result.matches[index];
      if (!m) return;
      const row = m.line - (scrollMax - scrolledBack);
      if (row >= 0 && row < size.rows) return;
      scrollTo(offsetForLine(m.line, result.scrollbackMax, size.rows));
    },
    [scrollMax, scrolledBack, size.rows, scrollTo],
  );

  const runSearch = useCallback(async () => {
    const id = sessionRef.current;
    const seq = ++findSeqRef.current;
    if (!id || !findQuery) {
      setFound(null);
      setCurrent(-1);
      return null;
    }
    try {
      const result = await ptySearch(id, findQuery, findCase);
      if (seq !== findSeqRef.current) return null;
      setFound(result);
      return result;
    } catch (err) {
      console.warn("[terminal] search failed", err);
      return null;
    }
  }, [findQuery, findCase]);

  // Search as the query changes, a beat after the last keystroke.
  useEffect(() => {
    if (!findOpen) return;
    const t = setTimeout(() => {
      void runSearch().then((result) => {
        if (!result) return;
        const idx = initialMatch(result.matches);
        setCurrent(idx);
        if (idx >= 0) reveal(result, idx);
      });
    }, 150);
    return () => clearTimeout(t);
    // `reveal` changes as the view scrolls; re-searching on scroll is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, runSearch]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!found) return;
      const next = stepMatch(current, found.matches.length, dir);
      setCurrent(next);
      if (next >= 0) reveal(found, next);
    },
    [found, current, reveal],
  );

  const matchBoxes = useMemo(
    () => (found ? visibleMatches(found.matches, scrollMax, scrolledBack, size.rows) : []),
    [found, scrollMax, scrolledBack, size.rows],
  );

  /* ---------- Keyboard ----------

     Tab and Shift+Tab are focus-navigation keys to the engine before they
     are anything else. Cancelling the keydown's default is what keeps the
     keyboard on the terminal, and it only works when the encoder actually
     recognises the press: see `keyOf` in bridge/pty.ts for the WebKitGTK
     Shift+Tab case, which used to arrive unnamed, go unhandled, and move
     focus to the panel's Restart button. */

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (status.phase !== "running") return;

      // Ctrl+Shift+F searches the scrollback. Plain Ctrl+F stays the
      // shell's (readline's forward-char).
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        e.stopPropagation();
        openFind();
        return;
      }

      // Panel toggles, the palette and tab switching belong to the app.
      const app = appShortcut(e.nativeEvent);
      if (app === "app") return;
      if (app) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("spark:terminal:cycle", { detail: { step: app === "next-tab" ? 1 : -1 } }),
        );
        return;
      }

      /* Copy and paste are the surface's, never the shell's — Ctrl+C has
         to stay SIGINT, which is the whole reason terminals moved copy
         onto Ctrl+Shift+C and Ctrl+Insert. */
      const clip = clipboardIntent(e.nativeEvent);
      if (clip) {
        e.preventDefault();
        e.stopPropagation();
        if (clip === "copy") void copySelection();
        else void pasteClipboard(true);
        return;
      }

      // Escape drops a selection before it reaches the shell as ESC —
      // only when there is one, so Escape still works as a key.
      if (e.key === "Escape" && !selectionIsEmpty(selection, size.cols)) {
        e.preventDefault();
        e.stopPropagation();
        setSelection(null);
        return;
      }

      // Shift+PageUp/PageDown/Home/End move the viewport, not the shell.
      // Bare PageUp still goes to the tty: pagers and editors bind it.
      const intent = scrollIntentForKey(e.nativeEvent, {
        viewportRows: size.rows,
        scrollbackMax: scrollMax,
      });
      if (intent) {
        e.preventDefault();
        e.stopPropagation();
        if ("delta" in intent) scrollBy(intent.delta);
        else scrollTo(intent.absolute);
        return;
      }

      const bytes = encodeKey(e.nativeEvent, modesRef.current);
      if (bytes === null) return;
      e.preventDefault();
      e.stopPropagation();
      // Typing scrolls the host back to the live bottom, so the selection
      // would be pointing at rows that are no longer on screen.
      if (selection) setSelection(null);
      send(bytes);
    },
    [
      send,
      status.phase,
      size.rows,
      size.cols,
      scrollMax,
      scrollBy,
      scrollTo,
      copySelection,
      pasteClipboard,
      selection,
      openFind,
    ],
  );

  /* The webview still delivers a native paste for the platform's own
     binding (Cmd+V on macOS); routing it through the same encoder keeps
     bracketed paste correct on that path too. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (text) send(encodePaste(text, modesRef.current.bracketedPaste));
      else if (e.clipboardData.types.some((t) => t === "Files" || t.startsWith("image/"))) {
        send(ctrlVBytes(modesRef.current.kittyFlags));
      }
    },
    [send],
  );

  /* ---------- Focus reporting (DEC 1004) ----------

     Editors reload changed files and agents pause spinners on these. The
     surface only reports while the program has asked. */
  const reportFocus = useCallback(
    (gained: boolean) => {
      if (modesRef.current.focusReporting) send(gained ? "\x1b[I" : "\x1b[O");
    },
    [send],
  );

  /* ---------- File drop ----------

     Dropping files on a terminal types their paths, shell-quoted, the way
     every desktop terminal does. It is also how an image reaches a program
     that attaches pictures by path — Claude Code turns a pasted image path
     into an attachment. Tauri intercepts OS file drops before the DOM sees
     them, so the drop arrives as a webview event with window coordinates. */
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const inside = (pos: { x: number; y: number }) => {
      const box = hostRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return false;
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "leave") {
            setDropping(false);
            return;
          }
          const over = inside(p.position);
          if (p.type === "enter" || p.type === "over") {
            setDropping(over);
            return;
          }
          setDropping(false);
          if (!over || !sessionRef.current || p.paths.length === 0) return;
          const text = p.paths.map(shellQuote).join(" ") + " ";
          send(encodePaste(text, modesRef.current.bracketedPaste));
          screenRef.current?.focus({ preventScroll: true });
        }),
      )
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [send]);

  /* ---------- Theme colours for the host ----------

     Programs ask the terminal for its background (OSC 11) to choose a
     light or dark scheme. The host answers from what it was told last.
     The theme is read off `data-theme` on <html> rather than the theme
     context, so the pop-out window — which has no provider — keeps up. */
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !isTauri) return;
    const push = () => {
      const css = getComputedStyle(el);
      const fg = css.getPropertyValue("--term-fg").trim();
      const bg = css.getPropertyValue("--term-bg").trim();
      const cursorColor = css.getPropertyValue("--term-cursor").trim();
      if (fg && bg) void ptySetPalette(fg, bg, cursorColor || undefined).catch(() => {});
    };
    push();
    const mo = new MutationObserver(push);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  /* ---------- Context menu ---------- */

  const hasSelection = !selectionIsEmpty(selection, size.cols);

  /** The link under the pointer when the menu was opened. */
  const [menuLink, setMenuLink] = useState<string | null>(null);
  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const at = pointAt(e.clientX, e.clientY, "floor");
      setMenuLink(linkAt(grid[at.row], at.col, size.cols)?.url ?? null);
    },
    [pointAt, grid, size.cols],
  );

  const menuEntries = useMemo<ContextMenuEntry[]>(
    () => [
      ...(menuLink
        ? ([
            { id: "openLink", label: "Open link", icon: "external", shortcut: "Ctrl+Click" },
            { id: "copyLink", label: "Copy link", icon: "link" },
            { id: "sepLink", separator: true },
          ] satisfies ContextMenuEntry[])
        : []),
      { id: "copy", label: "Copy", icon: "copy", shortcut: "Ctrl+Shift+C", disabled: !hasSelection },
      { id: "paste", label: "Paste", icon: "clipboard", shortcut: "Ctrl+Shift+V" },
      { id: "sep", separator: true },
      { id: "find", label: "Find…", icon: "search", shortcut: "Ctrl+Shift+F" },
      { id: "selectAll", label: "Select all", icon: "check" },
      { id: "clear", label: "Clear selection", icon: "close", disabled: !hasSelection },
    ],
    [hasSelection, menuLink],
  );

  const onMenuSelect = useCallback(
    (id: string) => {
      switch (id) {
        case "copy":
          void copySelection();
          break;
        case "paste":
          void pasteClipboard(true);
          break;
        case "selectAll":
          setSelection(selectAll(size.rows, size.cols));
          break;
        case "clear":
          setSelection(null);
          break;
        case "openLink":
          if (menuLink) openLink(menuLink);
          break;
        case "copyLink":
          if (menuLink) void writeClipboardText(menuLink);
          break;
        case "find":
          openFind();
          return;
      }
      screenRef.current?.focus({ preventScroll: true });
    },
    [copySelection, pasteClipboard, size.rows, size.cols, menuLink, openLink, openFind],
  );

  /* ---------- Render ---------- */

  const gridStyle = useMemo(
    () => ({
      fontFamily: FONT_FAMILY,
      fontSize: `${fontSize}px`,
      lineHeight: `${cell.height}px`,
      width: `${size.cols * cell.width}px`,
      height: `${size.rows * cell.height}px`,
    }),
    [cell.width, cell.height, size.cols, size.rows, fontSize],
  );

  const thumb = useMemo(
    () => thumbGeometry(scrolledBack, scrollMax, size.rows),
    [scrolledBack, scrollMax, size.rows],
  );

  const highlights = useMemo(
    () => rowSegments(selection, size.cols, size.rows),
    [selection, size.cols, size.rows],
  );

  const showCursor =
    cursor.visible && focused && status.phase === "running" && scrolledBack === 0 && !hasSelection;

  return (
    <ContextMenu entries={menuEntries} onSelect={onMenuSelect}>
      <div
        ref={hostRef}
        className={`tv ${focused ? "is-focused" : ""}`}
        style={{ padding: PADDING }}
        /* The host takes focus only to hand it straight on. Radix returns
           focus to its trigger — this element — when the context menu
           closes, and without somewhere to send it the keyboard would end
           up on the body and typing would go nowhere. */
        tabIndex={-1}
        onFocus={(e) => {
          if (e.target === e.currentTarget) screenRef.current?.focus({ preventScroll: true });
        }}
        onWheel={onWheel}
        onPointerDown={(e) => {
          // The grid does not fill the box: there is padding around it, and
          // short rows leave the right-hand side empty. Clicking any of that
          // must still put the keyboard on the terminal.
          if (e.target === e.currentTarget) screenRef.current?.focus({ preventScroll: true });
        }}
      >
        <div
          ref={screenRef}
          className="tv__screen"
          style={gridStyle}
          tabIndex={0}
          role="textbox"
          aria-multiline="true"
          aria-label="Terminal"
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => {
            setFocused(true);
            reportFocus(true);
          }}
          onBlur={() => {
            setFocused(false);
            reportFocus(false);
          }}
          onPointerDown={onScreenPointerDown}
          onContextMenu={onContextMenu}
          onPointerMove={onScreenPointerMove}
          onPointerUp={endSelecting}
          onPointerCancel={endSelecting}
        >
          {highlights.map((seg) => (
            <div
              key={seg.y}
              className="tv__selection"
              style={{
                top: seg.y * cell.height,
                left: seg.col * cell.width,
                width: seg.width * cell.width,
                height: cell.height,
              }}
              aria-hidden
            />
          ))}

          {matchBoxes.map((m) => (
            <div
              key={`${m.index}`}
              className={`tv__match ${m.index === current ? "is-current" : ""}`}
              style={{
                top: m.row * cell.height,
                left: m.col * cell.width,
                width: m.len * cell.width,
                height: cell.height,
              }}
              aria-hidden
            />
          ))}

          {grid.map((row, y) => (
            <div key={y} className="tv__row" style={{ top: y * cell.height, height: cell.height }}>
              {row ? row.spans.map((span, i) => <Cell key={i} span={span} cell={cell} />) : null}
            </div>
          ))}

          {showCursor && (
            <div
              className={`tv__cursor tv__cursor--${cursorStyle} ${cursorBlink ? "is-blinking" : ""}`}
              style={{
                top: cursor.row * cell.height,
                left: cursor.col * cell.width,
                width: cell.width,
                height: cell.height,
              }}
              aria-hidden
            />
          )}
        </div>

        {scrollMax > 0 && (
          <div
            ref={trackRef}
            className={`tv__scrollbar ${scrolledBack > 0 ? "is-active" : ""}`}
            aria-hidden
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              draggingRef.current = true;
              dragTo(e.clientY);
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) dragTo(e.clientY);
            }}
            onPointerUp={(e) => {
              draggingRef.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              draggingRef.current = false;
            }}
          >
            <div
              className="tv__thumb"
              style={{ top: `${thumb.top * 100}%`, height: `${thumb.height * 100}%` }}
            />
          </div>
        )}

        {scrolledBack > 0 && (
          <button
            type="button"
            className="tv__scrollback"
            // Keep the keyboard on the terminal: a button that takes focus
            // sends the next thing typed nowhere.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              scrollTo(0);
              screenRef.current?.focus({ preventScroll: true });
            }}
          >
            {scrolledBack} rows back — jump to latest
          </button>
        )}

        {findOpen && (
          <div
            className="tv__find"
            role="search"
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <input
              ref={findInputRef}
              className="tv__findInput"
              value={findQuery}
              placeholder="Find in terminal"
              aria-label="Find in terminal"
              spellCheck={false}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  step(e.shiftKey ? 1 : -1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                }
              }}
            />
            <span className="tv__findCount" aria-live="polite">
              {!findQuery
                ? ""
                : !found
                  ? "…"
                  : found.matches.length === 0
                    ? "No results"
                    : `${current + 1}/${found.matches.length}${found.truncated ? "+" : ""}`}
            </span>
            <button
              type="button"
              className={`tv__findBtn ${findCase ? "is-on" : ""}`}
              aria-pressed={findCase}
              title="Match case"
              onClick={() => setFindCase((v) => !v)}
            >
              Aa
            </button>
            <button type="button" className="tv__findBtn" title="Older (Enter)" aria-label="Older match" onClick={() => step(-1)}>
              <Icon name="arrow-up" size={13} />
            </button>
            <button type="button" className="tv__findBtn" title="Newer (Shift+Enter)" aria-label="Newer match" onClick={() => step(1)}>
              <Icon name="chevron-down" size={13} />
            </button>
            <button type="button" className="tv__findBtn" title="Close (Esc)" aria-label="Close find" onClick={closeFind}>
              <Icon name="close" size={12} />
            </button>
          </div>
        )}

        {dropping && <div className="tv__drop">Drop to insert the path</div>}

        {status.phase !== "running" && <StatusOverlay status={status} />}
      </div>
    </ContextMenu>
  );
}

/** Quote a path for a POSIX shell, leaving plain ones readable. */
export function shellQuote(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** One styled run, positioned by column so gaps stay gaps. */
function Cell({ span, cell }: { span: PtySpan; cell: { width: number; height: number } }) {
  const fg = span.inverse ? span.bg : span.fg;
  const bg = span.inverse ? span.fg : span.bg;
  const color = fg ?? (span.inverse ? "var(--term-bg)" : undefined);
  return (
    <span
      className="tv__span"
      style={{
        left: span.col * cell.width,
        // Faint text keeps its hue at reduced strength over whatever is
        // behind it, which is what SGR 2 means — not bold.
        color: span.dim
          ? `color-mix(in srgb, ${color ?? "var(--term-fg)"} 55%, transparent)`
          : color,
        background: bg ?? (span.inverse ? "var(--term-fg)" : undefined),
        fontWeight: span.bold ? 700 : undefined,
        fontStyle: span.italic ? "italic" : undefined,
        textDecoration: span.underline ? "underline" : undefined,
      }}
    >
      {span.text}
    </span>
  );
}

function StatusOverlay({ status }: { status: TerminalStatus }) {
  switch (status.phase) {
    case "starting":
      return <div className="tv__overlay tv__overlay--quiet">Starting shell…</div>;
    case "exited":
      return (
        <div className="tv__overlay">
          Shell exited{status.code !== 0 ? ` with code ${status.code}` : ""}.
          {status.message ? ` ${status.message}` : ""}
        </div>
      );
    case "failed":
      return <div className="tv__overlay tv__overlay--error">{status.message}</div>;
    case "running":
      return null;
  }
}
