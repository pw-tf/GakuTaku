import { BlobReader, ZipReader } from '@zip.js/zip.js';

/**
 * What kind of file the user picked. The extension decides when there is one; otherwise (some
 * Android pickers hand over names like "document:1234" or a title without ".epub") the content
 * does: PDF and ZIP signatures, an ePUB's mimetype entry or container, an Anki collection inside a
 * package, or plain text.
 */
export type FileKind = 'epub' | 'pdf' | 'txt' | 'apkg' | 'colpkg';

const EXT: Record<string, FileKind> = { epub: 'epub', pdf: 'pdf', txt: 'txt', apkg: 'apkg', colpkg: 'colpkg' };

export async function detectFileKind(file: Blob & { name?: string; type?: string }): Promise<FileKind | null> {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name ?? '')?.[1]?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext];
  if (file.type === 'application/epub+zip') return 'epub';
  if (file.type === 'application/pdf') return 'pdf';

  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const ascii = (from: number, len: number) => String.fromCharCode(...head.subarray(from, from + len));
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    // An ePUB starts with its uncompressed "mimetype" entry.
    if (ascii(30, 8) === 'mimetype' && ascii(38, 20).startsWith('application/epub+zip')) return 'epub';
    try {
      const zip = new ZipReader(new BlobReader(file));
      const names = new Set((await zip.getEntries()).map((e) => e.filename));
      await zip.close();
      if (names.has('META-INF/container.xml')) return 'epub';
      if (names.has('collection.anki21b') || names.has('collection.anki21') || names.has('collection.anki2')) return 'apkg';
    } catch {
      return null;
    }
    return null;
  }
  // Plain text: no NUL bytes, and valid UTF-8 (or UTF-16 with a BOM).
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return 'txt';
  if (head.length && !head.includes(0)) {
    try {
      // Streaming: a character cut off at the end of the sample isn't an error.
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
      return 'txt';
    } catch {
      return file.type?.startsWith('text/') ? 'txt' : null;
    }
  }
  return null;
}
