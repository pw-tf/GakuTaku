import * as Comlink from 'comlink';
import Tokenizer, { type IpadicToken } from '@sglkc/kuromoji/src/Tokenizer';
import BrowserDictionaryLoader from '@sglkc/kuromoji/src/loader/BrowserDictionaryLoader';
import { fetchBundledGzip } from '../dictionary/bundledAsset';
import { alignFurigana, type FuriSegment } from './furigana';
import { lookup as dictLookup, advancedKanji } from '../dictionary/lookup';
import type { LookupResult } from '../dictionary/types';

const DIC_PATH = '/dict/kuromoji';

let tokenizerPromise: Promise<Tokenizer> | null = null;

/**
 * kuromoji's own browser loader only knows `x.dat.gz` and reports a failed read by its statusText
 * (always "OK" from Capacitor's local server). Read the files through {@link fetchBundledGzip}
 * instead, which also finds the inflated copies the Android build ships.
 */
class AppDictionaryLoader extends BrowserDictionaryLoader {
  loadArrayBuffer(url: string, callback: (err: unknown, buffer: ArrayBuffer | null) => void): void {
    fetchBundledGzip(url).then(
      (bytes) => callback(null, bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer)),
      (err: unknown) => callback(err, null),
    );
  }
}

function getTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise<Tokenizer>((resolve, reject) => {
      new AppDictionaryLoader(DIC_PATH).load((err: unknown, dic: unknown) => {
        if (err) reject(new Error(`Couldn’t load the Japanese tokenizer. ${err instanceof Error ? err.message : String(err)}`));
        else resolve(new Tokenizer(dic));
      });
    });
    tokenizerPromise.catch(() => {
      tokenizerPromise = null;
    });
  }
  return tokenizerPromise;
}

function cleanReading(reading?: string): string | undefined {
  return reading && reading !== '*' ? reading : undefined;
}

/** One tappable token plus its furigana segments. */
export interface FuriToken {
  surface: string;
  basic: string;
  reading?: string;
  pos: string;
  segments: FuriSegment[];
  /** True if the token contains an advanced (≈N1/N2) kanji. undefined when the dict isn't loaded. */
  adv?: boolean;
}

export interface TokenLite {
  surface: string;
  reading?: string;
  basic: string;
  pos: string;
}

/** Arabic numerals, half- or full-width (kuromoji leaves these without a reading). */
const NUMERAL = /^[0-9０-９]+$/;

/**
 * Tokens with furigana. The dictionary reads a lone 月 as つき, so after a number (10月) it would
 * gloss the month as "moon"; read it as がつ there.
 */
function toFuriTokens(tokens: IpadicToken[], advSet: Set<string> | null): FuriToken[] {
  return tokens.map((t, i) => {
    let reading = cleanReading(t.reading);
    if (t.surface_form === '月' && i > 0 && NUMERAL.test(tokens[i - 1].surface_form)) reading = 'ガツ';
    return {
      surface: t.surface_form,
      basic: t.basic_form,
      reading,
      pos: t.pos,
      segments: alignFurigana(t.surface_form, reading),
      adv: advSet ? [...t.surface_form].some((c) => advSet.has(c)) : undefined,
    };
  });
}

const api = {
  /** Build the tokenizer (loads the kuromoji dictionary once). */
  async warmup(): Promise<void> {
    await getTokenizer();
  },

  async tokenize(text: string): Promise<TokenLite[]> {
    const tokenizer = await getTokenizer();
    return tokenizer.tokenize(text).map((t: IpadicToken) => ({
      surface: t.surface_form,
      reading: cleanReading(t.reading),
      basic: t.basic_form,
      pos: t.pos,
    }));
  },

  /** Tokenize and attach furigana segments to each token (for rendering + tap-to-lookup). */
  async furiganaFor(text: string): Promise<FuriToken[]> {
    const tokenizer = await getTokenizer();
    const tokens = tokenizer.tokenize(text);
    // Advanced-kanji set for "N3+" density; null when the kanji index can't be reached.
    const advList = await advancedKanji(text);
    const advSet = advList ? new Set(advList) : null;
    return toFuriTokens(tokens, advSet);
  },

  /** Batched furigana for many paragraphs (one chapter) — computes the advanced-kanji set once. */
  async furiganaForMany(texts: string[]): Promise<FuriToken[][]> {
    const tokenizer = await getTokenizer();
    const advList = await advancedKanji(texts.join(''));
    const advSet = advList ? new Set(advList) : null;
    return texts.map((text) => toFuriTokens(tokenizer.tokenize(text), advSet));
  },

  async lookup(term: string, basicForm?: string): Promise<LookupResult> {
    return dictLookup(term, basicForm);
  },
};

export type JpCoreApi = typeof api;

Comlink.expose(api);
