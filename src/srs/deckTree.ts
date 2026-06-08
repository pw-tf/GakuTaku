import type { DeckStat } from './srsHooks';

/**
 * Anki-style subdeck hierarchy derived from deck *names* (`Parent::Child::Leaf`) — no schema change,
 * matching how Anki itself models the tree and how imported deck names already arrive. Intermediate
 * parents that don't exist as their own deck become synthetic nodes; counts roll up to ancestors.
 */

export const DECK_SEP = '::';

export interface DeckNode {
  /** Full path, e.g. "JLPT::N3". */
  key: string;
  /** Last path segment, e.g. "N3". */
  label: string;
  depth: number;
  /** The real deck at this path, if one exists (null for synthetic intermediate parents). */
  deck: DeckStat | null;
  children: DeckNode[];
  /** This node's own counts plus all descendants'. */
  roll: { new: number; learning: number; due: number; total: number };
}

const empty = () => ({ new: 0, learning: 0, due: 0, total: 0 });

export function buildDeckTree(decks: DeckStat[]): DeckNode[] {
  const byKey = new Map<string, DeckNode>();
  const roots: DeckNode[] = [];

  function ensure(path: string[]): DeckNode {
    const key = path.join(DECK_SEP);
    let node = byKey.get(key);
    if (!node) {
      node = { key, label: path[path.length - 1], depth: path.length - 1, deck: null, children: [], roll: empty() };
      byKey.set(key, node);
      if (path.length === 1) roots.push(node);
      else ensure(path.slice(0, -1)).children.push(node);
    }
    return node;
  }

  for (const d of decks) {
    const path = d.name.split(DECK_SEP).map((s) => s.trim()).filter(Boolean);
    if (path.length === 0) continue;
    ensure(path).deck = d;
  }

  const roll = (n: DeckNode): DeckNode['roll'] => {
    const r = n.deck ? { new: n.deck.new, learning: n.deck.learning, due: n.deck.due, total: n.deck.total } : empty();
    for (const c of n.children) {
      const cr = roll(c);
      r.new += cr.new; r.learning += cr.learning; r.due += cr.due; r.total += cr.total;
    }
    n.roll = r;
    return r;
  };
  const sort = (nodes: DeckNode[]) => {
    nodes.sort((a, b) => a.label.localeCompare(b.label));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  roots.forEach(roll);
  return roots;
}

/** All real deck ids at and under a node — the set to study when "Study" is hit on a parent. */
export function descendantDeckIds(node: DeckNode): string[] {
  const ids: string[] = [];
  const walk = (n: DeckNode) => { if (n.deck) ids.push(n.deck.id); n.children.forEach(walk); };
  walk(node);
  return ids;
}

/** Flatten the tree into render order, hiding children of collapsed nodes. */
export function flattenVisible(roots: DeckNode[], collapsed: Set<string>): DeckNode[] {
  const out: DeckNode[] = [];
  const walk = (n: DeckNode) => {
    out.push(n);
    if (!collapsed.has(n.key)) n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/** Find a node by the deck id it carries. */
export function findNodeByDeckId(roots: DeckNode[], deckId: string): DeckNode | null {
  let found: DeckNode | null = null;
  const walk = (n: DeckNode) => {
    if (found) return;
    if (n.deck?.id === deckId) { found = n; return; }
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return found;
}
