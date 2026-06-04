/**
 * Preprocess jmdict-simplified release JSON into compact, sharded, gzipped NDJSON for the app.
 *
 * Usage:
 *   1. Download these from https://github.com/scriptin/jmdict-simplified/releases/latest
 *      into ./dict-src/ :
 *        - jmdict-eng-<ver>.json        (full English JMdict)
 *        - jmnedict-all-<ver>.json      (names)
 *        - kanjidic2-en-<ver>.json      (kanji)
 *   2. npm run build:dict
 *      → writes ./dict-build/{manifest.json, word/*.ndjson.gz, name/*.ndjson.gz, kanji/*.ndjson.gz}
 *   3. npm run upload:dict   (uploads ./dict-build to Supabase Storage)
 *
 * Output records use the shared DictRecord shape (src/dictionary/types.ts).
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { loadDictionary } from '@scriptin/jmdict-simplified-loader';
import type {
  JMdictWord,
  JMnedictWord,
  Kanjidic2Character,
} from '@scriptin/jmdict-simplified-types';
import type {
  DictManifest,
  DictRecord,
  KanjiData,
  NameData,
  WordData,
} from '../src/dictionary/types';

const SRC_DIR = 'dict-src';
const OUT_DIR = 'dict-build';
const SHARD_SIZE = 20_000; // records per shard (keeps gzipped shards well under 25 MiB)

function findFile(prefix: string): string {
  const match = readdirSync(SRC_DIR).find((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!match) throw new Error(`Missing ${SRC_DIR}/${prefix}*.json — download it from jmdict-simplified releases.`);
  return join(SRC_DIR, match);
}

/** Buffers records of one type and flushes them into numbered gzipped shards. */
class ShardWriter {
  private buffer: DictRecord[] = [];
  private index = 0;
  readonly shards: { path: string; count: number }[] = [];
  total = 0;

  constructor(private readonly type: string) {
    mkdirSync(join(OUT_DIR, type), { recursive: true });
  }

  add(record: DictRecord) {
    this.buffer.push(record);
    this.total++;
    if (this.buffer.length >= SHARD_SIZE) this.flush();
  }

  flush() {
    if (this.buffer.length === 0) return;
    const name = `${this.type}/${String(this.index).padStart(3, '0')}.ndjson.gz`;
    const ndjson = this.buffer.map((r) => JSON.stringify(r)).join('\n');
    createWriteStream(join(OUT_DIR, name)).end(gzipSync(ndjson));
    this.shards.push({ path: name, count: this.buffer.length });
    this.buffer = [];
    this.index++;
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
  writer: ShardWriter,
  map: (entry: T) => DictRecord,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // NOTE: the loader only attaches its entry parser from inside the onMetadata callback,
    // so onMetadata MUST be registered or zero entries are emitted.
    const loader = loadDictionary(type, file)
      .onMetadata(() => {})
      .onEntry((entry: T) => writer.add(map(entry)))
      .onEnd(() => {
        writer.flush();
        resolve();
      });
    loader.parser.on('error', reject);
  });
}

async function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const wordWriter = new ShardWriter('word');
  const nameWriter = new ShardWriter('name');
  const kanjiWriter = new ShardWriter('kanji');

  console.log('Processing JMdict (words)…');
  await streamInto<JMdictWord>('jmdict', findFile('jmdict-eng'), wordWriter, mapWord);
  console.log(`  ${wordWriter.total.toLocaleString()} words`);

  console.log('Processing JMnedict (names)…');
  await streamInto<JMnedictWord>('jmnedict', findFile('jmnedict'), nameWriter, mapName);
  console.log(`  ${nameWriter.total.toLocaleString()} names`);

  console.log('Processing KANJIDIC (kanji)…');
  await streamInto<Kanjidic2Character>('kanjidic', findFile('kanjidic2-en'), kanjiWriter, mapKanji);
  console.log(`  ${kanjiWriter.total.toLocaleString()} kanji`);

  const shards = [...wordWriter.shards, ...nameWriter.shards, ...kanjiWriter.shards];
  const totalRecords = wordWriter.total + nameWriter.total + kanjiWriter.total;
  const manifest: DictManifest = {
    version: new Date().toISOString().slice(0, 10) + `-${totalRecords}`,
    shards,
    totalRecords,
  };
  createWriteStream(join(OUT_DIR, 'manifest.json')).end(JSON.stringify(manifest));

  console.log(`\nDone. ${totalRecords.toLocaleString()} records in ${shards.length} shards → ${OUT_DIR}/`);
  console.log(`Manifest version: ${manifest.version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
