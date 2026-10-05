import { decayFromParams, memoryStateFromHistory, nextStates as fsrsNextStates, prepareParameters } from './fsrs';
import { fuzzFactor, fuzzSeed, learningIvlWithFuzz } from './fuzz';
import {
  asRevlogInterval,
  intervalKind,
  leeched,
  maybeAsDays,
  nextStates,
  revlogKind,
  type CardState,
  type LearnState,
  type NewState,
  type RelearnState,
  type ReviewState,
  type SchedulingStates,
  type StateContext,
} from './states';
import { LearningSteps } from './steps';
import type { Timing } from './timing';
import { CardQueue, CardType, type Card, type DeckConfig, type Rating, type RevlogEntry } from './types';

/**
 * Applying an answer to a card — a port of rslib/src/scheduler/answering/{mod,current,learning,
 * review,relearning,revlog}.rs (`CardStateUpdater`). Pure: takes a card row and returns the updated
 * row plus the revlog entry to insert; the caller writes both in one transaction.
 */

export interface SchedulingInput {
  card: Card;
  config: DeckConfig;
  /** Effective desired retention (deck override, else preset). */
  desiredRetention: number;
  timing: Timing;
  fsrs: boolean;
  fsrsShortTermWithSteps: boolean;
  /** The card's review history (only consulted when FSRS needs to derive a missing memory state). */
  revlog?: RevlogEntry[];
}

export interface PreparedCard {
  card: Card;
  states: SchedulingStates;
}

function learnSteps(c: DeckConfig) {
  return new LearningSteps(c.learnSteps);
}
function relearnSteps(c: DeckConfig) {
  return new LearningSteps(c.relearnSteps);
}

/** `CardStateUpdater::current_card_state` / `normal_study_state` (normal decks only). */
export function currentCardState(card: Card, config: DeckConfig, timing: Timing): CardState {
  const due = card.type === CardType.Review ? Math.min(card.due, timing.today) : card.due;
  const remaining = card.left % 1000;
  const memory = card.stability != null && card.difficulty != null ? { stability: card.stability, difficulty: card.difficulty } : null;
  const ease = card.factor / 1000;

  const elapsedSecs = (lastIvl: number): number => {
    if (card.queue === CardQueue.Learn) {
      const lastIvlWithFuzz = learningIvlWithFuzz(fuzzSeed(card.id, card.reps - 1), lastIvl);
      const lastAnswered = due - lastIvlWithFuzz;
      return Math.max(0, timing.now - lastAnswered);
    }
    if (card.queue === CardQueue.DayLearn) {
      const lastIvlDays = Math.max(Math.floor(lastIvl / 86_400), 1);
      return Math.max(0, (timing.today - due + lastIvlDays) * 86_400);
    }
    return 0;
  };

  switch (card.type) {
    case CardType.New:
      return { kind: 'new', position: Math.max(due, 0) } satisfies NewState;
    case CardType.Learn: {
      const lastIvl = learnSteps(config).currentDelaySecs(remaining);
      return { kind: 'learning', scheduledSecs: lastIvl, remainingSteps: remaining, elapsedSecs: elapsedSecs(lastIvl), memory } satisfies LearnState;
    }
    case CardType.Review:
      return {
        kind: 'review',
        scheduledDays: card.ivl,
        elapsedDays: Math.max(0, card.ivl - (due - timing.today)),
        easeFactor: ease,
        lapses: card.lapses,
        leeched: false,
        memory,
      } satisfies ReviewState;
    case CardType.Relearn:
    default: {
      const lastIvl = relearnSteps(config).currentDelaySecs(remaining);
      return {
        kind: 'relearning',
        learning: { kind: 'learning', scheduledSecs: lastIvl, elapsedSecs: elapsedSecs(lastIvl), remainingSteps: remaining, memory },
        review: { kind: 'review', scheduledDays: card.ivl, elapsedDays: card.ivl, easeFactor: ease, lapses: card.lapses, leeched: false, memory },
      } satisfies RelearnState;
    }
  }
}

/** Days since the card was last reviewed, as FSRS sees it. */
function fsrsDaysElapsed(card: Card, timing: Timing, revlog: RevlogEntry[] | undefined): number {
  let last = card.last_review;
  if (last == null && revlog?.length) last = Math.floor(Math.max(...revlog.filter((r) => r.ease > 0).map((r) => r.id)) / 1000);
  if (last == null || !Number.isFinite(last)) return 0;
  return Math.max(0, Math.floor((timing.nextDayAt - last) / 86_400));
}

/**
 * The card's current state and the outcome of each button (Anki `get_scheduling_states`).
 * When FSRS is on and the card has no memory state yet (imported, or FSRS just enabled), the state
 * is derived from its review history first — the returned `card` carries it.
 */
export function prepareCard(input: SchedulingInput): PreparedCard {
  const { config, timing } = input;
  let card = input.card;
  let fsrsStates = null;
  let allowShortTerm = false;
  if (input.fsrs) {
    const w = prepareParameters(config.fsrsParams);
    if ((card.stability == null || card.difficulty == null) && card.type !== CardType.New) {
      const m = memoryStateFromHistory(w, input.revlog ?? [], timing.nextDayAt, config.historicalRetention, card);
      card = { ...card, stability: m?.stability ?? null, difficulty: m?.difficulty ?? null };
    }
    const memory = card.stability != null && card.difficulty != null ? { stability: card.stability, difficulty: card.difficulty } : null;
    fsrsStates = fsrsNextStates(w, memory, input.desiredRetention, fsrsDaysElapsed(card, timing, input.revlog));
    const p = config.fsrsParams;
    allowShortTerm = p.length >= 19 ? p[17] > 0 && p[18] > 0 : p.length === 0;
  }
  const ctx: StateContext = {
    fuzzFactor: fuzzFactor(fuzzSeed(card.id, card.reps)),
    fsrsNextStates: fsrsStates,
    fsrsShortTermWithStepsEnabled: input.fsrsShortTermWithSteps,
    fsrsAllowShortTerm: allowShortTerm,
    steps: learnSteps(config),
    graduatingIntervalGood: config.graduatingIntervalGood,
    graduatingIntervalEasy: config.graduatingIntervalEasy,
    initialEaseFactor: config.initialEase,
    hardMultiplier: config.hardMultiplier,
    easyMultiplier: config.easyMultiplier,
    intervalMultiplier: config.intervalMultiplier,
    maximumReviewInterval: config.maximumReviewInterval,
    leechThreshold: config.leechThreshold,
    relearnSteps: relearnSteps(config),
    lapseMultiplier: config.lapseMultiplier,
    minimumLapseInterval: config.minimumLapseInterval,
  };
  return { card, states: nextStates(currentCardState(card, config, timing), ctx) };
}

export interface AnswerResult {
  card: Card;
  revlog: RevlogEntry;
  /** True when the card just became a leech (caller adds the `leech` tag). */
  leeched: boolean;
}

const secsUntilRollover = (t: Timing) => Math.max(0, t.nextDayAt - t.now);

const newPositionOf = (s: CardState) => (s.kind === 'new' ? s.position : null);

/** `CardStateUpdater::apply_study_state` + revlog creation, for normal (non-filtered) decks. */
export function applyAnswer(
  prepared: PreparedCard,
  rating: Rating,
  input: Pick<SchedulingInput, 'config' | 'timing' | 'fsrs' | 'desiredRetention'>,
  answeredAtMs: number,
  millisecondsTaken: number,
): AnswerResult {
  const { timing, config } = input;
  const current = prepared.states.current;
  const next = [prepared.states.again, prepared.states.hard, prepared.states.good, prepared.states.easy][rating - 1];
  const card: Card = { ...prepared.card };
  const rollover = secsUntilRollover(timing);
  const seed = fuzzSeed(card.id, card.reps);
  const fuzzedLearningDue = (secs: number) => timing.now + learningIvlWithFuzz(seed, secs);
  const pos = newPositionOf(current);

  card.reps += 1;
  card.desired_retention = input.fsrs ? input.desiredRetention : null;
  let easeForRevlog: number;

  switch (next.kind) {
    case 'new':
      card.type = CardType.New;
      card.queue = CardQueue.New;
      card.due = next.position;
      card.original_position = null;
      card.stability = card.difficulty = null;
      easeForRevlog = 0;
      break;
    case 'learning': {
      card.left = next.remainingSteps;
      card.type = CardType.Learn;
      if (pos != null) card.original_position = pos;
      card.stability = next.memory?.stability ?? null;
      card.difficulty = next.memory?.difficulty ?? null;
      const k = maybeAsDays(intervalKind(next), rollover);
      if ('secs' in k) {
        card.queue = CardQueue.Learn;
        card.due = fuzzedLearningDue(k.secs);
      } else {
        card.queue = CardQueue.DayLearn;
        card.due = timing.today + k.days;
      }
      easeForRevlog = next.memory ? difficultyShifted(next.memory.difficulty) : 0;
      break;
    }
    case 'review':
      card.queue = CardQueue.Review;
      card.type = CardType.Review;
      card.ivl = next.scheduledDays;
      card.due = timing.today + next.scheduledDays;
      card.factor = Math.round(next.easeFactor * 1000);
      card.lapses = next.lapses;
      card.left = 0;
      if (pos != null) card.original_position = pos;
      card.stability = next.memory?.stability ?? null;
      card.difficulty = next.memory?.difficulty ?? null;
      easeForRevlog = next.memory ? difficultyShifted(next.memory.difficulty) : next.easeFactor;
      break;
    case 'relearning': {
      card.ivl = next.review.scheduledDays;
      card.left = next.learning.remainingSteps;
      card.type = CardType.Relearn;
      card.lapses = next.review.lapses;
      card.factor = Math.round(next.review.easeFactor * 1000);
      if (pos != null) card.original_position = pos;
      card.stability = next.learning.memory?.stability ?? null;
      card.difficulty = next.learning.memory?.difficulty ?? null;
      const k = maybeAsDays(intervalKind(next), rollover);
      if ('secs' in k) {
        card.queue = CardQueue.Learn;
        card.due = fuzzedLearningDue(k.secs);
      } else {
        card.queue = CardQueue.DayLearn;
        card.due = timing.today + k.days;
      }
      easeForRevlog = next.learning.memory ? difficultyShifted(next.learning.memory.difficulty) : next.review.easeFactor;
      break;
    }
  }

  const isLeech = leeched(next);
  if (isLeech && config.leechAction === 'suspend') card.queue = CardQueue.Suspended;
  card.last_review = Math.floor(answeredAtMs / 1000);
  card.mod = timing.now;

  const revlog: RevlogEntry = {
    id: answeredAtMs,
    cid: card.id,
    ease: rating,
    ivl: asRevlogInterval(maybeAsDays(intervalKind(next), rollover)),
    lastIvl: asRevlogInterval(maybeAsDays(intervalKind(current), rollover)),
    factor: Math.round(easeForRevlog * 1000),
    time: Math.min(millisecondsTaken, config.capAnswerTimeToSecs * 1000),
    type: revlogKind(current),
  };
  return { card, revlog, leeched: isLeech };
}

/** Anki `FsrsMemoryState::difficulty_shifted`: difficulty 1–10 mapped to 0.1–1.1 for the revlog. */
function difficultyShifted(d: number): number {
  return (d - 1) / 9 + 0.1;
}

/** The FSRS decay a card's preset uses (for retrievability display/sorting). */
export const cardDecay = (config: DeckConfig) => decayFromParams(config.fsrsParams);
