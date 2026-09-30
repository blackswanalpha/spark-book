/* ============================================================
   sparkBook · src/shell/TerminalPanel.tsx

   Floating terminal panel and its pop-out twin.

   The panel owns chrome and window management; the shells live in
   the Rust host (src-tauri/src/pty.rs) and the grids are painted by
   TerminalView. xterm.js is gone — there is no terminal emulator in
   the renderer any more, and no simulated command table either:
   `ls`, `vim`, `htop` and everything else are the real programs.

   Tabs: one tab per shell, "+" opens another. Every session stays
   mounted and the inactive ones are hidden, because TerminalView
   kills its shell on unmount — an unmounting tab would end the
   session every time you looked at a different one.

   Mobile: a toggle that pins the *surface* to a phone viewport
   (dimensions only, no device frame). CSS drives it off two custom
   properties, so leaving mobile restores whatever size the user had
   dragged the panel to without the panel having to remember it.

   Root: the "Root" toggle respawns the active session through
   pkexec/sudo. The OS collects the password on its own; the app
   never sees, stores or forwards a credential.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@ui/Icon";
import { useExplorer, directoryOf } from "@store/explorer";
import { useDocs } from "@store/documents";
import { useTerminal, type RestoredTab } from "@store/terminal";
import { useSettings } from "@store/settings";
import { isTauri } from "@bridge/commands";
import { ptyRootSupport, type PtyPrivilege, type RootSupport } from "@bridge/pty";
import { TerminalView, detachOnUnmount, type TerminalStatus } from "./Terminal/TerminalView";
import {
  cleanName,
  createSession,
  closeSession as removeSession,
  currentCwd,
  cycleFrom,
  displayName,
  sessionTooltip,
  nextActiveAfterClose,
  patchSession,
  type TerminalSession,
} from "./Terminal/sessions";
import "./TerminalPanel.css";

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return "/";
  return path.slice(0, idx) || "/";
}

/**
 * Where a NEW terminal should start.
 *
 * Existing sessions keep the cwd they spawned with; this only feeds the
 * "+" button and the first session, so moving the tree selection stages
 * the next terminal instead of relocating the one you are typing in.
 */
function useNewTerminalCwd(): string {
  const root = useExplorer((s) => s.root);
  const selected = useExplorer((s) => s.selectedPath);
  const children = useExplorer((s) => s.children);
  const activePath = useDocs((s) => {
    const id = s.active;
    return id ? (s.docs[id]?.path ?? null) : null;
  });

  return useMemo(() => {
    if (selected) return directoryOf(children, selected);
    if (activePath) return dirOf(activePath);
    if (root) return root;
    // No folder open: home, as any terminal starts. The host expands it.
    return "~";
  }, [selected, children, activePath, root]);
}

const MIN_W = 380;
const MIN_H = 220;

/** One tab as handed to the pop-out window in its URL. */
export interface PoppedTab extends RestoredTab {
  /** Live host session to adopt; absent when the shell had ended. */
  adopt?: string;
}

/* Chrome the mobile preset has to sit inside, measured from the CSS:
   header + tab strip + footer + the holder's own padding, and the
   holder's padding plus the panel's border across. Keep these in step
   with the .term--mobile rules in TerminalPanel.css. */
const PANEL_CHROME_H = 40 + 32 + 28 + 8;
const PANEL_CHROME_W = 8 + 2;

/* ---------- Attention ----------

   A bell (or a notification OSC) from a shell the user is not looking
   at marks its tab, so a long build or an agent waiting on a question
   is noticed without polling every tab. Looking at the tab clears it. */

function useAttention(activeId: string | null) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const clear = useCallback((id: string | null) => {
    if (!id) return;
    setIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const ring = useCallback((id: string) => {
    // The tab in front of a focused window needs no badge.
    if (id === activeRef.current && document.hasFocus()) return;
    setIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  useEffect(() => clear(activeId), [activeId, clear]);
  useEffect(() => {
    const onFocus = () => clear(activeRef.current);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [clear]);

  return { attention: ids, ring };
}

/* ---------- Tab strip ---------- */

function SessionTabs({
  sessions,
  activeId,
  attention,
  onSelect,
  onClose,
  onAdd,
  onRename,
  children,
}: {
  sessions: TerminalSession[];
  activeId: string | null;
  /** Sessions that rang the bell since they were last looked at. */
  attention?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  /** Name a tab; null clears the name. */
  onRename: (id: string, name: string | null) => void;
  children?: React.ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef(sessions.length);

  /* Renaming: double-click a tab, press F2 on it, or run "Terminal:
     Rename Tab". Many shells in one project all read "src" otherwise. */
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const startRename = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      if (s) setRenaming({ id, draft: s.name ?? displayName(s) });
    },
    [sessions],
  );
  const commitRename = useCallback(() => {
    setRenaming((r) => {
      if (r) onRename(r.id, cleanName(r.draft));
      return null;
    });
  }, [onRename]);
  useEffect(() => {
    const onReq = () => {
      if (activeId) startRename(activeId);
    };
    window.addEventListener("spark:terminal:rename", onReq);
    return () => window.removeEventListener("spark:terminal:rename", onReq);
  }, [activeId, startRename]);

  /* A new tab is appended off the right edge once the strip fills up;
     scrolling to it is the difference between "+" appearing to work and
     appearing to do nothing. */
  useEffect(() => {
    if (sessions.length > countRef.current) {
      const el = stripRef.current;
      if (el) el.scrollLeft = el.scrollWidth;
    }
    countRef.current = sessions.length;
  }, [sessions.length]);

  const focusTab = useCallback((id: string) => {
    stripRef.current?.querySelector<HTMLElement>(`[id="term-tab-${id}"]`)?.focus();
  }, []);

  /* Only the active tab is a tab stop (roving tabindex), so the arrows
     are the only way to reach the others from the keyboard. And once a
     tab's own close button is gone the keyboard lands on the body; put
     it on whichever tab took over instead. A surface holding focus is
     left alone — it is the user typing. */
  const seenRef = useRef<{ activeId: string | null; count: number } | null>(null);
  useEffect(() => {
    const seen = seenRef.current;
    seenRef.current = { activeId, count: sessions.length };
    // Only a change moves the keyboard: the strip mounting at boot must
    // not pull it anywhere.
    if (!seen || !activeId || (seen.activeId === activeId && seen.count === sessions.length)) return;
    const focus = document.activeElement;
    const strip = stripRef.current;
    if (focus === document.body || (strip && focus && strip.contains(focus))) focusTab(activeId);
  }, [activeId, sessions.length, focusTab]);

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, id: string) => {
    const idx = sessions.findIndex((s) => s.id === id);
    let target: TerminalSession | undefined;
    switch (e.key) {
      case "Enter":
      case " ":
        target = sessions[idx];
        break;
      case "ArrowRight":
        target = sessions[(idx + 1) % sessions.length];
        break;
      case "ArrowLeft":
        target = sessions[(idx - 1 + sessions.length) % sessions.length];
        break;
      case "Home":
        target = sessions[0];
        break;
      case "End":
        target = sessions[sessions.length - 1];
        break;
      case "Delete":
        e.preventDefault();
        onClose(id);
        return;
      case "F2":
        e.preventDefault();
        startRename(id);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (!target) return;
    onSelect(target.id);
    focusTab(target.id);
  };

  return (
    <div className="term__tabs">
      <div className="term__tabList" role="tablist" aria-label="Terminal sessions" ref={stripRef}>
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              className={`term__tab ${active ? "is-active" : ""}`}
              // The close control is a button, so the tab itself cannot be
              // one — a button inside a button is invalid and Firefox drops
              // the inner one's clicks.
              role="tab"
              tabIndex={active ? 0 : -1}
              id={`term-tab-${s.id}`}
              aria-selected={active}
              aria-controls={`term-panel-${s.id}`}
              title={sessionTooltip(s)}
              onClick={() => onSelect(s.id)}
              onDoubleClick={() => startRename(s.id)}
              onKeyDown={(e) => onTabKeyDown(e, s.id)}
              onAuxClick={(e) => {
                // Middle-click closes, as it does on the editor's own tabs.
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(s.id);
                }
              }}
            >
              <Icon
                name={s.privilege === "root" ? "alert" : "terminal"}
                size={13}
                className={s.privilege === "root" ? "term__tabIcon--root" : undefined}
              />
              {renaming?.id === s.id ? (
                <input
                  className="term__tabRename"
                  value={renaming.draft}
                  aria-label="Tab name"
                  placeholder={displayName({ ...s, name: null })}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setRenaming({ id: s.id, draft: e.target.value })}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // The tab's own keys (arrows, Delete, Enter) must not
                    // act while its name is being typed.
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="term__tabName">{displayName(s)}</span>
              )}
              {attention?.has(s.id) && (
                <span className="term__tabBell" role="status" aria-label="Needs attention" />
              )}
              <button
                type="button"
                className="term__tabClose"
                aria-label={`Close ${displayName(s)}`}
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
                }}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          className="term__tabAdd"
          aria-label="New terminal"
          title="New terminal"
          onClick={onAdd}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      <span className="term__tabs-gap" aria-hidden />
      {children}
    </div>
  );
}

/* ---------- Surfaces ---------- */

function SessionSurfaces({
  sessions,
  activeId,
  holderClass,
  focusOnShow = true,
  onStatus,
  onTitle,
  onCwd,
  onBell,
}: {
  sessions: TerminalSession[];
  activeId: string | null;
  holderClass: string;
  /** See TerminalView: off while the panel is showing what a restore put back. */
  focusOnShow?: boolean;
  onStatus: (id: string, s: TerminalStatus) => void;
  onTitle: (id: string, t: string | null) => void;
  onCwd: (id: string, cwd: string) => void;
  onBell?: (id: string) => void;
}) {
  return (
    <>
      {sessions.map((s) => (
        <div
          key={s.id}
          className={holderClass}
          role="tabpanel"
          id={`term-panel-${s.id}`}
          aria-labelledby={`term-tab-${s.id}`}
          hidden={s.id !== activeId}
        >
          <TerminalView
            // cwd and privilege are part of the session's identity: a
            // change to either is a different shell, and remounting stops
            // the view painting the previous session's grid for a frame.
            key={`${s.cwd}::${s.privilege}::${s.restartKey}`}
            cwd={s.cwd}
            privilege={s.privilege}
            restartKey={s.restartKey}
            adopt={s.adopt}
            initialInput={s.initialInput}
            focusOnShow={focusOnShow}
            onStatus={(st) => onStatus(s.id, st)}
            onTitle={(t) => onTitle(s.id, t)}
            onCwd={(c) => onCwd(s.id, c)}
            onBell={() => onBell?.(s.id)}
          />
        </div>
      ))}
    </>
  );
}

/** Footer text for whichever session is in front. */
function statusLine(status: TerminalStatus | undefined): string {
  if (!status) return "starting…";
  switch (status.phase) {
    case "running":
      return `${status.shell}${status.privilege === "root" ? " · root" : ""}`;
    case "exited":
      return `exited (${status.code}) — Restart to start a new shell`;
    case "failed":
      return status.message;
    default:
      return "starting…";
  }
}

/* ---------- Docked panel ---------- */

export function TerminalDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const newCwd = useNewTerminalCwd();
  const sessions = useTerminal((s) => s.sessions);
  const activeId = useTerminal((s) => s.activeId);
  const { attention, ring } = useAttention(activeId);
  const mobile = useTerminal((s) => s.mobile);
  const setMobile = useTerminal((s) => s.setMobile);
  const ensureSession = useTerminal((s) => s.ensureSession);
  const addSession = useTerminal((s) => s.addSession);
  const closeSessionById = useTerminal((s) => s.closeSession);
  const setActiveSession = useTerminal((s) => s.setActiveSession);
  const setPrivilege = useTerminal((s) => s.setPrivilege);
  const restartSession = useTerminal((s) => s.restartSession);
  const setSessionTitle = useTerminal((s) => s.setSessionTitle);
  const setSessionCwd = useTerminal((s) => s.setSessionCwd);
  const renameSession = useTerminal((s) => s.renameSession);
  const statuses = useTerminal((s) => s.statuses);
  const setStatus = useTerminal((s) => s.setStatus);
  const mobileW = useSettings((s) => s.settings.terminal.mobileWidth);
  const mobileH = useSettings((s) => s.settings.terminal.mobileHeight);

  /* Geometry lives in the store, not in local state, so it can be
     captured into the project workspace — and so it survives a remount,
     which the old placedRef could not. */
  const panel = useTerminal((s) => s.panel);
  const panelPlaced = useTerminal((s) => s.panelPlaced);
  const setPanelRect = useTerminal((s) => s.setPanelRect);
  // Memoised so the drag/resize callbacks below keep a stable identity.
  const pos = useMemo(() => ({ x: panel.x, y: panel.y }), [panel.x, panel.y]);
  const size = useMemo(() => ({ w: panel.w, h: panel.h }), [panel.w, panel.h]);
  const setPos = useCallback(
    (next: { x: number; y: number } | ((p: { x: number; y: number }) => { x: number; y: number })) => {
      const cur = useTerminal.getState().panel;
      const value = typeof next === "function" ? next({ x: cur.x, y: cur.y }) : next;
      useTerminal.getState().setPanelRect(value);
    },
    [],
  );
  const setSize = useCallback(
    (next: { w: number; h: number } | ((p: { w: number; h: number }) => { w: number; h: number })) => {
      const cur = useTerminal.getState().panel;
      const value = typeof next === "function" ? next({ w: cur.w, h: cur.h }) : next;
      useTerminal.getState().setPanelRect(value);
    },
    [],
  );

  const [rootSupport, setRootSupport] = useState<RootSupport | null>(null);
  const [popping, setPopping] = useState(false);
  /** The panel's shells have been started (it was opened with these tabs). */
  const [spawned, setSpawned] = useState(open);
  useEffect(() => {
    if (open) setSpawned(true);
    else if (sessions.length === 0) setSpawned(false);
  }, [open, sessions.length]);

  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  /* A panel the workspace restore opened must not take the keyboard off
     the editor at boot; the store clears this on the first thing the user
     does to the panel. */
  const restoredOpen = useTerminal((s) => s.restoredOpen);

  /* The panel opens before it knows where to spawn; the cwd derivation is
     a hook, so the first session is created here rather than in the store. */
  useEffect(() => {
    if (open) ensureSession(newCwd);
    // newCwd is read once per open on purpose: re-running when the tree
    // selection moves would be a second spawn, not a relocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ensureSession]);

  /* "New Terminal" from the palette/menu lands here, because the cwd it
     should spawn in is derived by this component, not by the registry.
     Deliberately not gated on `open`: hooks run before this component's
     early return, so a closed panel still hears the request and opens
     for it. */
  useEffect(() => {
    const onNew = () => {
      useTerminal.getState().open();
      addSession(newCwd);
    };
    window.addEventListener("spark:terminal:new", onNew);
    return () => window.removeEventListener("spark:terminal:new", onNew);
  }, [addSession, newCwd]);

  /* Next/previous tab: Ctrl+PageDown/PageUp inside a shell, or the
     palette. The pop-out window answers the same event for its tabs. */
  useEffect(() => {
    const onCycle = (e: Event) => {
      const step = (e as CustomEvent<{ step: 1 | -1 }>).detail?.step ?? 1;
      useTerminal.getState().cycleSession(step);
    };
    window.addEventListener("spark:terminal:cycle", onCycle);
    return () => window.removeEventListener("spark:terminal:cycle", onCycle);
  }, []);

  /* Place the panel bottom-right on first open, then leave it where the
     user put it — re-centring on every open loses their arrangement. */
  useEffect(() => {
    if (!open || panelPlaced) return;
    setPanelRect(
      {
        x: Math.max(12, window.innerWidth - size.w - 24),
        y: Math.max(12, window.innerHeight - size.h - 56),
      },
      true,
    );
  }, [open, panelPlaced, setPanelRect, size.w, size.h]);

  /* A restored rect was measured against the previous window. Pull it
     back on screen once, rather than leaving the panel off the edge. */
  useEffect(() => {
    if (!open) return;
    setPos((p) => ({
      x: Math.min(p.x, Math.max(0, window.innerWidth - 120)),
      y: Math.min(p.y, Math.max(0, window.innerHeight - 60)),
    }));
  }, [open, setPos]);

  /* Keep the panel reachable when the window shrinks under it. */
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      setPos((p) => ({
        x: Math.min(p.x, Math.max(0, window.innerWidth - 120)),
        y: Math.min(p.y, Math.max(0, window.innerHeight - 60)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, setPos]);

  useEffect(() => {
    if (!open || !isTauri) return;
    let cancelled = false;
    ptyRootSupport()
      .then((s) => {
        if (!cancelled) setRootSupport(s);
      })
      .catch(() => {
        if (!cancelled) setRootSupport({ available: false, method: "none", alreadyRoot: false });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onStatus = useCallback(
    (id: string, s: TerminalStatus) => setStatus(id, s),
    [setStatus],
  );

  const onTitle = useCallback(
    (id: string, t: string | null) => setSessionTitle(id, t),
    [setSessionTitle],
  );

  const onCwd = useCallback(
    (id: string, cwd: string) => setSessionCwd(id, cwd),
    [setSessionCwd],
  );

  /* ---------- Drag ---------- */

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos],
  );

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy)),
    });
  }, [setPos]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  /* ---------- Resize ---------- */

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = size.w;
      const startH = size.h;
      const originX = pos.x;
      const originY = pos.y;

      const onMove = (ev: PointerEvent) => {
        setSize({
          w: Math.max(MIN_W, Math.min(window.innerWidth - originX - 8, startW + ev.clientX - startX)),
          h: Math.max(MIN_H, Math.min(window.innerHeight - originY - 8, startH + ev.clientY - startY)),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [pos.x, pos.y, size.w, size.h, setSize],
  );

  const togglePrivilege = useCallback(() => {
    if (!active) return;
    setPrivilege(active.id, active.privilege === "root" ? "user" : "root");
  }, [active, setPrivilege]);

  /* Entering mobile makes the panel taller than most drag-sized panels,
     so pull it back on screen rather than letting it run off the bottom. */
  const toggleMobile = useCallback(() => {
    const next = !mobile;
    setMobile(next);
    if (!next) return;
    const w = mobileW + PANEL_CHROME_W;
    const h = mobileH + PANEL_CHROME_H;
    setPos((p) => ({
      x: Math.max(8, Math.min(p.x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(p.y, window.innerHeight - h - 8)),
    }));
  }, [mobile, setMobile, mobileW, mobileH, setPos]);

  /* Pop out into a real OS window. The shells live in the Rust host, so
     the panel's tabs MOVE: each running one is adopted by the new window
     (whatever it is running keeps running), a tab whose shell has ended
     is respawned there, and the panel gives them all up — it used to
     keep the sessions in the store and respawn the lot the next time it
     opened, so both windows held shells and every running program died
     on the way across. */
  const popOut = useCallback(async () => {
    if (!isTauri || popping) return;
    setPopping(true);
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel("terminal");
      if (existing) {
        await existing.setFocus();
        return;
      }
      const cwd = active ? currentCwd(active) : newCwd;
      const moving: PoppedTab[] = sessions.map((s) => {
        const st = statuses[s.id];
        return {
          cwd: currentCwd(s),
          privilege: s.privilege,
          label: s.label,
          name: s.name ?? null,
          adopt: st?.phase === "running" ? st.id : undefined,
        };
      });
      const params = new URLSearchParams({
        terminal: "1",
        cwd,
        privilege: active?.privilege ?? "user",
        mobile: mobile ? "1" : "0",
        tabs: JSON.stringify(moving),
        active: String(Math.max(0, sessions.findIndex((s) => s.id === activeId))),
      });
      const options = {
        url: `index.html?${params.toString()}`,
        title: `Terminal — ${cwd}`,
        width: mobile ? mobileW + PANEL_CHROME_W : Math.max(MIN_W, size.w),
        height: mobile ? mobileH + 32 + 32 + 8 : Math.max(MIN_H, size.h),
        resizable: true,
        decorations: true,
        focus: true,
      };

      const spawn = (parent?: string) =>
        new Promise<void>((resolve, reject) => {
          const w = new WebviewWindow("terminal", parent ? { ...options, parent } : options);
          void w.once("tauri://created", () => resolve());
          void w.once("tauri://error", (e) => reject(new Error(String(e.payload))));
        });

      // Parented to the main window so it stays above it instead of
      // sinking behind the editor the moment you click back into it.
      // On Linux this is gtk_window_set_transient_for, on Windows an
      // owner window, on macOS a child window — all of which mean "above
      // this window", not "above every application", which is what
      // alwaysOnTop would have meant.
      try {
        await spawn("main");
      } catch {
        // A window manager that refuses the parent relationship should
        // cost you the z-order, not the terminal.
        await spawn();
      }
      // The window exists; from here the shells are its. Unmounting the
      // views would end them, so mark each one as leaving first.
      for (const tab of moving) if (tab.adopt) detachOnUnmount(tab.adopt);
      useTerminal.getState().reset();
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("spark:toast:error", {
          detail: {
            title: "Could not open a terminal window",
            body: String((err as Error)?.message ?? err),
          },
        }),
      );
    } finally {
      setPopping(false);
    }
  }, [active, activeId, sessions, statuses, newCwd, popping, size.w, size.h, mobile, mobileW, mobileH]);

  const isRoot = active?.privilege === "root";
  const rootBlocked = rootSupport != null && !rootSupport.available;

  /* Closing the panel hides it; it does not unmount it. TerminalView
     ends its shell on unmount, so returning null here killed every
     running program — a build, a dev server, an agent mid-task — each
     time the panel was toggled away, and reopening it respawned fresh
     shells. A panel that has not been opened since its tabs were
     restored stays unmounted, so a relaunch does not spawn shells
     nobody has asked to see yet. */
  if (!open && (!spawned || sessions.length === 0)) return null;

  return (
    <div
      className={`term term--floating ${isRoot ? "term--root" : ""} ${mobile ? "term--mobile" : ""}`}
      hidden={!open}
      role="dialog"
      aria-label="Terminal"
      aria-modal="false"
      style={
        {
          left: pos.x,
          top: pos.y,
          width: size.w,
          height: size.h,
          "--term-mobile-w": `${mobileW}px`,
          "--term-mobile-h": `${mobileH}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="term__header term__header--draggable"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="term__title">
          <Icon name="terminal" size={16} />
          <span>{active ? displayName(active) : "Terminal"}</span>
          {isRoot && <span className="term__badge term__badge--root">root</span>}
          <span className="term__cwd" title={active ? currentCwd(active) : undefined}>
            {active ? currentCwd(active) : null}
          </span>
        </div>

        <div className="term__actions">
          <button
            type="button"
            className={`term__icon-btn ${mobile ? "is-on" : ""}`}
            aria-pressed={mobile}
            aria-label={mobile ? "Leave mobile view" : "Mobile view"}
            title={
              mobile
                ? "Back to the resizable panel"
                : `Mobile view — ${mobileW}×${mobileH} (change it in Settings → Terminal)`
            }
            onClick={toggleMobile}
          >
            <Icon name={mobile ? "desktop" : "mobile"} size={16} />
          </button>

          {isTauri && (
            <button
              type="button"
              className="term__icon-btn"
              aria-label="Pop out"
              title="Move the terminal into its own OS window"
              disabled={popping}
              onClick={() => void popOut()}
            >
              <Icon name="external" size={16} />
            </button>
          )}

          <button
            type="button"
            className="term__icon-btn"
            aria-label="Close terminal"
            onClick={() => onOpenChange(false)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <SessionTabs
        sessions={sessions}
        activeId={activeId}
        attention={attention}
        onSelect={setActiveSession}
        onClose={closeSessionById}
        onAdd={() => addSession(newCwd)}
        onRename={renameSession}
      >
        <button
          type="button"
          className={`term__btn term__btn--sm ${isRoot ? "is-on" : ""}`}
          aria-pressed={isRoot}
          disabled={rootBlocked || !active}
          title={
            rootBlocked
              ? "No privilege helper found — install pkexec (polkit) or sudo to use root sessions."
              : isRoot
                ? "Switch this shell back to a normal user shell"
                : rootSupport?.alreadyRoot
                  ? "sparkBook already runs as root"
                  : `Restart this shell as root via ${rootSupport?.method ?? "pkexec"} — your OS will ask for the password`
          }
          onClick={togglePrivilege}
        >
          <Icon name={isRoot ? "alert" : "terminal"} size={13} />
          <span>{isRoot ? "Root" : "User"}</span>
        </button>

        <button
          type="button"
          className="term__btn term__btn--sm"
          title="Restart this shell"
          disabled={!active}
          onClick={() => active && restartSession(active.id)}
        >
          <Icon name="refresh" size={13} />
          <span>Restart</span>
        </button>
      </SessionTabs>

      <SessionSurfaces
        sessions={sessions}
        activeId={activeId}
        holderClass="term__holder"
        focusOnShow={!restoredOpen}
        onStatus={onStatus}
        onTitle={onTitle}
        onCwd={onCwd}
        onBell={ring}
      />

      <div className="term__footer">
        <span className="term__hint">{statusLine(activeId ? statuses[activeId] : undefined)}</span>
        <span className="term__footer-right">
          {sessions.length > 1 && (
            <span className="term__count">
              {sessions.length} shells
            </span>
          )}
          {mobile && (
            <span className="term__dims">
              {mobileW}×{mobileH}
            </span>
          )}
        </span>
      </div>

      {!mobile && (
        <div
          className="term__resizeHandle"
          onPointerDown={onResizePointerDown}
          aria-hidden
          title="Drag to resize"
        />
      )}
    </div>
  );
}

/* ---------- Pop-out window ---------- */

/**
 * Terminal-only view for the pop-out window (`index.html?terminal=1`).
 * Same tabs, "+" and mobile toggle as the panel; no panel chrome.
 *
 * Its sessions are local state rather than the store: this is a separate
 * webview with its own module instances, so the store here would be a
 * second empty one pretending to be shared. The transitions come from
 * sessions.ts, which is what the two actually have in common.
 */
export function TerminalStandaloneInner({
  cwd,
  privilege = "user",
  initialMobile = false,
  tabs,
  activeIndex = 0,
}: {
  cwd: string;
  privilege?: PtyPrivilege;
  initialMobile?: boolean;
  /** The panel's tabs, when this window was popped out of it. */
  tabs?: PoppedTab[];
  activeIndex?: number;
}) {
  /* One state object rather than three: adding and closing a tab move the
     list, the focus and the ordinal together, and splitting them meant
     calling setActiveId from inside a setSessions updater — a side effect
     in what React treats as pure, which it may run twice. */
  const [state, setState] = useState<{
    sessions: TerminalSession[];
    activeId: string | null;
    nextOrdinal: number;
  }>(() => {
    const seed: PoppedTab[] = tabs?.length ? tabs : [{ cwd, privilege, label: "Terminal 1" }];
    const sessions = seed.map((t, i) => ({
      ...createSession(t.cwd, t.privilege, i + 1),
      label: t.label,
      name: cleanName(t.name),
      adopt: t.adopt,
    }));
    const idx = activeIndex >= 0 && activeIndex < sessions.length ? activeIndex : 0;
    return { sessions, activeId: sessions[idx].id, nextOrdinal: sessions.length + 1 };
  });
  const { sessions, activeId } = state;
  const { attention, ring } = useAttention(activeId);

  const [mobile, setMobile] = useState(initialMobile);
  const mobileW = useSettings((s) => s.settings.terminal.mobileWidth);
  const mobileH = useSettings((s) => s.settings.terminal.mobileHeight);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  useEffect(() => {
    const name = active ? displayName(active) : "Terminal";
    document.title = `${name} — ${active ? currentCwd(active) : cwd}`;
  }, [active, cwd]);

  const setActiveId = useCallback((id: string) => {
    setState((st) => (st.activeId === id ? st : { ...st, activeId: id }));
  }, []);

  const onClose = useCallback((id: string) => {
    setState((st) => ({
      ...st,
      activeId: nextActiveAfterClose(st.sessions, id, st.activeId),
      sessions: removeSession(st.sessions, id),
    }));
  }, []);

  /* Closing the last shell in a window whose only job is that shell closes
     the window. Done as an effect, not inside the updater above, so it
     fires once per actual transition. */
  useEffect(() => {
    if (sessions.length > 0) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch(() => {});
  }, [sessions.length]);

  const onAdd = useCallback(() => {
    setState((st) => {
      // A new tab starts where the active one did; the pop-out has no file
      // tree to derive a different directory from.
      const from = st.sessions.find((s) => s.id === st.activeId) ?? st.sessions[st.sessions.length - 1];
      const session = createSession(
        from ? currentCwd(from) : cwd,
        from?.privilege ?? privilege,
        st.nextOrdinal,
      );
      return {
        sessions: [...st.sessions, session],
        activeId: session.id,
        nextOrdinal: st.nextOrdinal + 1,
      };
    });
  }, [cwd, privilege]);

  const onTitle = useCallback((id: string, title: string | null) => {
    setState((st) => {
      const sessions = patchSession(st.sessions, id, { title });
      return sessions === st.sessions ? st : { ...st, sessions };
    });
  }, []);

  const onCwd = useCallback((id: string, liveCwd: string) => {
    setState((st) => {
      const sessions = patchSession(st.sessions, id, { liveCwd });
      return sessions === st.sessions ? st : { ...st, sessions };
    });
  }, []);

  const onRename = useCallback((id: string, name: string | null) => {
    setState((st) => ({ ...st, sessions: patchSession(st.sessions, id, { name }) }));
  }, []);

  /* Ctrl+PageUp / Ctrl+PageDown move between tabs, as in the panel. */
  useEffect(() => {
    const onCycle = (e: Event) => {
      const step = (e as CustomEvent<{ step: 1 | -1 }>).detail?.step ?? 1;
      setState((st) => {
        const next = cycleFrom(st.sessions, st.activeId, step);
        return next === st.activeId ? st : { ...st, activeId: next };
      });
    };
    window.addEventListener("spark:terminal:cycle", onCycle);
    return () => window.removeEventListener("spark:terminal:cycle", onCycle);
  }, []);

  const onRestart = useCallback(() => {
    setState((st) => ({
      ...st,
      sessions: st.sessions.map((s) =>
        s.id === st.activeId ? { ...s, restartKey: s.restartKey + 1 } : s,
      ),
    }));
  }, []);

  /* Remember the desktop size once, so leaving mobile returns the window
     to what the user had rather than to a hard-coded default. */
  const desktopSizeRef = useRef<{ width: number; height: number } | null>(null);

  const toggleMobile = useCallback(async () => {
    const next = !mobile;
    setMobile(next);
    try {
      const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (next) {
        const factor = await win.scaleFactor();
        const current = (await win.innerSize()).toLogical(factor);
        desktopSizeRef.current = { width: current.width, height: current.height };
        // bar (32) + tab strip (32) + the body's 4px padding either side.
        await win.setSize(new LogicalSize(mobileW + 8, mobileH + 32 + 32 + 8));
      } else if (desktopSizeRef.current) {
        const { width, height } = desktopSizeRef.current;
        await win.setSize(new LogicalSize(width, height));
      }
    } catch {
      /* not under Tauri — the CSS constraint is the whole effect */
    }
  }, [mobile, mobileW, mobileH]);

  const noop = useCallback(() => {}, []);

  return (
    <div
      className={`term-standalone ${mobile ? "term--mobile is-mobile" : ""}`}
      style={
        { "--term-mobile-w": `${mobileW}px`, "--term-mobile-h": `${mobileH}px` } as React.CSSProperties
      }
    >
      <div className="term-standalone__bar">
        <Icon name="terminal" size={14} />
        <span className="term-standalone__name">{active ? displayName(active) : "Terminal"}</span>
        <span className="term-standalone__cwd">{active?.cwd ?? cwd}</span>
        <span className="term-standalone__gap" aria-hidden />
        <button
          type="button"
          className={`term__icon-btn ${mobile ? "is-on" : ""}`}
          aria-pressed={mobile}
          aria-label={mobile ? "Leave mobile view" : "Mobile view"}
          title={
            mobile
              ? "Back to the full window"
              : `Mobile view — ${mobileW}×${mobileH} (change it in Settings → Terminal)`
          }
          onClick={() => void toggleMobile()}
        >
          <Icon name={mobile ? "desktop" : "mobile"} size={15} />
        </button>
      </div>

      <SessionTabs
        sessions={sessions}
        activeId={activeId}
        attention={attention}
        onSelect={setActiveId}
        onClose={onClose}
        onAdd={onAdd}
        onRename={onRename}
      >
        <button
          type="button"
          className="term__btn term__btn--sm"
          title="Restart this shell"
          disabled={!active}
          onClick={onRestart}
        >
          <Icon name="refresh" size={13} />
          <span>Restart</span>
        </button>
      </SessionTabs>

      <SessionSurfaces
        sessions={sessions}
        activeId={activeId}
        holderClass="term-standalone__body"
        onStatus={noop}
        onTitle={onTitle}
        onCwd={onCwd}
        onBell={ring}
      />
    </div>
  );
}
