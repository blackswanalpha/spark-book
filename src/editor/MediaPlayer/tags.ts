/* ============================================================
   sparkBook · src/editor/MediaPlayer/tags.ts
   Title / artist / album / cover art from ID3v2 (MP3, AAC, WAV
   with an ID3 chunk at the head) and FLAC metadata blocks.

   Reads only the head of the file and never throws: a damaged
   tag yields whatever was readable before the damage.
   ============================================================ */

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  picture?: { mime: string; data: Uint8Array };
}

export function readTags(bytes: Uint8Array): AudioTags | null {
  try {
    if (ascii(bytes, 0, 3) === "ID3") return readId3(bytes);
    if (ascii(bytes, 0, 4) === "fLaC") return readFlac(bytes);
  } catch {
    /* fall through: no tags is a normal answer */
  }
  return null;
}

/* ---------- ID3v2.2 / 2.3 / 2.4 ---------- */

function readId3(bytes: Uint8Array): AudioTags | null {
  const ver = bytes[3];
  if (ver < 2 || ver > 4) return null;
  const flags = bytes[5];
  const size = synchsafe(bytes, 6);
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + size));
  // v2.2/2.3 apply unsynchronisation to the whole tag.
  if (flags & 0x80 && ver < 4) body = deunsync(body);
  let pos = 0;
  if (flags & 0x40 && ver >= 3) {
    pos = ver === 3 ? be32(body, 0) + 4 : synchsafe(body, 0);
  }

  const tags: AudioTags = {};
  const idLen = ver === 2 ? 3 : 4;
  const headLen = ver === 2 ? 6 : 10;
  let bestPictureType = -1;

  while (pos + headLen <= body.length) {
    const id = ascii(body, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding or garbage
    const frameSize = ver === 2 ? be24(body, pos + 3) : ver === 3 ? be32(body, pos + 4) : synchsafe(body, pos + 4);
    const formatFlags = ver === 4 ? body[pos + 9] : 0;
    let data = body.subarray(pos + headLen, Math.min(body.length, pos + headLen + frameSize));
    pos += headLen + frameSize;
    if (frameSize <= 0) continue;
    if (formatFlags & 0x02) data = deunsync(data);      // per-frame unsync (v2.4)
    if (formatFlags & 0x01) data = data.subarray(4);    // data length indicator

    switch (id) {
      case "TIT2": case "TT2": tags.title ??= decodeText(data); break;
      case "TPE1": case "TP1": tags.artist ??= decodeText(data); break;
      case "TALB": case "TAL": tags.album ??= decodeText(data); break;
      case "TYER": case "TYE": case "TDRC": tags.year ??= decodeText(data).slice(0, 4); break;
      case "APIC": case "PIC": {
        const pic = readApic(data, id === "PIC");
        // Prefer the front cover (type 3); otherwise keep the first picture.
        if (pic && (bestPictureType < 0 || (pic.type === 3 && bestPictureType !== 3))) {
          tags.picture = { mime: pic.mime, data: pic.data };
          bestPictureType = pic.type;
        }
        break;
      }
    }
  }
  return clean(tags);
}

function readApic(d: Uint8Array, v22: boolean): { mime: string; type: number; data: Uint8Array } | null {
  const enc = d[0];
  let pos = 1;
  let mime: string;
  if (v22) {
    const fmt = ascii(d, 1, 3).toUpperCase();
    mime = fmt === "PNG" ? "image/png" : "image/jpeg";
    pos = 4;
  } else {
    const end = d.indexOf(0, pos);
    if (end < 0) return null;
    mime = ascii(d, pos, end - pos) || "image/jpeg";
    if (!mime.includes("/")) mime = `image/${mime.toLowerCase() === "jpg" ? "jpeg" : mime.toLowerCase()}`;
    pos = end + 1;
  }
  const type = d[pos];
  pos = skipTerminated(d, pos + 1, enc);
  if (pos >= d.length) return null;
  return { mime, type, data: d.subarray(pos) };
}

/** Index just past a string terminator in encoding `enc`. */
function skipTerminated(d: Uint8Array, from: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < d.length; i += 2) if (d[i] === 0 && d[i + 1] === 0) return i + 2;
    return d.length;
  }
  const end = d.indexOf(0, from);
  return end < 0 ? d.length : end + 1;
}

function decodeText(d: Uint8Array): string {
  const enc = d[0];
  let body = d.subarray(1);
  let label = "latin1";
  if (enc === 1) {
    if (body[0] === 0xfe && body[1] === 0xff) { label = "utf-16be"; body = body.subarray(2); }
    else if (body[0] === 0xff && body[1] === 0xfe) { label = "utf-16le"; body = body.subarray(2); }
    else label = "utf-16le";
  } else if (enc === 2) label = "utf-16be";
  else if (enc === 3) label = "utf-8";
  const text = new TextDecoder(label).decode(body);
  // v2.4 separates multiple values with NUL.
  return text.split("\u0000").map((s) => s.trim()).filter(Boolean).join(", ");
}

function deunsync(d: Uint8Array): Uint8Array {
  const out = new Uint8Array(d.length);
  let n = 0;
  for (let i = 0; i < d.length; i++) {
    out[n++] = d[i];
    if (d[i] === 0xff && d[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/* ---------- FLAC ---------- */

function readFlac(bytes: Uint8Array): AudioTags | null {
  const tags: AudioTags = {};
  let pos = 4;
  for (;;) {
    if (pos + 4 > bytes.length) break;
    const head = bytes[pos];
    const type = head & 0x7f;
    const len = be24(bytes, pos + 1);
    const block = bytes.subarray(pos + 4, Math.min(bytes.length, pos + 4 + len));
    if (type === 4) readVorbisComment(block, tags);
    else if (type === 6 && !tags.picture) tags.picture = readFlacPicture(block) ?? undefined;
    pos += 4 + len;
    if (head & 0x80) break; // last-metadata-block flag
  }
  return clean(tags);
}

function readVorbisComment(b: Uint8Array, tags: AudioTags) {
  const utf8 = new TextDecoder("utf-8");
  let pos = 4 + le32(b, 0); // skip vendor string
  const count = le32(b, pos);
  pos += 4;
  for (let i = 0; i < count && pos + 4 <= b.length; i++) {
    const len = le32(b, pos);
    const entry = utf8.decode(b.subarray(pos + 4, pos + 4 + len));
    pos += 4 + len;
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    const value = entry.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "TITLE") tags.title ??= value;
    else if (key === "ARTIST") tags.artist ??= value;
    else if (key === "ALBUM") tags.album ??= value;
    else if (key === "DATE") tags.year ??= value.slice(0, 4);
  }
}

function readFlacPicture(b: Uint8Array): AudioTags["picture"] | null {
  let pos = 4; // picture type
  const mimeLen = be32(b, pos); pos += 4;
  const mime = ascii(b, pos, mimeLen) || "image/jpeg"; pos += mimeLen;
  const descLen = be32(b, pos); pos += 4 + descLen;
  pos += 16; // width, height, depth, colours
  const dataLen = be32(b, pos); pos += 4;
  if (pos + dataLen > b.length) return null;
  return { mime, data: b.subarray(pos, pos + dataLen) };
}

/* ---------- byte helpers ---------- */

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
function synchsafe(b: Uint8Array, at: number): number {
  return ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
}
function be24(b: Uint8Array, at: number): number {
  return (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
}
function be32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
}
function le32(b: Uint8Array, at: number): number {
  return ((b[at + 3] << 24) >>> 0) + ((b[at + 2] << 16) | (b[at + 1] << 8) | b[at]);
}

function clean(t: AudioTags): AudioTags | null {
  return t.title || t.artist || t.album || t.year || t.picture ? t : null;
}
