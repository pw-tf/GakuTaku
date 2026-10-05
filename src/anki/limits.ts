import type { Deck, DeckConfig } from './types';

/**
 * Daily limits — a port of rslib/src/decks/limits.rs (v3 scheduler). A deck's remaining new/review
 * allowance for today is its limit (today-only override → deck override → preset) minus what was
 * already studied today; children are capped by their parents.
 */

export interface RemainingLimits {
  review: number;
  new: number;
  capNewToReview: boolean;
}

export const UNLIMITED: RemainingLimits = { review: 9999, new: 9999, capNewToReview: false };

export function currentReviewLimit(deck: Deck, today: number): number | null {
  if (deck.review_limit_today && deck.review_limit_today.today === today) return deck.review_limit_today.limit;
  return deck.review_limit;
}

export function currentNewLimit(deck: Deck, today: number): number | null {
  if (deck.new_limit_today && deck.new_limit_today.today === today) return deck.new_limit_today.limit;
  return deck.new_limit;
}

/** Studied-today counters, or zero if they belong to another day. */
export function newRevCounts(deck: Deck, today: number): [number, number] {
  return deck.last_day_studied === today ? [deck.new_studied, deck.review_studied] : [0, 0];
}

export function remainingLimits(deck: Deck, config: DeckConfig | undefined, today: number, newCardsIgnoreReviewLimit: boolean): RemainingLimits {
  if (!config) return { ...UNLIMITED };
  let review = currentReviewLimit(deck, today) ?? config.reviewsPerDay;
  let newL = currentNewLimit(deck, today) ?? config.newPerDay;
  const [newToday, reviewToday] = newRevCounts(deck, today);
  review -= reviewToday;
  newL -= newToday;
  if (!newCardsIgnoreReviewLimit) {
    review -= newToday;
    newL = Math.min(newL, review);
  }
  return { review: Math.max(0, review), new: Math.max(0, newL), capNewToReview: !newCardsIgnoreReviewLimit };
}

export function capTo(l: RemainingLimits, cap: RemainingLimits): RemainingLimits {
  return { ...l, review: Math.min(l.review, cap.review), new: Math.min(l.new, cap.new) };
}

export type LimitKind = 'review' | 'new';

/** Deck names compare component-wise, case-insensitively (Anki's `unicase` on `\x1f`-separated names). */
export function compareDeckNames(a: string, b: string): number {
  const ka = a.split('::').map((s) => s.toLowerCase());
  const kb = b.split('::').map((s) => s.toLowerCase());
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return ka.length - kb.length;
}

/** Depth of a deck name; the unnamed whole-collection root is level 0. */
export const deckLevel = (name: string) => (name ? name.split('::').length : 0);
export const parentName = (name: string) => {
  const i = name.lastIndexOf('::');
  return i < 0 ? null : name.slice(0, i);
};

interface Node {
  deckId: number;
  level: number;
  limits: RemainingLimits;
  parent: Node | null;
  children: Node[];
}

/** `LimitTreeMap`: the remaining limits of the active deck hierarchy, decremented as cards are gathered. */
export class LimitTree {
  private readonly byId = new Map<number, Node>();
  private readonly root: Node;

  /** `decks` must be sorted by name, root first. */
  constructor(decks: Deck[], configs: Map<number, DeckConfig>, today: number, newCardsIgnoreReviewLimit: boolean) {
    const make = (d: Deck, parent: Node | null): Node => {
      let limits = remainingLimits(d, configs.get(d.conf_id), today, newCardsIgnoreReviewLimit);
      if (parent) limits = capTo(limits, parent.limits);
      const node: Node = { deckId: d.id, level: deckLevel(d.name), limits, parent, children: [] };
      this.byId.set(d.id, node);
      parent?.children.push(node);
      return node;
    };
    this.root = make(decks[0], null);
    // Decks arrive depth-first; walk them against a stack of open ancestors.
    const stack: Node[] = [this.root];
    for (const d of decks.slice(1)) {
      const level = deckLevel(d.name);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      if (!parent || parent.level !== level - 1) continue; // immediate parent missing — skip, like Anki
      stack.push(make(d, parent));
    }
  }

  rootLimitReached(kind: LimitKind): boolean {
    return this.root.limits[kind] === 0;
  }

  limitReached(deckId: number, kind: LimitKind): boolean {
    const n = this.byId.get(deckId);
    return !n || n.limits[kind] === 0;
  }

  has(deckId: number): boolean {
    return this.byId.has(deckId);
  }

  decrement(deckId: number, kind: LimitKind): void {
    let node = this.byId.get(deckId) ?? null;
    while (node) {
      const before = node.limits;
      const after = { ...before };
      if (kind === 'review') {
        after.review = Math.max(0, after.review - 1);
        if (after.capNewToReview) after.new = Math.min(after.new, after.review);
      } else {
        after.new = Math.max(0, after.new - 1);
      }
      node.limits = after;
      const reachedZero = (before.review > 0 && after.review === 0) || (before.new > 0 && after.new === 0);
      if (reachedZero) this.capDescendants(node, after);
      node = node.parent;
    }
  }

  private capDescendants(node: Node, limits: RemainingLimits): void {
    node.limits = capTo(node.limits, limits);
    for (const c of node.children) this.capDescendants(c, limits);
  }
}
