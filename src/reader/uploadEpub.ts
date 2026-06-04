import { supabase } from '../sync/supabase';
import { db } from '../sync/system';
import { openEpub } from './epub';
import { putBlob } from './bookCache';

const BUCKET = 'documents';

/**
 * Upload an ePUB: store the binary in Supabase Storage (private, per-user path), record metadata in
 * the synced `documents` table, and cache the blob locally for immediate offline reading.
 * Returns the new document id.
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
  const path = `${userId}/${docId}.epub`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: 'application/epub+zip', upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);

  await db.execute(
    `INSERT INTO documents (id, user_id, title, type, source, storage_path, language, added_at)
     VALUES (?, ?, ?, 'application/epub+zip', 'upload', ?, 'ja', ?)`,
    [docId, userId, creator ? `${title} — ${creator}` : title, path, new Date().toISOString()],
  );

  await putBlob(docId, file);
  return docId;
}
