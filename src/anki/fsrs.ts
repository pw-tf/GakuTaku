import { RevlogKind, type MemoryState, type RevlogEntry } from './types';

/**
 * FSRS-6, ported from fsrs-rs v6.6.2 (the version Anki pins): src/model.rs (the scalar model),
 * src/inference.rs (`next_states`, `memory_state`, `memory_state_from_sm2`) and
 * src/parameter_clipper.rs. Revlog → memory-state conversion is from Anki's
 * rslib/src/scheduler/fsrs/{memory_state,params}.rs.
 *
 * fsrs-rs computes in f32; this uses f64, so results can differ in the last few decimal places.
 */

export const FSRS5_DEFAULT_DECAY = 0.5;
export const FSRS6_DEFAULT_DECAY = 0.1542;

export const DEFAULT_PARAMETERS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
  0.6014, 1.8729, 0.5425, 0.0912, 0.0658, FSRS6_DEFAULT_DECAY,
];

const S_MIN = 0.001;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;
const INIT_S_MAX = 100;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** `check_and_fill_parameters` + `clip_parameters` (one relearning step, short-term off), as `FSRS::new` does. */
export function prepareParameters(params: readonly number[]): number[] {
  let w: number[];
  switch (params.length) {
    case 0:
      w = [...DEFAULT_PARAMETERS];
      break;
    case 17:
      w = [...params];
      w[4] = w[5] * 2 + w[4];
      w[5] = Math.log(w[5] * 3 + 1) / 3;
      w[6] += 0.5;
      w.push(0, 0, 0, FSRS5_DEFAULT_DECAY);
      break;
    case 19:
      w = [...params, 0, FSRS5_DEFAULT_DECAY];
      break;
    case 21:
      w = [...params];
      break;
    default:
      w = [...DEFAULT_PARAMETERS];
  }
  if (w.some((x) => !Number.isFinite(x))) w = [...DEFAULT_PARAMETERS];
  const ceiling = 2.0; // num_relearning_steps = 1
  const clamps: [number, number][] = [
    [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX],
    [D_MIN, D_MAX], [0.001, 4.0], [0.001, 4.0], [0.001, 0.75], [0.0, 4.5], [0.0, 0.8], [0.001, 3.5],
    [0.001, 5.0], [0.001, 0.25], [0.001, 0.9], [0.0, 4.0], [0.0, 1.0], [1.0, 6.0],
    [0.0, ceiling], [0.0, ceiling], [0.0, 0.8], [0.1, 0.8],
  ];
  return w.map((x, i) => clamp(x, clamps[i][0], clamps[i][1]));
}

/** Anki `get_decay_from_params` (on the *unfilled* stored params). */
export function decayFromParams(params: readonly number[]): number {
  if (params.length === 0) return FSRS6_DEFAULT_DECAY;
  if (params.length < 21) return FSRS5_DEFAULT_DECAY;
  return params[20];
}

function factorFor(w: readonly number[]): [number, number] {
  const decay = -w[20];
  return [decay, Math.exp(Math.log(0.9) / decay) - 1];
}

export function powerForgettingCurve(w: readonly number[], t: number, s: number): number {
  const [decay, factor] = factorFor(w);
  return Math.pow((t / s) * factor + 1, decay);
}

/** Unrounded interval in days for a stability and desired retention. */
export function nextInterval(w: readonly number[], stability: number, desiredRetention: number): number {
  const [decay, factor] = factorFor(w);
  return (stability / factor) * (Math.pow(desiredRetention, 1 / decay) - 1);
}

const initStability = (w: readonly number[], rating: number) => w[Math.min(Math.max(rating - 1, 0), 3)];
const initDifficulty = (w: readonly number[], rating: number) => w[4] - Math.exp(w[5] * Math.max(rating - 1, 0)) + 1;
const meanReversion = (w: readonly number[], newD: number) => w[7] * (initDifficulty(w, 4) - newD) + newD;
const linearDamping = (deltaD: number, oldD: number) => ((10 - oldD) * deltaD) / 9;
const nextDifficulty = (w: readonly number[], d: number, rating: number) => d + linearDamping(-w[6] * (rating - 3), d);

function stabilityAfterSuccess(w: readonly number[], s: number, d: number, r: number, rating: number): number {
  const hardPenalty = rating === 2 ? w[15] : 1;
  const easyBonus = rating === 4 ? w[16] : 1;
  return s * (Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hardPenalty * easyBonus + 1);
}

function stabilityAfterFailure(w: readonly number[], s: number, d: number, r: number): number {
  const newS = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
  return Math.min(newS, s / Math.exp(w[17] * w[18]));
}

function stabilityShortTerm(w: readonly number[], s: number, rating: number): number {
  const sinc = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(s, -w[19]);
  return s * (rating >= 2 ? Math.max(sinc, 1) : sinc);
}

/** One review applied to a memory state (`model.rs` `step`). `state` 0/0 with nth 0 = brand new. */
export function step(w: readonly number[], deltaT: number, rating: number, state: MemoryState, nth: number): MemoryState {
  const lastS = clamp(state.stability, S_MIN, S_MAX);
  const lastD = clamp(state.difficulty, D_MIN, D_MAX);
  const r = powerForgettingCurve(w, deltaT, lastS);
  let newS = rating === 1 ? stabilityAfterFailure(w, lastS, lastD, r) : stabilityAfterSuccess(w, lastS, lastD, r, rating);
  if (deltaT === 0) newS = stabilityShortTerm(w, lastS, rating);
  let newD = clamp(meanReversion(w, nextDifficulty(w, lastD, rating)), D_MIN, D_MAX);
  if (nth === 0 && state.stability === 0) {
    const init = clamp(Math.trunc(rating), 1, 4);
    newS = initStability(w, init);
    newD = clamp(initDifficulty(w, init), D_MIN, D_MAX);
  }
  if (rating === 0) {
    newS = lastS;
    newD = lastD;
  }
  return { stability: clamp(newS, S_MIN, S_MAX), difficulty: newD };
}

function validate(s: MemoryState): MemoryState {
  if (!Number.isFinite(s.stability) || !Number.isFinite(s.difficulty)) throw new Error('Invalid FSRS memory state');
  return s;
}

export interface ItemState {
  memory: MemoryState;
  /** Unrounded days. */
  interval: number;
}
export interface NextStates {
  again: ItemState;
  hard: ItemState;
  good: ItemState;
  easy: ItemState;
}

/** fsrs-rs `next_states`. */
export function nextStates(w: readonly number[], current: MemoryState | null, desiredRetention: number, daysElapsed: number): NextStates {
  const base = current ?? { stability: 0, difficulty: 0 };
  const nth = current ? 1 : 0;
  const one = (rating: number): ItemState => {
    const memory = validate(step(w, daysElapsed, rating, base, nth));
    return { memory, interval: nextInterval(w, memory.stability, desiredRetention) };
  };
  return { again: one(1), hard: one(2), good: one(3), easy: one(4) };
}

/** fsrs-rs `memory_state_from_sm2`. */
export function memoryStateFromSm2(w: readonly number[], easeFactor: number, interval: number, sm2Retention: number): MemoryState {
  const [decay, factor] = factorFor(w);
  const stability = (Math.max(interval, S_MIN) * factor) / (Math.pow(sm2Retention, 1 / decay) - 1);
  const difficulty =
    11 - (easeFactor - 1) / (Math.exp(w[8]) * Math.pow(stability, -w[9]) * Math.expm1((1 - sm2Retention) * w[10]));
  if (!Number.isFinite(stability) || !Number.isFinite(difficulty)) throw new Error('Invalid SM-2 state');
  return { stability, difficulty: clamp(difficulty, D_MIN, D_MAX) };
}

/** Days until `nextDayAt` since an answer (Anki `RevlogEntry::days_elapsed`). */
const revlogDaysElapsed = (e: RevlogEntry, nextDayAt: number) => Math.max(0, Math.floor((nextDayAt - Math.floor(e.id / 1000)) / 86_400));

const isCramming = (e: RevlogEntry) => e.type === RevlogKind.Filtered && e.factor === 0;
const isReset = (e: RevlogEntry) => e.type === RevlogKind.Manual && e.factor === 0;
const hasRating = (e: RevlogEntry) => e.ease > 0;
export const affectsScheduling = (e: RevlogEntry) => hasRating(e) && !isCramming(e);

interface FsrsReview {
  rating: number;
  deltaT: number;
}

/** Anki `reviews_for_fsrs` (non-training mode, no ignore-before cutoff). Entries must be ascending by id. */
function reviewsForFsrs(entries: RevlogEntry[], nextDayAt: number): { reviews: FsrsReview[]; complete: boolean; filtered: RevlogEntry[] } | null {
  let firstOfLastLearn: number | null = null;
  let firstUserGrade: number | null = null;
  let complete = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (isCramming(e)) continue;
    const userGraded = hasRating(e);
    const interday = e.ivl >= 1 || e.ivl <= -86_400;
    if (userGraded && interday) firstUserGrade = i;
    if (userGraded && e.type === RevlogKind.Learning) {
      firstOfLastLearn = i;
      complete = true;
    } else if (isReset(e)) {
      if (firstOfLastLearn != null) {
        complete = true;
        break;
      } else if (firstUserGrade != null) {
        complete = false;
        break;
      } else return null;
    } else if (firstOfLastLearn != null) break;
  }
  let start: number;
  if (firstOfLastLearn != null) start = firstOfLastLearn;
  else if (firstUserGrade != null) start = firstUserGrade;
  else return null;
  const filtered = entries.slice(start).filter(affectsScheduling);
  if (filtered.length === 0) return null;
  const reviews = filtered.map((e, i) => ({
    rating: e.ease,
    deltaT: i === 0 ? 0 : revlogDaysElapsed(filtered[i - 1], nextDayAt) - revlogDaysElapsed(e, nextDayAt),
  }));
  return { reviews, complete, filtered };
}

/**
 * A card's memory state from its review history (Anki `fsrs_item_for_memory_state` +
 * `Card::set_memory_state`). Falls back on the SM-2 ease/interval when the history is missing.
 */
export function memoryStateFromHistory(
  w: readonly number[],
  revlog: RevlogEntry[],
  nextDayAt: number,
  historicalRetention: number,
  card: { type: number; ivl: number; factor: number },
): MemoryState | null {
  const sorted = [...revlog].sort((a, b) => a.id - b.id);
  const out = reviewsForFsrs(sorted, nextDayAt);
  if (out) {
    let reviews = out.reviews;
    let state: MemoryState | null = null;
    if (!out.complete) {
      const first = out.filtered[0];
      const ease = (first.factor === 0 ? 2500 : first.factor) / 1000;
      state = memoryStateFromSm2(w, ease, Math.max(first.ivl, 1), historicalRetention);
      if (ease <= 1.1) state.difficulty = (ease - 0.1) * 9 + 1;
      reviews = reviews.slice(1);
    }
    let s: MemoryState = state ?? { stability: 0, difficulty: 0 };
    let startIndex = 0;
    if (!state) {
      if (reviews.length === 0) return null;
      const r0 = reviews[0];
      s = r0.rating === 0
        ? { stability: S_MIN, difficulty: D_MIN }
        : { stability: clamp(initStability(w, clamp(r0.rating, 1, 4)), S_MIN, S_MAX), difficulty: clamp(initDifficulty(w, clamp(r0.rating, 1, 4)), D_MIN, D_MAX) };
      startIndex = 1;
    }
    for (let i = startIndex; i < reviews.length; i++) s = step(w, reviews[i].deltaT, reviews[i].rating, s, i);
    return validate(s);
  }
  if (card.type === 0 || card.ivl === 0) return null;
  return memoryStateFromSm2(w, (card.factor || 2500) / 1000, card.ivl, historicalRetention);
}

/** Current retrievability of a review card (for sorting / display). */
export function retrievability(w: readonly number[], state: MemoryState, daysElapsed: number): number {
  return powerForgettingCurve(w, daysElapsed, state.stability);
}
