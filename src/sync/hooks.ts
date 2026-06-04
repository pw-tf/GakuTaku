import { useQuery, usePowerSync, useStatus } from '@powersync/react';
import type { DeckRecord, DocumentRecord } from './AppSchema';

export { useQuery, usePowerSync, useStatus };

/** Watched list of the current user's decks (RLS + sync rules scope to user_id). */
export function useDecks() {
  return useQuery<DeckRecord>('SELECT * FROM decks ORDER BY created_at DESC');
}

/** Watched list of uploaded documents (ePUBs). */
export function useDocuments() {
  return useQuery<DocumentRecord>('SELECT * FROM documents ORDER BY added_at DESC');
}

export interface PositionRow {
  document_id: string;
  percent: number | null;
  updated_at: string | null;
  locator: string | null;
}

/** Watched reading positions (one row per document). */
export function useReadingPositions() {
  return useQuery<PositionRow>('SELECT document_id, percent, updated_at, locator FROM reading_positions');
}
