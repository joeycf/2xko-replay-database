import type { VideoRecord } from '~~/types'

/**
 * Loads the full parsed replay list once (keyed → deduped across components).
 * Client-only $fetch of the static asset published by the build:before hook —
 * videos.json is deliberately NOT bundled into JS and NOT serialized into
 * per-route payloads (it's ~3.3 MB of JSON). Prerendered pages show skeletons
 * until this resolves on the client.
 */
export function useVideos() {
  const { data, pending, error } = useAsyncData(
    'videos',
    () => $fetch<VideoRecord[]>('/data/videos.json'),
    { server: false, default: () => [] as VideoRecord[] },
  )
  const byId = (id: string): VideoRecord | undefined => data.value.find((v) => v.id === id)
  return { videos: data, pending, error, byId }
}
