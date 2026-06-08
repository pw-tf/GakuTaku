import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type FSRS,
  type FSRSParameters,
  type Grade,
  type Steps,
} from 'ts-fsrs';
import type { CardRecord, DeckRecord, ReviewLogRecord } from '../sync/AppSchema';

export { Rating, State };
export type { Card, Grade };

/**
 * Parse a value from a jsonb-as-text column into an object, tolerating the legacy double-encoding bug
 * (a value that JSON.parses to a *string* is parsed once more). Returns `{}` on failure.
 */
export function parseJsonObject(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    let v: unknown = JSON.parse(text);
    if (typeof v === 'string') v = JSON.parse(v);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The four user-facing grades, in display order (Again..Easy = 1..4). */
export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

const DEFAULT_NEW_PER_DAY = 20;
const DEFAULT_REVIEWS_PER_DAY = 200;

/**
 * FSRS scheduler. Fuzz is disabled so scheduling is a pure function of (params, card, time,
 * rating): replaying the same review_logs on any device yields byte-identical card state, which
 * is what makes the event-sourced convergence in §3.3 of the build plan hold.
 */
const schedulerCache = new Map<string, FSRS>();

/**
 * FSRS scheduler for a deck config. `enable_short_term` is on (required for Anki-style learning
 * steps); per-deck `learningSteps`/`relearningSteps` and optimized `w` are applied when present.
 */
export function scheduler(cfg?: DeckConfig): FSRS {
  const key = JSON.stringify({ w: cfg?.w ?? null, ls: cfg?.learningSteps ?? null, rs: cfg?.relearningSteps ?? null });
  let s = schedulerCache.get(key);
  if (!s) {
    const params: Partial<FSRSParameters> = { enable_fuzz: false, enable_short_term: true };
    if (cfg?.w) params.w = cfg.w;
    if (cfg?.learningSteps?.length) params.learning_steps = cfg.learningSteps as Steps;
    if (cfg?.relearningSteps?.length) params.relearning_steps = cfg.relearningSteps as Steps;
    s = fsrs(generatorParameters(params));
    schedulerCache.set(key, s);
  }
  return s;
}

/**
 * Per-deck settings, stored in the deck's `fsrs_params` jsonb blob (the only flexible column on
 * `decks`). Besides the scheduler inputs (steps, optimized `w`) it also carries daily limits and a
 * free-text `description`; the FSRS scheduler ignores the non-scheduling keys.
 */
export interface DeckConfig {
  newPerDay: number;
  reviewsPerDay: number;
  learningSteps?: string[];
  relearningSteps?: string[];
  w?: number[];
  description?: string;
}

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** Parse a deck's `fsrs_params` jsonb (stored as text client-side) into typed config. */
export function deckConfig(deck: Pick<DeckRecord, 'fsrs_params'>): DeckConfig {
  const parsed = parseJsonObject(deck.fsrs_params) as {
    newPerDay?: unknown;
    reviewsPerDay?: unknown;
    learningSteps?: unknown;
    relearningSteps?: unknown;
    w?: unknown;
    description?: unknown;
  };
  return {
    newPerDay: typeof parsed.newPerDay === 'number' ? parsed.newPerDay : DEFAULT_NEW_PER_DAY,
    reviewsPerDay: typeof parsed.reviewsPerDay === 'number' ? parsed.reviewsPerDay : DEFAULT_REVIEWS_PER_DAY,
    learningSteps: asStringArray(parsed.learningSteps),
    relearningSteps: asStringArray(parsed.relearningSteps),
    w: Array.isArray(parsed.w) && parsed.w.every((x) => typeof x === 'number') ? (parsed.w as number[]) : undefined,
    description: typeof parsed.description === 'string' && parsed.description ? parsed.description : undefined,
  };
}

/** Serialize deck config back to the `fsrs_params` text column (preserving optimized weights/steps). */
export function serializeDeckConfig(cfg: DeckConfig): string {
  const out: Record<string, unknown> = { newPerDay: cfg.newPerDay, reviewsPerDay: cfg.reviewsPerDay };
  if (cfg.learningSteps?.length) out.learningSteps = cfg.learningSteps;
  if (cfg.relearningSteps?.length) out.relearningSteps = cfg.relearningSteps;
  if (cfg.w) out.w = cfg.w;
  if (cfg.description) out.description = cfg.description;
  return JSON.stringify(out);
}

/**
 * Order logs deterministically: by `review_time`, with `id` breaking ties. Replaying in this order
 * makes the event-sourced fold independent of insertion/sync order (§3.3).
 */
function orderLogs(logs: ReviewLogRecord[]): ReviewLogRecord[] {
  return [...logs].sort((a, b) => {
    const t = (a.review_time ?? '').localeCompare(b.review_time ?? '');
    return t !== 0 ? t : (a.id ?? '').localeCompare(b.id ?? '');
  });
}

/**
 * Derive a card's current FSRS state by replaying its append-only logs (§3.3). `createdAt` seeds
 * the empty card; each log advances it via `next()`. Logs are sorted by time (id breaks ties) so
 * the fold is deterministic regardless of insertion/sync order.
 */
export function deriveCard(logs: ReviewLogRecord[], createdAt: string, cfg?: DeckConfig): Card {
  const f = scheduler(cfg);
  let card = createEmptyCard(new Date(createdAt));
  for (const log of orderLogs(logs)) {
    if (log.rating == null || !log.review_time) continue;
    card = f.next(card, new Date(log.review_time), log.rating as Grade).card;
  }
  return card;
}

/** One replayed review, carrying the card's state *before* the rating was applied. */
export interface ReplayStep {
  /** FSRS state immediately before this review (New/Learning/Review/Relearning). */
  prevState: State;
  /** Reps accumulated before this review (0 = first-ever exposure of the card). */
  prevReps: number;
  rating: Grade;
  reviewTime: Date;
  elapsedMs: number;
}

/**
 * Replay a card's logs and emit one {@link ReplayStep} per review, capturing the pre-review state.
 * Raw `review_logs` rows don't store the state at review time; analytics (e.g. true-retention, which
 * counts only reviews of already-graduated cards) needs it, so we recover it by folding through the
 * same deterministic scheduler as {@link deriveCard}.
 */
export function replaySteps(logs: ReviewLogRecord[], createdAt: string, cfg?: DeckConfig): ReplayStep[] {
  const f = scheduler(cfg);
  let card = createEmptyCard(new Date(createdAt));
  const steps: ReplayStep[] = [];
  for (const log of orderLogs(logs)) {
    if (log.rating == null || !log.review_time) continue;
    steps.push({
      prevState: card.state,
      prevReps: card.reps,
      rating: log.rating as Grade,
      reviewTime: new Date(log.review_time),
      elapsedMs: log.elapsed_ms ?? 0,
    });
    card = f.next(card, new Date(log.review_time), log.rating as Grade).card;
  }
  return steps;
}

export interface GradePreview {
  grade: Grade;
  card: Card;
  interval: string;
}

/** Next-state preview for all four grades (powers the interval labels under the rate buttons). */
export function previews(card: Card, now: Date, cfg?: DeckConfig): GradePreview[] {
  const rl = scheduler(cfg).repeat(card, now);
  return GRADES.map((grade) => ({
    grade,
    card: rl[grade].card,
    interval: formatInterval(now, rl[grade].card.due),
  }));
}

/** Human-readable interval between two times: `<1m / 12m / 5h / 3d / 4mo / 1.2y`. */
export function formatInterval(from: Date, to: Date): string {
  const mins = (to.getTime() - from.getTime()) / 60000;
  if (mins < 1) return '<1m';
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30;
  if (months < 12) return `${Math.round(months)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export type CardStateLabel = 'new' | 'learning' | 'young' | 'mature';

/**
 * Map FSRS state → the maturity label used by the `.state-*` pills in the cards table. Works on the
 * minimal stored shape (state/reps ints + due/last_review dates); a Review-state card is "mature"
 * once its current interval reaches 21 days.
 */
export function cardStateLabel(card: { state: number; reps: number; due: Date; last_review?: Date | null }): CardStateLabel {
  if (card.reps === 0 || card.state === State.New) return 'new';
  if (card.state === State.Learning || card.state === State.Relearning) return 'learning';
  const ivlDays = card.last_review ? (card.due.getTime() - card.last_review.getTime()) / 86400000 : 0;
  return ivlDays >= 21 ? 'mature' : 'young';
}

/** Project a ts-fsrs Card onto the `cards` table's stored (cache) columns. */
export function toCardRow(card: Card): Pick<CardRecord, 'due' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'state' | 'last_review'> {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}
