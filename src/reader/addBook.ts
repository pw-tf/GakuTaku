import { db } from '../db';
import { decodeText, parseTxt, type TextBookData } from '../books/textBook';
import { openEpub } from './epub';
import { deleteBookFiles, putBlob, putCover, putText } from './bookCache';

export type BookKind = 'epub' | 'pdf' | 'txt';

const MIME: Record<BookKind, string> = { epub: 'application/epub+zip', pdf: 'application/pdf', txt: 'text/plain' };

export function bookKindOf(name: string): BookKind | null {
  const m = /\.(epub|pdf|txt)$/i.exec(name);
  return m ? (m[1].toLowerCase() as BookKind) : null;
}

/** The kind of a library document from its stored MIME type (older rows are all ePUB). */
export function docKind(type: string | null): BookKind {
  if (type === MIME.pdf) return 'pdf';
  if (type === MIME.txt) return 'txt';
  return 'epub';
}

/**
 * Add a book to the library: keep the file in the on-device book store, extract the text of TXT and
 * PDF books (once, here, so opening them later is instant), save an ePUB's cover, and record the
 * book in `documents`. Returns the new document id.
 */
export async function addBook(file: File, userId: string, onProgress?: (message: string, done?: number, total?: number) => void, knownKind?: BookKind | 'apkg' | 'colpkg' | null): Promise<string> {
  // The kind may come from the file's content when its name has no extension (some Android pickers).
  const kind = knownKind === 'epub' || knownKind === 'pdf' || knownKind === 'txt' ? knownKind : bookKindOf(file.name);
  if (!kind) throw new Error('Pick an ePUB, PDF or TXT file.');
  const buffer = await file.arrayBuffer();
  const baseName = file.name.replace(/\.(epub|pdf|txt)$/i, '');
  const docId = crypto.randomUUID();

  let title = baseName;
  let creator = '';
  let text: TextBookData | null = null;
  let cover: Blob | null = null;

  if (kind === 'epub') {
    try {
      const book = await openEpub(buffer);
      if (book.title && book.title !== 'Untitled') title = book.title;
      creator = book.creator;
      cover = await book.cover();
      book.destroy();
    } catch {
      // Fall back to the filename if metadata can't be read.
    }
  } else if (kind === 'txt') {
    text = parseTxt(decodeText(new Uint8Array(buffer)), baseName);
  } else {
    onProgress?.('Reading the PDF…');
    const { pdfToBook } = await import('../books/pdf');
    text = await pdfToBook(buffer, baseName, (done, total) => onProgress?.('Extracting text…', done, total));
  }
  if (text) {
    title = text.title || baseName;
    creator = text.creator;
    if (!text.chapters.some((c) => c.paragraphs.length)) throw new Error('No readable text found in this file.');
  }

  try {
    // Store the files first: a library row without its file can't be opened.
    await putBlob(docId, file);
    if (text) await putText(docId, text);
    if (cover) await putCover(docId, cover);
    await db.execute(
      `INSERT INTO documents (id, user_id, title, type, source, storage_path, language, added_at)
       VALUES (?, ?, ?, ?, 'upload', NULL, 'ja', ?)`,
      [docId, userId, creator ? `${title} — ${creator}` : title, MIME[kind], new Date().toISOString()],
    );
  } catch (e) {
    await deleteBookFiles(docId).catch(() => undefined);
    throw e;
  }
  return docId;
}

/** Remove a book, its reading position, bookmarks and stored files. Mined cards are kept. */
export async function removeBook(docId: string): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM reading_positions WHERE document_id = ?', [docId]);
    await tx.execute('DELETE FROM bookmarks WHERE document_id = ?', [docId]);
    await tx.execute('DELETE FROM documents WHERE id = ?', [docId]);
  });
  await deleteBookFiles(docId);
}
