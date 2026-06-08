import { useMemo, useState } from 'react';
import { useQuery } from '../sync/hooks';
import { deckConfig } from './fsrs';
import { parseNoteFields, type NoteFields } from './mining';

/**
 * Reactive SRS queries over the synced `cards` cache (thin wrappers around PowerSync's `useQuery`,
 * like `src/sync/hooks.ts`). The FSRS columns on `cards` are a replay cache (§3.3); these read them
 * for fast counts/listing without re-deriving from logs.
 */

/** A now-threshold captured once per component mount (avoids re-subscribing the query each render). */
function useStableNow(): string {
  const [now] = useState(() => new Date().toISOString());
  return now;
}

/** Start of today (local), captured once per mount — the boundary for "new cards introduced today". */
function useStartOfToday(): string {
  const [t] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  });
  return t;
}

/**
 * Cards actually studiable right now — the number a review session would queue (mirrors
 * `buildCandidates` in {@link useReview}): every due review plus new cards capped per deck by its
 * remaining daily new-card allowance. This is what the Review badge / "Today" count should show;
 * a raw count of all new cards (see {@link useDueCount}) overstates it for freshly imported decks.
 */
export function useStudyCount(): number {
  const decks = useDeckStats();
  const startOfToday = useStartOfToday();
  const introParams = useMemo(() => [startOfToday], [startOfToday]);
  const { data: intro } = useQuery<{ deck: string | null; cnt: number }>(
    `SELECT n.deck_id AS deck, COUNT(*) AS cnt
     FROM (SELECT card_id, MIN(review_time) AS first FROM review_logs GROUP BY card_id) f
     JOIN cards c ON c.id = f.card_id
     JOIN notes n ON n.id = c.note_id
     WHERE f.first >= ?
     GROUP BY n.deck_id`,
    introParams,
  );
  return useMemo(() => {
    const introByDeck = new Map(intro.map((r) => [r.deck ?? '', r.cnt]));
    let total = 0;
    for (const d of decks) {
      total += d.due;
      const allowance = Math.max(0, d.newPerDay - (introByDeck.get(d.id) ?? 0));
      total += Math.min(d.new, allowance);
    }
    return total;
  }, [decks, intro]);
}

export interface DueCount {
  due: number;
  newAvailable: number;
  total: number;
}

/** Cards available to study now: due reviews (reps>0, due≤now) plus untouched new cards. */
export function useDueCount(): DueCount {
  const now = useStableNow();
  const params = useMemo(() => [now], [now]);
  const { data } = useQuery<{ due: number | null; newc: number | null }>(
    `SELECT
       SUM(CASE WHEN reps > 0 AND due <= ? THEN 1 ELSE 0 END) AS due,
       SUM(CASE WHEN reps = 0 THEN 1 ELSE 0 END) AS newc
     FROM cards`,
    params,
  );
  const due = data[0]?.due ?? 0;
  const newAvailable = data[0]?.newc ?? 0;
  return { due, newAvailable, total: due + newAvailable };
}

export interface DeckStat {
  id: string;
  name: string;
  newPerDay: number;
  learningSteps?: string[];
  relearningSteps?: string[];
  due: number;
  new: number;
  total: number;
}

/** Per-deck counts (due / new / total) plus the deck's configured new-cards-per-day. */
export function useDeckStats(): DeckStat[] {
  const now = useStableNow();
  const params = useMemo(() => [now], [now]);
  const { data } = useQuery<{
    id: string;
    name: string | null;
    fsrs_params: string | null;
    total: number;
    newc: number;
    due: number;
  }>(
    `SELECT d.id, d.name, d.fsrs_params,
       COUNT(c.id) AS total,
       COALESCE(SUM(CASE WHEN c.reps = 0 THEN 1 ELSE 0 END), 0) AS newc,
       COALESCE(SUM(CASE WHEN c.reps > 0 AND c.due <= ? THEN 1 ELSE 0 END), 0) AS due
     FROM decks d
     LEFT JOIN notes n ON n.deck_id = d.id
     LEFT JOIN cards c ON c.note_id = n.id
     GROUP BY d.id
     ORDER BY d.created_at DESC`,
    params,
  );
  return data.map((r) => {
    const cfg = deckConfig({ fsrs_params: r.fsrs_params });
    return {
      id: r.id,
      name: r.name ?? 'Untitled',
      newPerDay: cfg.newPerDay,
      learningSteps: cfg.learningSteps,
      relearningSteps: cfg.relearningSteps,
      due: r.due,
      new: r.newc,
      total: r.total,
    };
  });
}

export interface CardRow {
  id: string;
  deck: string;
  fields: NoteFields;
  due: string | null;
  reps: number;
  state: number;
  last_review: string | null;
}

/** All cards (newest first) joined to their note fields + deck name, for the cards browser table. */
export function useAllCards(): CardRow[] {
  const { data } = useQuery<{
    id: string;
    deck: string | null;
    fields: string;
    due: string | null;
    reps: number;
    state: number;
    last_review: string | null;
  }>(
    `SELECT c.id, d.name AS deck, n.fields AS fields, c.due, c.reps, c.state, c.last_review
     FROM cards c
     JOIN notes n ON n.id = c.note_id
     LEFT JOIN decks d ON d.id = n.deck_id
     ORDER BY n.created_at DESC
     LIMIT 300`,
  );
  return data.map((r) => ({
    id: r.id,
    deck: r.deck ?? '—',
    fields: parseNoteFields(r.fields),
    due: r.due,
    reps: r.reps,
    state: r.state,
    last_review: r.last_review,
  }));
}
