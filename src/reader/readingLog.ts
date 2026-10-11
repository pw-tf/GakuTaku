import { db } from '../db';

export interface ReadEntry {
  /** Book id, or the article's link. */
  docKey: string;
  chapter: number;
  kind: 'chapter' | 'article';
  title: string;
  /** Japanese characters in the chapter. */
  chars: number;
  /** Active reading time. */
  ms: number;
}

/** Record a finished chapter or article (once: re-reading it later doesn't count again). */
export async function logRead(e: ReadEntry): Promise<void> {
  await db.execute('INSERT OR IGNORE INTO reading_log (doc_key, chapter, kind, title, chars, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    e.docKey, e.chapter, e.kind, e.title, e.chars, Math.round(e.ms), Date.now(),
  ]);
}
