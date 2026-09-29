/* ============================================================
   sparkBook · src/editor/MediaPlayer/source.ts
   Where the <video>/<audio> element gets its bytes.

   Order of preference:
   1. Bytes already in the document (browser mock, restored
      checkpoint) → blob URL.
   2. Tauri → the asset protocol. The host adds this one file to
      the scope and the engine streams it with range requests, so
      a 4 GB film opens as fast as a 4 MB one and seeks anywhere.
   3. Otherwise, or when the engine rejects the asset URL, read the
      file through the host and play it from a blob URL, provided
      it is small enough to hold in memory.
   ============================================================ */
import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri, mediaAllow, mediaMime, readFileBase64, stat, extname } from "@bridge/commands";
import { base64ToObjectUrl, formatBytes } from "@lib/binary";
import type { OpenDoc } from "@store/documents";

/** Largest file played from memory when streaming is unavailable. */
export const BLOB_LIMIT = 256 * 1024 * 1024;

export type SourceVia = "asset" | "blob";

export interface MediaSourceState {
  url: string | null;
  via: SourceVia | null;
  error: string | null;
}

/**
 * Resolve a playable URL for `doc`. `fallback()` switches a streamed
 * source to the in-memory path once; it returns false when there is no
 * fallback left to try, so the caller shows the error instead.
 */
export function useMediaSource(doc: OpenDoc | undefined): MediaSourceState & { fallback: () => boolean } {
  const path = doc?.path ?? null;
  const raw = doc?.raw ?? "";
  const name = doc?.name ?? "";
  const [state, setState] = useState<MediaSourceState>({ url: null, via: null, error: null });
  // Keyed by path so opening another file starts from the preferred route.
  const [memoryFor, setMemoryFor] = useState<string | null>(null);
  const forceMemory = path != null && memoryFor === path;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const mime = mediaMime(path ?? name);
    setState({ url: null, via: null, error: null });

    const toBlob = (b64: string) => {
      objectUrl = base64ToObjectUrl(b64, mime);
      return objectUrl;
    };

    (async () => {
      if (raw) {
        setState({ url: toBlob(raw), via: "blob", error: null });
        return;
      }
      if (!path) throw new Error("This media has no file to play from.");
      if (isTauri && !forceMemory) {
        await mediaAllow(path);
        if (!cancelled) setState({ url: convertFileSrc(path), via: "asset", error: null });
        return;
      }
      const info = await stat(path).catch(() => null);
      if (info && info.size > BLOB_LIMIT) {
        throw new Error(
          `This file is ${formatBytes(info.size)}. Files over ${formatBytes(BLOB_LIMIT)} can only be streamed, and streaming failed.`,
        );
      }
      const b64 = await readFileBase64(path);
      if (cancelled) return;
      setState({ url: toBlob(b64), via: "blob", error: null });
    })().catch((e: unknown) => {
      if (!cancelled) setState({ url: null, via: null, error: hostMessage(e) });
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, raw, name, forceMemory]);

  const fallback = useCallback(() => {
    if (state.via !== "asset" || !path) return false;
    setMemoryFor(path);
    return true;
  }, [state.via, path]);

  return { ...state, fallback };
}

function hostMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const kind = (e as { kind?: string } | null)?.kind;
  if (kind === "NotFound") return "The file is no longer there. It may have been moved or deleted.";
  if (kind === "PermissionDenied") return "sparkBook is not allowed to read this file.";
  return String((e as { data?: { message?: string } } | null)?.data?.message ?? e ?? "Unknown error");
}

type Platform = "linux" | "mac" | "windows" | "other";

function platform(): Platform {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

const CODEC_HELP: Record<Platform, string> = {
  linux:
    "On Linux the webview plays media through GStreamer. Installing gst-plugins-good, " +
    "gst-plugins-bad, gst-plugins-ugly and gst-libav adds most common codecs.",
  mac:
    "macOS plays MP4 and MOV (H.264, HEVC), MP3, AAC, WAV and FLAC. " +
    "MKV, AVI, WMV and most WebM files need another player.",
  windows:
    "Windows plays MP4 (H.264), WebM, MP3, AAC, WAV, FLAC and Ogg. " +
    "HEVC needs the HEVC Video Extensions from the Microsoft Store.",
  other: "The system media engine does not support this format or codec.",
};

export interface MediaErrorInfo { title: string; detail: string }

/** Turn a MediaError code into something a person can act on. */
export function describeMediaError(code: number | undefined, path: string): MediaErrorInfo {
  const ext = (extname(path) || "media").toUpperCase();
  switch (code) {
    case 1:
      return { title: "Playback was stopped.", detail: "Loading was aborted before the file could play." };
    case 2:
      return {
        title: "The file could not be read.",
        detail: "It may have been moved or deleted, or it lives on a drive that is no longer connected.",
      };
    case 3:
      return {
        title: "The file could not be decoded.",
        detail: "It may be damaged or incomplete, or it uses an encoding feature the decoder does not handle.",
      };
    case 4:
      return { title: `This ${ext} file cannot be played here.`, detail: CODEC_HELP[platform()] };
    default:
      return { title: "Playback failed.", detail: "The media engine reported an error without a reason." };
  }
}
