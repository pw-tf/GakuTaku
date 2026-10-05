import { BlobReader, BlobWriter, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, type Entry } from '@zip.js/zip.js';
import type { TextBookData } from '../books/textBook';

/**
 * GakuTaku's backup file: a zip holding everything that lives on the device.
 *
 *   manifest.json            what this is, when it was made, counts
 *   collection.sqlite3       the database (cards, notes, decks, review history, library, feeds…)
 *   prefs.json               app preferences
 *   media/<name>             card images and audio (names URI-encoded)
 *   books/<id>/file          each book's original file
 *   books/<id>/text.json     extracted text of TXT/PDF books
 *   books/<id>/cover         ePUB cover image
 *
 * Media and books are stored without compression (they're already compressed formats).
 */

export const BACKUP_FORMAT = 'gakutaku-backup';
export const BACKUP_VERSION = 1;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  counts: { media: number; books: number; databaseBytes: number };
}

export interface BackupBook {
  id: string;
  file?: Blob;
  text?: TextBookData;
  cover?: Blob;
}

/** Where a backup reads the device's data from. */
export interface BackupSource {
  database(): Promise<Uint8Array>;
  prefs(): string | null;
  media(): AsyncIterable<{ name: string; blob: Blob }>;
  books(): AsyncIterable<BackupBook>;
}

/** Where a restore writes it to. */
export interface RestoreTarget {
  database(bytes: Uint8Array): Promise<void>;
  prefs(json: string | null): void;
  /** Add or overwrite media files. */
  putMedia(files: { name: string; blob: Blob }[]): Promise<void>;
  /** Delete every media file not in `keep`. */
  pruneMedia(keep: Set<string>): Promise<void>;
  /** Add or overwrite a book's stored files. */
  putBook(book: BackupBook): Promise<void>;
  /** Delete the stored files of every book not in `keep`. */
  pruneBooks(keep: Set<string>): Promise<void>;
}

export type Progress = (message: string, done?: number, total?: number) => void;

const SQLITE_HEADER = 'SQLite format 3\0';

export async function createBackup(src: BackupSource, onProgress?: Progress): Promise<Blob> {
  const zip = new ZipWriter(new BlobWriter('application/zip'), { bufferedWrite: true });
  onProgress?.('Saving cards and history…');
  const database = await src.database();
  await zip.add('collection.sqlite3', new Uint8ArrayReader(database));
  const prefs = src.prefs();
  if (prefs) await zip.add('prefs.json', new TextReader(prefs));

  let media = 0;
  for await (const f of src.media()) {
    await zip.add(`media/${encodeURIComponent(f.name)}`, new BlobReader(f.blob), { level: 0 });
    if (++media % 50 === 0) onProgress?.(`Saving media… (${media.toLocaleString()} files)`);
  }

  let books = 0;
  onProgress?.('Saving books…');
  for await (const b of src.books()) {
    if (b.file) await zip.add(`books/${b.id}/file`, new BlobReader(b.file), { level: 0 });
    if (b.text) await zip.add(`books/${b.id}/text.json`, new TextReader(JSON.stringify(b.text)));
    if (b.cover) await zip.add(`books/${b.id}/cover`, new BlobReader(b.cover), { level: 0 });
    books++;
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    counts: { media, books, databaseBytes: database.length },
  };
  await zip.add('manifest.json', new TextReader(JSON.stringify(manifest, null, 2)));
  onProgress?.('Finishing…');
  return zip.close();
}

const text = async (e: Entry) => new TextDecoder().decode(await bytes(e));
const bytes = async (e: Entry) => {
  if (e.directory || !e.getData) throw new Error(`Unreadable entry ${e.filename}`);
  return e.getData(new Uint8ArrayWriter());
};
const blob = async (e: Entry) => {
  if (e.directory || !e.getData) throw new Error(`Unreadable entry ${e.filename}`);
  return e.getData(new BlobWriter());
};

/** Open a backup file and check it is one, without changing anything. */
export async function readBackup(file: Blob): Promise<{ manifest: BackupManifest; entries: Map<string, Entry>; close: () => Promise<void> }> {
  let reader: ZipReader<unknown>;
  let list: Entry[];
  try {
    reader = new ZipReader(new BlobReader(file));
    list = await reader.getEntries();
  } catch {
    throw new Error('This file isn’t a GakuTaku backup (it isn’t a zip file).');
  }
  const entries = new Map(list.map((e) => [e.filename, e]));
  const m = entries.get('manifest.json');
  const db = entries.get('collection.sqlite3');
  if (!m || !db) {
    await reader.close();
    throw new Error('This file isn’t a GakuTaku backup. (Anki decks and collections are imported from the Decks screen.)');
  }
  const manifest = JSON.parse(await text(m)) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) {
    await reader.close();
    throw new Error('This file isn’t a GakuTaku backup.');
  }
  if (manifest.version > BACKUP_VERSION) {
    await reader.close();
    throw new Error('This backup was made by a newer version of GakuTaku. Update the app, then restore it.');
  }
  return { manifest, entries, close: () => reader.close() };
}

/** Replace everything on the device with a backup's contents. */
export async function restoreBackup(file: Blob, target: RestoreTarget, onProgress?: Progress): Promise<BackupManifest> {
  const { manifest, entries, close } = await readBackup(file);
  try {
    onProgress?.('Checking the backup…');
    const database = await bytes(entries.get('collection.sqlite3')!);
    if (new TextDecoder('latin1').decode(database.subarray(0, 16)) !== SQLITE_HEADER) throw new Error('The backup’s database is damaged.');
    const prefs = entries.get('prefs.json');
    const prefsJson = prefs ? await text(prefs) : null;

    // Files are written over the top first and the database is swapped last, so a failure part-way
    // leaves the current collection working (with some extra files). Only then is anything the
    // backup doesn't have removed.
    onProgress?.('Restoring media…');
    const mediaEntries = [...entries.values()].filter((e) => e.filename.startsWith('media/') && !e.directory);
    let batch: { name: string; blob: Blob }[] = [];
    let done = 0;
    for (const e of mediaEntries) {
      batch.push({ name: decodeURIComponent(e.filename.slice('media/'.length)), blob: await blob(e) });
      if (batch.length >= 100) {
        await target.putMedia(batch);
        done += batch.length;
        batch = [];
        onProgress?.('Restoring media…', done, mediaEntries.length);
      }
    }
    if (batch.length) await target.putMedia(batch);

    onProgress?.('Restoring books…');
    const bookIds = new Set([...entries.keys()].filter((n) => n.startsWith('books/')).map((n) => n.split('/')[1]).filter(Boolean));
    for (const id of bookIds) {
      const f = entries.get(`books/${id}/file`);
      const t = entries.get(`books/${id}/text.json`);
      const c = entries.get(`books/${id}/cover`);
      await target.putBook({
        id,
        file: f ? await blob(f) : undefined,
        text: t ? (JSON.parse(await text(t)) as TextBookData) : undefined,
        cover: c ? await blob(c) : undefined,
      });
    }

    onProgress?.('Restoring cards and history…');
    await target.database(database);
    target.prefs(prefsJson);

    onProgress?.('Tidying up…');
    await target.pruneMedia(new Set(mediaEntries.map((e) => decodeURIComponent(e.filename.slice('media/'.length)))));
    await target.pruneBooks(bookIds);
    return manifest;
  } finally {
    await close();
  }
}

/** `GakuTaku-backup-2026-10-05.zip` */
export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `GakuTaku-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}
