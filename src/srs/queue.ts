import { type DeckConfig } from './fsrs';

/**
 * Single source of truth for "what's studiable today" — the daily-limit math and study-day boundary
 * shared by the review session builder (`buildCandidates` in {@link useReview}), the reactive deck
 * counts ({@link useDeckStats}/{@link useStudyCount} in `srsHooks`), and the nav badge. Keeping the
 * capping in one place guarantees the deck list, the badge, and the actual session always agree —
 * which they previously didn't (the grid showed raw counts, the badge showed capped ones).
 */

/** Anki-style day rollover hour (default 4am): reviews before this count toward the previous day. */
export const DEFAULT_DAY_CUTOFF_HOUR = 4;

/** Start of the current study day in local time, honouring the configurable rollover hour. */
export function studyDayStart(now: Date, cutoffHour: number): Date {
  const d = new Date(now);
  d.setHours(cutoffHour, 0, 0, 0);
  if (now.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  return d;
}

/** Today's per-deck activity that eats into the daily limits. */
export interface DeckToday {
  /** Cards whose first-ever review was today (count against the new-card limit). */
  introduced: number;
  /** Total reviews logged today (new introductions + actual reviews + relearns). */
  reviewed: number;
}

/** Raw (uncapped) per-deck queue sizes straight from the `cards` cache. */
export interface DeckRaw {
  /** reps = 0. */
  newCount: number;
  /** state ∈ {Learning, Relearning} and due ≤ now. */
  learningCount: number;
  /** state = Review and due ≤ now. */
  reviewCount: number;
}

/** What a deck can still serve today after limits. `learning` is never capped (a lapsed card must return). */
export interface DeckQueue {
  new: number;
  learning: number;
  due: number;
}

/** Remaining daily allowances for a deck given today's activity. */
export function deckAllowances(cfg: DeckConfig, today: DeckToday): { newLeft: number; reviewLeft: number } {
  const reviewsDone = Math.max(0, today.reviewed - today.introduced);
  return {
    newLeft: Math.max(0, cfg.newPerDay - today.introduced),
    reviewLeft: Math.max(0, cfg.reviewsPerDay - reviewsDone),
  };
}

/** Apply the daily caps to a deck's raw queue sizes. */
export function capDeckQueue(cfg: DeckConfig, raw: DeckRaw, today: DeckToday): DeckQueue {
  const { newLeft, reviewLeft } = deckAllowances(cfg, today);
  return {
    new: Math.min(raw.newCount, newLeft),
    learning: raw.learningCount,
    due: Math.min(raw.reviewCount, reviewLeft),
  };
}

// --- Shared SQL (index-backed) -------------------------------------------------------------------

/**
 * Per-deck raw counts from the `cards` cache. Splits the old lumped "due" into Learning (state 1/3)
 * vs Review (state 2) so the UI can show Anki's three numbers. Bind `[nowISO, nowISO, nowISO]`.
 */
export const RAW_DECK_COUNTS_SQL = `SELECT d.id AS deck, d.name AS name, d.fsrs_params AS fsrs_params, d.created_at AS created_at,
    COUNT(c.id) AS total,
    COALESCE(SUM(CASE WHEN c.reps = 0 THEN 1 ELSE 0 END), 0) AS newc,
    COALESCE(SUM(CASE WHEN c.reps > 0 AND c.due <= ? AND c.state IN (1, 3) THEN 1 ELSE 0 END), 0) AS learnc,
    COALESCE(SUM(CASE WHEN c.reps > 0 AND c.due <= ? AND c.state = 2 THEN 1 ELSE 0 END), 0) AS reviewc
  FROM decks d
  LEFT JOIN notes n ON n.deck_id = d.id
  LEFT JOIN cards c ON c.note_id = n.id
  GROUP BY d.id
  ORDER BY d.created_at DESC`;

/** Cards first-reviewed since the study-day start, per deck (new introductions today). Bind `[dayStartISO]`. */
export const INTRODUCED_TODAY_SQL = `SELECT n.deck_id AS deck, COUNT(*) AS cnt
  FROM (SELECT card_id, MIN(review_time) AS first FROM review_logs GROUP BY card_id) f
  JOIN cards c ON c.id = f.card_id
  JOIN notes n ON n.id = c.note_id
  WHERE f.first >= ?
  GROUP BY n.deck_id`;

/** All reviews logged since the study-day start, per deck. Bind `[dayStartISO]`. */
export const REVIEWED_TODAY_SQL = `SELECT n.deck_id AS deck, COUNT(*) AS cnt
  FROM review_logs rl JOIN cards c ON c.id = rl.card_id JOIN notes n ON n.id = c.note_id
  WHERE rl.review_time >= ?
  GROUP BY n.deck_id`;
