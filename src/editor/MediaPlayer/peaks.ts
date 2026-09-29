/* ============================================================
   sparkBook · src/editor/MediaPlayer/peaks.ts
   Waveform overview for the audio player.

   The file is decoded once, reduced to a fixed number of min/max
   pairs, and the PCM is dropped. Drawing then works from the
   pairs alone at any width.
   ============================================================ */

/** Pairs kept per file. Enough for a 4K-wide waveform. */
export const PEAK_RESOLUTION = 4096;

/** Interleaved [min0, max0, min1, max1, …] across all channels. */
export function computePeaks(channels: readonly Float32Array[], buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const len = channels.reduce((n, c) => Math.max(n, c.length), 0);
  if (!len || !buckets) return out;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * len) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * len) / buckets));
    let min = 0;
    let max = 0;
    for (const ch of channels) {
      for (let i = start; i < end && i < ch.length; i++) {
        const v = ch[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

/** Fold `peaks` down to `n` pairs, keeping the extremes of each group. */
export function resamplePeaks(peaks: Float32Array, n: number): Float32Array {
  const have = peaks.length / 2;
  if (n >= have) return peaks;
  const out = new Float32Array(n * 2);
  for (let b = 0; b < n; b++) {
    const start = Math.floor((b * have) / n);
    const end = Math.max(start + 1, Math.floor(((b + 1) * have) / n));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      if (peaks[i * 2] < min) min = peaks[i * 2];
      if (peaks[i * 2 + 1] > max) max = peaks[i * 2 + 1];
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

export interface DecodedAudio {
  peaks: Float32Array;
  channels: number;
  duration: number;
}

/** Samples per channel the decode may produce. Bounds peak memory at
    about 80 MB per channel however long the file is. */
const SAMPLE_BUDGET = 20_000_000;

/**
 * Decode compressed audio bytes and reduce them to peaks. Uses an
 * OfflineAudioContext so no output device is opened just to draw a
 * picture. Decoding resamples to the context rate, so the rate is
 * lowered for long files to keep the transient PCM buffer bounded.
 * Rejects when the engine cannot decode the format.
 */
export async function decodePeaks(bytes: Uint8Array, durationHint: number): Promise<DecodedAudio> {
  const Offline = window.OfflineAudioContext
    ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) throw new Error("Web Audio is not available");
  const seconds = Number.isFinite(durationHint) && durationHint > 0 ? durationHint : 600;
  const rate = Math.max(3000, Math.min(22050, Math.floor(SAMPLE_BUDGET / seconds)));
  const ctx = new Offline(1, 1, rate);
  // decodeAudioData detaches its argument, so hand it a copy.
  const copy = bytes.slice().buffer;
  const buf = await new Promise<AudioBuffer>((resolve, reject) => {
    const p = ctx.decodeAudioData(copy, resolve, reject);
    if (p && typeof p.then === "function") p.then(resolve, reject);
  });
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  return {
    peaks: computePeaks(channels, PEAK_RESOLUTION),
    channels: buf.numberOfChannels,
    duration: buf.duration,
  };
}
