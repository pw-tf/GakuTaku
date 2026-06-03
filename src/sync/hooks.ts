import { useQuery, usePowerSync, useStatus } from '@powersync/react';
import type { DeckRecord } from './AppSchema';

export { useQuery, usePowerSync, useStatus };

/** Watched list of the current user's decks (RLS + sync rules scope to user_id). */
export function useDecks() {
  return useQuery<DeckRecord>('SELECT * FROM decks ORDER BY created_at DESC');
}
