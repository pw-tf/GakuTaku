import type JSZip from 'jszip';
import { decompress } from 'fzstd';
import { supabase } from '../sync/supabase';
import { getMedia, putMedia } from './mediaCache';
import { mimeForMedia, withMime } from './mediaMime';

/**
 * Anki media handling for `.apkg` import (build plan M6). Note fields reference media as
 * `<img src="name">` and `[sound:name]`. On import we rewrite those refs to resolvable tokens,
 * upload the referenced blobs to the private `media` Storage bucket (and cache them locally), and at
 * render time resolve a token back to an object URL (from cache, else download once and cache).
 */

const BUCKET = 'media';

/**
 * Rewrite Anki media refs in a field value to tokens the renderer can resolve, recording each
 * referenced original filename in `referenced`. Local files only — http(s)/data URIs are left alone.
 * `<img src="x">` → `<img data-media="importId/x">`; `[sound:x]` → an audio placeholder span.
 */
export function rewriteMediaRefs(html: string, importId: string, referenced: Set<string>): string {
  let out = html.replace(/\[sound:([^\]]+)\]/gi, (_m, name: string) => {
    const f = name.trim();
    referenced.add(f);
    return `<span class="anki-audio" data-audio="${importId}/${encodeURIComponent(f)}"></span>`;
  });
  out = out.replace(/<img\b[^>]*>/gi, (tag: string) => {
    const m = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!m) return tag;
    const f = decodeURIComponent(m[1]).trim();
    if (/^(https?:|data:)/i.test(f)) return tag;
    referenced.add(f);
    return tag.replace(m[0], `data-media="${importId}/${encodeURIComponent(f)}"`);
  });
  return out;
}

/**
 * Upload the referenced media blobs to `media/{userId}/{importId}/{name}` and cache them locally.
 * `mediaMap` is the `.apkg`'s numbered-file → original-name map; we reverse it to find each blob.
 */
export async function uploadMedia(
  zip: JSZip,
  mediaMap: Record<string, string>,
  referenced: Set<string>,
  userId: string,
  importId: string,
  compressed: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const numberByName = new Map<string, string>();
  for (const [num, name] of Object.entries(mediaMap)) numberByName.set(name, num);

  let done = 0;
  const total = referenced.size;
  for (const name of referenced) {
    const numbered = numberByName.get(name);
    const entry = numbered ? zip.file(numbered) : null;
    if (entry) {
      // v3 packages zstd-compress each media file individually.
      let bytes: Uint8Array | null = new Uint8Array(await entry.async('arraybuffer'));
      if (compressed) {
        try {
          bytes = decompress(bytes);
        } catch {
          bytes = null; // corrupt entry — skip rather than store garbage
        }
      }
      if (bytes) {
        const blob = new Blob([bytes as BlobPart], { type: mimeForMedia(name) });
        const path = `${userId}/${importId}/${name}`;
        // Cache locally first: an upload can fail (offline import, quota) and the deck should still
        // play its audio on this device — the blob syncs up again on the next import of the same file.
        await putMedia(`${importId}/${name}`, blob);
        await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
      }
    }
    onProgress?.(++done, total);
  }
  return done;
}

/**
 * Object-URL cache so the same media blob isn't re-objectURL'd on every render. Bounded and
 * FIFO-evicted (revoking as it goes) — a long review session can touch thousands of files, and
 * every live object URL pins its blob in memory until revoked.
 */
const urlCache = new Map<string, string>();
const URL_CACHE_MAX = 250;

function cacheUrl(key: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  while (urlCache.size > URL_CACHE_MAX) {
    const oldest = urlCache.keys().next();
    if (oldest.done) break;
    URL.revokeObjectURL(urlCache.get(oldest.value)!);
    urlCache.delete(oldest.value);
  }
  return url;
}

/**
 * Resolve a `data-media`/`data-audio` token (`importId/encodedName`) to an object URL — from the
 * local cache, else downloaded once from Storage and cached. Returns null if unavailable offline.
 *
 * Blobs are re-typed on the way out ({@link withMime}): decks imported before media carried a MIME
 * type are cached as `application/octet-stream`, which media elements refuse to play.
 */
export async function resolveMedia(token: string, userId: string): Promise<string | null> {
  const slash = token.indexOf('/');
  if (slash < 0) return null;
  const importId = token.slice(0, slash);
  const name = decodeURIComponent(token.slice(slash + 1));
  const key = `${importId}/${name}`;

  const cachedUrl = urlCache.get(key);
  if (cachedUrl) return cachedUrl;

  const cached = await getMedia(key);
  if (cached) return cacheUrl(key, withMime(cached, name));

  const { data } = await supabase.storage.from(BUCKET).download(`${userId}/${key}`);
  if (!data) return null;
  const blob = withMime(data, name);
  await putMedia(key, blob);
  return cacheUrl(key, blob);
}
