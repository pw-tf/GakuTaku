/**
 * MIME types for Anki media filenames.
 *
 * This matters more than it looks: `@supabase/storage-js` ignores its `contentType` option for
 * `Blob` bodies (it switches to `FormData`, and the part's type comes from `blob.type`), so a
 * type-less Blob is stored — and downloaded back — as `application/octet-stream`. `<img>` sniffs
 * content and survives that, but `HTMLMediaElement` trusts the type of a `blob:` URL and refuses to
 * decode, which silently breaks every `[sound:…]` on a card. So the type has to be set on the Blob
 * itself, both when uploading and when re-wrapping anything cached without one.
 *
 * Kept dependency-free so scripts/verify-dict.ts can import it outside a browser.
 */

const MEDIA_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function mimeForMedia(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MEDIA_MIME[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** Give a blob the right media type when it has none (or a useless generic one). */
export function withMime(blob: Blob, name: string): Blob {
  if (blob.type && blob.type !== 'application/octet-stream' && blob.type !== 'text/plain') return blob;
  const type = mimeForMedia(name);
  return type === 'application/octet-stream' ? blob : blob.slice(0, blob.size, type);
}
