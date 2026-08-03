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

/** A record as produced by the build script, before it is filed under each of its headwords. */
export interface DictRecord {
  id: string; // `${type}:${sourceId}`
  type: DictType;
  forms: string[];
  data: WordData | NameData | KanjiData;
}

/**
 * A record as it is stored and shipped. `forms` is dropped: a record is reachable by headword
 * through the bucket it is filed in, and `id` is all the runtime needs to de-duplicate a record
 * that was reached through more than one form.
 */
export interface DictEntry {
  id: string;
  type: DictType;
  data: WordData | NameData | KanjiData;
}

/** One downloadable bucket: the entries for every headword that hashes to it. */
export type DictBucket = Record<string, DictEntry[]>;

/**
 * Which bucket a headword lives in. Shared by the build script and the runtime — they must agree
 * exactly, so this is the single definition. FNV-1a over UTF-16 code units: cheap, stable across
 * engines, and spreads Japanese headwords evenly enough that no bucket ends up an outlier.
 */
export function bucketOf(form: string, bucketCount: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < form.length; i++) {
    h ^= form.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % bucketCount;
}

/** Zero-padded bucket file path, e.g. `b/0042.json.gz`. */
export function bucketPath(bucket: number): string {
  return `b/${String(bucket).padStart(4, '0')}.json.gz`;
}

/** KANJIDIC JLPT levels only (`literal` → old-JLPT 1–4), for the reader's "N3+" furigana density. */
export const KANJI_JLPT_PATH = 'kanji-jlpt.json.gz';
export type KanjiJlptIndex = Record<string, number>;

/** Shape returned by the worker's lookup() to the UI. */
export interface LookupResult {
  query: string;
  words: WordData[];
  names: NameData[];
  kanji: KanjiData[];
}

/** Manifest describing the hosted dictionary (written by build-dict, read by the store). */
export interface DictManifest {
  /** Bumped on every build; the client's caches are keyed by it, so a new build self-invalidates. */
  version: string;
  /** Payload layout, so an old client can refuse a build it cannot read instead of misparsing it. */
  format: 'buckets-1';
  bucketCount: number;
  totalRecords: number;
  /** Total compressed size of all buckets, for the optional offline download's size estimate. */
  totalBytes: number;
}
