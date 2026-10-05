import { useQuery } from './useQuery';
import type { DeckRecord, DocumentRecord } from './schema';

export { useQuery };

/** Live list of decks, newest first. */
export function useDecks() {
  return useQuery<DeckRecord>('SELECT * FROM decks ORDER BY created_at DESC');
}

/** Live list of documents (books) in the library, newest first. */
export function useDocuments() {
  return useQuery<DocumentRecord>('SELECT * FROM documents ORDER BY added_at DESC');
}

export interface PositionRow {
  document_id: string;
  percent: number | null;
  updated_at: string | null;
  locator: string | null;
}

/** Live reading positions (one row per document). */
export function useReadingPositions() {
  return useQuery<PositionRow>('SELECT document_id, percent, updated_at, locator FROM reading_positions');
}
