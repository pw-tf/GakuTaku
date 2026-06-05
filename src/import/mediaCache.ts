import Dexie, { type Table } from 'dexie';

interface CachedMedia {
  /** `${importId}/${originalName}`. */
  key: string;
  blob: Blob;
}

/** Local cache of imported Anki media (images/audio) for offline rendering; mirrors the `media`
 *  Storage bucket, the same way {@link ../reader/bookCache} caches ePUB blobs. */
class MediaCacheDB extends Dexie {
  media!: Table<CachedMedia, string>;
  constructor() {
    super('gakutaku-media');
    this.version(1).stores({ media: 'key' });
  }
}

const cacheDb = new MediaCacheDB();

export async function getMedia(key: string): Promise<Blob | undefined> {
  return (await cacheDb.media.get(key))?.blob;
}

export async function putMedia(key: string, blob: Blob): Promise<void> {
  await cacheDb.media.put({ key, blob });
}
