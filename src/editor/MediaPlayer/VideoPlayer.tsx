/* ============================================================
   sparkBook · src/editor/MediaPlayer/VideoPlayer.tsx
   The video surface.

   The <video> element owns playback state; React mirrors it. The
   controls, menus and overlays all live inside the player root so
   they come along into fullscreen.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenDoc } from "@store/documents";
import { Icon } from "@ui/Icon";
import { isTauri, openWithOS, extname, mediaMime } from "@bridge/commands";
import { useMediaSource, describeMediaError, type MediaErrorInfo } from "./source";
import { useMediaElement } from "./useMediaElement";
import { useTransport } from "./useTransport";
import { keyToAction } from "./keymap";
import { formatRate, formatTime } from "./time";
import { cuesAt } from "./subtitles";
import { loadPrefs, savePrefs, type SubtitleSize } from "./prefs";
import {
  useSubtitles, useThumbnailer, useFrameRate, useFullscreen, usePictureInPicture,
} from "./videoHooks";
import {
  Seekbar, VolumeControl, MenuPanel, MenuItem, SpeedList, BezelView, ErrorPanel,
  ShortcutSheet, belongsToControl, keepFocusOnPlayer, useRestoreFocus,
} from "./parts";

type Menu = "speed" | "subs" | "settings";

/** Controls hide after this long without pointer or key activity. */
const IDLE_MS = 2500;
/** Caption height as a share of the picture height. */
const SUB_SCALE: Record<SubtitleSize, number> = { s: 0.04, m: 0.052, l: 0.068 };

export function VideoPlayer({ doc }: { doc: OpenDoc }) {
  const src = useMediaSource(doc);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const snap = useMediaElement(video);
  const meta = useMemo(() => ({ title: doc.name }), [doc.name]);
  const t = useTransport(video, snap, doc.path, meta);
  const subs = useSubtitles(doc.path);
  const thumbs = useThumbnailer(src.url);
  const fps = useFrameRate(video);
  const rootRef = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(rootRef);
  const pip = usePictureInPicture(video);

  const [menu, setMenu] = useState<Menu | null>(null);
  const [help, setHelp] = useState(false);
  const [stats, setStats] = useState(false);
  const [fill, setFill] = useState(false);
  const [remaining, setRemaining] = useState(false);
  const [subSize, setSubSize] = useState<SubtitleSize>(() => loadPrefs().subtitleSize);
  const [failure, setFailure] = useState<MediaErrorInfo | null>(null);
  const [stageH, setStageH] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  // A new source gets a clean slate.
  useEffect(() => { setFailure(null); }, [src.url]);

  // Land keyboard focus on the player so Space works straight away.
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, [doc.id]);
  useRestoreFocus(rootRef, !!menu || help);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- Idle: hide controls and cursor while watching ---------- */
  const [idle, setIdle] = useState(false);
  const [overControls, setOverControls] = useState(false);
  const idleTimer = useRef(0);
  const poke = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);
  const controlsShown = !idle || snap.paused || !!menu || help || overControls || !!failure;

  /* ---------- Errors ---------- */
  const onVideoError = useCallback(() => {
    const code = video?.error?.code;
    // Streaming refused (network) or rejected (format): the in-memory
    // route is worth one try before giving up.
    if ((code === 2 || code === 4) && src.fallback()) return;
    setFailure(describeMediaError(code, doc.path ?? doc.name));
  }, [video, src, doc.path, doc.name]);

  const retry = useCallback(() => {
    setFailure(null);
    video?.load();
  }, [video]);

  const openExternal = doc.path && isTauri ? () => { void openWithOS(doc.path!); } : undefined;

  /* ---------- Actions ---------- */
  const stepFrame = useCallback((dir: 1 | -1) => {
    if (!video) return;
    video.pause();
    const step = 1 / (fps ?? 30);
    t.seek(video.currentTime + dir * step);
  }, [video, fps, t]);

  const toggleCaptions = useCallback(() => {
    const wasOn = !!subs.active;
    if (!subs.toggle()) { t.flash("No subtitles. Load a file from the CC menu.", "closed-captioning"); return; }
    t.flash(wasOn ? "Subtitles off" : "Subtitles on", "closed-captioning");
  }, [subs, t]);

  const nudgeDelay = useCallback((ms: number) => {
    const next = Math.round((subs.delay + ms / 1000) * 10) / 10;
    subs.setDelay(next);
    t.flash(`Subtitle delay ${next > 0 ? "+" : ""}${Math.round(next * 1000)} ms`, "closed-captioning");
  }, [subs, t]);

  const changeSubSize = useCallback((s: SubtitleSize) => {
    setSubSize(s);
    savePrefs({ subtitleSize: s });
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    poke();
    if (belongsToControl(e)) return;
    const a = keyToAction(e, "video");
    if (!a) return;
    let handled = true;
    switch (a.type) {
      case "frame": stepFrame(a.dir); break;
      case "fullscreen": void fs.toggle(); break;
      case "escape":
        if (help) setHelp(false);
        else if (menu) setMenu(null);
        else if (fs.active) fs.exit();
        else handled = false;
        break;
      case "pip": if (pip.supported) void pip.toggle(); else handled = false; break;
      case "captions": toggleCaptions(); break;
      case "subDelay": nudgeDelay(a.ms); break;
      case "stats": setStats((v) => !v); break;
      case "help": setHelp((v) => !v); break;
      default: handled = t.run(a);
    }
    if (handled) e.preventDefault();
  }, [poke, stepFrame, fs, help, menu, pip, toggleCaptions, nudgeDelay, t]);

  const onVideoClick = useCallback(() => {
    if (menu) { setMenu(null); return; }
    t.toggle();
  }, [menu, t]);

  const onHover = useCallback((at: number | null) => {
    if (at != null && Number.isFinite(snap.duration)) thumbs.request(at, snap.duration);
  }, [thumbs, snap.duration]);

  const preview = useCallback(
    () => (thumbs.available ? <canvas ref={thumbs.setTarget} className="mp-seek__preview" aria-hidden /> : null),
    [thumbs.available, thumbs.setTarget],
  );

  /* ---------- Derived view state ---------- */
  const shownCues = subs.active ? cuesAt(subs.cues, snap.time - subs.delay) : [];
  const subPx = Math.max(13, Math.min(56, stageH * SUB_SCALE[subSize]));
  const timeLabel = remaining && Number.isFinite(snap.duration)
    ? `-${formatTime(snap.duration - snap.time, snap.duration)}`
    : formatTime(snap.time, snap.duration);
  const error = failure ?? (src.error ? { title: "This video could not be opened.", detail: src.error } : null);
  const started = snap.time > 0 || !snap.paused;

  const cls = [
    "mp", "mp--video",
    controlsShown ? "" : "mp--idle",
    fs.active ? "mp--fs" : "",
    fs.pseudo ? "mp--pseudo-fs" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      ref={rootRef}
      className={cls}
      tabIndex={0}
      aria-label={`Video player: ${doc.name}`}
      onKeyDown={onKeyDown}
      onPointerMove={poke}
      onPointerDown={poke}
    >
      <div ref={stageRef} className="mp__stage">
        {src.url && (
          <video
            ref={setVideo}
            className="mp__video"
            src={src.url}
            preload="metadata"
            playsInline
            style={{ objectFit: fill ? "cover" : "contain" }}
            onClick={onVideoClick}
            onDoubleClick={() => void fs.toggle()}
            onError={onVideoError}
          />
        )}

        {shownCues.length > 0 && (
          <div
            className="mp-captions"
            style={{ fontSize: `${subPx}px`, bottom: controlsShown ? "calc(var(--mp-bar-h) + 14px)" : "6%" }}
            aria-live="off"
          >
            {shownCues.map((c, ci) =>
              c.lines.map((line, li) => (
                <span key={`${ci}:${li}`} className="mp-captions__line">
                  {line.map((sp, si) => (
                    <span key={si} style={{
                      fontStyle: sp.i ? "italic" : undefined,
                      fontWeight: sp.b ? 700 : undefined,
                      textDecoration: sp.u ? "underline" : undefined,
                    }}>{sp.text}</span>
                  ))}
                </span>
              )),
            )}
          </div>
        )}

        {snap.waiting && !error && <div className="mp-spinner" aria-label="Buffering" />}

        {!started && snap.ready && !error && (
          <button type="button" className="mp-bigplay" onClick={t.toggle} aria-label="Play">
            <Icon name="play" size={34} weight="fill" />
          </button>
        )}

        <BezelView bezel={t.bezel} />

        {stats && (
          <Stats
            video={video}
            name={doc.name}
            via={src.via}
            mime={mediaMime(doc.path ?? doc.name)}
            fps={fps}
            snap={snap}
            onClose={() => setStats(false)}
          />
        )}

        {error && (
          <ErrorPanel title={error.title} detail={error.detail} onRetry={src.url ? retry : undefined} onOpenExternal={openExternal} />
        )}

        {help && <ShortcutSheet kind="video" onClose={() => setHelp(false)} />}
      </div>

      <div
        className="mp__controls"
        onMouseDown={keepFocusOnPlayer}
        onPointerEnter={() => setOverControls(true)}
        onPointerLeave={() => setOverControls(false)}
      >
        <Seekbar
          time={snap.time}
          duration={snap.duration}
          buffered={snap.buffered}
          onSeek={t.seek}
          ab={t.ab}
          preview={preview}
          onHover={onHover}
        />
        <div className="mp__bar">
          <button type="button" className="mp-btn mp-btn--play" onClick={t.toggle}
            aria-label={snap.paused ? "Play" : "Pause"} title={snap.paused ? "Play (K)" : "Pause (K)"}>
            <Icon name={snap.paused || snap.ended ? "play" : "pause"} size={20} weight="fill" />
          </button>
          <button type="button" className="mp-btn" onClick={() => t.seekBy(-10)} aria-label="Back 10 seconds" title="Back 10 s (J)">
            <Icon name="clock-counter-clockwise" size={18} />
          </button>
          <button type="button" className="mp-btn" onClick={() => t.seekBy(10)} aria-label="Forward 10 seconds" title="Forward 10 s (L)">
            <Icon name="clock-clockwise" size={18} />
          </button>
          <VolumeControl volume={snap.volume} muted={snap.muted} onVolume={t.setVolume} onMute={t.toggleMute} />
          <button type="button" className="mp-time" onClick={() => setRemaining((v) => !v)}
            title={remaining ? "Show elapsed time" : "Show remaining time"}>
            <span>{timeLabel}</span>
            <span className="mp-time__sep">/</span>
            <span>{formatTime(snap.duration)}</span>
          </button>

          <span className="mp__spacer" />

          {t.ab.a != null && (
            <button type="button" className="mp-chip" onClick={t.cycleAB} title="A-B loop (B)">
              {t.ab.b == null ? `A ${formatTime(t.ab.a, snap.duration)} →` : `A-B ${formatTime(t.ab.a, snap.duration)} – ${formatTime(t.ab.b, snap.duration)}`}
            </button>
          )}
          {t.loop && <span className="mp-chip mp-chip--static" title="Loop on (R)"><Icon name="repeat" size={14} /></span>}

          <div className="mp-anchor">
            <button type="button" className={`mp-btn mp-btn--text ${menu === "speed" ? "is-on" : ""}`}
              onClick={() => setMenu(menu === "speed" ? null : "speed")}
              aria-label="Playback speed" aria-haspopup="dialog" aria-expanded={menu === "speed"} title="Speed (< >)">
              {formatRate(snap.rate)}
            </button>
            {menu === "speed" && (
              <MenuPanel title="Speed" onClose={() => setMenu(null)}>
                <SpeedList rate={snap.rate} onRate={(r) => { t.setRate(r); setMenu(null); }} />
              </MenuPanel>
            )}
          </div>

          <div className="mp-anchor">
            <button type="button" className={`mp-btn ${subs.active ? "is-on" : ""}`}
              onClick={() => setMenu(menu === "subs" ? null : "subs")}
              aria-label="Subtitles" aria-haspopup="dialog" aria-expanded={menu === "subs"} title="Subtitles (C)">
              <Icon name="closed-captioning" size={19} weight={subs.active ? "fill" : "regular"} />
            </button>
            {menu === "subs" && (
              <MenuPanel title="Subtitles" onClose={() => setMenu(null)}>
                <div className="mp-menu__list" role="menu">
                  <MenuItem checked={!subs.active} onClick={() => subs.select(null)}>Off</MenuItem>
                  {subs.tracks.map((tr) => (
                    <MenuItem key={tr.path} checked={subs.active === tr.path} onClick={() => subs.select(tr.path)}>
                      {tr.label}
                    </MenuItem>
                  ))}
                  <MenuItem onClick={() => { void subs.addFromDialog(); }}>Load from file…</MenuItem>
                </div>
                {subs.error && <p className="mp-menu__note">{subs.error}</p>}
                <div className="mp-menu__row">
                  <span>Delay</span>
                  <button type="button" className="mp-btn mp-btn--sm" onClick={() => nudgeDelay(-100)} aria-label="Subtitles earlier" title="Earlier (Z)">−</button>
                  <span className="mp-menu__value">{Math.round(subs.delay * 1000)} ms</span>
                  <button type="button" className="mp-btn mp-btn--sm" onClick={() => nudgeDelay(100)} aria-label="Subtitles later" title="Later (X)">+</button>
                  {subs.delay !== 0 && (
                    <button type="button" className="mp-btn mp-btn--sm mp-btn--text" onClick={() => subs.setDelay(0)}>Reset</button>
                  )}
                </div>
                <div className="mp-menu__row" role="group" aria-label="Subtitle size">
                  <span>Size</span>
                  {(["s", "m", "l"] as SubtitleSize[]).map((sz) => (
                    <button key={sz} type="button" className={`mp-btn mp-btn--sm mp-btn--text ${subSize === sz ? "is-on" : ""}`}
                      aria-pressed={subSize === sz} onClick={() => changeSubSize(sz)}>
                      {sz.toUpperCase()}
                    </button>
                  ))}
                </div>
              </MenuPanel>
            )}
          </div>

          <div className="mp-anchor">
            <button type="button" className={`mp-btn ${menu === "settings" ? "is-on" : ""}`}
              onClick={() => setMenu(menu === "settings" ? null : "settings")}
              aria-label="Settings" aria-haspopup="dialog" aria-expanded={menu === "settings"} title="Settings">
              <Icon name="gear-six" size={19} />
            </button>
            {menu === "settings" && (
              <MenuPanel title="Settings" onClose={() => setMenu(null)}>
                <div className="mp-menu__list" role="menu">
                  <MenuItem checked={t.loop} onClick={t.toggleLoop} hint="R">Loop</MenuItem>
                  <MenuItem checked={t.ab.a != null} onClick={t.cycleAB} hint="B">
                    {t.ab.a == null ? "A-B loop: set A here" : t.ab.b == null ? "A-B loop: set B here" : "A-B loop: clear"}
                  </MenuItem>
                  <MenuItem checked={fill} onClick={() => setFill((v) => !v)}>Fill the frame</MenuItem>
                  <MenuItem checked={stats} onClick={() => setStats((v) => !v)} hint="I">Stats</MenuItem>
                  <MenuItem onClick={() => { setMenu(null); setHelp(true); }} hint="?">Keyboard shortcuts</MenuItem>
                  {openExternal && <MenuItem onClick={() => { setMenu(null); openExternal(); }}>Open in system player</MenuItem>}
                </div>
              </MenuPanel>
            )}
          </div>

          {pip.supported && (
            <button type="button" className={`mp-btn ${pip.active ? "is-on" : ""}`} onClick={() => void pip.toggle()}
              aria-label="Picture in picture" title="Picture in picture (P)">
              <Icon name="picture-in-picture" size={19} />
            </button>
          )}
          <button type="button" className="mp-btn" onClick={() => void fs.toggle()}
            aria-label={fs.active ? "Exit fullscreen" : "Fullscreen"} title={fs.active ? "Exit fullscreen (F)" : "Fullscreen (F)"}>
            <Icon name={fs.active ? "corners-in" : "corners-out"} size={19} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Stats overlay ---------- */

function Stats({ video, name, via, mime, fps, snap, onClose }: {
  video: HTMLVideoElement | null;
  name: string;
  via: string | null;
  mime: string;
  fps: number | null;
  snap: ReturnType<typeof useMediaElement>;
  onClose: () => void;
}) {
  const q = video?.getVideoPlaybackQuality?.();
  const ahead = snap.buffered.find(([s, e]) => snap.time >= s && snap.time <= e);
  const rows: Array<[string, string]> = [
    ["File", `${name} (${(extname(name) || "?").toUpperCase()}, ${mime})`],
    ["Source", via === "asset" ? "Streamed from disk" : via === "blob" ? "Loaded into memory" : "—"],
    ["Resolution", snap.width ? `${snap.width} × ${snap.height}` : "—"],
    ["Viewport", video ? `${video.clientWidth} × ${video.clientHeight}` : "—"],
    ["Frame rate", fps ? `${fps} fps (measured)` : "measuring…"],
    ["Frames", q ? `${q.droppedVideoFrames} dropped of ${q.totalVideoFrames}` : "—"],
    ["Buffered ahead", ahead ? `${(ahead[1] - snap.time).toFixed(1)} s` : "0 s"],
    ["Position", `${snap.time.toFixed(3)} / ${Number.isFinite(snap.duration) ? snap.duration.toFixed(3) : "?"} s`],
    ["Speed · volume", `${formatRate(snap.rate)} · ${snap.muted ? "muted" : `${Math.round(snap.volume * 100)}%`}`],
  ];
  return (
    <div className="mp-stats" role="status">
      <button type="button" className="mp-btn mp-btn--sm mp-stats__close" onClick={onClose} aria-label="Close stats">
        <Icon name="x" size={14} />
      </button>
      <dl>
        {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
      </dl>
    </div>
  );
}
