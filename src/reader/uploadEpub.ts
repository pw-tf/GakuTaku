import { db } from '../db';
import { openEpub } from './epub';
import { putBlob } from './bookCache';

/**
 * Add an ePUB to the library: record its metadata in `documents` and keep the file itself in the
 * on-device book store. Returns the new document id.
 */
export async function uploadEpub(file: File, userId: string): Promise<string> {
  const buffer = await file.arrayBuffer();

  // Read title/author from the ePUB metadata.
  let title = file.name.replace(/\.epub$/i, '');
  let creator = '';
  try {
    const book = await openEpub(buffer);
    if (book.title) title = book.title;
    creator = book.creator;
    book.destroy();
  } catch {
    // Fall back to the filename if metadata can't be read.
  }

  const docId = crypto.randomUUID();
  // Store the file first: a library row without its file can't be opened.
  await putBlob(docId, file);
  await db.execute(
    `INSERT INTO documents (id, user_id, title, type, source, storage_path, language, added_at)
     VALUES (?, ?, ?, 'application/epub+zip', 'upload', NULL, 'ja', ?)`,
    [docId, userId, creator ? `${title} — ${creator}` : title, new Date().toISOString()],
  );
  return docId;
}
