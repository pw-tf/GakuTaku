import * as Comlink from 'comlink';
import Tokenizer, { type IpadicToken } from '@sglkc/kuromoji/src/Tokenizer';
import BrowserDictionaryLoader from '@sglkc/kuromoji/src/loader/BrowserDictionaryLoader';
import { alignFurigana, type FuriSegment } from './furigana';
import { ensureDictionary, isDictionaryLoaded, type LoadProgress } from '../dictionary/loader';
import { lookup as dictLookup } from '../dictionary/lookup';
import type { LookupResult } from '../dictionary/types';

const DIC_PATH = '/dict/kuromoji';

let tokenizerPromise: Promise<Tokenizer> | null = null;

function getTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise<Tokenizer>((resolve, reject) => {
      new BrowserDictionaryLoader(DIC_PATH).load((err: unknown, dic: unknown) => {
        if (err) reject(err);
        else resolve(new Tokenizer(dic));
      });
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
}

export interface TokenLite {
  surface: string;
  reading?: string;
  basic: string;
  pos: string;
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
    return tokenizer.tokenize(text).map((t: IpadicToken) => {
      const reading = cleanReading(t.reading);
      return {
        surface: t.surface_form,
        basic: t.basic_form,
        reading,
        pos: t.pos,
        segments: alignFurigana(t.surface_form, reading),
      };
    });
  },

  isDictionaryLoaded,

  async ensureDictionary(onProgress?: (p: LoadProgress) => void): Promise<void> {
    await ensureDictionary(onProgress ? (p) => void onProgress(p) : undefined);
  },

  async lookup(term: string, basicForm?: string): Promise<LookupResult> {
    return dictLookup(term, basicForm);
  },
};

export type JpCoreApi = typeof api;

Comlink.expose(api);
