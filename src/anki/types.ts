/**
 * Anki's data model, as GakuTaku stores it. Field names and value encodings follow Anki's own
 * `cards` / `revlog` / deck-config shapes (rslib/src/card, rslib/src/revlog, proto deck_config), so
 * an imported collection keeps its scheduling state verbatim and the ported scheduler
 * (./states.ts, ./queue.ts) runs on exactly the inputs Anki's does.
 */

/** `cards.type` — what the card *is*. */
export const enum CardType {
  New = 0,
  Learn = 1,
  Review = 2,
  Relearn = 3,
}

/** `cards.queue` — where the card is scheduled (negative = user/scheduler state). */
export const enum CardQueue {
  New = 0,
  /** Intraday learning; `due` is a unix timestamp in seconds. */
  Learn = 1,
  /** `due` is a day number. */
  Review = 2,
  /** Interday learning; `due` is a day number. */
  DayLearn = 3,
  PreviewRepeat = 4,
  Suspended = -1,
  SchedBuried = -2,
  UserBuried = -3,
}

/** `revlog.type`. */
export const enum RevlogKind {
  Learning = 0,
  Review = 1,
  Relearning = 2,
  /** Anki calls this "Filtered"; also used for early reviews. */
  Filtered = 3,
  Manual = 4,
  Rescheduled = 5,
}

export type Rating = 1 | 2 | 3 | 4;
export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

export interface MemoryState {
  stability: number;
  difficulty: number;
}

/** A row of the `cards` table. */
export interface Card {
  id: number;
  nid: number;
  did: number;
  ord: number;
  /** Seconds since epoch. */
  mod: number;
  type: CardType;
  queue: CardQueue;
  /** New: position. Learn/PreviewRepeat: unix secs. Review/DayLearn: day number. */
  due: number;
  /** Days (review cards). */
  ivl: number;
  /** Permille ease (2500 = 250%). 0 for new cards. */
  factor: number;
  reps: number;
  lapses: number;
  /** Remaining learning steps (Anki stores `today * 1000 + left` historically; only `% 1000` is read). */
  left: number;
  odue: number;
  odid: number;
  flags: number;
  /** FSRS memory state; null when FSRS has never scored this card. */
  stability: number | null;
  difficulty: number | null;
  desired_retention: number | null;
  /** Unix secs of the last (non-manual) review. */
  last_review: number | null;
  /** The new-card position the card had before it was first studied (Anki `original_position`). */
  original_position: number | null;
}

/** A row of the `revlog` table. */
export interface RevlogEntry {
  /** Answer time in epoch milliseconds (also the primary key, as in Anki). */
  id: number;
  cid: number;
  /** Button: 1–4, or 0 for manual entries. */
  ease: number;
  /** Days if positive, negative seconds if a learning step. */
  ivl: number;
  lastIvl: number;
  /** Permille ease, or FSRS difficulty shifted ×1000+100… (Anki stores difficulty here when FSRS is on). */
  factor: number;
  /** Milliseconds spent answering. */
  time: number;
  type: RevlogKind;
}

export type NewGatherPriority = 'deck' | 'deckThenRandomNotes' | 'lowestPosition' | 'highestPosition' | 'randomNotes' | 'randomCards';
export type NewSortOrder = 'template' | 'noSort' | 'templateThenRandom' | 'randomNoteThenTemplate' | 'randomCard';
export type ReviewMix = 'mix' | 'afterReviews' | 'beforeReviews';
export type ReviewOrder =
  | 'day'
  | 'dayThenDeck'
  | 'deckThenDay'
  | 'intervalsAscending'
  | 'intervalsDescending'
  | 'easeAscending'
  | 'easeDescending'
  | 'retrievabilityAscending'
  | 'retrievabilityDescending'
  | 'relativeOverdueness'
  | 'random'
  | 'added'
  | 'reverseAdded';

/** Anki's deck options group (`DeckConfig.Config`), with Anki's defaults. */
export interface DeckConfig {
  learnSteps: number[]; // minutes
  relearnSteps: number[]; // minutes
  newPerDay: number;
  reviewsPerDay: number;
  initialEase: number;
  easyMultiplier: number;
  hardMultiplier: number;
  lapseMultiplier: number;
  intervalMultiplier: number;
  maximumReviewInterval: number;
  minimumLapseInterval: number;
  graduatingIntervalGood: number;
  graduatingIntervalEasy: number;
  newCardInsertOrder: 'due' | 'random';
  newCardGatherPriority: NewGatherPriority;
  newCardSortOrder: NewSortOrder;
  newMix: ReviewMix;
  interdayLearningMix: ReviewMix;
  reviewOrder: ReviewOrder;
  leechAction: 'suspend' | 'tagOnly';
  leechThreshold: number;
  disableAutoplay: boolean;
  capAnswerTimeToSecs: number;
  showTimer: boolean;
  buryNew: boolean;
  buryReviews: boolean;
  buryInterdayLearning: boolean;
  desiredRetention: number;
  historicalRetention: number;
  /** FSRS parameters; empty = defaults. */
  fsrsParams: number[];
  /** Anki's "Ignore cards reviewed before" (YYYY-MM-DD, or empty): history the optimizer skips. */
  ignoreRevlogsBeforeDate: string;
}

export function defaultDeckConfig(): DeckConfig {
  return {
    learnSteps: [1, 10],
    relearnSteps: [10],
    newPerDay: 20,
    reviewsPerDay: 200,
    initialEase: 2.5,
    easyMultiplier: 1.3,
    hardMultiplier: 1.2,
    lapseMultiplier: 0,
    intervalMultiplier: 1,
    maximumReviewInterval: 36500,
    minimumLapseInterval: 1,
    graduatingIntervalGood: 1,
    graduatingIntervalEasy: 4,
    newCardInsertOrder: 'due',
    newCardGatherPriority: 'deck',
    newCardSortOrder: 'template',
    newMix: 'mix',
    interdayLearningMix: 'mix',
    reviewOrder: 'day',
    leechAction: 'tagOnly',
    leechThreshold: 8,
    disableAutoplay: false,
    capAnswerTimeToSecs: 60,
    showTimer: false,
    buryNew: false,
    buryReviews: false,
    buryInterdayLearning: false,
    desiredRetention: 0.9,
    historicalRetention: 0.9,
    fsrsParams: [],
    ignoreRevlogsBeforeDate: '',
  };
}

/** Fill any missing keys of a stored config with Anki's defaults. */
export function normalizeDeckConfig(raw: Partial<DeckConfig> | null | undefined): DeckConfig {
  const d = defaultDeckConfig();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d } as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in d)) continue;
    const def = (d as unknown as Record<string, unknown>)[k];
    if (Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def) out[k] = v;
  }
  return out as unknown as DeckConfig;
}

/** Anki's per-deck "today only" limit override. */
export interface DayLimit {
  limit: number;
  today: number;
}

/** Anki's filtered-deck search orders (`FilteredSearchOrder`). */
export type FilteredOrder = 'oldestSeen' | 'random' | 'ivlAsc' | 'ivlDesc' | 'lapses' | 'added' | 'due' | 'reverseAdded';

export interface FilteredTerm {
  search: string;
  limit: number;
  order: FilteredOrder;
}

/** A filtered deck's settings (Anki `FilteredDeck`). */
export interface FilteredDeckConfig {
  /** One or two searches; cards matching the first are pulled in first. */
  terms: FilteredTerm[];
  /** Answers change the cards' schedules; off = "preview" (cards return unchanged). */
  reschedule: boolean;
  previewAgainSecs: number;
  previewHardSecs: number;
  /** 0 = Good returns the card to its deck. */
  previewGoodSecs: number;
}

export function defaultFilteredConfig(): FilteredDeckConfig {
  return {
    terms: [{ search: '', limit: 100, order: 'random' }],
    reschedule: true,
    previewAgainSecs: 60,
    previewHardSecs: 600,
    previewGoodSecs: 0,
  };
}

/** A row of the `decks` table: a normal deck, or a filtered deck when `filtered` is set. */
export interface Deck {
  id: number;
  /** Full name with `::` separators. */
  name: string;
  conf_id: number;
  description: string;
  /** "This deck" limit overrides (null = use the preset). */
  review_limit: number | null;
  new_limit: number | null;
  review_limit_today: DayLimit | null;
  new_limit_today: DayLimit | null;
  desired_retention: number | null;
  collapsed: boolean;
  last_day_studied: number;
  new_studied: number;
  review_studied: number;
  learning_studied: number;
  ms_studied: number;
  /** Set for filtered decks (which have no preset: conf_id is 0). */
  filtered: FilteredDeckConfig | null;
}

/** Collection-wide settings (Anki's Preferences → Scheduling, plus the FSRS toggle). */
export interface CollectionConfig {
  fsrs: boolean;
  /** Anki "Next day starts at" (0–23). */
  rollover: number;
  /** Anki "Learn ahead limit", seconds. */
  learnAheadSecs: number;
  newCardsIgnoreReviewLimit: boolean;
  applyAllParentLimits: boolean;
  fsrsShortTermWithSteps: boolean;
  /** Next new-card position to hand out. */
  nextPos: number;
}

export function defaultCollectionConfig(): CollectionConfig {
  return {
    fsrs: true,
    rollover: 4,
    learnAheadSecs: 1200,
    newCardsIgnoreReviewLimit: false,
    applyAllParentLimits: false,
    fsrsShortTermWithSteps: false,
    nextPos: 1,
  };
}
