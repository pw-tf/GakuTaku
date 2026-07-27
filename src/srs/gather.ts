import { State } from './fsrs';
import type { ResolvedDeckConfig } from './presets';
import type { DeckBudget } from './queue';

/**
 * Gather / sort / mix for the review session, matching Anki v3's "Display Order" deck options.
 * Pure and DB-free — lightweight rows in, ordered ids out — so `scripts/verify-srs.ts` can assert
 * exact sequences with a seeded RNG. The session builder (useReview) feeds it active candidate rows
 * plus per-deck budgets from queue.ts; limit consumption happens *during* the new-card gather, like
 * v3, so the gather order decides which cards make the daily cap.
 *
 * v3 semantics matched:
 *  - The *selected* deck's preset drives ordering/mixing; subdeck presets contribute limits only.
 *  - Interday learning and new cards are merged into the review stream per their mix options;
 *    intraday learning is excluded from mixing entirely — those cards return at their exact step
 *    timestamps during the session (the `timed` output).
 */

export interface GatherRow {
  id: string;
  noteId: string;
  deckId: string;
  state: number;
  reps: number;
  /** Due timestamp (ms). */
  dueMs: number;
  /** Anki new-card ordinal; null = legacy card (falls back to created order). */
  position: number | null;
  createdMs: number;
  templateIndex: number;
  stability: number | null;
  lastReviewMs: number | null;
  difficulty: number | null;
}

export interface GatherInput {
  /** Active new cards (reps = 0), any order. */
  newRows: GatherRow[];
  /** Active cards with reps > 0 due before the day rollover (review + learning states). */
  dueRows: GatherRow[];
  /** Per-deck budgets (already v3-interacted via queue.deckBudget). Consumed during gather. */
  budgets: Map<string, DeckBudget>;
  /** The selected deck's own budget applied to the whole gather (v3 tree cap); null = no tree cap. */
  treeBudget: DeckBudget | null;
  /** The selected deck's resolved config — ordering, sorting, and mixing come from here. */
  cfg: ResolvedDeckConfig;
  /** Deck ids in tree order, for the 'deck' gather priority and the 'dueDateDeck' sort. */
  deckOrder: string[];
  /** Start of the study day (ms) — splits interday from intraday learning. */
  dayStartMs: number;
  rng: () => number;
}

export interface GatherOutput {
  /** New + review + interday-learning ids in final display order. */
  seq: string[];
  /** Intraday learning ids (served by their exact due times, outside the display order). */
  timed: string[];
}

/** Deterministic PRNG so verification can pin expected orders (and fuzzed ties stay testable). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isLearningState = (s: number) => s === State.Learning || s === State.Relearning;

const posKey = (r: GatherRow) => r.position ?? Number.MAX_SAFE_INTEGER;

function shuffled<T>(rows: T[], rng: () => number): T[] {
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Random key per note so a note's cards can be shuffled as a unit. */
function noteRandKeys(rows: GatherRow[], rng: () => number): Map<string, number> {
  const keys = new Map<string, number>();
  for (const r of rows) if (!keys.has(r.noteId)) keys.set(r.noteId, rng());
  return keys;
}

/** Consume per-deck + tree budgets in the given order; returns the rows that made the cap. */
function takeBudget(rows: GatherRow[], budgets: Map<string, DeckBudget>, tree: DeckBudget | null, kind: keyof DeckBudget): GatherRow[] {
  const out: GatherRow[] = [];
  for (const r of rows) {
    if (tree && tree[kind] <= 0) break;
    const b = budgets.get(r.deckId);
    if (!b || b[kind] <= 0) continue;
    b[kind]--;
    if (tree) tree[kind]--;
    out.push(r);
  }
  return out;
}

function gatherNew(input: GatherInput): GatherRow[] {
  const { newRows, cfg, deckOrder, rng } = input;
  const deckIdx = new Map(deckOrder.map((id, i) => [id, i]));
  let ordered: GatherRow[];
  switch (cfg.newGatherPriority) {
    case 'deck':
      ordered = [...newRows].sort(
        (a, b) =>
          (deckIdx.get(a.deckId) ?? 0) - (deckIdx.get(b.deckId) ?? 0) || posKey(a) - posKey(b) || a.createdMs - b.createdMs,
      );
      break;
    case 'positionAsc':
      ordered = [...newRows].sort((a, b) => posKey(a) - posKey(b) || a.createdMs - b.createdMs);
      break;
    case 'positionDesc':
      ordered = [...newRows].sort((a, b) => posKey(b) - posKey(a) || b.createdMs - a.createdMs);
      break;
    case 'randomNotes': {
      const keys = noteRandKeys(newRows, rng);
      ordered = [...newRows].sort(
        (a, b) => (keys.get(a.noteId) ?? 0) - (keys.get(b.noteId) ?? 0) || a.templateIndex - b.templateIndex,
      );
      break;
    }
    case 'randomCards':
      ordered = shuffled(newRows, rng);
      break;
  }
  return takeBudget(ordered, input.budgets, input.treeBudget, 'new');
}

function sortNew(rows: GatherRow[], cfg: ResolvedDeckConfig, rng: () => number): GatherRow[] {
  switch (cfg.newSortOrder) {
    case 'gathered':
      return rows;
    case 'template':
      return [...rows].map((r, i) => [r, i] as const).sort((a, b) => a[0].templateIndex - b[0].templateIndex || a[1] - b[1]).map(([r]) => r);
    case 'templateThenRandom': {
      const rand = new Map(rows.map((r) => [r.id, rng()]));
      return [...rows].sort((a, b) => a.templateIndex - b.templateIndex || (rand.get(a.id) ?? 0) - (rand.get(b.id) ?? 0));
    }
    case 'randomNoteThenTemplate': {
      const keys = noteRandKeys(rows, rng);
      return [...rows].sort((a, b) => (keys.get(a.noteId) ?? 0) - (keys.get(b.noteId) ?? 0) || a.templateIndex - b.templateIndex);
    }
    case 'random':
      return shuffled(rows, rng);
  }
}

const DAY_MS = 86_400_000;

function sortReviews(rows: GatherRow[], cfg: ResolvedDeckConfig, deckOrder: string[], rng: () => number): GatherRow[] {
  const dueDay = (r: GatherRow) => Math.floor(r.dueMs / DAY_MS);
  const interval = (r: GatherRow) => (r.lastReviewMs != null ? r.dueMs - r.lastReviewMs : 0);
  const rand = new Map(rows.map((r) => [r.id, rng()]));
  const rnd = (r: GatherRow) => rand.get(r.id) ?? 0;
  const deckIdx = new Map(deckOrder.map((id, i) => [id, i]));
  switch (cfg.reviewSortOrder) {
    case 'dueDateRandom':
      return [...rows].sort((a, b) => dueDay(a) - dueDay(b) || rnd(a) - rnd(b));
    case 'dueDateDeck':
      return [...rows].sort(
        (a, b) => dueDay(a) - dueDay(b) || (deckIdx.get(a.deckId) ?? 0) - (deckIdx.get(b.deckId) ?? 0) || rnd(a) - rnd(b),
      );
    case 'intervalsAsc':
      return [...rows].sort((a, b) => interval(a) - interval(b) || rnd(a) - rnd(b));
    case 'intervalsDesc':
      return [...rows].sort((a, b) => interval(b) - interval(a) || rnd(a) - rnd(b));
    case 'difficultyAsc':
      return [...rows].sort((a, b) => (a.difficulty ?? 0) - (b.difficulty ?? 0) || rnd(a) - rnd(b));
    case 'difficultyDesc':
      return [...rows].sort((a, b) => (b.difficulty ?? 0) - (a.difficulty ?? 0) || rnd(a) - rnd(b));
    case 'retrievabilityAsc': {
      // Lowest retrievability first ≈ largest elapsed-time-to-stability ratio first.
      const key = (r: GatherRow) => {
        const elapsed = r.lastReviewMs != null ? Math.max(0, Date.now() - r.lastReviewMs) / DAY_MS : 0;
        return -(elapsed / Math.max(0.01, r.stability ?? 0.01));
      };
      return [...rows].sort((a, b) => key(a) - key(b) || rnd(a) - rnd(b));
    }
  }
}

/**
 * Spread `extra` through `main` per the mix option. 'mix' distributes proportionally (v3's even
 * spread): after each main card, an accumulator owes extra.length/main.length insertions.
 */
export function interleave<T>(main: T[], extra: T[], mode: 'mix' | 'afterReviews' | 'beforeReviews'): T[] {
  if (!extra.length) return [...main];
  if (!main.length) return [...extra];
  if (mode === 'beforeReviews') return [...extra, ...main];
  if (mode === 'afterReviews') return [...main, ...extra];
  const out: T[] = [];
  const per = extra.length / main.length;
  let acc = 0;
  let ei = 0;
  for (const m of main) {
    out.push(m);
    acc += per;
    while (ei < extra.length && acc >= 1) {
      out.push(extra[ei++]);
      acc -= 1;
    }
  }
  while (ei < extra.length) out.push(extra[ei++]);
  return out;
}

export function gatherSession(input: GatherInput): GatherOutput {
  const { dueRows, cfg, deckOrder, dayStartMs, rng } = input;

  const intraday: GatherRow[] = [];
  const interday: GatherRow[] = [];
  const reviews: GatherRow[] = [];
  for (const r of dueRows) {
    if (isLearningState(r.state)) {
      if (r.lastReviewMs != null && r.lastReviewMs >= dayStartMs) intraday.push(r);
      else interday.push(r);
    } else {
      reviews.push(r);
    }
  }

  // Interday learning first (earliest due first), against the review limit — v3's gather order.
  interday.sort((a, b) => a.dueMs - b.dueMs);
  const interdayTaken = takeBudget(interday, input.budgets, input.treeBudget, 'interday');
  const reviewsTaken = takeBudget(sortReviews(reviews, cfg, deckOrder, rng), input.budgets, input.treeBudget, 'due');
  const newTaken = sortNew(gatherNew(input), cfg, rng);

  const seqRows = interleave(interleave(reviewsTaken, interdayTaken, cfg.interdayLearningMix), newTaken, cfg.newReviewMix);

  intraday.sort((a, b) => a.dueMs - b.dueMs);
  return { seq: seqRows.map((r) => r.id), timed: intraday.map((r) => r.id) };
}
