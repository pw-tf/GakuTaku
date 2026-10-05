import { capTo, compareDeckNames, deckLevel, remainingLimits, UNLIMITED, type RemainingLimits } from './limits';
import type { Deck, DeckConfig } from './types';

/**
 * The deck list with due counts — a port of rslib/src/decks/tree.rs (`deck_tree` with
 * `sum_counts_and_apply_limits_v3`). These are the numbers Anki/AnkiDroid show next to each deck.
 */

/** Raw per-deck counts straight from the cards table (see `dueCountsSql`). */
export interface RawDueCounts {
  new: number;
  review: number;
  interdayLearning: number;
  intradayLearning: number;
  total: number;
}

export interface DeckTreeNode {
  deckId: number;
  /** Last name component. */
  name: string;
  fullName: string;
  level: number;
  collapsed: boolean;
  /** A filtered deck (Anki shows these in blue). */
  filtered: boolean;
  children: DeckTreeNode[];
  newCount: number;
  learnCount: number;
  reviewCount: number;
  /** Cards in this deck only / including subdecks. */
  totalInDeck: number;
  totalIncludingChildren: number;
}

/**
 * Per-deck raw counts. Params: `today` (day number) and `learnCutoff` (unix secs = now + learn-ahead).
 * Mirrors rslib/src/storage/deck/due_counts.sql.
 */
export const dueCountsSql = `
SELECT did,
  SUM(queue = 0) AS new,
  SUM(queue = 2 AND due <= ?1) AS review,
  SUM(queue = 3 AND due <= ?1) AS interday,
  SUM((queue = 1 AND due < ?2) OR (queue = 4 AND due <= ?2)) AS intraday,
  COUNT(1) AS total
FROM cards GROUP BY did`;

interface Counts {
  new: number;
  review: number;
  intraday: number;
  interday: number;
}

function capped(c: Counts, remaining: RemainingLimits): Counts {
  const out = { ...c };
  out.interday = Math.min(out.interday, remaining.review);
  let remainingReviews = Math.max(0, remaining.review - out.interday);
  out.review = Math.min(out.review, remainingReviews);
  out.new = Math.min(out.new, remaining.new);
  if (remaining.capNewToReview) {
    remainingReviews = Math.max(0, remainingReviews - out.review);
    out.new = Math.min(out.new, remainingReviews);
  }
  return out;
}

/** Build the name hierarchy (decks whose parent is missing are skipped, as in Anki). */
export function buildDeckNodes(decks: Deck[]): DeckTreeNode[] {
  const sorted = [...decks].sort((a, b) => compareDeckNames(a.name, b.name));
  const top: DeckTreeNode[] = [];
  const stack: DeckTreeNode[] = [];
  for (const d of sorted) {
    const level = deckLevel(d.name);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (level > 1 && (!parent || parent.level !== level - 1)) continue;
    const node: DeckTreeNode = {
      deckId: d.id,
      name: d.name.split('::').pop() ?? d.name,
      fullName: d.name,
      level,
      collapsed: d.collapsed,
      filtered: !!d.filtered,
      children: [],
      newCount: 0,
      learnCount: 0,
      reviewCount: 0,
      totalInDeck: 0,
      totalIncludingChildren: 0,
    };
    if (parent) parent.children.push(node);
    else top.push(node);
    stack.push(node);
  }
  return top;
}

export function deckTreeWithCounts(
  decks: Deck[],
  configs: Map<number, DeckConfig>,
  raw: Map<number, RawDueCounts>,
  today: number,
  opts: { newCardsIgnoreReviewLimit: boolean; applyAllParentLimits: boolean },
): DeckTreeNode[] {
  const roots = buildDeckNodes(decks);
  const limits = new Map<number, RemainingLimits>();
  for (const d of decks) limits.set(d.id, remainingLimits(d, configs.get(d.conf_id), today, opts.newCardsIgnoreReviewLimit));

  const visit = (node: DeckTreeNode, parentLimits: RemainingLimits | null): Counts => {
    let remaining = limits.get(node.deckId) ?? { ...UNLIMITED };
    let childParentLimits = parentLimits;
    if (parentLimits) {
      remaining = capTo(remaining, parentLimits);
      childParentLimits = remaining;
    }
    const r = raw.get(node.deckId);
    const uncapped: Counts = { new: r?.new ?? 0, review: r?.review ?? 0, intraday: r?.intradayLearning ?? 0, interday: r?.interdayLearning ?? 0 };
    node.totalInDeck = r?.total ?? 0;
    let total = node.totalInDeck;
    for (const child of node.children) {
      const c = visit(child, childParentLimits);
      uncapped.new += c.new;
      uncapped.review += c.review;
      uncapped.intraday += c.intraday;
      uncapped.interday += c.interday;
      total += child.totalIncludingChildren;
    }
    const out = capped(uncapped, remaining);
    node.newCount = out.new;
    node.reviewCount = out.review;
    node.learnCount = out.intraday + out.interday;
    node.totalIncludingChildren = total;
    return out;
  };
  for (const root of roots) visit(root, opts.applyAllParentLimits ? { ...UNLIMITED } : null);
  return roots;
}

/** Locate a deck in the tree. */
export function findDeckNode(roots: DeckTreeNode[], deckId: number): DeckTreeNode | null {
  for (const n of roots) {
    if (n.deckId === deckId) return n;
    const hit = findDeckNode(n.children, deckId);
    if (hit) return hit;
  }
  return null;
}

/** All deck ids in a subtree (the deck itself first). */
export function subtreeIds(node: DeckTreeNode): number[] {
  return [node.deckId, ...node.children.flatMap(subtreeIds)];
}
