// Minimal ambient types for the (untyped, CommonJS) @sglkc/kuromoji deep imports we use.
// We bypass the default Node-loader entry and wire the browser loader + tokenizer directly.

declare module '@sglkc/kuromoji/src/Tokenizer' {
  export interface IpadicToken {
    word_id: number;
    word_type: string;
    word_position: number;
    surface_form: string;
    pos: string;
    pos_detail_1: string;
    pos_detail_2: string;
    pos_detail_3: string;
    conjugated_type: string;
    conjugated_form: string;
    basic_form: string;
    /** Katakana reading; may be undefined for unknown words. */
    reading?: string;
    pronunciation?: string;
  }
  export default class Tokenizer {
    constructor(dic: unknown);
    tokenize(text: string): IpadicToken[];
  }
}

declare module '@sglkc/kuromoji/src/loader/BrowserDictionaryLoader' {
  export default class BrowserDictionaryLoader {
    constructor(dicPath: string);
    load(callback: (err: unknown, dic: unknown) => void): void;
  }
}
