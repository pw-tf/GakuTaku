/** Record types shared between the preprocess build script and the runtime store. */

export type DictType = 'word' | 'name' | 'kanji';

export interface WordSense {
  pos: string[];
  gloss: string[];
}

export interface WordData {
  kanji: string[];
  kana: string[];
  senses: WordSense[];
  common: boolean;
}

export interface NameData {
  kanji: string[];
  kana: string[];
  translations: { type: string[]; text: string[] }[];
}

export interface KanjiData {
  literal: string;
  onyomi: string[];
  kunyomi: string[];
  meanings: string[];
  grade?: number;
  jlpt?: number;
  strokeCount?: number;
}

/** A stored, searchable record. `forms` is multiEntry-indexed for O(1) lookup by any headword. */
export interface DictRecord {
  id: string; // `${type}:${sourceId}`
  type: DictType;
  forms: string[];
  data: WordData | NameData | KanjiData;
}

/** Shape returned by the worker's lookup() to the UI. */
export interface LookupResult {
  query: string;
  words: WordData[];
  names: NameData[];
  kanji: KanjiData[];
}

/** Manifest describing the hosted dictionary shards (written by build-dict, read by the loader). */
export interface DictManifest {
  version: string;
  shards: { path: string; count: number }[];
  totalRecords: number;
}
