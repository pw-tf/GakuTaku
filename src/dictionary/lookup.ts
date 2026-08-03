import { entriesForForms, getKanjiJlpt } from './store';
import type { KanjiData, LookupResult, NameData, WordData } from './types';
import { deinflect } from '../jp-core/deinflect';

const KANJI_RE = /[一-龯㐀-䶿]/;

/**
 * Look up a term: tries the surface form, the (optional) kuromoji base form, and deinflection
 * candidates, then adds per-kanji info from KANJIDIC.
 *
 * Every form is resolved in one pass so the whole lookup costs however many *distinct buckets*
 * the candidates hash into — usually one or two requests, and none once they are cached.
 */
export async function lookup(term: string, basicForm?: string): Promise<LookupResult> {
  const candidates = new Set<string>([term]);
  if (basicForm && basicForm !== '*') candidates.add(basicForm);
  for (const c of deinflect(term)) candidates.add(c);
  if (basicForm && basicForm !== '*') {
    for (const c of deinflect(basicForm)) candidates.add(c);
  }
  const kanjiChars = [...new Set([...term].filter((ch) => KANJI_RE.test(ch)))];

  const entries = await entriesForForms([...candidates, ...kanjiChars]);

  const words: WordData[] = [];
  const names: NameData[] = [];
  const kanjiByLiteral = new Map<string, KanjiData>();
  for (const entry of entries) {
    if (entry.type === 'kanji') {
      const k = entry.data as KanjiData;
      kanjiByLiteral.set(k.literal, k);
    } else if (entry.type === 'word') {
      words.push(entry.data as WordData);
    } else if (entry.type === 'name') {
      names.push(entry.data as NameData);
    }
  }
  // Common words first.
  words.sort((a, b) => Number(b.common) - Number(a.common));

  const kanji = kanjiChars.map((ch) => kanjiByLiteral.get(ch)).filter((k): k is KanjiData => !!k);

  return { query: term, words, names, kanji };
}

/**
 * Set of "advanced" kanji in the text — those at old-JLPT level ≤2 (≈N1/N2) or not listed at all.
 * Used for the reader's "N3+" furigana density (show readings only for harder words). Best-effort,
 * per-kanji (not per-word). Returns null when the dictionary can't be reached at all, so callers
 * can tell "no advanced kanji here" apart from "we don't know".
 */
export async function advancedKanji(text: string): Promise<string[] | null> {
  const chars = [...new Set([...text].filter((ch) => KANJI_RE.test(ch)))];
  if (!chars.length) return [];
  let jlpt: Record<string, number>;
  try {
    jlpt = await getKanjiJlpt();
  } catch {
    return null; // offline before the index was ever cached
  }
  return chars.filter((ch) => {
    const j = jlpt[ch];
    return j === undefined || j <= 2;
  });
}
