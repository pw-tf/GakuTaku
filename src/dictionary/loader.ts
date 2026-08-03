import { cacheBucket, cachedBucketCount, getKanjiJlpt, getManifest } from './store';

/**
 * The *optional* full-offline download.
 *
 * Lookup itself needs none of this: `store.ts` fetches the one or two buckets a word hashes into
 * and caches them, so words looked up while online keep working offline afterwards. This warms
 * every remaining bucket in one go, for readers who want the whole dictionary available on a
 * plane. It is resumable — already-cached buckets are skipped — and safe to run twice.
 */

/** Parallel bucket fetches. Enough to keep the connection busy without swamping it. */
const CONCURRENCY = 8;

export interface LoadProgress {
  phase: 'manifest' | 'download' | 'done';
  loaded: number;
  total: number;
}

export interface OfflineStatus {
  cached: number;
  total: number;
  /** Approximate download size of the whole dictionary, in bytes. */
  totalBytes: number;
  complete: boolean;
}

/** How much of the dictionary is available offline right now. */
export async function offlineStatus(): Promise<OfflineStatus> {
  const manifest = await getManifest();
  const cached = await cachedBucketCount(manifest);
  return {
    cached,
    total: manifest.bucketCount,
    totalBytes: manifest.totalBytes,
    complete: cached >= manifest.bucketCount,
  };
}

/** True once every bucket is cached locally (i.e. lookup is fully offline-capable). */
export async function isDictionaryLoaded(): Promise<boolean> {
  try {
    return (await offlineStatus()).complete;
  } catch {
    return false;
  }
}

/**
 * Download every bucket not yet cached. Progress is reported in buckets, and the fixed-size
 * worker pool keeps a steady number of requests in flight rather than issuing thousands at once.
 */
export async function ensureDictionary(onProgress?: (p: LoadProgress) => void): Promise<void> {
  onProgress?.({ phase: 'manifest', loaded: 0, total: 0 });
  const manifest = await getManifest();
  await getKanjiJlpt();

  const total = manifest.bucketCount;
  let loaded = await cachedBucketCount(manifest);
  onProgress?.({ phase: 'download', loaded, total });

  let next = 0;
  const worker = async () => {
    for (;;) {
      const bucket = next++;
      if (bucket >= total) return;
      // Only newly fetched buckets advance the bar — `loaded` already counts the cached ones.
      if (await cacheBucket(bucket, manifest)) {
        onProgress?.({ phase: 'download', loaded: Math.min(total, ++loaded), total });
      }
    }
  };
  // The first rejection wins; the other workers stop at their next iteration boundary.
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  onProgress?.({ phase: 'done', loaded: total, total });
}
