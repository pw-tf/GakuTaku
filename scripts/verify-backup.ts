/**
 * Checks for the backup file format (src/backup/format.ts): a backup restores exactly what was
 * saved, a restore removes what the backup doesn't have, a failed restore leaves the existing
 * collection in place, and files that aren't GakuTaku backups are refused before anything changes.
 *
 *   npm run verify:backup
 */
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { backupFileName, createBackup, readBackup, restoreBackup, type BackupBook, type RestoreTarget } from '../src/backup/format';
import type { TextBookData } from '../src/books/textBook';

let failures = 0;
let passes = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passes++;
  else {
    failures++;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  }
}
async function rejects(label: string, p: Promise<unknown>, match: RegExp) {
  try {
    await p;
    eq(label, 'resolved', `rejected with ${match}`);
  } catch (e) {
    eq(label, match.test(e instanceof Error ? e.message : String(e)), true);
  }
}

/** A stand-in database file: SQLite's 100-byte header (schema version at byte 60) plus a tag. */
function fakeDb(tag: string, schema = 2): Uint8Array {
  const header = new Uint8Array(100);
  header.set(new TextEncoder().encode('SQLite format 3\0'));
  new DataView(header.buffer).setUint32(60, schema);
  return new Uint8Array([...header, ...new TextEncoder().encode(tag)]);
}
const textOf = async (b?: Blob) => (b ? new TextDecoder().decode(new Uint8Array(await b.arrayBuffer())) : undefined);

// ---- A device with data ---------------------------------------------------------------------
const book: TextBookData = { title: '雨の日', creator: '作者', chapters: [{ title: '一', paragraphs: ['雨が降った。'] }] };
const deviceA = {
  db: fakeDb('A'),
  prefs: '{"state":{"accent":"#3f5bb0"},"version":1}',
  media: new Map<string, Blob>([
    ['word_1.mp3', new Blob(['mp3-bytes'], { type: 'audio/mpeg' })],
    ['画像 #1?.png', new Blob(['png'], { type: 'image/png' })],
    ['dir/odd%name.jpg', new Blob(['jpg'])],
  ]),
  books: new Map<string, BackupBook>([
    ['b1', { id: 'b1', file: new Blob(['epub-bytes']), cover: new Blob(['cover']) }],
    ['b2', { id: 'b2', file: new Blob(['txt-bytes']), text: book }],
  ]),
};

async function* iter<T>(xs: Iterable<T>) {
  for (const x of xs) yield x;
}

const progress: string[] = [];
const backup = await createBackup(
  {
    database: async () => deviceA.db,
    prefs: () => deviceA.prefs,
    media: () => iter([...deviceA.media].map(([name, blob]) => ({ name, blob }))),
    books: () => iter(deviceA.books.values()),
  },
  (m) => progress.push(m),
);
eq('backup is a zip', backup.type, 'application/zip');
const { manifest, close } = await readBackup(backup);
await close();
eq('manifest counts', manifest.counts, { media: 3, books: 2, databaseBytes: deviceA.db.length });
eq('progress reported', progress.length > 0, true);

// ---- Restoring onto another device ----------------------------------------------------------
function memoryDevice(init: { db: Uint8Array; media: Record<string, string>; books: string[] }) {
  const state = {
    db: init.db,
    prefs: null as string | null,
    media: new Map(Object.entries(init.media).map(([k, v]) => [k, new Blob([v])])),
    books: new Map<string, BackupBook>(init.books.map((id) => [id, { id, file: new Blob(['old']) }])),
    failOnBook: false,
  };
  const target: RestoreTarget = {
    schemaVersion: 2,
    database: async (bytes) => {
      state.db = bytes;
    },
    prefs: (json) => {
      state.prefs = json;
    },
    putMedia: async (files) => {
      for (const f of files) state.media.set(f.name, f.blob);
    },
    pruneMedia: async (keep) => {
      for (const k of [...state.media.keys()]) if (!keep.has(k)) state.media.delete(k);
    },
    putBook: async (b) => {
      if (state.failOnBook) throw new Error('disk full');
      state.books.set(b.id, b);
    },
    pruneBooks: async (keep) => {
      for (const k of [...state.books.keys()]) if (!keep.has(k)) state.books.delete(k);
    },
  };
  return { state, target };
}

const B = memoryDevice({ db: fakeDb('B'), media: { 'old.mp3': 'old', 'word_1.mp3': 'stale' }, books: ['old-book'] });
await restoreBackup(backup, B.target);
eq('database restored', [...B.state.db], [...deviceA.db]);
eq('prefs restored', B.state.prefs, deviceA.prefs);
eq('media names round-trip (odd characters too)', [...B.state.media.keys()].sort(), [...deviceA.media.keys()].sort());
eq('media content restored', await textOf(B.state.media.get('word_1.mp3')), 'mp3-bytes');
eq('media not in the backup removed', B.state.media.has('old.mp3'), false);
eq('books restored', [...B.state.books.keys()].sort(), ['b1', 'b2']);
eq('book file', await textOf(B.state.books.get('b1')!.file), 'epub-bytes');
eq('book cover', await textOf(B.state.books.get('b1')!.cover), 'cover');
eq('book text', B.state.books.get('b2')!.text, book);
eq('book without a cover', B.state.books.get('b2')!.cover, undefined);

// A restore that fails part-way leaves the collection and its media as they were.
const C = memoryDevice({ db: fakeDb('C'), media: { 'keep.mp3': 'mine' }, books: ['mine'] });
C.state.failOnBook = true;
await rejects('failed restore reports the error', restoreBackup(backup, C.target), /disk full/);
eq('failed restore: database untouched', [...C.state.db], [...fakeDb('C')]);
eq('failed restore: existing media kept', C.state.media.has('keep.mp3'), true);
eq('failed restore: existing books kept', C.state.books.has('mine'), true);

// ---- Files that aren't backups --------------------------------------------------------------
await rejects('not a zip', readBackup(new Blob(['hello'])), /isn’t a zip/);
const apkgLike = new ZipWriter(new BlobWriter());
await apkgLike.add('collection.anki21', new TextReader('x'));
await apkgLike.add('media', new TextReader('{}'));
await rejects('an Anki package is pointed to the Decks screen', readBackup(await apkgLike.close()), /Decks screen/);
const future = new ZipWriter(new BlobWriter());
await future.add('collection.sqlite3', new TextReader('SQLite format 3\0'));
await future.add('manifest.json', new TextReader(JSON.stringify({ format: 'gakutaku-backup', version: 99, createdAt: '', counts: {} })));
await rejects('a newer backup version is refused', readBackup(await future.close()), /newer version/);
const corrupt = new ZipWriter(new BlobWriter());
await corrupt.add('collection.sqlite3', new TextReader('not a database'));
await corrupt.add('manifest.json', new TextReader(JSON.stringify({ format: 'gakutaku-backup', version: 1, createdAt: '', counts: {} })));
const D = memoryDevice({ db: fakeDb('D'), media: { 'a.mp3': 'a' }, books: [] });
await rejects('a damaged database is refused', restoreBackup(await corrupt.close(), D.target), /damaged/);
eq('…before anything changed', [D.state.media.size, [...D.state.db]], [1, [...fakeDb('D')]]);

// Databases this app can't open are refused before anything changes.
async function backupWith(db: Uint8Array) {
  const z = new ZipWriter(new BlobWriter());
  await z.add('collection.sqlite3', new Uint8ArrayReader(db));
  await z.add('media/x.mp3', new TextReader('x'));
  await z.add('manifest.json', new TextReader(JSON.stringify({ format: 'gakutaku-backup', version: 1, createdAt: '', counts: {} })));
  return z.close();
}
const E = memoryDevice({ db: fakeDb('E'), media: { 'a.mp3': 'a' }, books: [] });
await rejects('a database without a GakuTaku schema version is refused', restoreBackup(await backupWith(fakeDb('x', 0)), E.target), /isn’t a GakuTaku database/);
await rejects('a database from a newer app version is refused', restoreBackup(await backupWith(fakeDb('x', 3)), E.target), /newer version/);
eq('…before anything changed', [E.state.media.size, [...E.state.db]], [1, [...fakeDb('E')]]);
await restoreBackup(await backupWith(fakeDb('older', 1)), E.target);
eq('an older schema version restores (the app migrates it on open)', [...E.state.db], [...fakeDb('older', 1)]);

eq('file name', backupFileName(new Date(2026, 9, 5)), 'GakuTaku-backup-2026-10-05.zip');

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
