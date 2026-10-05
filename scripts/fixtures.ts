/**
 * Builds realistic Anki packages for tests: a Kaishi-1.5k-style Japanese deck (12 fields,
 * furigana, word/sentence audio, pictures, nightMode CSS, a custom preset with FSRS parameters)
 * with cards in every scheduling state and review history — in both package formats:
 *
 * - legacy (`collection.anki21`, schema 11, JSON configs, JSON media map)
 * - modern (`collection.anki21b`, zstd, schema 18 with protobuf configs, protobuf media map)
 */
import sqlite3InitModule, { type Database, type SqlValue } from '@sqlite.org/sqlite-wasm';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { zstdCompressSync } from 'node:zlib';
import { ankiDaysElapsed } from '../src/anki/timing';

export const KAISHI_FIELDS = [
  'Word', 'Word Reading', 'Word Meaning', 'Word Furigana', 'Word Audio', 'Sentence', 'Sentence Meaning',
  'Sentence Furigana', 'Sentence Audio', 'Notes', 'Pitch Accent', 'Picture',
];
export const KAISHI_QFMT = '<div class="word">{{Word}}</div>';
export const KAISHI_AFMT =
  '{{FrontSide}}<hr id=answer><div class="reading">{{furigana:Word Furigana}}</div>{{Word Audio}}' +
  '<div class="meaning">{{Word Meaning}}</div><div class="sentence">{{furigana:Sentence Furigana}}</div>{{Sentence Audio}}' +
  '{{#Picture}}<div class="pic">{{Picture}}</div>{{/Picture}}';
export const KAISHI_CSS =
  '.card { font-family: "Noto Sans JP", sans-serif; font-size: 30px; text-align: center; color: black; background-color: white; }\n' +
  '.card.nightMode { background-color: #1e1e1e; color: #eee; }\n.word { font-size: 64px; }\n.sentence { font-size: 24px; }';

const WORDS: [string, string, string, string][] = [
  ['食べる', 'たべる', 'to eat', '食[た]べる'], ['飲む', 'のむ', 'to drink', '飲[の]む'], ['見る', 'みる', 'to see', '見[み]る'],
  ['行く', 'いく', 'to go', '行[い]く'], ['来る', 'くる', 'to come', '来[く]る'], ['学校', 'がっこう', 'school', '学校[がっこう]'],
  ['先生', 'せんせい', 'teacher', '先生[せんせい]'], ['水', 'みず', 'water', '水[みず]'], ['本', 'ほん', 'book', '本[ほん]'],
  ['日本', 'にほん', 'Japan', '日本[にほん]'], ['友達', 'ともだち', 'friend', '友達[ともだち]'], ['猫', 'ねこ', 'cat', '猫[ねこ]'],
  ['犬', 'いぬ', 'dog', '犬[いぬ]'], ['電車', 'でんしゃ', 'train', '電車[でんしゃ]'], ['時間', 'じかん', 'time', '時間[じかん]'],
  ['仕事', 'しごと', 'work', '仕事[しごと]'], ['天気', 'てんき', 'weather', '天気[てんき]'], ['名前', 'なまえ', 'name', '名前[なまえ]'],
  ['音楽', 'おんがく', 'music', '音楽[おんがく]'], ['映画', 'えいが', 'movie', '映画[えいが]'],
];

/** A real 2×2 PNG, so rendered pictures actually load. */
export const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
const FAKE_MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x44, ...new Array(64).fill(0)]);

export const NT_ID = 1_600_000_000_001;
export const DECK_ID = 1_600_000_000_100;
export const CONF_ID = 1_600_000_000_200;
export const FSRS_PARAMS = [0.4, 1.2, 3.1, 15.7, 7.2, 0.53, 1.46, 0.0046, 1.54, 0.12, 1.01, 1.93, 0.11, 0.3, 2.27, 0.25, 2.9, 0.52, 0.66, 0.1, 0.16];

export interface FixtureCard {
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  data: string;
}

export interface Fixture {
  bytes: Uint8Array;
  crt: number;
  /** The source collection's day number at `nowMs`. */
  srcToday: number;
  cards: FixtureCard[];
  revlogCount: number;
  mediaNames: string[];
}

function cardsFor(srcToday: number, nowSecs: number): FixtureCard[] {
  const out: FixtureCard[] = [];
  const fsrs = (s: number, d: number, lrt: number) => JSON.stringify({ s, d, dr: 0.9, decay: 0.1542, lrt });
  for (let i = 0; i < WORDS.length; i++) {
    if (i < 5) out.push({ type: 0, queue: 0, due: 5 + i, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, data: '' }); // new
    else if (i < 8) out.push({ type: 1, queue: 1, due: nowSecs + 300 * (i - 4), ivl: 0, factor: 0, reps: 1, lapses: 0, left: 1, data: fsrs(0.4, 6, nowSecs - 60) }); // learning
    else if (i < 13) out.push({ type: 2, queue: 2, due: srcToday - (i - 8), ivl: 10 + i, factor: 2500, reps: 5, lapses: 0, left: 0, data: fsrs(12 + i, 5, nowSecs - 86400 * (10 + i)) }); // due reviews
    else if (i < 16) out.push({ type: 2, queue: 2, due: srcToday + (i - 12) * 3, ivl: 20, factor: 2500, reps: 6, lapses: 1, left: 0, data: fsrs(25, 6, nowSecs - 86400 * 5) }); // future reviews
    else if (i === 16) out.push({ type: 3, queue: 1, due: nowSecs + 120, ivl: 1, factor: 2300, reps: 9, lapses: 2, left: 1, data: fsrs(2, 7.5, nowSecs - 600) }); // relearning
    else if (i === 17) out.push({ type: 2, queue: -1, due: srcToday - 2, ivl: 30, factor: 2500, reps: 7, lapses: 0, left: 0, data: '' }); // suspended review
    else if (i === 18) out.push({ type: 0, queue: -3, due: 10, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, data: '' }); // buried new
    else out.push({ type: 2, queue: 2, due: srcToday, ivl: 8, factor: 2650, reps: 4, lapses: 0, left: 0, data: '' }); // review without FSRS data
  }
  return out;
}

function noteFields(i: number): string[] {
  const [w, r, m, f] = WORDS[i];
  return [
    w, r, m, f, `[sound:word_${i}.mp3]`, `${w}が好きです。`, `I like ${m}.`, `${f}が 好[す]きです。`, `[sound:sent_${i}.mp3]`,
    '', '', i % 3 === 0 ? `<img src="pic_${i}.png">` : '',
  ];
}

const SCHEMA11 = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);`;

const SCHEMA18_EXTRA = `
CREATE TABLE notetypes (id integer primary key, name text not null, mtime_secs integer not null, usn integer not null, config blob not null);
CREATE TABLE fields (ntid integer not null, ord integer not null, name text not null, config blob not null, primary key (ntid, ord));
CREATE TABLE templates (ntid integer not null, ord integer not null, name text not null, mtime_secs integer not null, usn integer not null, config blob not null, primary key (ntid, ord));
CREATE TABLE decks (id integer primary key, name text not null, mtime_secs integer not null, usn integer not null, common blob not null, kind blob not null);
CREATE TABLE deck_config (id integer primary key, name text not null, mtime_secs integer not null, usn integer not null, config blob not null);
CREATE TABLE config (KEY text not null primary key, usn integer not null, mtime_secs integer not null, val blob not null);`;

// ---- tiny protobuf writer -------------------------------------------------------------------

class Pb {
  private parts: number[] = [];
  private varint(v: number) {
    let n = BigInt.asUintN(64, BigInt(Math.trunc(v)));
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n) b |= 0x80;
      this.parts.push(b);
    } while (n);
  }
  uint(tag: number, v: number) {
    if (!v) return this;
    this.varint(tag * 8);
    this.varint(v);
    return this;
  }
  bytes(tag: number, b: Uint8Array) {
    this.varint(tag * 8 + 2);
    this.varint(b.length);
    this.parts.push(...b);
    return this;
  }
  str(tag: number, s: string) {
    return s ? this.bytes(tag, new TextEncoder().encode(s)) : this;
  }
  msg(tag: number, m: Pb) {
    return this.bytes(tag, m.done());
  }
  float(tag: number, f: number) {
    if (!f) return this;
    this.varint(tag * 8 + 5);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, f, true);
    this.parts.push(...b);
    return this;
  }
  floats(tag: number, fs: number[]) {
    if (!fs.length) return this;
    const b = new Uint8Array(fs.length * 4);
    fs.forEach((f, i) => new DataView(b.buffer).setFloat32(i * 4, f, true));
    return this.bytes(tag, b);
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

// ---- builder ------------------------------------------------------------------------------------

export async function buildKaishiPackage(format: 'legacy' | 'modern', nowMs = Date.now()): Promise<Fixture> {
  const sqlite3 = await sqlite3InitModule();
  const db: Database = new sqlite3.oo1.DB(':memory:', 'c');
  const run = (sql: string, bind: unknown[] = []) => db.exec({ sql, bind: bind as SqlValue[] });
  db.exec(SCHEMA11);
  if (format === 'modern') db.exec(SCHEMA18_EXTRA);

  const nowSecs = Math.floor(nowMs / 1000);
  const crt = nowSecs - 400 * 86400;
  const offset = new Date(nowMs).getTimezoneOffset();
  const srcToday = ankiDaysElapsed(crt, nowSecs, 4, offset, offset);
  const cards = cardsFor(srcToday, nowSecs);

  if (format === 'legacy') {
    const models = {
      [NT_ID]: {
        id: NT_ID, name: 'Kaishi 1.5k', type: 0, sortf: 0, css: KAISHI_CSS, did: DECK_ID,
        flds: KAISHI_FIELDS.map((name, ord) => ({ name, ord })),
        tmpls: [{ name: 'Recognition', ord: 0, qfmt: KAISHI_QFMT, afmt: KAISHI_AFMT }],
      },
    };
    const decks = {
      1: { id: 1, name: 'Default', conf: 1, dyn: 0, desc: '' },
      [DECK_ID]: { id: DECK_ID, name: 'Kaishi 1.5k', conf: CONF_ID, dyn: 0, desc: 'A Japanese vocab deck' },
    };
    const dconf = {
      1: { id: 1, name: 'Default', new: { perDay: 20, delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, order: 1 }, rev: { perDay: 200, ease4: 1.3, ivlFct: 1, maxIvl: 36500, hardFactor: 1.2 }, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 1 } },
      [CONF_ID]: {
        id: CONF_ID, name: 'Kaishi', new: { perDay: 10, delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, order: 1, bury: true },
        rev: { perDay: 300, ease4: 1.3, ivlFct: 1, maxIvl: 36500, hardFactor: 1.2, bury: true }, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
        desiredRetention: 0.88, fsrsParams6: FSRS_PARAMS, reviewOrder: 1, newMix: 2,
      },
    };
    run('INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [
      crt, JSON.stringify({ creationOffset: offset, rollover: 4, fsrs: true, collapseTime: 1200 }), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}',
    ]);
  } else {
    run('INSERT INTO col VALUES (1, ?, 0, 0, 18, 0, 0, 0, ?, ?, ?, ?, ?)', [crt, '', '', '', '', '']);
    run('INSERT INTO notetypes VALUES (?, ?, 0, 0, ?)', [NT_ID, 'Kaishi 1.5k', new Pb().uint(1, 0).str(3, KAISHI_CSS).done()]);
    KAISHI_FIELDS.forEach((name, ord) => run('INSERT INTO fields VALUES (?, ?, ?, ?)', [NT_ID, ord, name, new Uint8Array()]));
    run('INSERT INTO templates VALUES (?, 0, ?, 0, 0, ?)', [NT_ID, 'Recognition', new Pb().str(1, KAISHI_QFMT).str(2, KAISHI_AFMT).done()]);
    const normal = (conf: number, desc: string) => new Pb().msg(1, new Pb().uint(1, conf).str(4, desc));
    run('INSERT INTO decks VALUES (1, ?, 0, 0, ?, ?)', ['Default', new Uint8Array(), normal(1, '').done()]);
    run('INSERT INTO decks VALUES (?, ?, 0, 0, ?, ?)', [DECK_ID, 'Kaishi 1.5k', new Uint8Array(), normal(CONF_ID, 'A Japanese vocab deck').done()]);
    const conf = (newPerDay: number, revPerDay: number, extra: (p: Pb) => Pb) =>
      extra(new Pb().floats(1, [1, 10]).floats(2, [10]).uint(9, newPerDay).uint(10, revPerDay).float(11, 2.5).float(12, 1.3).float(13, 1.2).float(15, 1).uint(16, 36500).uint(17, 1).uint(18, 1).uint(19, 4).uint(22, 8).float(37, 0.9)).done();
    run('INSERT INTO deck_config VALUES (1, ?, 0, 0, ?)', ['Default', conf(20, 200, (p) => p.uint(21, 1))]);
    run('INSERT INTO deck_config VALUES (?, ?, 0, 0, ?)', [CONF_ID, 'Kaishi', conf(10, 300, (p) => p.floats(6, FSRS_PARAMS).float(37, 0.88).uint(27, 1).uint(28, 1).uint(33, 1).uint(30, 2))]);
    const cfg = (k: string, v: unknown) => run('INSERT INTO config VALUES (?, 0, 0, ?)', [k, new TextEncoder().encode(JSON.stringify(v))]);
    cfg('creationOffset', offset);
    cfg('rollover', 4);
    cfg('fsrs', true);
    cfg('collapseTime', 1200);
  }

  let revlogCount = 0;
  let revId = (nowSecs - 30 * 86400) * 1000;
  for (let i = 0; i < WORDS.length; i++) {
    const nid = 1_600_000_100_000 + i;
    const cid = 1_600_000_200_000 + i;
    const fields = noteFields(i);
    run('INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0, 0, ?)', [nid, `guid${i}`, NT_ID, ' kaishi ', fields.join('\x1f'), fields[0], '']);
    const c = cards[i];
    run('INSERT INTO cards VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)', [cid, nid, DECK_ID, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.left, c.data]);
    for (let r = 0; r < c.reps; r++) {
      run('INSERT INTO revlog VALUES (?, ?, 0, ?, ?, ?, ?, 4000, ?)', [revId++, cid, r === 0 ? 1 : 3, r === 0 ? -60 : r * 3, r === 0 ? 0 : -600, c.factor, r === 0 ? 0 : 1]);
      revlogCount++;
    }
  }

  const dbBytes = sqlite3.capi.sqlite3_js_db_export(db.pointer!);
  db.close();

  const mediaNames: string[] = [];
  const files: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < WORDS.length; i++) {
    files.push({ name: `word_${i}.mp3`, data: FAKE_MP3 }, { name: `sent_${i}.mp3`, data: FAKE_MP3 });
    if (i % 3 === 0) files.push({ name: `pic_${i}.png`, data: PNG });
  }
  files.forEach((f) => mediaNames.push(f.name));

  const zip = new ZipWriter(new BlobWriter('application/zip'));
  if (format === 'legacy') {
    await zip.add('collection.anki21', new Uint8ArrayReader(dbBytes));
    await zip.add('media', new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(Object.fromEntries(files.map((f, i) => [String(i), f.name]))))));
    for (let i = 0; i < files.length; i++) await zip.add(String(i), new Uint8ArrayReader(files[i].data));
  } else {
    await zip.add('meta', new Uint8ArrayReader(new Pb().uint(1, 3).done()));
    await zip.add('collection.anki21b', new Uint8ArrayReader(Uint8Array.from(zstdCompressSync(dbBytes))));
    const entries = new Pb();
    files.forEach((f) => entries.msg(1, new Pb().str(1, f.name).uint(2, f.data.length)));
    await zip.add('media', new Uint8ArrayReader(Uint8Array.from(zstdCompressSync(entries.done()))));
    for (let i = 0; i < files.length; i++) await zip.add(String(i), new Uint8ArrayReader(Uint8Array.from(zstdCompressSync(files[i].data))));
  }
  const blob = await zip.close();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), crt, srcToday, cards, revlogCount, mediaNames };
}
