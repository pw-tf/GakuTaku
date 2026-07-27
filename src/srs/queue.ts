import type { ResolvedDeckConfig } from './presets';

/**
 * Single source of truth for "what's studiable today" — the daily-limit math, the study-day
 * boundary, and the shared SQL used by both the review session builder (`buildCandidates` in
 * {@link useReview}) and the reactive deck counts ({@link useDeckStats}/{@link useStudyCount} in
 * `srsHooks`). Keeping the capping in one place guarantees the deck list, the badge, and the actual
 * session always agree — which they previously didn't (the grid showed raw counts, the badge showed
 * capped ones). The SQL constants became builders returning `{sql, params}` when the active-card
 * predicate made bind order non-trivial: consumers share the params too, so they cannot disagree.
 *
 * Daily-limit semantics follow Anki's v3 scheduler:
 *  - The review limit is consumed per *card* per day (three learning steps of one card eat one
 *    slot), by interday learning cards first, then due reviews.
 *  - New cards also consume the review limit: with 200 reviews allowed and 195 used, at most 5 new
 *    cards are introduced (unless "new cards ignore review limit" is set on the preset).
 *  - Intraday learning is never capped — a card in a same-day (re)learning step must return.
 */

/** Anki-style day rollover hour (default 4am): reviews before this count toward the previous day. */
export const DEFAULT_DAY_CUTOFF_HOUR = 4;

/** Anki's "learn ahead limit" default (Preferences → Scheduling), in minutes. */
export const DEFAULT_LEARN_AHEAD_MINUTES = 20;

/** Start of the current study day in local time, honouring the configurable rollover hour. */
export function studyDayStart(now: Date, cutoffHour: number): Date {
  const d = new Date(now);
  d.setHours(cutoffHour, 0, 0, 0);
  if (now.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * End of the current study day (= the next rollover). Like Anki, scheduling is day-granular: a card
 * due *any time* before the next rollover counts as due today and is studiable now, instead of
 * trickling in at its exact timestamp through the day.
 */
export function studyDayEnd(now: Date, cutoffHour: number): Date {
  const d = studyDayStart(now, cutoffHour);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Today's per-deck activity that eats into the daily limits. */
export interface DeckToday {
  /** Cards whose first-ever answer was today (count against the new-card limit). */
  introduced: number;
  /** DISTINCT cards answered today (v3: limits are per card per day, not per answer). */
  reviewed: number;
}

/** Raw (uncapped) per-deck queue sizes straight from the `cards` cache, active cards only. */
export interface DeckRaw {
  /** reps = 0. */
  newCount: number;
  /** (Re)learning cards due before the rollover whose last answer was today — never capped. */
  learnIntraday: number;
  /** (Re)learning cards due before the rollover last answered on an earlier day — consume the review limit. */
  learnInterday: number;
  /** state = Review and due before the next day rollover (Anki-style day granularity). */
  reviewCount: number;
}

/** What a deck can still serve today after limits. */
export interface DeckQueue {
  new: number;
  /** Intraday learning (uncapped) + the review-limit-capped interday learning. */
  learning: number;
  due: number;
}

/** The subset of config the limit math needs. */
export type LimitsConfig = Pick<ResolvedDeckConfig, 'newPerDay' | 'reviewsPerDay' | 'newIgnoreReviewLimit'>;

/** How many cards of each kind a deck may still serve today (v3 limit interactions applied). */
export interface DeckBudget {
  interday: number;
  due: number;
  new: number;
}

/**
 * Anki v3 budget: interday learning consumes the review limit first, then due reviews; whatever
 * review headroom remains (if any) caps new-card intake unless the preset opts out.
 */
export function deckBudget(cfg: LimitsConfig, raw: DeckRaw, today: DeckToday): DeckBudget {
  const reviewLeft = Math.max(0, cfg.reviewsPerDay - today.reviewed);
  const interday = Math.min(raw.learnInterday, reviewLeft);
  const due = Math.min(raw.reviewCount, reviewLeft - interday);
  const newHeadroom = cfg.newIgnoreReviewLimit ? Number.POSITIVE_INFINITY : reviewLeft - interday - due;
  const newLeft = Math.max(0, Math.min(cfg.newPerDay - today.introduced, newHeadroom));
  return { interday, due, new: Math.min(raw.newCount, newLeft) };
}

/** Apply the daily caps to a deck's raw queue sizes. */
export function capDeckQueue(cfg: LimitsConfig, raw: DeckRaw, today: DeckToday): DeckQueue {
  const b = deckBudget(cfg, raw, today);
  return { new: b.new, learning: raw.learnIntraday + b.interday, due: b.due };
}

/**
 * v3: the limits of the deck you *study* also cap its whole subtree. Applied on top of the
 * per-deck-capped sums, with the tree's combined today-activity. Learning is left uncapped here
 * (the intraday/interday split is lost after summing; letting lapsed cards return wins — documented
 * simplification of v3, which re-splits at gather).
 */
export function capTreeQueue(cfg: LimitsConfig, summed: DeckQueue, treeToday: DeckToday): DeckQueue {
  const reviewLeft = Math.max(0, cfg.reviewsPerDay - treeToday.reviewed);
  const due = Math.min(summed.due, reviewLeft);
  const newHeadroom = cfg.newIgnoreReviewLimit ? Number.POSITIVE_INFINITY : reviewLeft - due;
  const newLeft = Math.max(0, Math.min(cfg.newPerDay - treeToday.introduced, newHeadroom));
  return { new: Math.min(summed.new, newLeft), learning: summed.learning, due };
}

// --- Shared SQL (index-backed) -------------------------------------------------------------------

export interface SqlQuery {
  sql: string;
  params: string[];
}

/**
 * Predicate for cards that participate in study queues and counts, on alias `c`. One bind: the
 * study-day start. Suspended (queue -1) cards are always out. Buried cards (queue -2/-3) are out
 * only until their `buried_until` passes — every bury writes a study-day-end timestamp, so
 * comparing against *today's day start* is exact: yesterday's burials have expired, today's have
 * not. Making burial expire by comparison (instead of only by a sweep) keeps counts correct across
 * devices even before {@link sweepExpiredBuried} converges the rows back to queue 0. A buried row
 * with no `buried_until` (shouldn't happen) counts as expired so it can never be stranded.
 */
export const ACTIVE_SQL = `(COALESCE(c.queue, 0) = 0 OR (COALESCE(c.queue, 0) <= -2 AND (c.buried_until IS NULL OR c.buried_until <= ?)))`;

/**
 * Per-deck raw counts from the `cards` cache. Splits learning into intraday (last answered today —
 * uncapped) vs interday (crossed a day boundary — consumes the review limit like Anki v3), and
 * reports suspended/buried tallies for the deck screen's affordances.
 */
export function rawDeckCountsQuery(dayStart: string, dayEnd: string): SqlQuery {
  const params: string[] = [];
  const p = (v: string) => {
    params.push(v);
    return '?';
  };
  const active = () => {
    params.push(dayStart);
    return ACTIVE_SQL;
  };
  const sql = `SELECT d.id AS deck, d.name AS name, d.fsrs_params AS fsrs_params, d.preset_id AS preset_id, d.created_at AS created_at,
    COUNT(c.id) AS total,
    COALESCE(SUM(CASE WHEN ${active()} AND c.reps = 0 THEN 1 ELSE 0 END), 0) AS newc,
    COALESCE(SUM(CASE WHEN ${active()} AND c.reps > 0 AND c.due <= ${p(dayEnd)} AND c.state IN (1, 3) AND c.last_review >= ${p(dayStart)} THEN 1 ELSE 0 END), 0) AS learn_intraday,
    COALESCE(SUM(CASE WHEN ${active()} AND c.reps > 0 AND c.due <= ${p(dayEnd)} AND c.state IN (1, 3) AND (c.last_review < ${p(dayStart)} OR c.last_review IS NULL) THEN 1 ELSE 0 END), 0) AS learn_interday,
    COALESCE(SUM(CASE WHEN ${active()} AND c.reps > 0 AND c.due <= ${p(dayEnd)} AND c.state = 2 THEN 1 ELSE 0 END), 0) AS reviewc,
    COALESCE(SUM(CASE WHEN COALESCE(c.queue, 0) = -1 THEN 1 ELSE 0 END), 0) AS suspendedc,
    COALESCE(SUM(CASE WHEN COALESCE(c.queue, 0) <= -2 AND c.buried_until IS NOT NULL AND c.buried_until > ${p(dayStart)} THEN 1 ELSE 0 END), 0) AS buriedc
  FROM decks d
  LEFT JOIN notes n ON n.deck_id = d.id
  LEFT JOIN cards c ON c.note_id = n.id
  GROUP BY d.id
  ORDER BY d.created_at DESC`;
  return { sql, params };
}

/**
 * Cards introduced today (first-ever *answer* since the study-day start), per deck. Scans only
 * today's logs (the `by_time` index) and uses an indexed `NOT EXISTS` to confirm no earlier review —
 * far cheaper than computing `MIN(review_time)` across the whole history on every change. Manual
 * (rating 0) events are not answers and don't introduce a card.
 */
export function introducedTodayQuery(dayStart: string): SqlQuery {
  return {
    sql: `SELECT n.deck_id AS deck, COUNT(DISTINCT rl.card_id) AS cnt
  FROM review_logs rl
  JOIN cards c ON c.id = rl.card_id
  JOIN notes n ON n.id = c.note_id
  WHERE rl.review_time >= ? AND rl.rating >= 1
    AND NOT EXISTS (SELECT 1 FROM review_logs r2 WHERE r2.card_id = rl.card_id AND r2.review_time < ? AND r2.rating >= 1)
  GROUP BY n.deck_id`,
    params: [dayStart, dayStart],
  };
}

/** DISTINCT cards answered since the study-day start, per deck (v3 counts a card once per day). */
export function reviewedTodayQuery(dayStart: string): SqlQuery {
  return {
    sql: `SELECT n.deck_id AS deck, COUNT(DISTINCT rl.card_id) AS cnt
  FROM review_logs rl JOIN cards c ON c.id = rl.card_id JOIN notes n ON n.id = c.note_id
  WHERE rl.review_time >= ? AND rl.rating >= 1
  GROUP BY n.deck_id`,
    params: [dayStart],
  };
}
