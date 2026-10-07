import { db } from '../db';
import { useLive } from '../db/useLive';

export interface Bookmark {
  id: string;
  chapter: number;
  paragraph: number;
  kind: 'bookmark' | 'highlight';
  text: string;
}

/** A book's bookmarks and highlights, in reading order (live). */
export function useBookmarks(documentId: string | null | undefined): Bookmark[] {
  const { data } = useLive(
    async () =>
      documentId
        ? db.getAll<Bookmark>('SELECT id, chapter, paragraph, kind, text FROM bookmarks WHERE document_id = ? ORDER BY chapter, paragraph, created_at', [documentId])
        : [],
    [documentId],
    ['bookmarks'],
  );
  return data ?? [];
}

export async function addBookmark(documentId: string, b: Omit<Bookmark, 'id'>): Promise<void> {
  await db.execute('INSERT INTO bookmarks (id, document_id, chapter, paragraph, kind, text, created_at) VALUES (uuid(), ?, ?, ?, ?, ?, ?)', [
    documentId, b.chapter, b.paragraph, b.kind, b.text, new Date().toISOString(),
  ]);
}

export async function removeBookmark(id: string): Promise<void> {
  await db.execute('DELETE FROM bookmarks WHERE id = ?', [id]);
}
