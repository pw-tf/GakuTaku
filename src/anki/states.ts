import { constrainedFuzzBounds, minimumReviewFuzzInterval, withReviewFuzz } from './fuzz';
import type { NextStates } from './fsrs';
import { LearningSteps } from './steps';
import { RevlogKind, type MemoryState } from './types';

/**
 * Anki's card state machine, ported from rslib/src/scheduler/states/{mod,new,learning,review,
 * relearning,normal,interval_kind}.rs. Given a card's current state and its deck options
 * ({@link StateContext}), {@link nextStates} returns what each answer button would do — the same
 * values Anki shows on its buttons and applies when answered.
 */

export const INITIAL_EASE_FACTOR = 2.5;
export const MINIMUM_EASE_FACTOR = 1.3;
const EASE_FACTOR_AGAIN_DELTA = -0.2;
const EASE_FACTOR_HARD_DELTA = -0.15;
const EASE_FACTOR_EASY_DELTA = 0.15;

export interface NewState {
  kind: 'new';
  position: number;
}
export interface LearnState {
  kind: 'learning';
  remainingSteps: number;
  scheduledSecs: number;
  elapsedSecs: number;
  memory: MemoryState | null;
}
export interface ReviewState {
  kind: 'review';
  scheduledDays: number;
  elapsedDays: number;
  easeFactor: number;
  lapses: number;
  leeched: boolean;
  memory: MemoryState | null;
}
export interface RelearnState {
  kind: 'relearning';
  learning: LearnState;
  review: ReviewState;
}
export type CardState = NewState | LearnState | ReviewState | RelearnState;

export interface SchedulingStates {
  current: CardState;
  again: CardState;
  hard: CardState;
  good: CardState;
  easy: CardState;
}

export interface StateContext {
  fuzzFactor: number | null;
  fsrsNextStates: NextStates | null;
  fsrsShortTermWithStepsEnabled: boolean;
  fsrsAllowShortTerm: boolean;
  steps: LearningSteps;
  graduatingIntervalGood: number;
  graduatingIntervalEasy: number;
  initialEaseFactor: number;
  hardMultiplier: number;
  easyMultiplier: number;
  intervalMultiplier: number;
  maximumReviewInterval: number;
  leechThreshold: number;
  relearnSteps: LearningSteps;
  lapseMultiplier: number;
  minimumLapseInterval: number;
}

export function defaultReview(over: Partial<ReviewState> = {}): ReviewState {
  return { kind: 'review', scheduledDays: 0, elapsedDays: 0, easeFactor: INITIAL_EASE_FACTOR, lapses: 0, leeched: false, memory: null, ...over };
}

function minAndMax(ctx: StateContext, minimum: number): [number, number] {
  const maximum = Math.max(ctx.maximumReviewInterval, 1);
  return [Math.min(Math.max(minimum, 1), maximum), maximum];
}

const fuzz = (ctx: StateContext, interval: number, minimum: number, maximum: number) =>
  withReviewFuzz(ctx.fuzzFactor, interval, minimum, maximum);

// ---- Interval kinds -------------------------------------------------------------

export type IntervalKind = { secs: number } | { days: number };

export function intervalKind(s: CardState): IntervalKind {
  switch (s.kind) {
    case 'new':
      return { secs: 0 };
    case 'learning':
      return { secs: s.scheduledSecs };
    case 'review':
      return { days: s.scheduledDays };
    case 'relearning':
      return { secs: s.learning.scheduledSecs };
  }
}

/** `IntervalKind::maybe_as_days`: a learning delay past the rollover counts in days. */
export function maybeAsDays(k: IntervalKind, secsUntilRollover: number): IntervalKind {
  if ('secs' in k && k.secs >= secsUntilRollover) return { days: Math.floor((k.secs - secsUntilRollover) / 86_400) + 1 };
  return k;
}

export const asSeconds = (k: IntervalKind) => ('secs' in k ? k.secs : k.days * 86_400);
export const asRevlogInterval = (k: IntervalKind) => ('days' in k ? k.days : -k.secs);

export function revlogKind(s: CardState): RevlogKind {
  switch (s.kind) {
    case 'new':
    case 'learning':
      return RevlogKind.Learning;
    case 'review':
      return s.elapsedDays - s.scheduledDays < 0 ? RevlogKind.Filtered : RevlogKind.Review;
    case 'relearning':
      return RevlogKind.Relearning;
  }
}

export function reviewStateOf(s: CardState): ReviewState | null {
  return s.kind === 'review' ? s : s.kind === 'relearning' ? s.review : null;
}
export const leeched = (s: CardState) => reviewStateOf(s)?.leeched ?? false;

// ---- Learning ---------------------------------------------------------------------

function learnGraduate(ctx: StateContext, which: 'again' | 'hard' | 'good', self: LearnState, remainingSteps: number): CardState {
  const memory = ctx.fsrsNextStates ? ctx.fsrsNextStates[which].memory : null;
  const [minimum, maximum] = minAndMax(ctx, 1);
  let interval: number;
  let shortTerm = false;
  if (ctx.fsrsNextStates) {
    interval = ctx.fsrsNextStates[which].interval;
    shortTerm = ctx.fsrsAllowShortTerm && (ctx.fsrsShortTermWithStepsEnabled || ctx.steps.isEmpty()) && interval < 0.5;
  } else {
    interval = ctx.graduatingIntervalGood;
  }
  if (shortTerm) {
    return { ...self, kind: 'learning', remainingSteps, scheduledSecs: Math.trunc(interval * 86_400), elapsedSecs: 0, memory };
  }
  return defaultReview({
    scheduledDays: fuzz(ctx, Math.max(Math.round(interval), 1), minimum, maximum),
    easeFactor: ctx.initialEaseFactor,
    memory,
  });
}

function learningNextStates(self: LearnState, ctx: StateContext): Omit<SchedulingStates, 'current'> {
  // Again
  let again: CardState;
  const againDelay = ctx.steps.againDelaySecsLearn();
  if (againDelay != null) {
    again = {
      kind: 'learning',
      remainingSteps: ctx.steps.remainingForFailed(),
      scheduledSecs: againDelay,
      elapsedSecs: 0,
      memory: ctx.fsrsNextStates?.again.memory ?? null,
    };
  } else {
    again = learnGraduate(ctx, 'again', self, ctx.steps.remainingForFailed());
  }
  // Hard
  let hard: CardState;
  const hardDelay = ctx.steps.hardDelaySecs(self.remainingSteps);
  if (hardDelay != null) {
    hard = { ...self, scheduledSecs: hardDelay, elapsedSecs: 0, memory: ctx.fsrsNextStates?.hard.memory ?? null };
  } else {
    hard = learnGraduate(ctx, 'hard', self, self.remainingSteps);
  }
  // Good
  let good: CardState;
  const goodDelay = ctx.steps.goodDelaySecs(self.remainingSteps);
  if (goodDelay != null) {
    good = {
      kind: 'learning',
      remainingSteps: ctx.steps.remainingForGood(self.remainingSteps),
      scheduledSecs: goodDelay,
      elapsedSecs: 0,
      memory: ctx.fsrsNextStates?.good.memory ?? null,
    };
  } else {
    good = learnGraduate(ctx, 'good', self, self.remainingSteps);
  }
  // Easy
  let [minimum] = minAndMax(ctx, 1);
  const [, maximum] = minAndMax(ctx, 1);
  let easyInterval: number;
  if (ctx.fsrsNextStates) {
    const goodIvl = fuzz(ctx, ctx.fsrsNextStates.good.interval, minimum, maximum);
    minimum = goodIvl + 1;
    easyInterval = Math.max(Math.round(ctx.fsrsNextStates.easy.interval), 1);
  } else {
    easyInterval = ctx.graduatingIntervalEasy;
  }
  const easy = defaultReview({
    scheduledDays: fuzz(ctx, easyInterval, minimum, maximum),
    easeFactor: ctx.initialEaseFactor,
    memory: ctx.fsrsNextStates?.easy.memory ?? null,
  });
  return { again, hard, good, easy };
}

// ---- Review -----------------------------------------------------------------------

function leechThresholdMet(lapses: number, threshold: number): boolean {
  if (threshold <= 0) return false;
  const half = Math.max(Math.ceil(threshold / 2), 1);
  return lapses >= threshold && (lapses - threshold) % half === 0;
}

function constrainPassingInterval(ctx: StateContext, interval: number, minimum: number, doFuzz: boolean): number {
  const ivl = ctx.fsrsNextStates ? interval : interval * ctx.intervalMultiplier;
  const [min, max] = minAndMax(ctx, minimum);
  return doFuzz ? fuzz(ctx, ivl, min, max) : Math.min(Math.max(Math.round(ivl), min), max);
}

function failingReviewInterval(self: ReviewState, ctx: StateContext): [number, MemoryState | null] {
  if (ctx.fsrsNextStates) return [ctx.fsrsNextStates.again.interval, ctx.fsrsNextStates.again.memory];
  const [minimum, maximum] = minAndMax(ctx, ctx.minimumLapseInterval);
  const ivl = fuzz(ctx, Math.max(self.scheduledDays, 1) * ctx.lapseMultiplier, minimum, maximum);
  return [ivl, null];
}

function passingReviewIntervals(self: ReviewState, ctx: StateContext): [number, number, number] {
  const fs = ctx.fsrsNextStates;
  if (fs) {
    const hard = constrainPassingInterval(ctx, fs.hard.interval, Math.max(minimumReviewFuzzInterval(fs.hard.interval, self.scheduledDays, ctx.maximumReviewInterval), 1), true);
    const good = constrainPassingInterval(ctx, fs.good.interval, Math.max(minimumReviewFuzzInterval(fs.good.interval, self.scheduledDays, ctx.maximumReviewInterval), hard + 1), true);
    const easy = constrainPassingInterval(ctx, fs.easy.interval, Math.max(minimumReviewFuzzInterval(fs.easy.interval, self.scheduledDays, ctx.maximumReviewInterval), good + 1), true);
    return [hard, good, easy];
  }
  if (self.elapsedDays - self.scheduledDays < 0) {
    // early review (Anki's direct port of the Python implementation)
    const scheduled = Math.max(self.scheduledDays, 1);
    const elapsed = self.elapsedDays;
    const hard = constrainPassingInterval(ctx, Math.max(elapsed * ctx.hardMultiplier, scheduled * (ctx.hardMultiplier / 2)), 0, false);
    const good = constrainPassingInterval(ctx, Math.max(elapsed * self.easeFactor, scheduled), 0, false);
    const reducedBonus = ctx.easyMultiplier - (ctx.easyMultiplier - 1) / 2;
    const easy = constrainPassingInterval(ctx, Math.max(elapsed * self.easeFactor, scheduled) * reducedBonus, 0, false);
    return [hard, good, easy];
  }
  const current = Math.max(self.scheduledDays, 1);
  const daysLate = Math.max(self.elapsedDays - self.scheduledDays, 0);
  const hardMin = ctx.hardMultiplier <= 1 ? 0 : self.scheduledDays + 1;
  const hard = constrainPassingInterval(ctx, current * ctx.hardMultiplier, hardMin, true);
  const goodMin = ctx.hardMultiplier <= 1 ? self.scheduledDays + 1 : hard + 1;
  const good = constrainPassingInterval(ctx, (current + daysLate / 2) * self.easeFactor, goodMin, true);
  const easy = constrainPassingInterval(ctx, (current + daysLate) * self.easeFactor * ctx.easyMultiplier, good + 1, true);
  return [hard, good, easy];
}

function reviewNextStates(self: ReviewState, ctx: StateContext): Omit<SchedulingStates, 'current'> {
  const [hardIvl, goodIvl, easyIvl] = passingReviewIntervals(self, ctx);
  // Again
  const lapses = self.lapses + 1;
  const [scheduledDays, memory] = failingReviewInterval(self, ctx);
  const againReview = defaultReview({
    scheduledDays: Math.max(Math.round(scheduledDays), 1),
    elapsedDays: 0,
    easeFactor: Math.max(self.easeFactor + EASE_FACTOR_AGAIN_DELTA, MINIMUM_EASE_FACTOR),
    lapses,
    leeched: leechThresholdMet(lapses, ctx.leechThreshold),
    memory,
  });
  let again: CardState;
  const againDelay = ctx.relearnSteps.againDelaySecsLearn();
  if (againDelay != null) {
    again = {
      kind: 'relearning',
      learning: { kind: 'learning', remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: againDelay, elapsedSecs: 0, memory },
      review: againReview,
    };
  } else if (ctx.fsrsAllowShortTerm && (ctx.fsrsShortTermWithStepsEnabled || ctx.relearnSteps.isEmpty()) && scheduledDays < 0.5) {
    again = {
      kind: 'relearning',
      learning: { kind: 'learning', remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: Math.trunc(scheduledDays * 86_400), elapsedSecs: 0, memory },
      review: againReview,
    };
  } else {
    again = againReview;
  }
  const fs = ctx.fsrsNextStates;
  const hard: ReviewState = { ...self, scheduledDays: hardIvl, elapsedDays: 0, easeFactor: Math.max(self.easeFactor + EASE_FACTOR_HARD_DELTA, MINIMUM_EASE_FACTOR), memory: fs ? fs.hard.memory : null };
  const good: ReviewState = { ...self, scheduledDays: goodIvl, elapsedDays: 0, memory: fs ? fs.good.memory : null };
  const easy: ReviewState = { ...self, scheduledDays: easyIvl, elapsedDays: 0, easeFactor: self.easeFactor + EASE_FACTOR_EASY_DELTA, memory: fs ? fs.easy.memory : null };
  return { again, hard, good, easy };
}

// ---- Relearning -------------------------------------------------------------------

function relearnFsrsOutcome(self: RelearnState, ctx: StateContext, which: 'again' | 'hard' | 'good', learning: Partial<LearnState>, memory: MemoryState | null): CardState {
  const [minimum, maximum] = minAndMax(ctx, 1);
  const interval = ctx.fsrsNextStates![which].interval;
  const review: ReviewState = { ...self.review, scheduledDays: fuzz(ctx, Math.max(Math.round(interval), 1), minimum, maximum), memory };
  if (ctx.fsrsAllowShortTerm && (ctx.fsrsShortTermWithStepsEnabled || ctx.relearnSteps.isEmpty()) && interval < 0.5) {
    return { kind: 'relearning', learning: { ...self.learning, ...learning, scheduledSecs: Math.trunc(interval * 86_400), memory }, review };
  }
  return review;
}

function relearningNextStates(self: RelearnState, ctx: StateContext): Omit<SchedulingStates, 'current'> {
  // Again
  const [failDays, failMemory] = failingReviewInterval(self.review, ctx);
  let again: CardState;
  const againDelay = ctx.relearnSteps.againDelaySecsLearn();
  if (againDelay != null) {
    again = {
      kind: 'relearning',
      learning: { kind: 'learning', remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: againDelay, elapsedSecs: 0, memory: failMemory },
      review: { ...self.review, scheduledDays: Math.max(Math.round(failDays), 1), elapsedDays: 0, memory: failMemory },
    };
  } else if (ctx.fsrsNextStates) {
    again = relearnFsrsOutcome(self, ctx, 'again', { remainingSteps: ctx.relearnSteps.remainingForFailed(), elapsedSecs: 0 }, failMemory);
  } else {
    again = self.review;
  }
  // Hard
  const hardMemory = ctx.fsrsNextStates?.hard.memory ?? null;
  let hard: CardState;
  const hardDelay = ctx.relearnSteps.hardDelaySecs(self.learning.remainingSteps);
  if (hardDelay != null) {
    hard = { kind: 'relearning', learning: { ...self.learning, scheduledSecs: hardDelay, memory: hardMemory }, review: { ...self.review, elapsedDays: 0, memory: hardMemory } };
  } else if (ctx.fsrsNextStates) {
    hard = relearnFsrsOutcome(self, ctx, 'hard', {}, hardMemory);
  } else {
    hard = self.review;
  }
  // Good
  const goodMemory = ctx.fsrsNextStates?.good.memory ?? null;
  let good: CardState;
  const goodDelay = ctx.relearnSteps.goodDelaySecs(self.learning.remainingSteps);
  if (goodDelay != null) {
    good = {
      kind: 'relearning',
      learning: { kind: 'learning', scheduledSecs: goodDelay, remainingSteps: ctx.relearnSteps.remainingForGood(self.learning.remainingSteps), elapsedSecs: 0, memory: goodMemory },
      review: { ...self.review, elapsedDays: 0, memory: goodMemory },
    };
  } else if (ctx.fsrsNextStates) {
    good = relearnFsrsOutcome(self, ctx, 'good', { remainingSteps: ctx.relearnSteps.remainingForGood(self.learning.remainingSteps) }, goodMemory);
  } else {
    good = self.review;
  }
  // Easy
  let easyDays: number;
  if (ctx.fsrsNextStates) {
    let [minimum] = minAndMax(ctx, 1);
    const [, maximum] = minAndMax(ctx, 1);
    const goodIvl = fuzz(ctx, ctx.fsrsNextStates.good.interval, minimum, maximum);
    minimum = goodIvl + 1;
    easyDays = fuzz(ctx, Math.max(Math.round(ctx.fsrsNextStates.easy.interval), 1), minimum, maximum);
  } else {
    easyDays = self.review.scheduledDays + 1;
  }
  const easy: ReviewState = { ...self.review, scheduledDays: easyDays, elapsedDays: 0, memory: ctx.fsrsNextStates?.easy.memory ?? null };
  return { again, hard, good, easy };
}

// ---- Entry point ------------------------------------------------------------------

export function nextStates(current: CardState, ctx: StateContext): SchedulingStates {
  switch (current.kind) {
    case 'new': {
      const learn: LearnState = { kind: 'learning', remainingSteps: ctx.steps.remainingForFailed(), scheduledSecs: 0, elapsedSecs: 0, memory: null };
      return { current, ...learningNextStates(learn, ctx) };
    }
    case 'learning':
      return { current, ...learningNextStates(current, ctx) };
    case 'review':
      return { current, ...reviewNextStates(current, ctx) };
    case 'relearning':
      return { current, ...relearningNextStates(current, ctx) };
  }
}

/** Exposed for tests. */
export { constrainedFuzzBounds, leechThresholdMet };
