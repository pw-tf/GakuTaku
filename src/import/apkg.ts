import { BlobReader, Uint8ArrayWriter, ZipReader, type Entry } from '@zip.js/zip.js';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { decompress } from 'fzstd';
import { inflateSync } from 'fflate';
import { decodeFields, pbFloat, pbFloats, pbHas, pbMessage, pbMessages, pbString, pbUint, type PbValue } from './proto';
import { defaultDeckConfig, type DeckConfig, type NewGatherPriority, type NewSortOrder, type ReviewMix, type ReviewOrder } from '../anki/types';
import type { Notetype } from '../anki/notetype';

/**
 * Read an Anki package — `.apkg` (deck export) or `.colpkg` (whole-collection backup) — keeping
 * everything Anki stores: note types with their templates/CSS, decks with their limits, presets
 * (deck options, including FSRS parameters), notes, cards with their full scheduling state, the
 * review history, and the media list.
 *
 * Packages come in two formats (the `meta` entry says which):
 * - legacy (v1/v2): `collection.anki2`/`.anki21`, schema 11, with JSON blobs in `col` and a JSON media map;
 * - modern (v3): `collection.anki21b`, zstd-compressed schema 18, with protobuf config blobs, a
 *   protobuf media map and individually zstd-compressed media files.
 *
 * The archive is read entry by entry from the `File` (zip.js), so a large collection's media never
 * has to fit in memory at once.
 */

export class UnsupportedApkgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedApkgError';
  }
}

export interface ParsedDeck {
  id: number;
  name: string;
  confId: number;
  description: string;
  filtered: boolean;
  reviewLimit: number | null;
  newLimit: number | null;
  desiredRetention: number | null;
  collapsed: boolean;
}

export interface ParsedDeckConfig {
  id: number;
  name: string;
  config: DeckConfig;
}

export interface ParsedCard {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  stability: number | null;
  difficulty: number | null;
  desiredRetention: number | null;
  lastReview: number | null;
  originalPosition: number | null;
}

export interface ParsedNote {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  tags: string;
  flds: string;
}

export interface ParsedRevlog {
  id: number;
  cid: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  time: number;
  type: number;
}

export interface ParsedPackage {
  /** Collection creation time (unix secs) — review due dates are days since then. */
  crt: number;
  /** Anki "next day starts at" of the source collection (default 4). */
  rollover: number;
  /** Minutes west of UTC at creation, or null for old collections. */
  creationOffset: number | null;
  /** Source collection's scheduling preferences (only meaningful for `.colpkg`). */
  fsrs: boolean | null;
  learnAheadSecs: number | null;
  newCardsIgnoreReviewLimit: boolean | null;
  applyAllParentLimits: boolean | null;
  notetypes: Notetype[];
  decks: ParsedDeck[];
  deckConfigs: ParsedDeckConfig[];
  notes: ParsedNote[];
  cards: ParsedCard[];
  revlog: ParsedRevlog[];
  /** zip entry name → original media filename. */
  media: Map<string, string>;
  mediaCompressed: boolean;
  /** Read one media file's bytes by its zip entry name. */
  readMedia(entryName: string): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

const FIELD_SEP = '\x1f';

/** A read-only, in-memory view of the package's SQLite collection. */
interface Database {
  exec(sql: string): Record<string, unknown>[];
  close(): void;
}

let sqlitePromise: ReturnType<typeof sqlite3InitModule> | null = null;

async function openDatabase(bytes: Uint8Array): Promise<Database> {
  sqlitePromise ??= sqlite3InitModule();
  const sqlite3 = await sqlitePromise;
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer!,
    'main',
    p,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc) {
    db.close();
    throw new UnsupportedApkgError('The collection inside this package couldn’t be opened.');
  }
  return {
    exec: (sql) => (db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) as Record<string, unknown>[]).map((r) => ({ ...r })),
    close: () => db.close(),
  };
}

function rows(db: Database, sql: string): Record<string, unknown>[] {
  try {
    return db.exec(sql);
  } catch {
    return []; // table missing in this schema
  }
}
const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v == null ? d : Number(v) || d);
const str = (v: unknown) => (v == null ? '' : String(v));
const blob = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array());
const json = <T,>(v: unknown, d: T): T => {
  try {
    return v == null || v === '' ? d : (JSON.parse(String(v)) as T);
  } catch {
    return d;
  }
};

// ---- Deck options --------------------------------------------------------------------

const GATHER: Record<number, NewGatherPriority> = { 0: 'deck', 5: 'deckThenRandomNotes', 1: 'lowestPosition', 2: 'highestPosition', 3: 'randomNotes', 4: 'randomCards' };
const SORT: Record<number, NewSortOrder> = { 0: 'template', 1: 'noSort', 2: 'templateThenRandom', 3: 'randomNoteThenTemplate', 4: 'randomCard' };
const MIX: Record<number, ReviewMix> = { 0: 'mix', 1: 'afterReviews', 2: 'beforeReviews' };
const REVIEW: Record<number, ReviewOrder> = {
  0: 'day', 1: 'dayThenDeck', 2: 'deckThenDay', 3: 'intervalsAscending', 4: 'intervalsDescending', 5: 'easeAscending', 6: 'easeDescending',
  7: 'retrievabilityAscending', 11: 'retrievabilityDescending', 12: 'relativeOverdueness', 8: 'random', 9: 'added', 10: 'reverseAdded',
};
const pos = (v: number, d: number) => (v > 0 ? v : d);
const pickParams = (p6: number[], p5: number[], p4: number[]) => (p6.length ? p6 : p5.length ? p5 : p4);

/** `DeckConfig.Config` protobuf (schema 18) → our config. */
function deckConfigFromProto(buf: Uint8Array): DeckConfig {
  const f = decodeFields(buf);
  const d = defaultDeckConfig();
  return {
    ...d,
    learnSteps: pbFloats(f, 1),
    relearnSteps: pbFloats(f, 2),
    fsrsParams: pickParams(pbFloats(f, 6), pbFloats(f, 5), pbFloats(f, 3)),
    newPerDay: pbUint(f, 9),
    reviewsPerDay: pbUint(f, 10),
    initialEase: pos(pbFloat(f, 11), d.initialEase),
    easyMultiplier: pos(pbFloat(f, 12), d.easyMultiplier),
    hardMultiplier: pos(pbFloat(f, 13), d.hardMultiplier),
    lapseMultiplier: pbFloat(f, 14),
    intervalMultiplier: pos(pbFloat(f, 15), d.intervalMultiplier),
    maximumReviewInterval: pos(pbUint(f, 16), d.maximumReviewInterval),
    minimumLapseInterval: pos(pbUint(f, 17), d.minimumLapseInterval),
    graduatingIntervalGood: pos(pbUint(f, 18), d.graduatingIntervalGood),
    graduatingIntervalEasy: pos(pbUint(f, 19), d.graduatingIntervalEasy),
    newCardInsertOrder: pbUint(f, 20) === 1 ? 'random' : 'due',
    newCardGatherPriority: GATHER[pbUint(f, 34)] ?? 'deck',
    newCardSortOrder: SORT[pbUint(f, 32)] ?? 'template',
    newMix: MIX[pbUint(f, 30)] ?? 'mix',
    reviewOrder: REVIEW[pbUint(f, 33)] ?? 'day',
    interdayLearningMix: MIX[pbUint(f, 31)] ?? 'mix',
    leechAction: pbUint(f, 21) === 0 ? 'suspend' : 'tagOnly',
    leechThreshold: pbUint(f, 22),
    disableAutoplay: !!pbUint(f, 23),
    capAnswerTimeToSecs: pos(pbUint(f, 24), d.capAnswerTimeToSecs),
    showTimer: !!pbUint(f, 25),
    buryNew: !!pbUint(f, 27),
    buryReviews: !!pbUint(f, 28),
    buryInterdayLearning: !!pbUint(f, 29),
    desiredRetention: pos(pbFloat(f, 37), d.desiredRetention),
    historicalRetention: pos(pbFloat(f, 40), d.historicalRetention),
    ignoreRevlogsBeforeDate: pbString(f, 46),
  };
}

/** Legacy schema-11 `dconf` JSON → our config (Anki deckconfig/schema11.rs). */
function deckConfigFromJson(c: Record<string, unknown>): DeckConfig {
  const d = defaultDeckConfig();
  const nw = (c.new ?? {}) as Record<string, unknown>;
  const rev = (c.rev ?? {}) as Record<string, unknown>;
  const lapse = (c.lapse ?? {}) as Record<string, unknown>;
  const ints = Array.isArray(nw.ints) ? (nw.ints as number[]) : [];
  const floats = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(Number).filter(Number.isFinite) : []);
  return {
    ...d,
    learnSteps: Array.isArray(nw.delays) ? floats(nw.delays) : d.learnSteps,
    relearnSteps: Array.isArray(lapse.delays) ? floats(lapse.delays) : d.relearnSteps,
    newPerDay: num(nw.perDay, d.newPerDay),
    reviewsPerDay: num(rev.perDay, d.reviewsPerDay),
    initialEase: num(nw.initialFactor, 2500) / 1000,
    easyMultiplier: num(rev.ease4, d.easyMultiplier),
    hardMultiplier: num(rev.hardFactor, d.hardMultiplier),
    lapseMultiplier: num(lapse.mult, 0),
    intervalMultiplier: num(rev.ivlFct, 1) || 1,
    maximumReviewInterval: num(rev.maxIvl, d.maximumReviewInterval),
    minimumLapseInterval: num(lapse.minInt, 1),
    graduatingIntervalGood: ints.length >= 2 ? ints[0] : d.graduatingIntervalGood,
    graduatingIntervalEasy: ints.length >= 2 ? ints[1] : d.graduatingIntervalEasy,
    newCardInsertOrder: num(nw.order, 1) === 0 ? 'random' : 'due',
    newCardGatherPriority: GATHER[num(c.newGatherPriority)] ?? 'deck',
    newCardSortOrder: SORT[num(c.newSortOrder)] ?? 'template',
    newMix: MIX[num(c.newMix)] ?? 'mix',
    reviewOrder: REVIEW[num(c.reviewOrder)] ?? 'day',
    interdayLearningMix: MIX[num(c.interdayLearningMix)] ?? 'mix',
    leechAction: num(lapse.leechAction, 1) === 0 ? 'suspend' : 'tagOnly',
    leechThreshold: num(lapse.leechFails, d.leechThreshold),
    disableAutoplay: c.autoplay === false,
    capAnswerTimeToSecs: num(c.maxTaken, d.capAnswerTimeToSecs) || d.capAnswerTimeToSecs,
    showTimer: !!num(c.timer),
    buryNew: !!nw.bury,
    buryReviews: !!rev.bury,
    buryInterdayLearning: !!c.buryInterdayLearning,
    desiredRetention: num(c.desiredRetention) > 0 ? num(c.desiredRetention) : d.desiredRetention,
    historicalRetention: num(c.sm2Retention) > 0 ? num(c.sm2Retention) : d.historicalRetention,
    fsrsParams: pickParams(floats(c.fsrsParams6), floats(c.fsrsParams5), floats(c.fsrsWeights)),
    ignoreRevlogsBeforeDate: typeof c.ignoreRevlogsBeforeDate === 'string' ? c.ignoreRevlogsBeforeDate : '',
  };
}

// ---- Schema 11 (legacy JSON) --------------------------------------------------------------

function parseLegacyCol(db: Database) {
  const col = rows(db, 'SELECT crt, conf, models, decks, dconf FROM col LIMIT 1')[0];
  if (!col) throw new UnsupportedApkgError('This file has no Anki collection inside.');
  const conf = json<Record<string, unknown>>(col.conf, {});
  const models = json<Record<string, Record<string, unknown>>>(col.models, {});
  const notetypes: Notetype[] = Object.values(models).map((m) => ({
    id: num(m.id),
    name: str(m.name),
    kind: num(m.type) === 1 ? 1 : 0,
    fields: ((m.flds as { name: string; ord: number }[]) ?? []).map((f) => ({ name: f.name, ord: f.ord })),
    templates: ((m.tmpls as { name: string; ord: number; qfmt: string; afmt: string }[]) ?? []).map((t) => ({ name: t.name, ord: t.ord, qfmt: t.qfmt ?? '', afmt: t.afmt ?? '' })),
    css: str(m.css),
    sortIdx: num(m.sortf),
    latexPre: m.latexPre ? str(m.latexPre) : undefined,
    latexPost: m.latexPost ? str(m.latexPost) : undefined,
  }));
  const decks: ParsedDeck[] = Object.values(json<Record<string, Record<string, unknown>>>(col.decks, {})).map((d) => ({
    id: num(d.id),
    name: str(d.name),
    confId: num(d.conf, 1),
    description: str(d.desc),
    filtered: !!num(d.dyn),
    reviewLimit: d.reviewLimit == null ? null : num(d.reviewLimit),
    newLimit: d.newLimit == null ? null : num(d.newLimit),
    desiredRetention: d.desiredRetention == null ? null : num(d.desiredRetention),
    collapsed: !!d.collapsed,
  }));
  const deckConfigs: ParsedDeckConfig[] = Object.values(json<Record<string, Record<string, unknown>>>(col.dconf, {})).map((c) => ({
    id: num(c.id),
    name: str(c.name) || 'Imported',
    config: deckConfigFromJson(c),
  }));
  return {
    crt: num(col.crt),
    rollover: conf.rollover == null ? 4 : num(conf.rollover, 4),
    creationOffset: conf.creationOffset == null ? null : num(conf.creationOffset),
    fsrs: conf.fsrs == null ? null : !!conf.fsrs,
    learnAheadSecs: conf.collapseTime == null ? null : num(conf.collapseTime),
    newCardsIgnoreReviewLimit: conf.newCardsIgnoreReviewLimit == null ? null : !!conf.newCardsIgnoreReviewLimit,
    applyAllParentLimits: conf.applyAllParentLimits == null ? null : !!conf.applyAllParentLimits,
    notetypes,
    decks,
    deckConfigs,
  };
}

// ---- Schema 18 (normalized tables, protobuf configs) -----------------------------------------

function parseModernCol(db: Database) {
  const col = rows(db, 'SELECT crt FROM col LIMIT 1')[0];
  const config = new Map<string, unknown>();
  for (const r of rows(db, 'SELECT KEY AS k, val FROM config')) {
    const raw = r.val instanceof Uint8Array ? new TextDecoder().decode(r.val) : str(r.val);
    config.set(str(r.k), json<unknown>(raw, null));
  }

  const fieldsByNt = new Map<number, { name: string; ord: number }[]>();
  for (const f of rows(db, 'SELECT ntid, ord, name FROM fields')) {
    const k = num(f.ntid);
    (fieldsByNt.get(k) ?? fieldsByNt.set(k, []).get(k)!).push({ name: str(f.name), ord: num(f.ord) });
  }
  const tmplByNt = new Map<number, { name: string; ord: number; qfmt: string; afmt: string }[]>();
  for (const t of rows(db, 'SELECT ntid, ord, name, config FROM templates')) {
    const k = num(t.ntid);
    const cfg = safeDecode(blob(t.config));
    (tmplByNt.get(k) ?? tmplByNt.set(k, []).get(k)!).push({ name: str(t.name), ord: num(t.ord), qfmt: pbString(cfg, 1), afmt: pbString(cfg, 2) });
  }
  const notetypes: Notetype[] = rows(db, 'SELECT id, name, config FROM notetypes').map((nt) => {
    const id = num(nt.id);
    const cfg = safeDecode(blob(nt.config));
    return {
      id,
      name: str(nt.name),
      kind: pbUint(cfg, 1) === 1 ? 1 : 0,
      fields: (fieldsByNt.get(id) ?? []).sort((a, b) => a.ord - b.ord),
      templates: (tmplByNt.get(id) ?? []).sort((a, b) => a.ord - b.ord),
      css: pbString(cfg, 3),
      sortIdx: pbUint(cfg, 2),
      latexPre: pbString(cfg, 5) || undefined,
      latexPost: pbString(cfg, 6) || undefined,
    };
  });

  const decks: ParsedDeck[] = rows(db, 'SELECT id, name, common, kind FROM decks').map((d) => {
    const common = safeDecode(blob(d.common));
    const kind = safeDecode(blob(d.kind));
    const normal = pbMessages(kind, 1)[0];
    const n = normal ? decodeFields(normal) : new Map<number, PbValue[]>();
    return {
      id: num(d.id),
      // Schema 18 separates name components with \x1f where schema 11 used "::".
      name: str(d.name).split(FIELD_SEP).join('::'),
      confId: normal ? pbUint(n, 1) || 1 : 1,
      description: pbString(n, 4),
      filtered: !normal && pbMessages(kind, 2).length > 0,
      reviewLimit: pbHas(n, 6) ? pbUint(n, 6) : null,
      newLimit: pbHas(n, 7) ? pbUint(n, 7) : null,
      desiredRetention: pbHas(n, 10) ? pbFloat(n, 10) : null,
      collapsed: !!pbUint(common, 1),
    };
  });
  const deckConfigs: ParsedDeckConfig[] = rows(db, 'SELECT id, name, config FROM deck_config').map((c) => ({
    id: num(c.id),
    name: str(c.name) || 'Imported',
    config: deckConfigFromProto(blob(c.config)),
  }));
  const cfgNum = (k: string) => (typeof config.get(k) === 'number' ? (config.get(k) as number) : null);
  const cfgBool = (k: string) => (typeof config.get(k) === 'boolean' ? (config.get(k) as boolean) : null);
  return {
    crt: num(col?.crt),
    rollover: cfgNum('rollover') ?? 4,
    creationOffset: cfgNum('creationOffset'),
    fsrs: cfgBool('fsrs'),
    learnAheadSecs: cfgNum('collapseTime'),
    newCardsIgnoreReviewLimit: cfgBool('newCardsIgnoreReviewLimit'),
    applyAllParentLimits: cfgBool('applyAllParentLimits'),
    notetypes,
    decks,
    deckConfigs,
  };
}

function safeDecode(buf: Uint8Array): Map<number, PbValue[]> {
  try {
    return decodeFields(buf);
  } catch {
    return new Map();
  }
}

// ---- Cards / notes / revlog (same columns in both schemas) --------------------------------

function parseCardData(text: string) {
  const d = json<Record<string, unknown>>(text, {});
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  return { stability: n('s'), difficulty: n('d'), desiredRetention: n('dr'), lastReview: n('lrt'), originalPosition: n('pos') };
}

function parseContent(db: Database) {
  const notes: ParsedNote[] = rows(db, 'SELECT id, guid, mid, mod, tags, flds FROM notes').map((n) => ({
    id: num(n.id),
    guid: str(n.guid),
    mid: num(n.mid),
    mod: num(n.mod),
    tags: str(n.tags),
    flds: str(n.flds),
  }));
  const cards: ParsedCard[] = rows(db, 'SELECT id, nid, did, ord, mod, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards').map((c) => ({
    id: num(c.id),
    nid: num(c.nid),
    did: num(c.did),
    ord: num(c.ord),
    mod: num(c.mod),
    type: num(c.type),
    queue: num(c.queue),
    due: num(c.due),
    ivl: num(c.ivl),
    factor: num(c.factor),
    reps: num(c.reps),
    lapses: num(c.lapses),
    left: num(c.left),
    odue: num(c.odue),
    odid: num(c.odid),
    flags: num(c.flags),
    ...parseCardData(str(c.data)),
  }));
  const revlog: ParsedRevlog[] = rows(db, 'SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog').map((r) => ({
    id: num(r.id),
    cid: num(r.cid),
    ease: num(r.ease),
    ivl: num(r.ivl),
    lastIvl: num(r.lastIvl),
    factor: num(r.factor),
    time: num(r.time),
    type: num(r.type),
  }));
  return { notes, cards, revlog };
}

// ---- Archive ------------------------------------------------------------------------------

async function entryBytes(e: Entry | undefined): Promise<Uint8Array | null> {
  if (!e || e.directory || !('getData' in e)) return null;
  return (e as Entry & { getData: (w: Uint8ArrayWriter) => Promise<Uint8Array> }).getData(new Uint8ArrayWriter());
}

/** Bytes read from the package per window: big sequential reads instead of one per media file. */
const WINDOW = 8 * 1024 * 1024;

/**
 * Reads zip entries straight from the file. zip.js costs several milliseconds per entry (stream
 * setup and checksumming), which for a deck's thousands of media files dominated the whole import.
 * Media entries are laid out one after another, so they are read through a sliding window and
 * sliced out (stored) or inflated synchronously with fflate (deflated). Anything
 * unusual (encryption, another method, a bad header) goes back to zip.js.
 */
export class EntryReader {
  private win = new Uint8Array(0);
  private winStart = 0;
  constructor(private readonly file: Blob) {}

  private async bytes(start: number, length: number): Promise<Uint8Array> {
    const end = start + length;
    if (start < this.winStart || end > this.winStart + this.win.length) {
      const size = Math.max(length, WINDOW);
      this.win = new Uint8Array(await this.file.slice(start, Math.min(start + size, this.file.size)).arrayBuffer());
      this.winStart = start;
      if (this.win.length < length) throw new Error('Truncated zip entry');
    }
    return this.win.subarray(start - this.winStart, end - this.winStart);
  }

  async read(e: Entry | undefined): Promise<Uint8Array | null> {
    if (!e || e.directory) return null;
    if (!e.encrypted && e.offset >= 0) {
      try {
        const h = await this.bytes(e.offset, 30);
        const sig = h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24);
        if (sig === 0x04034b50) {
          const method = h[8] | (h[9] << 8);
          const dataStart = e.offset + 30 + (h[26] | (h[27] << 8)) + (h[28] | (h[29] << 8));
          if (method === 0) return (await this.bytes(dataStart, e.compressedSize)).slice();
          if (method === 8) {
            const out = inflateSync(await this.bytes(dataStart, e.compressedSize), { out: new Uint8Array(e.uncompressedSize) });
            if (out.length === e.uncompressedSize) return out;
          }
        }
      } catch {
        /* fall back to zip.js */
      }
    }
    return entryBytes(e);
  }
}

/** Parse an `.apkg` / `.colpkg` file. Call `close()` when done reading media. */
export async function parseApkg(file: Blob): Promise<ParsedPackage> {
  const zip = new ZipReader(new BlobReader(file));
  let entries: Entry[];
  try {
    entries = await zip.getEntries();
  } catch {
    throw new UnsupportedApkgError('This doesn’t look like an Anki package (.apkg / .colpkg).');
  }
  const byName = new Map(entries.map((e) => [e.filename, e]));
  const mediaReader = new EntryReader(file);

  let version = 0;
  const meta = await entryBytes(byName.get('meta'));
  if (meta) {
    try {
      version = pbUint(decodeFields(meta), 1);
    } catch {
      version = 0;
    }
  }
  const modern = byName.get('collection.anki21b');
  const v3 = !!modern && (version >= 3 || !byName.has('collection.anki21'));

  let dbBytes: Uint8Array | null;
  if (v3) {
    const raw = await entryBytes(modern);
    try {
      dbBytes = raw && decompress(raw);
    } catch {
      throw new UnsupportedApkgError('Couldn’t decompress this package — the file may be damaged.');
    }
  } else {
    dbBytes = await entryBytes(byName.get('collection.anki21') ?? byName.get('collection.anki2'));
  }
  if (!dbBytes) throw new UnsupportedApkgError('No Anki collection found inside this file.');

  const db = await openDatabase(dbBytes);
  dbBytes = null;
  let head: ReturnType<typeof parseLegacyCol>;
  let content: ReturnType<typeof parseContent>;
  try {
    const hasNotetypesTable = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notetypes'").length > 0;
    head = hasNotetypesTable ? parseModernCol(db) : parseLegacyCol(db);
    content = parseContent(db);
  } finally {
    db.close();
  }

  // media map
  const media = new Map<string, string>();
  const mediaRaw = await entryBytes(byName.get('media'));
  if (mediaRaw) {
    if (v3) {
      try {
        pbMessages(decodeFields(decompress(mediaRaw)), 1).forEach((m, i) => {
          const f = decodeFields(m);
          const name = pbString(f, 1);
          const zipName = pbHas(f, 4) ? String(pbUint(f, 4)) : String(i);
          if (name) media.set(zipName, name);
        });
      } catch {
        /* no usable media map */
      }
    } else {
      for (const [k, v] of Object.entries(json<Record<string, string>>(new TextDecoder().decode(mediaRaw), {}))) media.set(k, v);
    }
  }

  return {
    ...head,
    ...content,
    media,
    mediaCompressed: v3,
    async readMedia(entryName: string) {
      const bytes = await mediaReader.read(byName.get(entryName));
      if (!bytes) return null;
      if (!v3) return bytes;
      try {
        return decompress(bytes);
      } catch {
        return null;
      }
    },
    close: () => zip.close(),
  };
}

export { pbMessage };
