/**
 * Compact, Yomitan-style deinflector. Produces candidate dictionary forms from a (possibly
 * conjugated) surface string by swapping inflectional endings. Deliberately over-generates —
 * the dictionary lookup validates candidates, so false candidates simply find no entry.
 *
 * For text that has been tokenized by kuromoji, the token's `basic_form` already covers the
 * common cases; this engine is the fallback for raw text selections and chained inflections.
 */

interface Rule {
  from: string;
  to: string[];
}

// Ordered roughly longest-suffix-first so more specific rules are tried.
const RULES: Rule[] = [
  // polite (ichidan stem + masu, and godan masu-stem)
  { from: 'ません', to: ['る'] },
  { from: 'ましょう', to: ['る'] },
  { from: 'ました', to: ['る'] },
  { from: 'まして', to: ['る'] },
  { from: 'ます', to: ['る'] },
  { from: 'きます', to: ['く'] },
  { from: 'ぎます', to: ['ぐ'] },
  { from: 'します', to: ['す'] },
  { from: 'ちます', to: ['つ'] },
  { from: 'にます', to: ['ぬ'] },
  { from: 'びます', to: ['ぶ'] },
  { from: 'みます', to: ['む'] },
  { from: 'ります', to: ['る'] },
  { from: 'います', to: ['う'] },

  // te / ta forms (godan)
  { from: 'って', to: ['う', 'つ', 'る'] },
  { from: 'った', to: ['う', 'つ', 'る'] },
  { from: 'んで', to: ['ぬ', 'ぶ', 'む'] },
  { from: 'んだ', to: ['ぬ', 'ぶ', 'む'] },
  { from: 'いて', to: ['く'] },
  { from: 'いた', to: ['く'] },
  { from: 'いで', to: ['ぐ'] },
  { from: 'いだ', to: ['ぐ'] },
  { from: 'して', to: ['す'] },
  { from: 'した', to: ['す'] },
  // te / ta forms (ichidan) + generic
  { from: 'て', to: ['る'] },
  { from: 'た', to: ['る'] },

  // negative (godan: あ-row + ない ; ichidan: stem + ない)
  { from: 'なかった', to: ['る'] },
  { from: 'かない', to: ['く'] },
  { from: 'がない', to: ['ぐ'] },
  { from: 'さない', to: ['す'] },
  { from: 'たない', to: ['つ'] },
  { from: 'なない', to: ['ぬ'] },
  { from: 'ばない', to: ['ぶ'] },
  { from: 'まない', to: ['む'] },
  { from: 'らない', to: ['る'] },
  { from: 'わない', to: ['う'] },
  { from: 'ない', to: ['る'] },

  // passive / potential / causative (ichidan-shaped results)
  { from: 'させられる', to: ['する', 'る'] },
  { from: 'られる', to: ['る'] },
  { from: 'させる', to: ['する', 'る'] },
  { from: 'られた', to: ['る'] },
  { from: 'せる', to: ['す'] },
  { from: 'れる', to: ['る'] },

  // desiderative / volitional
  { from: 'たい', to: ['る'] },
  { from: 'たく', to: ['る'] },
  { from: 'よう', to: ['る'] },

  // i-adjective
  { from: 'くなかった', to: ['い'] },
  { from: 'くない', to: ['い'] },
  { from: 'かった', to: ['い'] },
  { from: 'くて', to: ['い'] },
  { from: 'く', to: ['い'] },
];

const MAX_CANDIDATES = 60;

/**
 * Returns a deduped set of candidate dictionary forms (including the original term).
 * Applies rules over a couple of passes to catch chained inflections.
 */
export function deinflect(term: string): string[] {
  const results = new Set<string>([term]);
  let frontier = [term];

  for (let pass = 0; pass < 2 && results.size < MAX_CANDIDATES; pass++) {
    const next: string[] = [];
    for (const word of frontier) {
      for (const rule of RULES) {
        if (word.length > rule.from.length && word.endsWith(rule.from)) {
          const stem = word.slice(0, word.length - rule.from.length);
          for (const end of rule.to) {
            const candidate = stem + end;
            if (!results.has(candidate)) {
              results.add(candidate);
              next.push(candidate);
              if (results.size >= MAX_CANDIDATES) break;
            }
          }
        }
        if (results.size >= MAX_CANDIDATES) break;
      }
    }
    frontier = next;
  }

  return [...results];
}
