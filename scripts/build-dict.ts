/**
 * Preprocess jmdict-simplified release JSON into the app's on-demand dictionary buckets.
 *
 * Usage:
 *   1. Download these from https://github.com/scriptin/jmdict-simplified/releases/latest
 *      into ./dict-src/ :
 *        - jmdict-eng-<ver>.json        (full English JMdict)
 *        - jmnedict-all-<ver>.json      (names)
 *        - kanjidic2-en-<ver>.json      (kanji)
 *   2. npm run build:dict
 *      → writes ./dict-build/{manifest.json, kanji-jlpt.json.gz, b/0000.json.gz …}
 *   3. npm run upload:dict   (uploads ./dict-build to Supabase Storage)
 *
 * Each entry is filed under every headword it can be found by, and each headword lives in the
 * bucket its hash picks (src/dictionary/types.ts `bucketOf` — the runtime uses the same function).
 * A lookup therefore fetches only the one or two buckets its candidate forms fall in, which is why
 * the app needs no up-front download at all.
 *
 * Memory: entries are serialised as they stream in and flushed to per-bucket temp files, so peak
 * usage stays flat instead of holding the whole ~950k-record dictionary in the heap.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { loadDictionary } from '@scriptin/jmdict-simplified-loader';
import type {
  JMdictWord,
  JMnedictWord,
  Kanjidic2Character,
} from '@scriptin/jmdict-simplified-types';
import {
  bucketOf,
  bucketPath,
  KANJI_JLPT_PATH,
  type DictEntry,
  type DictManifest,
  type DictRecord,
  type KanjiData,
  type KanjiJlptIndex,
  type NameData,
  type WordData,
} from '../src/dictionary/types';

const SRC_DIR = 'dict-src';
const OUT_DIR = 'dict-build';
const TMP_DIR = join(OUT_DIR, '.tmp');
/** ~4k buckets keeps a single bucket around 20 KB gzipped — one lookup, one small request. */
const BUCKET_COUNT = 4096;
/** Form→entry pairs held in memory before they are appended to their bucket's temp file. */
const FLUSH_EVERY = 250_000;
/** Temp-file line separator; safe because neither a headword nor compact JSON contains a tab. */
const SEP = '\t';

function findFile(prefix: string): string {
  const match = readdirSync(SRC_DIR).find((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!match) throw new Error(`Missing ${SRC_DIR}/${prefix}*.json — download it from jmdict-simplified releases.`);
  return join(SRC_DIR, match);
}

/**
 * Files each record under every one of its headwords, buffering to bounded memory and spilling to
 * one temp file per bucket. `finish()` then turns each temp file into its gzipped bucket.
 */
class BucketWriter {
  private pending = new Map<number, string[]>();
  private buffered = 0;
  /** Distinct records seen (a record filed under three headwords still counts once). */
  records = 0;
  formEntries = 0;

  constructor() {
    mkdirSync(TMP_DIR, { recursive: true });
    mkdirSync(join(OUT_DIR, 'b'), { recursive: true });
  }

  add(record: DictRecord): void {
    this.records++;
    const entry: DictEntry = { id: record.id, type: record.type, data: record.data };
    const json = JSON.stringify(entry);
    for (const form of new Set(record.forms)) {
      if (!form) continue;
      const bucket = bucketOf(form, BUCKET_COUNT);
      const list = this.pending.get(bucket);
      if (list) list.push(form + SEP + json);
      else this.pending.set(bucket, [form + SEP + json]);
      this.formEntries++;
      this.buffered++;
    }
    if (this.buffered >= FLUSH_EVERY) this.flush();
  }

  flush(): void {
    for (const [bucket, lines] of this.pending) {
      appendFileSync(join(TMP_DIR, `${bucket}`), lines.join('\n') + '\n');
    }
    this.pending.clear();
    this.buffered = 0;
  }

  /** Collapse each bucket's temp file into `{ headword: [entry, …] }` and gzip it. */
  finish(): number {
    this.flush();
    let totalBytes = 0;
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      const tmp = join(TMP_DIR, `${bucket}`);
      const grouped: Record<string, unknown[]> = {};
      if (existsSync(tmp)) {
        for (const line of readFileSync(tmp, 'utf8').split('\n')) {
          if (!line) continue;
          const tab = line.indexOf(SEP);
          const form = line.slice(0, tab);
          (grouped[form] ??= []).push(JSON.parse(line.slice(tab + 1)));
        }
      }
      const gz = gzipSync(Buffer.from(JSON.stringify(grouped)), { level: 9 });
      // Synchronous: 4096 buffered write streams would exhaust the file-descriptor limit.
      writeFileSync(join(OUT_DIR, bucketPath(bucket)), gz);
      totalBytes += gz.length;
    }
    rmSync(TMP_DIR, { recursive: true, force: true });
    return totalBytes;
  }
}

const onlyEnglish = (lang: string) => lang === 'eng' || lang === 'en';

function mapWord(w: JMdictWord): DictRecord {
  const kanji = w.kanji.map((k) => k.text);
  const kana = w.kana.map((k) => k.text);
  const senses = w.sense.map((s) => ({
    pos: s.partOfSpeech,
    gloss: s.gloss.filter((g) => onlyEnglish(g.lang)).map((g) => g.text),
  }));
  const common = w.kanji.some((k) => k.common) || w.kana.some((k) => k.common);
  const data: WordData = { kanji, kana, senses, common };
  return { id: `word:${w.id}`, type: 'word', forms: [...new Set([...kanji, ...kana])], data };
}

function mapName(n: JMnedictWord): DictRecord {
  const kanji = n.kanji.map((k) => k.text);
  const kana = n.kana.map((k) => k.text);
  const translations = n.translation.map((t) => ({
    type: t.type,
    text: t.translation.filter((tr) => onlyEnglish(tr.lang)).map((tr) => tr.text),
  }));
  const data: NameData = { kanji, kana, translations };
  return { id: `name:${n.id}`, type: 'name', forms: [...new Set([...kanji, ...kana])], data };
}

function mapKanji(c: Kanjidic2Character): DictRecord {
  const onyomi: string[] = [];
  const kunyomi: string[] = [];
  const meanings: string[] = [];
  for (const group of c.readingMeaning?.groups ?? []) {
    for (const r of group.readings) {
      if (r.type === 'ja_on') onyomi.push(r.value);
      else if (r.type === 'ja_kun') kunyomi.push(r.value);
    }
    for (const m of group.meanings) {
      if (m.lang === 'en') meanings.push(m.value);
    }
  }
  const data: KanjiData = {
    literal: c.literal,
    onyomi,
    kunyomi,
    meanings,
    grade: c.misc.grade ?? undefined,
    jlpt: c.misc.jlptLevel ?? undefined,
    strokeCount: c.misc.strokeCounts[0],
  };
  return { id: `kanji:${c.literal}`, type: 'kanji', forms: [c.literal], data };
}

function streamInto<T>(
  type: 'jmdict' | 'jmnedict' | 'kanjidic',
  file: string,
  onRecord: (entry: T) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // NOTE: the loader only attaches its entry parser from inside the onMetadata callback,
    // so onMetadata MUST be registered or zero entries are emitted.
    const loader = loadDictionary(type, file)
      .onMetadata(() => {})
      .onEntry((entry: T) => onRecord(entry))
      .onEnd(() => resolve());
    loader.parser.on('error', reject);
  });
}

async function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const writer = new BucketWriter();
  /** Kanji → old-JLPT level, shipped separately: the reader needs a level for every kanji on
   *  screen, and one small index beats a bucket fetch per character. */
  const kanjiJlpt: KanjiJlptIndex = {};

  console.log('Processing JMdict (words)…');
  let words = 0;
  await streamInto<JMdictWord>('jmdict', findFile('jmdict-eng'), (w) => {
    writer.add(mapWord(w));
    words++;
  });
  console.log(`  ${words.toLocaleString()} words`);

  console.log('Processing JMnedict (names)…');
  let names = 0;
  await streamInto<JMnedictWord>('jmnedict', findFile('jmnedict'), (n) => {
    writer.add(mapName(n));
    names++;
  });
  console.log(`  ${names.toLocaleString()} names`);

  console.log('Processing KANJIDIC (kanji)…');
  let kanji = 0;
  await streamInto<Kanjidic2Character>('kanjidic', findFile('kanjidic2-en'), (c) => {
    const record = mapKanji(c);
    writer.add(record);
    const jlpt = (record.data as KanjiData).jlpt;
    if (jlpt !== undefined) kanjiJlpt[c.literal] = jlpt;
    kanji++;
  });
  console.log(`  ${kanji.toLocaleString()} kanji`);

  console.log(`Writing ${BUCKET_COUNT} buckets…`);
  const totalBytes = writer.finish();
  writeFileSync(join(OUT_DIR, KANJI_JLPT_PATH), gzipSync(Buffer.from(JSON.stringify(kanjiJlpt)), { level: 9 }));

  const totalRecords = writer.records;
  const manifest: DictManifest = {
    version: `${new Date().toISOString().slice(0, 10)}-${totalRecords}`,
    format: 'buckets-1',
    bucketCount: BUCKET_COUNT,
    totalRecords,
    totalBytes,
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`\nDone. ${totalRecords.toLocaleString()} records filed under ${writer.formEntries.toLocaleString()} headwords.`);
  console.log(`  ${BUCKET_COUNT} buckets, ${mb(totalBytes)} total, ~${(totalBytes / BUCKET_COUNT / 1024).toFixed(1)} KB each.`);
  console.log(`  Manifest version: ${manifest.version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
