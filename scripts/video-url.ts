// Turning a RECORD id into a YouTube URL.
//
// For most sources the record id IS the video id and this is a concatenation.
// It stopped being one when replayTheater arrived: those records are SEGMENTS
// of longform tournament VODs, keyed `${videoId}@${startSeconds}`, and pasting
// that into a URL gives youtu.be/abc123XYZ_@11091 — a dead link, in exactly the
// review tools a human uses to adjudicate the record.
//
// Pure and dependency-free so the dev pages can use it too.

export interface VideoRef {
  videoId: string;
  /** seconds into the video, or 0 */
  start: number;
}

/** Split a record id into its video id and start offset. */
export function refOf(id: string): VideoRef {
  const at = id.lastIndexOf('@');
  if (at === -1) return { videoId: id, start: 0 };
  const start = Number(id.slice(at + 1));
  return Number.isFinite(start) && start >= 0
    ? { videoId: id.slice(0, at), start }
    : { videoId: id, start: 0 };
}

/** Short watch link, offset included when the record is a segment. */
export function watchUrl(id: string): string {
  const { videoId, start } = refOf(id);
  return start > 0 ? `https://youtu.be/${videoId}?t=${start}` : `https://youtu.be/${videoId}`;
}

/** Canonical watch link (what yt-dlp and the API want). */
export function longWatchUrl(id: string): string {
  const { videoId, start } = refOf(id);
  return start > 0
    ? `https://www.youtube.com/watch?v=${videoId}&t=${start}s`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

/** Thumbnail for a record — derived from the VIDEO, never the composite id. */
export function thumbUrl(id: string, quality = 'hqdefault'): string {
  return `https://i.ytimg.com/vi/${refOf(id).videoId}/${quality}.jpg`;
}
