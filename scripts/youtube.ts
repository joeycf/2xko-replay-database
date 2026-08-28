// The YouTube Data API v3 client, shared by every fetcher.
//
// It used to live inside scripts/fetch.ts, which was fine while fetch.ts was the
// only thing that talked to YouTube. scripts/fetch-theater.ts also needs video
// metadata — Replay Theater indexes matches by video id and start offset and
// carries no title, duration, view count or thumbnail — and fetch.ts cannot be
// imported: it calls main() at module load and exits on a missing key, so
// importing it would run a full channel fetch as a side effect.
//
// IMPORTING THIS MODULE IS SIDE-EFFECT FREE. The key check is `requireApiKey()`,
// called by an entry point, not by module evaluation. That is the whole reason
// the extraction is shaped this way.

import type { ChannelKey, RawVideoRecord } from '../types/index';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let API_KEY: string | null = null;

/** Read YT_API_KEY, or exit with the same message every entry point printed. */
export function requireApiKey(script: string): string {
  const rawKey = process.env.YT_API_KEY;
  if (!rawKey) {
    console.error(
      [
        '✖ Missing YT_API_KEY.',
        '  Create a .env file in the project root containing:',
        '    YT_API_KEY=your_key_here',
        `  (see .env.example). ${script} loads it via \`tsx --env-file-if-exists=.env\`.`,
      ].join('\n'),
    );
    process.exit(1);
  }
  API_KEY = rawKey;
  return rawKey;
}

/** GET with retry on 5xx / 429; fail loudly on any other 4xx. */
export async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>,
  retries = 5,
): Promise<T> {
  if (!API_KEY) throw new Error('youtube: requireApiKey() must run before apiGet()');
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', API_KEY);

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `  ⚠ network error on ${endpoint} (attempt ${attempt}/${retries}); retrying in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    const body = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `  ⚠ HTTP ${res.status} on ${endpoint} ${JSON.stringify(params)} (attempt ${attempt}/${retries}); retrying in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }
    // Non-retryable 4xx or out of retries → fail loudly with the API's error body.
    // (The key is never included: it is only ever set on the URL, not in `params`.)
    throw new Error(
      `YouTube API error: HTTP ${res.status} on ${endpoint} ${JSON.stringify(params)}\n${body}`,
    );
  }
  throw new Error(`Exhausted retries for ${endpoint}`);
}

// ── minimal shapes of the API responses we consume ───────────────────────────
export type Thumbnails = Record<string, { url?: string } | undefined>;
export interface ChannelsResponse {
  items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
}
export interface PlaylistItemsResponse {
  items?: Array<{ contentDetails?: { videoId?: string } }>;
  nextPageToken?: string;
}
export interface VideoItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: Thumbnails;
    channelTitle?: string;
  };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}
export interface VideosResponse {
  items?: VideoItem[];
}

/** Page through a playlist collecting every videoId, in playlist order. */
export async function listAllUploadIds(playlistId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = { part: 'contentDetails', maxResults: '50', playlistId };
    if (pageToken) params.pageToken = pageToken;
    const data = await apiGet<PlaylistItemsResponse>('playlistItems', params);
    for (const item of data.items ?? []) {
      const vid = item.contentDetails?.videoId;
      if (vid) ids.push(vid);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

/** Highest-res thumbnail: maxres → standard → high → medium → default → fallback. */
export function pickThumbnail(thumbs: Thumbnails | undefined, videoId: string): string {
  for (const key of ['maxres', 'standard', 'high', 'medium', 'default'] as const) {
    const url = thumbs?.[key]?.url;
    if (url) return url;
  }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** ISO-8601 duration (e.g. "PT7M1S") → seconds. */
export function parseIsoDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return 0;
  const [, h, min, s] = m;
  return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

export function toRawRecord(item: VideoItem, channel: ChannelKey): RawVideoRecord {
  const sn = item.snippet ?? {};
  return {
    id: item.id,
    channel,
    title: sn.title ?? '',
    description: sn.description ?? '',
    publishedAt: sn.publishedAt ?? '',
    thumbnail: pickThumbnail(sn.thumbnails, item.id),
    durationSec: parseIsoDuration(item.contentDetails?.duration),
    viewCount: Number(item.statistics?.viewCount ?? 0),
  };
}

/**
 * Full metadata in batches of 50, preserving the caller's id order.
 *
 * Ids the API does not return (deleted, private) are DROPPED — the caller sees
 * a shorter array than it asked for. fetch.ts wants exactly that (an unlisted
 * upload has left the catalogue). A caller that needs to know which ids
 * vanished should diff its input against the result: fetch-theater.ts does,
 * because a Replay Theater entry pointing at a video that has since gone
 * private is a fact worth reporting, not a silent omission.
 */
export async function fetchVideoMetadata(
  ids: string[],
  channel: ChannelKey,
): Promise<RawVideoRecord[]> {
  const byId = new Map<string, RawVideoRecord>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet<VideosResponse>('videos', {
      part: 'snippet,contentDetails,statistics',
      id: batch.join(','),
    });
    for (const item of data.items ?? []) byId.set(item.id, toRawRecord(item, channel));
  }
  return ids.map((id) => byId.get(id)).filter((r): r is RawVideoRecord => r != null);
}

/** Like fetchVideoMetadata, but also returns the uploading channel's title —
 *  fetch-theater.ts needs it because a Replay Theater VOD is hosted by whoever
 *  ran the event (11 different channels across the 2XKO catalogue), and that
 *  name is what the record's `channelName` should say. */
export async function fetchVideoMetadataWithUploader(
  ids: string[],
  channel: ChannelKey,
): Promise<Map<string, RawVideoRecord & { uploader: string }>> {
  const byId = new Map<string, RawVideoRecord & { uploader: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet<VideosResponse>('videos', {
      part: 'snippet,contentDetails,statistics',
      id: batch.join(','),
    });
    for (const item of data.items ?? []) {
      byId.set(item.id, {
        ...toRawRecord(item, channel),
        uploader: item.snippet?.channelTitle ?? '',
      });
    }
  }
  return byId;
}
