/* ============================================================
   sparkBook · src/editor/MediaPlayer/AudioPlayer.tsx
   The audio surface: cover art and tags, a waveform to seek on,
   and the shared transport.

   Playback streams like video. The waveform and tags need the
   bytes, so they are read separately and only for files small
   enough to decode in memory; larger files get a plain scrubber.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenDoc } from "@store/documents";
import { Icon } from "@ui/Icon";
import { extname, isTauri, openWithOS, readFileBase64, stat } from "@bridge/commands";
import { base64ToBytes, base64ByteLength, formatBytes } from "@lib/binary";
import { useMediaSource, describeMediaError, type MediaErrorInfo } from "./source";
import { useMediaElement } from "./useMediaElement";
import { useTransport } from "./useTransport";
import { keyToAction } from "./keymap";
import { formatRate, formatTime } from "./time";
import { readTags, type AudioTags } from "./tags";
import { decodePeaks } from "./peaks";
import { Waveform } from "./Waveform";
import {
  Seekbar, VolumeControl, MenuPanel, SpeedList, BezelView, ErrorPanel, ShortcutSheet,
  belongsToControl, keepFocusOnPlayer, useRestoreFocus,
} from "./parts";

/** Largest file read for waveform and tags. */
export const ANALYSE_LIMIT = 64 * 1024 * 1024;

type Analysis =
  | { state: "idle" | "reading" | "decoding" }
  | { state: "done"; peaks: Float32Array; channels: number }
  | { state: "skipped"; reason: string };

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

export function AudioPlayer({ doc }: { doc: OpenDoc }) {
  const src = useMediaSource(doc);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const snap = useMediaElement(audio);

  /* ---------- Bytes → tags, cover, waveform ---------- */
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [tags, setTags] = useState<AudioTags | null>(null);
  const [analysis, setAnalysis] = useState<Analysis>({ state: "idle" });

  useEffect(() => {
    setBytes(null);
    setTags(null);
    setSize(null);
    setAnalysis({ state: "reading" });
    let cancelled = false;
    (async () => {
      let b64 = doc.raw;
      if (!b64) {
        if (!doc.path) return;
        const info = await stat(doc.path).catch(() => null);
        if (info?.size) setSize(info.size);
        if (info && info.size > ANALYSE_LIMIT) {
          setAnalysis({ state: "skipped", reason: `No waveform for files over ${formatBytes(ANALYSE_LIMIT)}.` });
          return;
        }
        b64 = await readFileBase64(doc.path);
      }
      if (cancelled) return;
      const data = base64ToBytes(b64);
      setSize(base64ByteLength(b64));
      setTags(readTags(data));
      setBytes(data);
    })().catch(() => {
      if (!cancelled) setAnalysis({ state: "skipped", reason: "The file could not be read for a waveform." });
    });
    return () => { cancelled = true; };
  }, [doc.path, doc.raw]);

  // Decode once the duration is known: it bounds the decode buffer.
  const durationKnown = Number.isFinite(snap.duration) && snap.duration > 0;
  useEffect(() => {
    if (!bytes || !durationKnown) return;
    let cancelled = false;
    setAnalysis({ state: "decoding" });
    decodePeaks(bytes, snap.duration)
      .then((d) => { if (!cancelled) setAnalysis({ state: "done", peaks: d.peaks, channels: d.channels }); })
      .catch(() => { if (!cancelled) setAnalysis({ state: "skipped", reason: "This format could not be decoded for a waveform." }); })
      // The compressed bytes are not needed after decoding.
      .finally(() => { if (!cancelled) setBytes(null); });
    return () => { cancelled = true; };
    // snap.duration is read once per byte buffer on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, durationKnown]);

  const cover = useMemo(() => {
    const pic = tags?.picture;
    if (!pic) return null;
    return URL.createObjectURL(new Blob([pic.data.slice() as unknown as BlobPart], { type: pic.mime }));
  }, [tags]);
  useEffect(() => () => { if (cover) URL.revokeObjectURL(cover); }, [cover]);

  const title = tags?.title || stemOf(doc.name);
  const meta = useMemo(
    () => ({ title, artist: tags?.artist, album: tags?.album, artwork: cover ?? undefined }),
    [title, tags?.artist, tags?.album, cover],
  );
  const t = useTransport(audio, snap, doc.path, meta);

  /* ---------- UI state ---------- */
  const rootRef = useRef<HTMLDivElement>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [remaining, setRemaining] = useState(false);
  const [failure, setFailure] = useState<MediaErrorInfo | null>(null);

  useEffect(() => { setFailure(null); }, [src.url]);
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, [doc.id]);
  useRestoreFocus(rootRef, speedOpen || help);

  const onAudioError = useCallback(() => {
    const code = audio?.error?.code;
    if ((code === 2 || code === 4) && src.fallback()) return;
    setFailure(describeMediaError(code, doc.path ?? doc.name));
  }, [audio, src, doc.path, doc.name]);

  const openExternal = doc.path && isTauri ? () => { void openWithOS(doc.path!); } : undefined;

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (belongsToControl(e)) return;
    const a = keyToAction(e, "audio");
    if (!a) return;
    let handled = true;
    if (a.type === "help") setHelp((v) => !v);
    else if (a.type === "escape") {
      if (help) setHelp(false);
      else if (speedOpen) setSpeedOpen(false);
      else handled = false;
    } else handled = t.run(a);
    if (handled) e.preventDefault();
  }, [help, speedOpen, t]);

  const error = failure ?? (src.error ? { title: "This audio could not be opened.", detail: src.error } : null);
  const subtitle = [tags?.artist, tags?.album, tags?.year].filter(Boolean).join(" · ");
  const facts = [
    (extname(doc.name) || "audio").toUpperCase(),
    size != null ? formatBytes(size) : null,
    analysis.state === "done" ? (analysis.channels === 1 ? "mono" : analysis.channels === 2 ? "stereo" : `${analysis.channels} ch`) : null,
  ].filter(Boolean).join(" · ");
  const timeLabel = remaining && durationKnown
    ? `-${formatTime(snap.duration - snap.time, snap.duration)}`
    : formatTime(snap.time, snap.duration);

  return (
    <div
      ref={rootRef}
      className="mp mp--audio"
      tabIndex={0}
      aria-label={`Audio player: ${doc.name}`}
      onKeyDown={onKeyDown}
    >
      {src.url && (
        <audio ref={setAudio} src={src.url} preload="metadata" onError={onAudioError} />
      )}

      <div className="mp-audio">
        <div className="mp-audio__head">
          <div className="mp-audio__art">
            {cover ? <img src={cover} alt={`Cover of ${title}`} /> : <Icon name="music-notes" size={48} />}
          </div>
          <div className="mp-audio__meta">
            <h2 className="mp-audio__title" title={title}>{title}</h2>
            {subtitle && <p className="mp-audio__sub">{subtitle}</p>}
            <p className="mp-audio__facts">{facts}</p>
          </div>
        </div>

        <div className="mp-audio__scrub" onMouseDown={keepFocusOnPlayer}>
          {analysis.state === "done" ? (
            <Waveform peaks={analysis.peaks} time={snap.time} duration={snap.duration} ab={t.ab} onSeek={t.seek} />
          ) : (
            <div className="mp-audio__plain">
              <Seekbar time={snap.time} duration={snap.duration} buffered={snap.buffered} onSeek={t.seek} ab={t.ab} />
              <p className="mp-audio__note">
                {analysis.state === "skipped" ? analysis.reason : "Drawing waveform…"}
              </p>
            </div>
          )}
          <div className="mp-audio__times">
            <button type="button" className="mp-time" onClick={() => setRemaining((v) => !v)}
              title={remaining ? "Show elapsed time" : "Show remaining time"}>
              {timeLabel}
            </button>
            {t.ab.a != null && (
              <button type="button" className="mp-chip" onClick={t.cycleAB} title="A-B loop (B)">
                {t.ab.b == null ? `A ${formatTime(t.ab.a, snap.duration)} →` : `A-B ${formatTime(t.ab.a, snap.duration)} – ${formatTime(t.ab.b, snap.duration)}`}
              </button>
            )}
            <span className="mp-time mp-time--static">{formatTime(snap.duration)}</span>
          </div>
        </div>

        <div className="mp-audio__transport" onMouseDown={keepFocusOnPlayer}>
          <button type="button" className={`mp-btn ${t.ab.a != null ? "is-on" : ""}`} onClick={t.cycleAB}
            aria-label="A-B loop" title="A-B loop: set A, set B, clear (B)">
            <span className="mp-btn__label">A-B</span>
          </button>
          <button type="button" className="mp-btn" onClick={() => t.seekBy(-10)} aria-label="Back 10 seconds" title="Back 10 s (J)">
            <Icon name="clock-counter-clockwise" size={20} />
          </button>
          <button type="button" className="mp-btn mp-btn--hero" onClick={t.toggle}
            aria-label={snap.paused ? "Play" : "Pause"} title={snap.paused ? "Play (Space)" : "Pause (Space)"}>
            <Icon name={snap.paused || snap.ended ? "play" : "pause"} size={26} weight="fill" />
          </button>
          <button type="button" className="mp-btn" onClick={() => t.seekBy(10)} aria-label="Forward 10 seconds" title="Forward 10 s (L)">
            <Icon name="clock-clockwise" size={20} />
          </button>
          <button type="button" className={`mp-btn ${t.loop ? "is-on" : ""}`} onClick={t.toggleLoop}
            aria-label="Loop" aria-pressed={t.loop} title="Loop (R)">
            <Icon name="repeat" size={20} />
          </button>
        </div>

        <div className="mp-audio__aux" onMouseDown={keepFocusOnPlayer}>
          <VolumeControl volume={snap.volume} muted={snap.muted} onVolume={t.setVolume} onMute={t.toggleMute} />
          <span className="mp__spacer" />
          <div className="mp-anchor">
            <button type="button" className={`mp-btn mp-btn--text ${speedOpen ? "is-on" : ""}`}
              onClick={() => setSpeedOpen((v) => !v)} aria-label="Playback speed"
              aria-haspopup="dialog" aria-expanded={speedOpen} title="Speed (< >)">
              {formatRate(snap.rate)}
            </button>
            {speedOpen && (
              <MenuPanel title="Speed" onClose={() => setSpeedOpen(false)}>
                <SpeedList rate={snap.rate} onRate={(r) => { t.setRate(r); setSpeedOpen(false); }} />
              </MenuPanel>
            )}
          </div>
          <button type="button" className="mp-btn" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
            <Icon name="keyboard" size={19} />
          </button>
        </div>
      </div>

      {snap.waiting && !error && <div className="mp-spinner mp-spinner--corner" aria-label="Buffering" />}
      <BezelView bezel={t.bezel} />
      {error && (
        <ErrorPanel title={error.title} detail={error.detail}
          onRetry={src.url ? () => { setFailure(null); audio?.load(); } : undefined}
          onOpenExternal={openExternal} />
      )}
      {help && <ShortcutSheet kind="audio" onClose={() => setHelp(false)} />}
    </div>
  );
}
