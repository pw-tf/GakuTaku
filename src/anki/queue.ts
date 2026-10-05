import { powerForgettingCurve, prepareParameters } from './fsrs';
import { compareDeckNames, LimitTree } from './limits';
import type { Timing } from './timing';
import { CardQueue, type Deck, type DeckConfig, type ReviewMix, type ReviewOrder } from './types';

/**
 * The study queue — a port of rslib/src/scheduler/queue/ (builder/{mod,gathering,sorting,burying,
 * intersperser}.rs, learning.rs, main.rs, mod.rs). {@link buildQueues} gathers today's cards for a
 * deck (respecting daily limits, sibling burying and the preset's display order) and
 * {@link CardQueues} hands them out one at a time, re-queueing learning cards and keeping the
 * new/learn/review counts exactly as Anki does.
 */

/** The card columns the queue needs. */
export interface QueueCard {
  id: number;
  nid: number;
  did: number;
  ord: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  mod: number;
  reps: number;
  stability: number | null;
  difficulty: number | null;
  last_review: number | null;
}

export type EntryKind = 'new' | 'learning' | 'review';
interface MainEntry {
  id: number;
  kind: 'new' | 'review' | 'interdayLearning';
}
interface LearningEntry {
  id: number;
  due: number;
  reps: number;
}

export interface Counts {
  new: number;
  learning: number;
  review: number;
}

// ---- FNV-1a (Anki's `fnvhash`) -------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** FNV-1a over little-endian i64 values, as Anki's `FnvHasher::write_i64`. Returns an unsigned 64-bit hash. */
export function fnvHash(...values: number[]): bigint {
  let h = FNV_OFFSET;
  for (const v of values) {
    let x = BigInt.asUintN(64, BigInt(Math.trunc(v)));
    for (let i = 0; i < 8; i++) {
      h ^= x & 0xffn;
      h = BigInt.asUintN(64, h * FNV_PRIME);
      x >>= 8n;
    }
  }
  return h;
}
/** As SQLite sees it (`hasher.finish() as i64`). */
const fnvSigned = (...v: number[]) => BigInt.asIntN(64, fnvHash(...v));
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

// ---- Burying ------------------------------------------------------------------------

interface BuryMode {
  buryNew: boolean;
  buryReviews: boolean;
  buryInterdayLearning: boolean;
}
const NO_BURY: BuryMode = { buryNew: false, buryReviews: false, buryInterdayLearning: false };
const buryModeOf = (c: DeckConfig | undefined): BuryMode =>
  c ? { buryNew: c.buryNew, buryReviews: c.buryReviews, buryInterdayLearning: c.buryInterdayLearning } : NO_BURY;

// ---- Builder -------------------------------------------------------------------------

export interface QueueBuildInput {
  timing: Timing;
  learnAheadSecs: number;
  /** The deck being studied. */
  rootDeckId: number;
  /** Every deck (used for names, configs and parent limits). */
  decks: Deck[];
  configs: Map<number, DeckConfig>;
  /** Candidate cards in the root deck and its subdecks (any queue ≥ 0). */
  cards: QueueCard[];
  newCardsIgnoreReviewLimit: boolean;
  applyAllParentLimits: boolean;
  fsrs: boolean;
}

/** Study the whole collection rather than one deck. */
export const WHOLE_COLLECTION = 0;

function syntheticRoot(): Deck {
  return {
    id: WHOLE_COLLECTION, name: '', conf_id: -1, description: '', review_limit: null, new_limit: null, review_limit_today: null,
    new_limit_today: null, desired_retention: null, collapsed: false, last_day_studied: 0, new_studied: 0, review_studied: 0,
    learning_studied: 0, ms_studied: 0,
  };
}

function isUnder(name: string, root: string) {
  return name === root || name.startsWith(root + '::');
}

function reviewComparator(order: ReviewOrder, input: QueueBuildInput, deckRank: Map<number, number>): (a: QueueCard, b: QueueCard) => number {
  const { timing, fsrs } = input;
  const rnd = (a: QueueCard, b: QueueCard) => cmpBig(fnvSigned(a.id, a.mod), fnvSigned(b.id, b.mod));
  const confOf = new Map(input.decks.map((d) => [d.id, d.conf_id]));
  const deckCfg = (c: QueueCard) => input.configs.get(confOf.get(c.did) ?? 1);
  const r = (c: QueueCard) => {
    if (c.stability == null) return 1;
    const cfg = deckCfg(c);
    const w = prepareParameters(cfg?.fsrsParams ?? []);
    const elapsed = c.last_review != null ? Math.max(0, Math.floor((timing.nextDayAt - c.last_review) / 86_400)) : Math.max(0, timing.today - (c.due - c.ivl));
    return powerForgettingCurve(w, elapsed, c.stability);
  };
  const rCache = new Map<number, number>();
  const rOf = (c: QueueCard) => rCache.get(c.id) ?? (rCache.set(c.id, r(c)), rCache.get(c.id)!);
  const sub: ((a: QueueCard, b: QueueCard) => number)[] = [];
  const day = (a: QueueCard, b: QueueCard) => a.due - b.due;
  const deck = (a: QueueCard, b: QueueCard) => (deckRank.get(a.did) ?? 0) - (deckRank.get(b.did) ?? 0);
  switch (order) {
    case 'day': sub.push(day); break;
    case 'dayThenDeck': sub.push(day, deck); break;
    case 'deckThenDay': sub.push(deck, day); break;
    case 'intervalsAscending': sub.push((a, b) => a.ivl - b.ivl); break;
    case 'intervalsDescending': sub.push((a, b) => b.ivl - a.ivl); break;
    case 'easeAscending':
      sub.push(fsrs ? (a, b) => (b.difficulty ?? 0) - (a.difficulty ?? 0) : (a, b) => a.factor - b.factor);
      break;
    case 'easeDescending':
      sub.push(fsrs ? (a, b) => (a.difficulty ?? 0) - (b.difficulty ?? 0) : (a, b) => b.factor - a.factor);
      break;
    case 'retrievabilityAscending': sub.push((a, b) => rOf(a) - rOf(b)); break;
    case 'retrievabilityDescending': sub.push((a, b) => rOf(b) - rOf(a)); break;
    case 'relativeOverdueness':
      sub.push(fsrs ? (a, b) => rOf(a) - rOf(b) : (a, b) => {
        const k = (c: QueueCard) => -(1 + (timing.today - c.due + 0.001) / Math.max(c.ivl, 1));
        return k(a) - k(b);
      });
      break;
    case 'random': break;
    case 'added': sub.push((a, b) => a.nid - b.nid || a.ord - b.ord); break;
    case 'reverseAdded': sub.push((a, b) => b.nid - a.nid || a.ord - b.ord); break;
  }
  sub.push(rnd);
  return (a, b) => {
    for (const f of sub) {
      const v = f(a, b);
      if (v !== 0) return v;
    }
    return 0;
  };
}

/** Evenly mix two lists (Anki's `Intersperser`). */
function intersperse<T>(one: T[], two: T[]): T[] {
  const out: T[] = [];
  const ratio = (one.length + 1) / (two.length + 1);
  let i = 0;
  let j = 0;
  while (i < one.length || j < two.length) {
    if (i < one.length && j < two.length) {
      if ((j + 1) * ratio < i + 1) out.push(two[j++]);
      else out.push(one[i++]);
    } else if (i < one.length) out.push(one[i++]);
    else out.push(two[j++]);
  }
  return out;
}

/** Anki `merge_day_learning` / `merge_new`: place `other` relative to `reviews`. */
function mix<T>(reviews: T[], other: T[], mode: ReviewMix): T[] {
  switch (mode) {
    case 'afterReviews': return [...reviews, ...other];
    case 'beforeReviews': return [...other, ...reviews];
    case 'mix': return intersperse(reviews, other);
  }
}

export function buildQueues(input: QueueBuildInput): CardQueues {
  const { timing, configs } = input;
  const deckById = new Map(input.decks.map((d) => [d.id, d]));
  // rootDeckId 0 = the whole collection: an unnamed, unlimited root above the top-level decks.
  const wholeCollection = input.rootDeckId === WHOLE_COLLECTION;
  const root = wholeCollection ? syntheticRoot() : deckById.get(input.rootDeckId);
  if (!root) throw new Error('Deck not found');

  const sortedDecks = [...input.decks].sort((a, b) => compareDeckNames(a.name, b.name));
  const active = wholeCollection ? sortedDecks : sortedDecks.filter((d) => isUnder(d.name, root.name));
  const activeIds = new Set(active.map((d) => d.id));
  const limitDecks = wholeCollection
    ? [root, ...active]
    : input.applyAllParentLimits
      ? [...sortedDecks.filter((d) => isUnder(root.name, d.name) && d.id !== root.id), ...active]
      : active;
  const limits = new LimitTree(limitDecks, configs, timing.today, input.newCardsIgnoreReviewLimit);
  const deckRank = new Map(active.map((d, i) => [d.id, i]));
  const rootCfg = configs.get(root.conf_id);
  const sort = {
    newGather: rootCfg?.newCardGatherPriority ?? 'deck',
    newSort: rootCfg?.newCardSortOrder ?? 'template',
    reviewOrder: rootCfg?.reviewOrder ?? 'day',
    dayLearnMix: rootCfg?.interdayLearningMix ?? 'mix',
    newMix: rootCfg?.newMix ?? 'mix',
  };

  const seenNotes = new Map<number, BuryMode>();
  /** Returns the note's bury mode *before* this card (Anki `get_and_update_bury_mode_for_note`). */
  const buryModeForNote = (c: QueueCard): BuryMode | null => {
    const mode = buryModeOf(configs.get(deckById.get(c.did)?.conf_id ?? -1));
    const prev = seenNotes.get(c.nid);
    if (prev) {
      seenNotes.set(c.nid, {
        buryNew: prev.buryNew || mode.buryNew,
        buryReviews: prev.buryReviews || mode.buryReviews,
        buryInterdayLearning: prev.buryInterdayLearning || mode.buryInterdayLearning,
      });
      return prev;
    }
    seenNotes.set(c.nid, mode);
    return null;
  };

  const cards = input.cards.filter((c) => activeIds.has(c.did));

  // 1. intraday learning (no limits)
  const learning: LearningEntry[] = [];
  for (const c of cards.filter((c) => (c.queue === CardQueue.Learn || c.queue === CardQueue.PreviewRepeat) && c.due <= timing.nextDayAt)) {
    buryModeForNote(c);
    learning.push({ id: c.id, due: c.due, reps: c.reps });
  }

  // 2. interday learning, then 3. reviews
  const cmp = reviewComparator(sort.reviewOrder, input, deckRank);
  const gatherDue = (queue: CardQueue, kind: 'learning' | 'review', into: QueueCard[]) => {
    if (limits.rootLimitReached('review')) return;
    const due = cards.filter((c) => c.queue === queue && c.due <= timing.today).sort(cmp);
    for (const c of due) {
      if (limits.rootLimitReached('review')) break;
      if (limits.limitReached(c.did, 'review')) continue;
      const prev = buryModeForNote(c);
      const bury = prev ? (kind === 'review' ? prev.buryReviews : prev.buryInterdayLearning) : false;
      if (!bury) {
        into.push(c);
        limits.decrement(c.did, 'review');
      }
    }
  };
  const dayLearning: QueueCard[] = [];
  const reviews: QueueCard[] = [];
  gatherDue(CardQueue.DayLearn, 'learning', dayLearning);
  gatherDue(CardQueue.Review, 'review', reviews);

  // 4. new cards
  const salt = (timing.today * 2654435761) >>> 0;
  const newCards = cards.filter((c) => c.queue === CardQueue.New);
  const byPosition = (desc: boolean) => (a: QueueCard, b: QueueCard) => (desc ? b.due - a.due : a.due - b.due) || a.ord - b.ord;
  const byRandomNotes = (a: QueueCard, b: QueueCard) => cmpBig(fnvSigned(a.nid, salt), fnvSigned(b.nid, salt)) || a.ord - b.ord;
  const byRandomCards = (a: QueueCard, b: QueueCard) => cmpBig(fnvSigned(a.id, salt), fnvSigned(b.id, salt));
  const gathered: QueueCard[] = [];
  const tryAdd = (c: QueueCard) => {
    const prev = buryModeForNote(c);
    if (prev?.buryNew) return;
    gathered.push(c);
    limits.decrement(c.did, 'new');
  };
  if (sort.newGather === 'deck' || sort.newGather === 'deckThenRandomNotes') {
    const order = sort.newGather === 'deck' ? byPosition(false) : byRandomNotes;
    for (const d of active) {
      if (limits.rootLimitReached('new')) break;
      if (limits.limitReached(d.id, 'new')) continue;
      for (const c of newCards.filter((c) => c.did === d.id).sort(order)) {
        if (limits.limitReached(d.id, 'new')) break;
        tryAdd(c);
      }
    }
  } else {
    const order =
      sort.newGather === 'lowestPosition' ? byPosition(false)
      : sort.newGather === 'highestPosition' ? byPosition(true)
      : sort.newGather === 'randomNotes' ? byRandomNotes
      : byRandomCards;
    for (const c of [...newCards].sort(order)) {
      if (limits.rootLimitReached('new')) break;
      if (!limits.limitReached(c.did, 'new')) tryAdd(c);
    }
  }

  // sort new (sorting.rs)
  let sortedNew = gathered;
  const idHash = (c: QueueCard) => fnvHash(c.id, timing.today);
  const nidHash = (c: QueueCard) => fnvHash(c.nid, timing.today);
  switch (sort.newSort) {
    case 'noSort': break;
    case 'template': sortedNew = [...gathered].sort((a, b) => a.ord - b.ord); break;
    case 'templateThenRandom': sortedNew = [...gathered].sort((a, b) => a.ord - b.ord || cmpBig(idHash(a), idHash(b))); break;
    case 'randomNoteThenTemplate': sortedNew = [...gathered].sort((a, b) => cmpBig(nidHash(a), nidHash(b)) || a.ord - b.ord); break;
    case 'randomCard': sortedNew = [...gathered].sort((a, b) => cmpBig(idHash(a), idHash(b))); break;
  }

  // build
  learning.sort((a, b) => Number(a.reps === 0) - Number(b.reps === 0) || a.due - b.due);
  const cutoff = timing.now + input.learnAheadSecs;
  const learnCount = learning.filter((e) => e.due <= cutoff).length + dayLearning.length;
  const reviewEntries: MainEntry[] = reviews.map((c) => ({ id: c.id, kind: 'review' }));
  const dayLearnEntries: MainEntry[] = dayLearning.map((c) => ({ id: c.id, kind: 'interdayLearning' }));
  const withDayLearn = mix(reviewEntries, dayLearnEntries, sort.dayLearnMix);
  const main = mix(withDayLearn, sortedNew.map((c): MainEntry => ({ id: c.id, kind: 'new' })), sort.newMix);

  return new CardQueues({
    counts: { new: sortedNew.length, review: reviews.length, learning: learnCount },
    main,
    learning,
    today: timing.today,
    learnAheadSecs: input.learnAheadSecs,
    cutoff: timing.now,
  });
}

// ---- Runtime --------------------------------------------------------------------------

export interface QueueEntry {
  id: number;
  kind: EntryKind;
  /** Where it came from, for undo. */
  source: 'learning' | 'main';
}

interface QueueSnapshot {
  counts: Counts;
  main: MainEntry[];
  learning: LearningEntry[];
  cutoff: number;
}

export class CardQueues {
  private counts: Counts;
  private main: MainEntry[];
  private learning: LearningEntry[];
  readonly today: number;
  private readonly learnAheadSecs: number;
  private cutoff: number;

  constructor(init: { counts: Counts; main: MainEntry[]; learning: LearningEntry[]; today: number; learnAheadSecs: number; cutoff: number }) {
    this.counts = init.counts;
    this.main = init.main;
    this.learning = init.learning;
    this.today = init.today;
    this.learnAheadSecs = init.learnAheadSecs;
    this.cutoff = init.cutoff;
  }

  private aheadCutoff() {
    return this.cutoff + this.learnAheadSecs;
  }

  /** Current counts; when all are zero, newly-due learning cards are pulled in first (Anki `counts()`). */
  getCounts(nowSecs: number): Counts {
    if (this.counts.new === 0 && this.counts.learning === 0 && this.counts.review === 0) this.updateLearningCutoffAndCount(nowSecs);
    return { ...this.counts };
  }

  /** The next card to show, or null when done for now. */
  next(nowSecs: number): QueueEntry | null {
    this.getCounts(nowSecs);
    const now = this.learning.find((e) => e.due <= this.cutoff);
    if (now) return { id: now.id, kind: 'learning', source: 'learning' };
    const head = this.main[0];
    if (head) return { id: head.id, kind: head.kind === 'new' ? 'new' : head.kind === 'review' ? 'review' : 'learning', source: 'main' };
    const ahead = this.learning.find((e) => e.due > this.cutoff && e.due <= this.aheadCutoff());
    if (ahead) return { id: ahead.id, kind: 'learning', source: 'learning' };
    return null;
  }

  /** The earliest intraday learning card still waiting (for "come back in N minutes"). */
  nextLearningDue(): number | null {
    return this.learning.length ? Math.min(...this.learning.map((e) => e.due)) : null;
  }

  snapshot(): QueueSnapshot {
    return { counts: { ...this.counts }, main: [...this.main], learning: [...this.learning], cutoff: this.cutoff };
  }

  restore(s: QueueSnapshot): void {
    this.counts = { ...s.counts };
    this.main = [...s.main];
    this.learning = [...s.learning];
    this.cutoff = s.cutoff;
  }

  /** Remove `id` (which must be the card just shown) and adjust counts (Anki `pop_entry`). */
  pop(id: number): void {
    const li = this.learning.findIndex((e) => e.id === id);
    if (li >= 0) {
      this.learning.splice(li, 1);
      this.counts.learning = Math.max(0, this.counts.learning - 1);
      return;
    }
    if (this.main[0]?.id === id) {
      const head = this.main.shift()!;
      if (head.kind === 'new') this.counts.new -= 1;
      else if (head.kind === 'review') this.counts.review -= 1;
      else this.counts.learning = Math.max(0, this.counts.learning - 1);
      return;
    }
    // Not at the top (e.g. answered from elsewhere): drop it wherever it is.
    const mi = this.main.findIndex((e) => e.id === id);
    if (mi >= 0) {
      const [e] = this.main.splice(mi, 1);
      if (e.kind === 'new') this.counts.new -= 1;
      else if (e.kind === 'review') this.counts.review -= 1;
      else this.counts.learning = Math.max(0, this.counts.learning - 1);
    }
  }

  /** Drop cards that were buried/suspended/deleted mid-session. */
  remove(ids: Set<number>): void {
    for (const id of ids) this.pop(id);
  }

  /** After answering: put an intraday learning card back if it's still due today (Anki `maybe_requeue_learning_card`). */
  requeueLearning(card: { id: number; queue: number; due: number; reps: number }, nextDayAt: number): void {
    if ((card.queue === CardQueue.Learn || card.queue === CardQueue.PreviewRepeat) && card.due < nextDayAt) {
      const entry = { id: card.id, due: card.due, reps: card.reps };
      const cutoff = this.aheadCutoff();
      if (entry.due <= cutoff && this.main.length === 0) {
        const next = this.learning[0];
        if (next && next.due >= entry.due && next.due + 1 < cutoff) entry.due = next.due + 1;
      }
      if (entry.due <= this.aheadCutoff()) this.counts.learning += 1;
      const key = (e: LearningEntry): [number, number] => [Number(e.reps === 0), e.due];
      const k = key(entry);
      let idx = this.learning.findIndex((e) => {
        const ke = key(e);
        return ke[0] > k[0] || (ke[0] === k[0] && ke[1] > k[1]);
      });
      if (idx < 0) idx = this.learning.length;
      this.learning.splice(idx, 0, entry);
    }
  }

  /** Move the cutoff to now and count learning cards that became due (Anki `update_learning_cutoff_and_count`). */
  updateLearningCutoffAndCount(nowSecs: number): void {
    const lastAhead = this.aheadCutoff();
    this.cutoff = nowSecs;
    const newAhead = this.aheadCutoff();
    this.counts.learning += this.learning.filter((e) => e.due > lastAhead && e.due <= newAhead).length;
  }
}
