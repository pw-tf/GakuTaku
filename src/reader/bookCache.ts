import Dexie, { type Table } from 'dexie';

interface CachedBook {
  id: string;
  blob: Blob;
}

/** Local cache of ePUB binaries for offline reading (not synced; mirrors Supabase Storage). */
class BookCacheDB extends Dexie {
  books!: Table<CachedBook, string>;
  constructor() {
    super('gakutaku-books');
    this.version(1).stores({ books: 'id' });
  }
}

const cacheDb = new BookCacheDB();

export async function getBlob(id: string): Promise<Blob | undefined> {
  return (await cacheDb.books.get(id))?.blob;
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  await cacheDb.books.put({ id, blob });
}
