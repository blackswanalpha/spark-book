/* ============================================================
   sparkBook · src/editor/MediaPlayer/parts.tsx
   Pieces both players share: scrubber, volume, speed list,
   feedback bezel, error panel, shortcut sheet, and a menu panel
   that renders inside the player so it survives fullscreen.
   ============================================================ */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@ui/Icon";
import { Button } from "@ui/Button";
import { formatRate, formatTime, RATES } from "./time";
import { SHORTCUTS, type MediaKind } from "./keymap";
import type { Bezel } from "./useTransport";

/* ---------- Pointer → time helper ---------- */

/** Time under `clientX` within `el`, for a timeline spanning `duration`. */
export function timeAt(el: HTMLElement, clientX: number, duration: number): number {
  const r = el.getBoundingClientRect();
  const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
  return Math.max(0, Math.min(1, f)) * (Number.isFinite(duration) ? duration : 0);
}

/**
 * Drag-to-seek over any horizontal timeline. Seeks are coalesced to one
 * per animation frame: a drag across a two-hour file would otherwise
 * queue hundreds of seeks the decoder has to abandon.
 */
export function useScrub(duration: number, onSeek: (t: number) => void) {
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const frame = useRef(0);

  const flush = useCallback(() => {
    frame.current = 0;
    if (pending.current != null) onSeek(pending.current);
    pending.current = null;
  }, [onSeek]);

  const queue = useCallback((t: number) => {
    pending.current = t;
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const handlers = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !Number.isFinite(duration)) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const t = timeAt(e.currentTarget, e.clientX, duration);
      setDrag(t);
      queue(t);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const t = timeAt(e.currentTarget, e.clientX, duration);
      setHover(t);
      if (drag != null) { setDrag(t); queue(t); }
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (drag == null) return;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      pending.current = null;
      onSeek(timeAt(e.currentTarget, e.clientX, duration));
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
    onPointerLeave: () => setHover(null),
  };
  return { drag, hover, handlers };
}

/* ---------- Seekbar ---------- */

export interface SeekbarProps {
  time: number;
  duration: number;
  buffered: Array<[number, number]>;
  onSeek: (t: number) => void;
  ab?: { a: number | null; b: number | null };
  /** Extra tooltip content for the hovered time (video thumbnails). */
  preview?: (t: number) => ReactNode;
  onHover?: (t: number | null) => void;
}

export function Seekbar({ time, duration, buffered, onSeek, ab, preview, onHover }: SeekbarProps) {
  const { drag, hover, handlers } = useScrub(duration, onSeek);
  const known = Number.isFinite(duration) && duration > 0;
  const pct = (t: number) => (known ? `${Math.max(0, Math.min(100, (t / duration) * 100))}%` : "0%");
  const shown = drag ?? time;
  const tipAt = drag ?? hover;

  useEffect(() => { onHover?.(tipAt); }, [tipAt, onHover]);

  return (
    <div
      className={`mp-seek ${drag != null ? "is-dragging" : ""}`}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={known ? Math.floor(duration) : 0}
      aria-valuenow={Math.floor(shown)}
      aria-valuetext={`${formatTime(shown, duration)} of ${formatTime(duration)}`}
      {...handlers}
    >
      <div className="mp-seek__track">
        {buffered.map(([s, e], i) => (
          <div key={i} className="mp-seek__buffer" style={{ left: pct(s), width: known ? `${((e - s) / duration) * 100}%` : 0 }} />
        ))}
        {ab?.a != null && (
          <div
            className={`mp-seek__ab ${ab.b == null ? "is-open" : ""}`}
            style={{ left: pct(ab.a), width: ab.b != null && known ? `${((ab.b - ab.a) / duration) * 100}%` : undefined }}
          />
        )}
        <div className="mp-seek__fill" style={{ width: pct(shown) }} />
      </div>
      <div className="mp-seek__knob" style={{ left: pct(shown) }} />
      {tipAt != null && known && (
        <div className="mp-seek__tip" style={{ left: pct(tipAt) }}>
          {preview?.(tipAt)}
          <span className="mp-seek__tip-time">{formatTime(tipAt, duration)}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- Volume ---------- */

export function volumeIcon(volume: number, muted: boolean): string {
  if (muted || volume === 0) return "speaker-x";
  return volume < 0.5 ? "speaker-low" : "speaker-high";
}

export function VolumeControl({ volume, muted, onVolume, onMute }: {
  volume: number; muted: boolean; onVolume: (v: number) => void; onMute: () => void;
}) {
  const level = muted ? 0 : volume;
  return (
    <div className="mp-volume">
      <button type="button" className="mp-btn" onClick={onMute}
        aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute (M)" : "Mute (M)"}>
        <Icon name={volumeIcon(volume, muted)} size={18} />
      </button>
      <input
        className="mp-volume__range"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={level}
        aria-label="Volume"
        aria-valuetext={`${Math.round(level * 100)}%`}
        style={{ ["--mp-level" as string]: `${level * 100}%` }}
        onChange={(e) => onVolume(Number(e.currentTarget.value))}
      />
    </div>
  );
}

/* ---------- Menu panel ---------- */

export function MenuPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus the first choice so the menu is usable from the keyboard.
    ref.current?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      className="mp-menu"
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      }}
    >
      <div className="mp-menu__title">{title}</div>
      {children}
    </div>
  );
}

export function MenuItem({ checked, onClick, children, hint }: {
  checked?: boolean; onClick: () => void; children: ReactNode; hint?: ReactNode;
}) {
  return (
    <button type="button" className={`mp-menu__item ${checked ? "is-checked" : ""}`}
      role="menuitemradio" aria-checked={!!checked} onClick={onClick}>
      <span className="mp-menu__check" aria-hidden>{checked ? <Icon name="check" size={14} /> : null}</span>
      <span className="mp-menu__label">{children}</span>
      {hint != null && <span className="mp-menu__hint">{hint}</span>}
    </button>
  );
}

export function SpeedList({ rate, onRate }: { rate: number; onRate: (r: number) => void }) {
  return (
    <div className="mp-menu__list" role="menu">
      {RATES.map((r) => (
        <MenuItem key={r} checked={Math.abs(r - rate) < 1e-6} onClick={() => onRate(r)}>
          {r === 1 ? "Normal" : formatRate(r)}
        </MenuItem>
      ))}
    </div>
  );
}

/* ---------- Bezel: transient feedback in the middle of the player ---------- */

export function BezelView({ bezel }: { bezel: Bezel | null }) {
  if (!bezel) return null;
  return (
    <div key={bezel.id} className="mp-bezel" role="status" aria-live="polite">
      {bezel.icon && <Icon name={bezel.icon} size={20} />}
      <span>{bezel.text}</span>
    </div>
  );
}

/* ---------- Error panel ---------- */

export function ErrorPanel({ title, detail, onRetry, onOpenExternal }: {
  title: string; detail: string; onRetry?: () => void; onOpenExternal?: () => void;
}) {
  return (
    <div className="mp-error" role="alert">
      <Icon name="warning" size={26} />
      <p className="mp-error__title">{title}</p>
      <p className="mp-error__detail">{detail}</p>
      <div className="mp-error__actions">
        {onOpenExternal && <Button size="sm" variant="primary" icon="arrow-square-out" onClick={onOpenExternal}>Open in system player</Button>}
        {onRetry && <Button size="sm" variant="secondary" icon="arrow-clockwise" onClick={onRetry}>Try again</Button>}
      </div>
    </div>
  );
}

/* ---------- Shortcut sheet ---------- */

export function ShortcutSheet({ kind, onClose }: { kind: MediaKind; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return (
    <div
      ref={ref}
      className="mp-help"
      role="dialog"
      aria-label="Keyboard shortcuts"
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "?") { e.stopPropagation(); e.preventDefault(); onClose(); }
      }}
    >
      <div className="mp-help__card" onClick={(e) => e.stopPropagation()}>
        <div className="mp-help__head">
          <span>Keyboard shortcuts</span>
          <button type="button" className="mp-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="mp-help__grid">
          {SHORTCUTS.filter((g) => !g.kind || g.kind === kind).map((g) => (
            <section key={g.group}>
              <h3>{g.group}</h3>
              <dl>
                {g.rows.map(([k, v]) => (
                  <div key={k} className="mp-help__row"><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Put focus back on the player when an overlay that held it closes.
    Otherwise focus falls to <body> and every shortcut stops working. */
export function useRestoreFocus(ref: React.RefObject<HTMLElement>, overlayOpen: boolean) {
  useEffect(() => {
    if (overlayOpen) return;
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus({ preventScroll: true });
  }, [overlayOpen, ref]);
}

/** True when a key event should be left to the focused control: Space and
    Enter activate buttons, arrows move range inputs and menus. */
export function belongsToControl(e: React.KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t.isContentEditable) return e.key !== "Escape";
  if (tag === "BUTTON") return e.key === " " || e.key === "Enter";
  return !!t.closest(".mp-menu") && e.key !== "Escape";
}

/** Clicking a control with the mouse must not park focus on it, or the
    next Space press re-clicks it instead of pausing. Keyboard focus is
    unaffected. */
export function keepFocusOnPlayer(e: React.MouseEvent) {
  if ((e.target as HTMLElement).closest("button")) e.preventDefault();
}
