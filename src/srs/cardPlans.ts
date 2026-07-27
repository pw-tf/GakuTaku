import { State } from './fsrs';
import type { ResolvedDeckConfig } from './presets';

/**
 * Pure decision logic for card operations (Anki parity): which siblings to bury after an answer,
 * when the leech action fires, flag metadata, and the "set due date" spec parser. DB-free so
 * `scripts/verify-srs.ts` can table-test it; the SQL-executing counterparts live in `cardOps.ts`.
 */

// --- Anki queue values (mirrored in the cards.queue column and .apkg import) ---------------------

export const QUEUE_ACTIVE = 0;
export const QUEUE_SUSPENDED = -1;
export const QUEUE_SCHED_BURIED = -2;
export const QUEUE_USER_BURIED = -3;

// --- Flags (Anki's seven colored flags; 0 = none) ------------------------------------------------

export const FLAG_NAMES = ['No flag', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'] as const;
export const FLAG_COLORS = ['', '#e5535a', '#eb8a30', '#4fa965', '#4a90d9', '#e07ba8', '#3ec2c2', '#9d78d2'] as const;

// --- Leeches -------------------------------------------------------------------------------------

export const hasLeechTag = (tags: string): boolean => /(^|\s)leech(\s|$)/i.test(tags);

export interface LeechPlan {
  tag: boolean;
  suspend: boolean;
}

/**
 * Anki's leech rule: act when lapses reach the threshold, then again every half-threshold
 * (8, 12, 16 … at the default 8). The action comes from the preset: 'suspend' (Anki's default)
 * also suspends the card; 'tagOnly' just tags the note.
 */
export function leechPlan(
  prevLapses: number,
  nextLapses: number,
  cfg: Pick<ResolvedDeckConfig, 'leechThreshold' | 'leechAction'>,
  tags: string,
): LeechPlan {
  const none = { tag: false, suspend: false };
  if (nextLapses <= prevLapses) return none;
  const threshold = Math.max(1, cfg.leechThreshold);
  const every = Math.max(1, Math.floor(threshold / 2));
  if (nextLapses < threshold || (nextLapses - threshold) % every !== 0) return none;
  return { tag: !hasLeechTag(tags), suspend: cfg.leechAction === 'suspend' };
}

// --- Sibling burying -----------------------------------------------------------------------------

/** The light sibling row the bury decision needs. */
export interface SiblingRow {
  id: string;
  state: number;
  reps: number;
  dueMs: number | null;
  queue: number;
  lastReviewMs: number | null;
}

/**
 * Which siblings (other cards of the answered card's note) to bury for the rest of the day, per
 * the preset's bury options. Buckets follow Anki: new siblings; review siblings in today's queue;
 * interday-learning siblings in today's queue. Intraday learning siblings are never buried (same
 * as Anki — a card mid-step today must return). Already suspended/buried siblings are skipped.
 *
 * Deliberate deviation from v3, documented in useReview: Anki v3 buries siblings at *gather* time
 * inside its queue builder; here burying happens at *answer* time (v2/AnkiDroid-legacy semantics)
 * because the reactive SQL deck counts cannot run a gather — this keeps the repo's
 * counts-never-disagree invariant while still never showing two siblings on the same day.
 */
export function siblingBuryPlan(
  siblings: SiblingRow[],
  cfg: Pick<ResolvedDeckConfig, 'buryNewSiblings' | 'buryReviewSiblings' | 'buryInterdayLearningSiblings'>,
  dayStartMs: number,
  dayEndMs: number,
): string[] {
  const out: string[] = [];
  for (const s of siblings) {
    if (s.queue !== QUEUE_ACTIVE) continue;
    const isNew = s.reps === 0 || s.state === State.New;
    const isLearning = !isNew && (s.state === State.Learning || s.state === State.Relearning);
    const dueToday = s.dueMs != null && s.dueMs < dayEndMs;
    if (isNew) {
      if (cfg.buryNewSiblings) out.push(s.id);
    } else if (isLearning) {
      const interday = s.lastReviewMs == null || s.lastReviewMs < dayStartMs;
      if (interday && dueToday && cfg.buryInterdayLearningSiblings) out.push(s.id);
    } else if (s.state === State.Review && dueToday && cfg.buryReviewSiblings) {
      out.push(s.id);
    }
  }
  return out;
}

// --- Set due date --------------------------------------------------------------------------------

export interface DueDateSpec {
  min: number;
  max: number;
}

/** Anki's "set due date" syntax: `"5"` = 5 days from today, `"3-7"` = random per card in 3..7. */
export function parseDueDateSpec(spec: string): DueDateSpec | null {
  const m = spec.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const max = m[2] != null ? parseInt(m[2], 10) : min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
  return { min, max };
}
