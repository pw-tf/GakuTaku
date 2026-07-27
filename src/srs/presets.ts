import {
  DEFAULT_DESIRED_RETENTION,
  DEFAULT_MAXIMUM_INTERVAL,
  DEFAULT_NEW_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
  deckConfig,
  parseJsonObject,
} from './fsrs';

/**
 * Deck option presets — Anki's shared "options group". All scheduling configuration lives on a
 * `deck_presets` row referenced by many decks (`decks.preset_id`); editing a preset affects every
 * deck using it, with no fan-out writes. `decks.fsrs_params` keeps only what Anki itself stores
 * per-deck: the description and the optional "this deck" daily-limit overrides.
 *
 * This module is pure (no DB, no React) so `scripts/verify-srs.ts` can exercise the parse/resolve
 * logic against fixtures; the DB-facing operations live in `presetOps.ts`.
 *
 * Every default below is Anki v3's default, named to match the deck-options screen.
 */

/** Anki "New card gather order". */
export type NewGatherPriority = 'deck' | 'positionAsc' | 'positionDesc' | 'randomNotes' | 'randomCards';
/** Anki "New card sort order". */
export type NewSortOrder = 'template' | 'gathered' | 'templateThenRandom' | 'randomNoteThenTemplate' | 'random';
/** Anki "New/review order" and "Interday learning/review order". */
export type ReviewMix = 'mix' | 'afterReviews' | 'beforeReviews';
/** Anki "Review sort order" (the FSRS-mode set: ease orders become difficulty orders). */
export type ReviewSortOrder =
  | 'dueDateRandom'
  | 'dueDateDeck'
  | 'intervalsAsc'
  | 'intervalsDesc'
  | 'difficultyAsc'
  | 'difficultyDesc'
  | 'retrievabilityAsc';
export type LeechAction = 'suspend' | 'tagOnly';
export type InsertionOrder = 'sequential' | 'random';

export interface DeckPresetConfig {
  // Daily limits
  newPerDay: number; // Anki: 20
  reviewsPerDay: number; // Anki: 200
  newIgnoreReviewLimit: boolean; // Anki "New cards ignore review limit": false
  // New cards
  learningSteps?: string[]; // Anki: ['1m','10m'] (undefined → ts-fsrs's identical default)
  insertionOrder: InsertionOrder; // Anki: 'sequential'
  // Lapses
  relearningSteps?: string[]; // Anki: ['10m']
  leechThreshold: number; // Anki: 8
  leechAction: LeechAction; // Anki: 'suspend'
  // Display order
  newGatherPriority: NewGatherPriority; // Anki: 'deck' ("Deck")
  newSortOrder: NewSortOrder; // Anki: 'template' ("Card type, then order gathered")
  newReviewMix: ReviewMix; // Anki: 'mix' ("Mix with reviews")
  interdayLearningMix: ReviewMix; // Anki: 'mix'
  reviewSortOrder: ReviewSortOrder; // Anki: 'dueDateRandom' ("Due date, then random")
  // Burying
  buryNewSiblings: boolean; // Anki: false
  buryReviewSiblings: boolean; // Anki: false
  buryInterdayLearningSiblings: boolean; // Anki: false
  // FSRS (weights live on the preset, matching Anki)
  desiredRetention: number; // Anki: 0.9
  maximumInterval: number; // Anki: 36500
  w?: number[];
}

/** Per-deck data that stays on `decks.fsrs_params` — exactly what Anki keeps per-deck. */
export interface DeckOverrides {
  description?: string;
  /** Anki "Daily limits → This deck": overrides the preset's limit for this deck only. */
  newPerDayOverride?: number;
  reviewsPerDayOverride?: number;
}

/** A deck's effective config: preset values with per-deck overrides applied. */
export interface ResolvedDeckConfig extends DeckPresetConfig {
  description?: string;
  presetId: string | null;
}

export const DEFAULT_PRESET_NAME = 'Default';

export function defaultPresetConfig(): DeckPresetConfig {
  return {
    newPerDay: DEFAULT_NEW_PER_DAY,
    reviewsPerDay: DEFAULT_REVIEWS_PER_DAY,
    newIgnoreReviewLimit: false,
    insertionOrder: 'sequential',
    leechThreshold: 8,
    leechAction: 'suspend',
    newGatherPriority: 'deck',
    newSortOrder: 'template',
    newReviewMix: 'mix',
    interdayLearningMix: 'mix',
    reviewSortOrder: 'dueDateRandom',
    buryNewSiblings: false,
    buryReviewSiblings: false,
    buryInterdayLearningSiblings: false,
    desiredRetention: DEFAULT_DESIRED_RETENTION,
    maximumInterval: DEFAULT_MAXIMUM_INTERVAL,
  };
}

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const GATHER_PRIORITIES: readonly NewGatherPriority[] = ['deck', 'positionAsc', 'positionDesc', 'randomNotes', 'randomCards'];
const NEW_SORT_ORDERS: readonly NewSortOrder[] = ['template', 'gathered', 'templateThenRandom', 'randomNoteThenTemplate', 'random'];
const REVIEW_MIXES: readonly ReviewMix[] = ['mix', 'afterReviews', 'beforeReviews'];
const REVIEW_SORT_ORDERS: readonly ReviewSortOrder[] = [
  'dueDateRandom', 'dueDateDeck', 'intervalsAsc', 'intervalsDesc', 'difficultyAsc', 'difficultyDesc', 'retrievabilityAsc',
];

/** Parse a `deck_presets.config` jsonb (text client-side) into a fully-defaulted config. */
export function parsePresetConfig(text: string | null | undefined): DeckPresetConfig {
  const p = parseJsonObject(text) as Partial<Record<keyof DeckPresetConfig, unknown>>;
  const d = defaultPresetConfig();
  return {
    newPerDay: typeof p.newPerDay === 'number' && p.newPerDay >= 0 ? p.newPerDay : d.newPerDay,
    reviewsPerDay: typeof p.reviewsPerDay === 'number' && p.reviewsPerDay >= 0 ? p.reviewsPerDay : d.reviewsPerDay,
    newIgnoreReviewLimit: typeof p.newIgnoreReviewLimit === 'boolean' ? p.newIgnoreReviewLimit : d.newIgnoreReviewLimit,
    learningSteps: asStringArray(p.learningSteps),
    insertionOrder: oneOf(p.insertionOrder, ['sequential', 'random'] as const, d.insertionOrder),
    relearningSteps: asStringArray(p.relearningSteps),
    leechThreshold: typeof p.leechThreshold === 'number' && p.leechThreshold >= 1 ? Math.floor(p.leechThreshold) : d.leechThreshold,
    leechAction: oneOf(p.leechAction, ['suspend', 'tagOnly'] as const, d.leechAction),
    newGatherPriority: oneOf(p.newGatherPriority, GATHER_PRIORITIES, d.newGatherPriority),
    newSortOrder: oneOf(p.newSortOrder, NEW_SORT_ORDERS, d.newSortOrder),
    newReviewMix: oneOf(p.newReviewMix, REVIEW_MIXES, d.newReviewMix),
    interdayLearningMix: oneOf(p.interdayLearningMix, REVIEW_MIXES, d.interdayLearningMix),
    reviewSortOrder: oneOf(p.reviewSortOrder, REVIEW_SORT_ORDERS, d.reviewSortOrder),
    buryNewSiblings: typeof p.buryNewSiblings === 'boolean' ? p.buryNewSiblings : d.buryNewSiblings,
    buryReviewSiblings: typeof p.buryReviewSiblings === 'boolean' ? p.buryReviewSiblings : d.buryReviewSiblings,
    buryInterdayLearningSiblings:
      typeof p.buryInterdayLearningSiblings === 'boolean' ? p.buryInterdayLearningSiblings : d.buryInterdayLearningSiblings,
    desiredRetention:
      typeof p.desiredRetention === 'number' && p.desiredRetention > 0 && p.desiredRetention < 1
        ? p.desiredRetention
        : d.desiredRetention,
    maximumInterval:
      typeof p.maximumInterval === 'number' && p.maximumInterval >= 1 ? p.maximumInterval : d.maximumInterval,
    w: Array.isArray(p.w) && p.w.every((x) => typeof x === 'number') ? (p.w as number[]) : undefined,
  };
}

/** Serialize preset config, eliding values equal to the Anki defaults (same style as fsrs_params). */
export function serializePresetConfig(cfg: DeckPresetConfig): string {
  const d = defaultPresetConfig();
  const out: Record<string, unknown> = {};
  const keep = <K extends keyof DeckPresetConfig>(k: K) => {
    if (cfg[k] !== d[k] && cfg[k] !== undefined) out[k] = cfg[k];
  };
  keep('newPerDay');
  keep('reviewsPerDay');
  keep('newIgnoreReviewLimit');
  if (cfg.learningSteps?.length) out.learningSteps = cfg.learningSteps;
  keep('insertionOrder');
  if (cfg.relearningSteps?.length) out.relearningSteps = cfg.relearningSteps;
  keep('leechThreshold');
  keep('leechAction');
  keep('newGatherPriority');
  keep('newSortOrder');
  keep('newReviewMix');
  keep('interdayLearningMix');
  keep('reviewSortOrder');
  keep('buryNewSiblings');
  keep('buryReviewSiblings');
  keep('buryInterdayLearningSiblings');
  keep('desiredRetention');
  keep('maximumInterval');
  if (cfg.w) out.w = cfg.w;
  return JSON.stringify(out);
}

/** Parse a deck's `fsrs_params` for its per-deck data (description + limit overrides). */
export function parseDeckOverrides(text: string | null | undefined): DeckOverrides {
  const p = parseJsonObject(text) as Partial<Record<keyof DeckOverrides, unknown>>;
  return {
    description: typeof p.description === 'string' && p.description ? p.description : undefined,
    newPerDayOverride: typeof p.newPerDayOverride === 'number' && p.newPerDayOverride >= 0 ? p.newPerDayOverride : undefined,
    reviewsPerDayOverride:
      typeof p.reviewsPerDayOverride === 'number' && p.reviewsPerDayOverride >= 0 ? p.reviewsPerDayOverride : undefined,
  };
}

export function serializeDeckOverrides(o: DeckOverrides): string {
  const out: Record<string, unknown> = {};
  if (o.description) out.description = o.description;
  if (o.newPerDayOverride != null) out.newPerDayOverride = o.newPerDayOverride;
  if (o.reviewsPerDayOverride != null) out.reviewsPerDayOverride = o.reviewsPerDayOverride;
  return JSON.stringify(out);
}

/** The minimal deck row shape resolution needs. */
export interface DeckConfigSource {
  preset_id?: string | null;
  fsrs_params: string | null;
}

/**
 * A deck's effective config. With a preset: preset config + per-deck overrides. Without one
 * (legacy deck, pre-migration data, or a stale client's write): the old full-config `fsrs_params`
 * parse, mapped onto the preset shape with Anki-default values for the new knobs — except
 * `leechAction`, which stays 'tagOnly' for legacy decks because that was their actual behavior;
 * the faithful 'suspend' default applies to preset-backed decks only.
 */
export function resolveDeckConfig(deck: DeckConfigSource, presetConfig: DeckPresetConfig | null): ResolvedDeckConfig {
  if (deck.preset_id && presetConfig) {
    const o = parseDeckOverrides(deck.fsrs_params);
    return {
      ...presetConfig,
      newPerDay: o.newPerDayOverride ?? presetConfig.newPerDay,
      reviewsPerDay: o.reviewsPerDayOverride ?? presetConfig.reviewsPerDay,
      description: o.description,
      presetId: deck.preset_id,
    };
  }
  const legacy = deckConfig({ fsrs_params: deck.fsrs_params });
  return {
    ...defaultPresetConfig(),
    newPerDay: legacy.newPerDay,
    reviewsPerDay: legacy.reviewsPerDay,
    learningSteps: legacy.learningSteps,
    relearningSteps: legacy.relearningSteps,
    desiredRetention: legacy.desiredRetention,
    maximumInterval: legacy.maximumInterval,
    w: legacy.w,
    leechAction: 'tagOnly',
    description: legacy.description,
    presetId: null,
  };
}

/** True when a legacy deck's `fsrs_params` carries any non-default scheduling value. */
export function legacyParamsCustomized(text: string | null | undefined): boolean {
  const legacy = deckConfig({ fsrs_params: text ?? null });
  return (
    legacy.newPerDay !== DEFAULT_NEW_PER_DAY ||
    legacy.reviewsPerDay !== DEFAULT_REVIEWS_PER_DAY ||
    legacy.desiredRetention !== DEFAULT_DESIRED_RETENTION ||
    legacy.maximumInterval !== DEFAULT_MAXIMUM_INTERVAL ||
    !!legacy.learningSteps?.length ||
    !!legacy.relearningSteps?.length ||
    !!legacy.w
  );
}

// --- UI labels (Anki's deck-options wording) -----------------------------------------------------

export const GATHER_PRIORITY_LABELS: Record<NewGatherPriority, string> = {
  deck: 'Deck',
  positionAsc: 'Ascending position',
  positionDesc: 'Descending position',
  randomNotes: 'Random notes',
  randomCards: 'Random cards',
};

export const NEW_SORT_ORDER_LABELS: Record<NewSortOrder, string> = {
  template: 'Card type, then order gathered',
  gathered: 'Order gathered',
  templateThenRandom: 'Card type, then random',
  randomNoteThenTemplate: 'Random note, then card type',
  random: 'Random',
};

export const REVIEW_MIX_LABELS: Record<ReviewMix, string> = {
  mix: 'Mix with reviews',
  afterReviews: 'Show after reviews',
  beforeReviews: 'Show before reviews',
};

export const REVIEW_SORT_ORDER_LABELS: Record<ReviewSortOrder, string> = {
  dueDateRandom: 'Due date, then random',
  dueDateDeck: 'Due date, then deck',
  intervalsAsc: 'Ascending intervals',
  intervalsDesc: 'Descending intervals',
  difficultyAsc: 'Ascending difficulty',
  difficultyDesc: 'Descending difficulty',
  retrievabilityAsc: 'Ascending retrievability',
};

export const LEECH_ACTION_LABELS: Record<LeechAction, string> = {
  suspend: 'Suspend card',
  tagOnly: 'Tag only',
};

export const INSERTION_ORDER_LABELS: Record<InsertionOrder, string> = {
  sequential: 'Sequential (oldest cards first)',
  random: 'Random',
};
