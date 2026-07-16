import type { VideoRecord } from '~~/types';

/**
 * Dev-tooling replacement for the retired useVideos(): the curation pages
 * (/dev/fuse-gaps, /dev/fuse-orient) need the RICH VideoRecord shape (fuse
 * per team, matchType, parse confidence), which the generic public
 * replays.json deliberately drops — so they fetch data/videos.json through
 * the dev-only server route instead.
 */
export function useDevVideos() {
  const { data, pending, error } = useAsyncData<VideoRecord[]>(
    'dev-videos',
    () => $fetch<VideoRecord[]>('/api/dev/videos'),
    { server: false, default: () => [] },
  );
  return { videos: data as Ref<VideoRecord[]>, pending, error };
}
