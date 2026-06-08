import { useMemo, useState } from 'react';
import { useQuery } from '../sync/hooks';
import { deckConfig, parseJsonObject } from './fsrs';
import { NOTE_TYPE_NAME, parseNoteFields } from './mining';

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
  const dayParams = useMemo(() => [startOfToday], [startOfToday]);
  const { data: intro } = useQuery<{ deck: string | null; cnt: number }>(
    `SELECT n.deck_id AS deck, COUNT(*) AS cnt
     FROM (SELECT card_id, MIN(review_time) AS first FROM review_logs GROUP BY card_id) f
     JOIN cards c ON c.id = f.card_id
     JOIN notes n ON n.id = c.note_id
     WHERE f.first >= ?
     GROUP BY n.deck_id`,
    dayParams,
  );
  const { data: revToday } = useQuery<{ deck: string | null; cnt: number }>(
    `SELECT n.deck_id AS deck, COUNT(*) AS cnt
     FROM review_logs rl
     JOIN cards c ON c.id = rl.card_id
     JOIN notes n ON n.id = c.note_id
     WHERE rl.review_time >= ?
     GROUP BY n.deck_id`,
    dayParams,
  );
  return useMemo(() => {
    const introByDeck = new Map(intro.map((r) => [r.deck ?? '', r.cnt]));
    const revByDeck = new Map(revToday.map((r) => [r.deck ?? '', r.cnt]));
    let total = 0;
    for (const d of decks) {
      const introduced = introByDeck.get(d.id) ?? 0;
      // Reviews already done today (excluding new-card introductions) eat into the daily review cap.
      const reviewsDone = Math.max(0, (revByDeck.get(d.id) ?? 0) - introduced);
      total += Math.min(d.due, Math.max(0, d.reviewsPerDay - reviewsDone));
      total += Math.min(d.new, Math.max(0, d.newPerDay - introduced));
    }
    return total;
  }, [decks, intro, revToday]);
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
  reviewsPerDay: number;
  learningSteps?: string[];
  relearningSteps?: string[];
  description?: string;
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
      reviewsPerDay: cfg.reviewsPerDay,
      learningSteps: cfg.learningSteps,
      relearningSteps: cfg.relearningSteps,
      description: cfg.description,
      due: r.due,
      new: r.newc,
      total: r.total,
    };
  });
}

export interface CardRow {
  id: string;
  deck: string;
  /** Primary/sort field — Term for vocab, the note type's first field for imported decks. */
  front: string;
  /** Reading (vocab only; empty for imported note types). */
  reading: string;
  /** Secondary text — Meaning for vocab, the remaining fields joined for imported decks. */
  back: string;
  due: string | null;
  reps: number;
  state: number;
  last_review: string | null;
}

interface RawCardRow {
  id: string;
  deck: string | null;
  fields: string;
  nt_name: string | null;
  nt_fields: string | null;
  due: string | null;
  reps: number;
  state: number;
  last_review: string | null;
}

const CARD_SELECT = `SELECT c.id, d.name AS deck, n.fields AS fields, nt.name AS nt_name, nt.fields AS nt_fields,
    c.due, c.reps, c.state, c.last_review
  FROM cards c
  JOIN notes n ON n.id = c.note_id
  LEFT JOIN decks d ON d.id = n.deck_id
  LEFT JOIN note_types nt ON nt.id = n.note_type_id`;

/** Strip HTML tags, media tokens and entities so a note field reads as plain text in the browser table. */
function plainText(s: string): string {
  return s
    .replace(/\[sound:[^\]]*\]/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map a raw row to display fields, handling both the built-in vocab type and imported note types. */
function toCardRow(r: RawCardRow): CardRow {
  const base = { id: r.id, deck: r.deck ?? '—', due: r.due, reps: r.reps, state: r.state, last_review: r.last_review };
  if (!r.nt_name || r.nt_name === NOTE_TYPE_NAME) {
    const f = parseNoteFields(r.fields);
    return { ...base, front: f.Term, reading: f.Reading, back: f.Meaning };
  }
  // Imported note type: show the first field as the term and the rest as the meaning.
  const values = parseJsonObject(r.fields);
  const order = (() => {
    try {
      const v = parseJsonObject(r.nt_fields) as unknown;
      return Array.isArray(v) ? (v as string[]) : Object.keys(values);
    } catch {
      return Object.keys(values);
    }
  })();
  const names = order.length ? order : Object.keys(values);
  const str = (k: string) => plainText(typeof values[k] === 'string' ? (values[k] as string) : '');
  const front = str(names[0] ?? '');
  const back = names.slice(1).map(str).filter(Boolean).join(' · ');
  return { ...base, front, reading: '', back };
}

/** Cards in a single deck (newest first), for the deck detail browser. */
export function useDeckCards(deckId: string): CardRow[] {
  const params = useMemo(() => [deckId], [deckId]);
  const { data } = useQuery<RawCardRow>(
    `${CARD_SELECT} WHERE n.deck_id = ? ORDER BY n.created_at DESC LIMIT 500`,
    params,
  );
  return data.map(toCardRow);
}
