import Dexie, { type Table } from 'dexie';
import type { TextBookData } from '../books/textBook';

interface CachedBook {
  id: string;
  blob: Blob;
}

interface CachedText {
  id: string;
  data: TextBookData;
}

interface CachedCover {
  id: string;
  blob: Blob;
}

/**
 * The on-device store of book files (the `documents` table holds their metadata): the original file,
 * the extracted text of TXT/PDF books, and cover images.
 */
class BookCacheDB extends Dexie {
  books!: Table<CachedBook, string>;
  texts!: Table<CachedText, string>;
  covers!: Table<CachedCover, string>;
  constructor() {
    super('gakutaku-books');
    this.version(1).stores({ books: 'id' });
    this.version(2).stores({ books: 'id', texts: 'id', covers: 'id' });
  }
}

const cacheDb = new BookCacheDB();

export async function getBlob(id: string): Promise<Blob | undefined> {
  return (await cacheDb.books.get(id))?.blob;
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  await cacheDb.books.put({ id, blob });
}

export async function getText(id: string): Promise<TextBookData | undefined> {
  return (await cacheDb.texts.get(id))?.data;
}

export async function putText(id: string, data: TextBookData): Promise<void> {
  await cacheDb.texts.put({ id, data });
}

export async function getCover(id: string): Promise<Blob | undefined> {
  return (await cacheDb.covers.get(id))?.blob;
}

export async function putCover(id: string, blob: Blob): Promise<void> {
  await cacheDb.covers.put({ id, blob });
}

/** Remove everything stored for a book. */
export async function deleteBookFiles(id: string): Promise<void> {
  await cacheDb.transaction('rw', cacheDb.books, cacheDb.texts, cacheDb.covers, async () => {
    await cacheDb.books.delete(id);
    await cacheDb.texts.delete(id);
    await cacheDb.covers.delete(id);
  });
}
