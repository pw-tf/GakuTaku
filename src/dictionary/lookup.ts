import { dictDb } from './db';
import type { DictRecord, KanjiData, LookupResult, NameData, WordData } from './types';
import { deinflect } from '../jp-core/deinflect';

const KANJI_RE = /[一-龯㐀-䶿]/;

/**
 * Look up a term: tries the surface form, the (optional) kuromoji base form, and deinflection
 * candidates against the multiEntry `forms` index, then adds per-kanji info from KANJIDIC.
 */
export async function lookup(term: string, basicForm?: string): Promise<LookupResult> {
  const candidates = new Set<string>([term]);
  if (basicForm && basicForm !== '*') candidates.add(basicForm);
  for (const c of deinflect(term)) candidates.add(c);
  if (basicForm && basicForm !== '*') {
    for (const c of deinflect(basicForm)) candidates.add(c);
  }

  const matches = await dictDb.entries.where('forms').anyOf([...candidates]).toArray();

  const words: WordData[] = [];
  const names: NameData[] = [];
  const seen = new Set<string>();
  for (const rec of matches) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    if (rec.type === 'word') words.push(rec.data as WordData);
    else if (rec.type === 'name') names.push(rec.data as NameData);
  }
  // Common words first.
  words.sort((a, b) => Number(b.common) - Number(a.common));

  // Per-kanji info for any kanji in the term.
  const kanjiChars = [...new Set([...term].filter((ch) => KANJI_RE.test(ch)))];
  let kanji: KanjiData[] = [];
  if (kanjiChars.length) {
    const kanjiRecs = (await dictDb.entries.where('forms').anyOf(kanjiChars).toArray()).filter(
      (r: DictRecord) => r.type === 'kanji',
    );
    const order = new Map(kanjiChars.map((c, i) => [c, i]));
    kanji = kanjiRecs
      .map((r) => r.data as KanjiData)
      .sort((a, b) => (order.get(a.literal) ?? 0) - (order.get(b.literal) ?? 0));
  }

  return { query: term, words, names, kanji };
}

/**
 * Set of "advanced" kanji in the text — those at old-JLPT level ≤2 (≈N1/N2) or not listed at all.
 * Used for the reader's "N3+" furigana density (show readings only for harder words). Best-effort,
 * per-kanji (not per-word). Returns an empty set if the dictionary isn't loaded.
 */
export async function advancedKanji(text: string): Promise<string[]> {
  const chars = [...new Set([...text].filter((ch) => KANJI_RE.test(ch)))];
  if (!chars.length) return [];
  const recs = (await dictDb.entries.where('forms').anyOf(chars).toArray()).filter(
    (r: DictRecord) => r.type === 'kanji',
  );
  const jlptByChar = new Map<string, number | undefined>();
  for (const r of recs) {
    const k = r.data as KanjiData;
    jlptByChar.set(k.literal, k.jlpt);
  }
  return chars.filter((ch) => {
    const j = jlptByChar.get(ch);
    return j === undefined || j <= 2;
  });
}
