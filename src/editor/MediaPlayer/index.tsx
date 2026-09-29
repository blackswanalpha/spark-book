/* ============================================================
   sparkBook · src/editor/MediaPlayer/index.tsx
   Video and audio surfaces. Read-only: the file on disk is the
   document, streamed rather than held in the store.
   ============================================================ */
import { useDocs } from "@store/documents";
import { VideoPlayer } from "./VideoPlayer";
import { AudioPlayer } from "./AudioPlayer";
import "./MediaPlayer.css";
import "../editor.css";

export function MediaPlayer({ docId }: { docId: string }) {
  const doc = useDocs((s) => s.docs[docId]);
  if (!doc) return null;
  // Keyed by path: a Save As copy is a different file with its own
  // resume point and subtitles, so the player starts fresh.
  return doc.mode === "audio"
    ? <AudioPlayer key={doc.path ?? doc.id} doc={doc} />
    : <VideoPlayer key={doc.path ?? doc.id} doc={doc} />;
}

export default MediaPlayer;
