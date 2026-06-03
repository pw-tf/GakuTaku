/** A run of text, optionally annotated with a reading (furigana over the run). */
export interface FuriSegment {
  text: string;
  reading?: string;
}

const KANJI_RE = /[一-龯㐀-䶿豈-﫿々]/;

export function hasKanji(s: string): boolean {
  return KANJI_RE.test(s);
}

function isKanji(ch: string): boolean {
  return KANJI_RE.test(ch);
}

/** Katakana → hiragana (codepoint shift). Leaves everything else untouched. */
export function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * Align a token's surface form with its (katakana) reading, producing furigana segments.
 * Strips matching okurigana from the head and tail so the reading only covers the kanji core.
 * Good for the common ~95% of cases; ambiguous interior okurigana falls back to one ruby over
 * the whole kanji run (acceptable per the build plan's accuracy note).
 */
export function alignFurigana(surface: string, readingKatakana?: string): FuriSegment[] {
  if (!readingKatakana || !hasKanji(surface)) {
    return [{ text: surface }];
  }
  const reading = katakanaToHiragana(readingKatakana);
  const surfHira = katakanaToHiragana(surface);
  if (reading === surfHira) {
    return [{ text: surface }];
  }

  // Matching kana prefix.
  let p = 0;
  while (
    p < surface.length &&
    p < reading.length &&
    !isKanji(surface[p]) &&
    surfHira[p] === reading[p]
  ) {
    p++;
  }
  // Matching kana suffix (not overlapping the prefix).
  let s = 0;
  while (
    s < surface.length - p &&
    s < reading.length - p &&
    !isKanji(surface[surface.length - 1 - s]) &&
    surfHira[surface.length - 1 - s] === reading[reading.length - 1 - s]
  ) {
    s++;
  }

  const segments: FuriSegment[] = [];
  if (p > 0) segments.push({ text: surface.slice(0, p) });
  const midSurface = surface.slice(p, surface.length - s);
  const midReading = reading.slice(p, reading.length - s);
  if (midSurface) {
    segments.push(midReading ? { text: midSurface, reading: midReading } : { text: midSurface });
  }
  if (s > 0) segments.push({ text: surface.slice(surface.length - s) });
  return segments;
}
