import Dexie, { type Table } from 'dexie';
import { mimeForMedia, withMime } from '../import/mediaMime';

/**
 * The media folder: every image/audio file a note can reference, keyed by its filename — the same
 * model as Anki's `collection.media`, so note fields keep Anki's plain `<img src="x.jpg">` and
 * `[sound:x.mp3]` references and render, edit and export unchanged.
 */

interface MediaFile {
  name: string;
  blob: Blob;
}

class MediaDB extends Dexie {
  files!: Table<MediaFile, string>;
  constructor() {
    super('gakutaku-media-files');
    this.version(1).stores({ files: 'name' });
  }
}

const mediaDb = new MediaDB();

export async function getMediaFile(name: string): Promise<Blob | null> {
  const row = await mediaDb.files.get(name);
  return row ? withMime(row.blob, name) : null;
}

export async function hasMediaFile(name: string): Promise<{ size: number } | null> {
  const row = await mediaDb.files.get(name);
  return row ? { size: row.blob.size } : null;
}

export async function putMediaFile(name: string, data: Blob | Uint8Array): Promise<void> {
  const blob = data instanceof Blob ? withMime(data, name) : new Blob([data as BlobPart], { type: mimeForMedia(name) });
  await mediaDb.files.put({ name, blob });
}

export async function putMediaFiles(files: { name: string; data: Uint8Array }[]): Promise<void> {
  await mediaDb.files.bulkPut(files.map((f) => ({ name: f.name, blob: new Blob([f.data as BlobPart], { type: mimeForMedia(f.name) }) })));
}

export async function mediaFileCount(): Promise<number> {
  return mediaDb.files.count();
}

/**
 * A free filename for an incoming file that clashes with a different existing one (Anki appends a
 * hash; we append the content's size and a short checksum).
 */
export function renamedForConflict(name: string, data: Uint8Array): string {
  let h = 0;
  for (let i = 0; i < data.length; i += Math.max(1, Math.floor(data.length / 4096))) h = (Math.imul(h, 31) + data[i]) | 0;
  const dot = name.lastIndexOf('.');
  const tag = `-${(h >>> 0).toString(16)}`;
  return dot > 0 ? name.slice(0, dot) + tag + name.slice(dot) : name + tag;
}

const urlCache = new Map<string, string>();
const URL_CACHE_MAX = 300;

/** An object URL for a media file (cached; null when the file isn't on this device). */
export async function mediaUrl(name: string): Promise<string | null> {
  const hit = urlCache.get(name);
  if (hit) return hit;
  const blob = await getMediaFile(name);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(name, url);
  while (urlCache.size > URL_CACHE_MAX) {
    const oldest = urlCache.keys().next().value as string;
    URL.revokeObjectURL(urlCache.get(oldest)!);
    urlCache.delete(oldest);
  }
  return url;
}

/** A data: URL for a media file (for cards rendered inside an isolated frame). */
export async function mediaDataUrl(name: string): Promise<string | null> {
  const blob = await getMediaFile(name);
  if (!blob) return null;
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}
