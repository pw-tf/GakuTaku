import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { Collection, Sql } from '../anki/collection';
import { restoreFromFilteredDeck } from '../anki/answer';
import type { Notetype } from '../anki/notetype';
import { timingAt } from '../anki/timing';
import { CardQueue, CardType, type Card, type Deck, type DeckConfig, type RevlogEntry } from '../anki/types';

/**
 * Export decks as an Anki package (`.apkg`) that Anki and AnkiDroid import: a schema-11
 * `collection.anki21` (the "legacy" package format every Anki version reads) plus a JSON media map
 * and numbered media files — the mirror image of src/import/apkg.ts.
 *
 * Review due dates in Anki count days since the collection's creation (`crt`); the package gets a
 * `crt` exactly {@link CRT_DAYS_AGO} study days ago, with the device's time zone and rollover hour,
 * so due dates convert both ways without drift.
 */

export const CRT_DAYS_AGO = 3650;

export interface ExportOptions {
  /** Keep review state and history (Anki "Include scheduling information"); off = all cards new. */
  scheduling: boolean;
  /** Include the media files the notes use. */
  media: boolean;
}

export interface ExportData {
  decks: Deck[];
  configs: { id: number; name: string; config: DeckConfig }[];
  notetypes: Notetype[];
  notes: { id: number; guid: string; mid: number; mod: number; tags: string; flds: string; sfld: string }[];
  cards: Card[];
  revlog: RevlogEntry[];
  rollover: number;
  fsrs: boolean;
  learnAheadSecs: number;
}

/** Everything in a deck and its subdecks (or the whole collection), as stored. */
export async function gatherExport(col: Collection, sql: Sql, deckId: number | null): Promise<ExportData> {
  const cfg = await col.config();
  const allDecks = await col.decks();
  const root = deckId == null ? null : allDecks.find((d) => d.id === deckId);
  const inTree = (d: Deck) => !root || d.id === root.id || d.name.toLowerCase().startsWith(root.name.toLowerCase() + '::');
  const decks = allDecks.filter((d) => !d.filtered && inTree(d));
  const ids = decks.map((d) => d.id);
  const idList = ids.join(',') || 'NULL';
  // Cards borrowed by filtered decks belong to their home deck.
  const cards = await sql.all<Card>(`SELECT * FROM cards WHERE (odid = 0 AND did IN (${idList})) OR odid IN (${idList})`);
  const nids = [...new Set(cards.map((c) => c.nid))];
  const notes: ExportData['notes'] = [];
  for (let i = 0; i < nids.length; i += 500) {
    const chunk = nids.slice(i, i + 500);
    notes.push(...(await sql.all<ExportData['notes'][number]>(`SELECT id, guid, mid, mod, tags, flds, sfld FROM notes WHERE id IN (${chunk.join(',')})`)));
  }
  const revlog: RevlogEntry[] = [];
  const cids = cards.map((c) => c.id);
  for (let i = 0; i < cids.length; i += 500) {
    revlog.push(...(await sql.all<RevlogEntry>(`SELECT * FROM revlog WHERE cid IN (${cids.slice(i, i + 500).join(',')})`)));
  }
  const mids = new Set(notes.map((n) => n.mid));
  const notetypes = (await col.notetypes()).filter((nt) => mids.has(nt.id));
  const confIds = new Set(decks.map((d) => d.conf_id));
  const configs = (await col.deckConfigs()).filter((c) => confIds.has(c.id));
  return { decks, configs, notetypes, notes, cards, revlog, rollover: cfg.rollover, fsrs: cfg.fsrs, learnAheadSecs: cfg.learnAheadSecs };
}

/** Media files a note's fields refer to (`<img src>`, `[sound:]`, and other `src=` attributes). */
export function mediaReferences(flds: string): string[] {
  const out = new Set<string>();
  for (const m of flds.matchAll(/\bsrc\s*=\s*["']?([^"'\s>]+)["']?/gi)) {
    const name = decodeHtmlEntities(m[1]);
    if (!/^(?:[a-z]+:|\/\/|data:)/i.test(name)) out.add(name);
  }
  for (const m of flds.matchAll(/\[sound:([^\]]+)\]/g)) out.add(decodeHtmlEntities(m[1]));
  return [...out];
}

const decodeHtmlEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);`;

// Inverse of the importer's enum tables (Anki deckconfig/schema11.rs numbering).
const GATHER = { deck: 0, deckThenRandomNotes: 5, lowestPosition: 1, highestPosition: 2, randomNotes: 3, randomCards: 4 } as const;
const SORT = { template: 0, noSort: 1, templateThenRandom: 2, randomNoteThenTemplate: 3, randomCard: 4 } as const;
const MIX = { mix: 0, afterReviews: 1, beforeReviews: 2 } as const;
const REVIEW = {
  day: 0, dayThenDeck: 1, deckThenDay: 2, intervalsAscending: 3, intervalsDescending: 4, easeAscending: 5, easeDescending: 6,
  retrievabilityAscending: 7, retrievabilityDescending: 11, relativeOverdueness: 12, random: 8, added: 9, reverseAdded: 10,
} as const;

function dconfJson(id: number, name: string, c: DeckConfig, mod: number) {
  return {
    id, name, mod, usn: -1, dyn: false,
    maxTaken: c.capAnswerTimeToSecs, autoplay: !c.disableAutoplay, timer: c.showTimer ? 1 : 0, replayq: true,
    new: { bury: c.buryNew, delays: c.learnSteps, initialFactor: Math.round(c.initialEase * 1000), ints: [c.graduatingIntervalGood, c.graduatingIntervalEasy, 0], order: c.newCardInsertOrder === 'random' ? 0 : 1, perDay: c.newPerDay },
    rev: { bury: c.buryReviews, ease4: c.easyMultiplier, ivlFct: c.intervalMultiplier, maxIvl: c.maximumReviewInterval, perDay: c.reviewsPerDay, hardFactor: c.hardMultiplier },
    lapse: { delays: c.relearnSteps, leechAction: c.leechAction === 'suspend' ? 0 : 1, leechFails: c.leechThreshold, minInt: c.minimumLapseInterval, mult: c.lapseMultiplier },
    newMix: MIX[c.newMix] ?? 0,
    newPerDayMinimum: 0,
    interdayLearningMix: MIX[c.interdayLearningMix] ?? 0,
    reviewOrder: REVIEW[c.reviewOrder] ?? 0,
    newSortOrder: SORT[c.newCardSortOrder] ?? 0,
    newGatherPriority: GATHER[c.newCardGatherPriority] ?? 0,
    buryInterdayLearning: c.buryInterdayLearning,
    desiredRetention: c.desiredRetention,
    sm2Retention: c.historicalRetention,
    fsrsParams6: c.fsrsParams.length >= 19 ? c.fsrsParams : [],
    fsrsParams5: c.fsrsParams.length === 19 ? c.fsrsParams : [],
    fsrsWeights: c.fsrsParams.length && c.fsrsParams.length < 19 ? c.fsrsParams : [],
    ignoreRevlogsBeforeDate: c.ignoreRevlogsBeforeDate,
  };
}

function modelJson(nt: Notetype, did: number, mod: number) {
  const fields = [...nt.fields].sort((a, b) => a.ord - b.ord);
  return {
    id: nt.id, name: nt.name, type: nt.kind, mod, usn: -1, sortf: nt.sortIdx, did,
    tmpls: [...nt.templates].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, ord: t.ord, qfmt: t.qfmt, afmt: t.afmt, bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0 })),
    flds: fields.map((f) => ({ name: f.name, ord: f.ord, sticky: false, rtl: false, font: 'Arial', size: 20, description: '', plainText: false, collapsed: false, excludeFromSearch: false, media: [] })),
    css: nt.css,
    latexPre: nt.latexPre ?? '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: nt.latexPost ?? '\\end{document}',
    latexsvg: false,
    req: nt.kind === 1 ? [] : nt.templates.map((t) => [t.ord, 'any', fields.map((f) => f.ord)]),
    tags: [], vers: [],
  };
}

function deckJson(d: Deck, mod: number) {
  return {
    id: d.id, name: d.name, desc: d.description, conf: d.conf_id, dyn: 0, mod, usn: -1,
    collapsed: d.collapsed, browserCollapsed: d.collapsed,
    newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0], extendNew: 0, extendRev: 0,
    reviewLimit: d.review_limit, newLimit: d.new_limit, reviewLimitToday: null, newLimitToday: null,
    desiredRetention: d.desired_retention,
  };
}

/** A 32-bit checksum of the first field's text (Anki `field_checksum`: first 8 hex digits of its SHA-1). */
async function fieldChecksum(text: string): Promise<number> {
  const plain = text.replace(/<[^>]*>/g, '').trim();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(plain)));
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

/** Build the `.apkg` file. `readMedia` fetches a media file by name (null when missing). */
export async function buildApkg(data: ExportData, opts: ExportOptions, readMedia: (name: string) => Promise<Blob | null>, nowMs = Date.now()): Promise<{ blob: Blob; notes: number; cards: number; media: number }> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const t = timingAt(nowMs, data.rollover);
  const nowSecs = Math.floor(nowMs / 1000);
  // `crt`: the rollover hour, CRT_DAYS_AGO study days ago, local time.
  const dayStart = new Date((t.nextDayAt - 86_400) * 1000);
  const crtDate = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() - CRT_DAYS_AGO, data.rollover % 24, 0, 0, 0);
  const crt = Math.floor(crtDate.getTime() / 1000);
  const toAnkiDay = (ourDay: number) => ourDay - t.today + CRT_DAYS_AGO;
  try {
    db.exec(SCHEMA);
    const run = (sql: string, bind: unknown[]) => db.exec({ sql, bind: bind as never });

    const mod = nowSecs;
    const decks: Record<string, unknown> = {
      1: deckJson({ id: 1, name: 'Default', conf_id: 1, description: '', review_limit: null, new_limit: null, review_limit_today: null, new_limit_today: null, desired_retention: null, collapsed: false, last_day_studied: 0, new_studied: 0, review_studied: 0, learning_studied: 0, ms_studied: 0, filtered: null }, mod),
    };
    for (const d of data.decks) decks[d.id] = deckJson(d, mod);
    const dconf: Record<string, unknown> = {};
    for (const c of data.configs) dconf[c.id] = dconfJson(c.id, c.name, c.config, mod);
    if (!dconf[1]) {
      const any = data.configs[0];
      if (any) dconf[1] = dconfJson(1, 'Default', any.config, mod);
    }
    const firstDeck = data.decks[0]?.id ?? 1;
    const models: Record<string, unknown> = {};
    for (const nt of data.notetypes) models[nt.id] = modelJson(nt, firstDeck, mod);
    const maxPos = Math.max(0, ...data.cards.filter((c) => c.type === CardType.New).map((c) => c.due));
    const conf = {
      activeDecks: [firstDeck], curDeck: firstDeck, newSpread: 0, collapseTime: data.learnAheadSecs, timeLim: 0, estTimes: true, dueCounts: true,
      curModel: data.notetypes[0]?.id ?? null, nextPos: maxPos + 1, sortType: 'noteFld', sortBackwards: false, addToCur: true,
      schedVer: 2, sched2021: true, rollover: data.rollover, creationOffset: new Date(nowMs).getTimezoneOffset(), fsrs: data.fsrs,
    };
    run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [crt, nowMs, nowMs, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}']);

    const media = new Set<string>();
    db.exec('BEGIN');
    for (const n of data.notes) {
      const first = n.flds.split('\x1f')[0] ?? '';
      run('INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, ?)', [n.id, n.guid, n.mid, n.mod, n.tags, n.flds, n.sfld, await fieldChecksum(first), '']);
      if (opts.media) for (const m of mediaReferences(n.flds)) media.add(m);
    }
    let newPos = 0;
    const sorted = [...data.cards].sort((a, b) => (a.type === CardType.New && b.type === CardType.New ? a.due - b.due : 0));
    for (const original of sorted) {
      const c: Card = { ...original };
      restoreFromFilteredDeck(c);
      if (!opts.scheduling) {
        // Anki's export without scheduling: every card new, in its current order, unflagged.
        Object.assign(c, { type: CardType.New, queue: c.queue === CardQueue.Suspended ? CardQueue.Suspended : CardQueue.New, due: c.type === CardType.New ? c.due : maxPos + ++newPos, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, flags: 0, stability: null, difficulty: null, desired_retention: null, last_review: null });
      }
      const dayBased = c.type === CardType.Review || ((c.type === CardType.Learn || c.type === CardType.Relearn) && c.due < 1_000_000_000);
      const due = dayBased ? toAnkiDay(c.due) : c.due;
      const extra: Record<string, number> = {};
      if (c.stability != null) extra.s = Math.round(c.stability * 1000) / 1000;
      if (c.difficulty != null) extra.d = Math.round(c.difficulty * 1000) / 1000;
      if (c.desired_retention != null) extra.dr = Math.round(c.desired_retention * 100) / 100;
      if (c.last_review != null) extra.lrt = c.last_review;
      if (c.original_position != null) extra.pos = c.original_position;
      run('INSERT INTO cards VALUES (?, ?, ?, ?, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)', [
        c.id, c.nid, c.did, c.ord, c.mod, c.type, c.queue, due, c.ivl, c.factor, c.reps, c.lapses, c.left, c.flags, Object.keys(extra).length ? JSON.stringify(extra) : '',
      ]);
    }
    if (opts.scheduling) {
      for (const r of data.revlog) run('INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)', [r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type]);
    }
    db.exec('COMMIT');

    const bytes = sqlite3.capi.sqlite3_js_db_export(db.pointer!);
    const zip = new ZipWriter(new BlobWriter('application/zip'));
    await zip.add('collection.anki21', new Uint8ArrayReader(bytes));
    const map: Record<string, string> = {};
    let i = 0;
    for (const name of media) {
      const blob = await readMedia(name);
      if (!blob) continue;
      await zip.add(String(i), new Uint8ArrayReader(new Uint8Array(await blob.arrayBuffer())), { level: 0 });
      map[String(i)] = name;
      i++;
    }
    await zip.add('media', new TextReader(JSON.stringify(map)));
    return { blob: await zip.close(), notes: data.notes.length, cards: data.cards.length, media: i };
  } finally {
    db.close();
  }
}

/** `My Deck::Sub` → `My Deck - Sub.apkg` */
export function apkgFileName(deckName: string | null): string {
  const base = (deckName ?? 'GakuTaku collection').replace(/::/g, ' - ').replace(/[\\/:*?"<>|]/g, '_').trim() || 'deck';
  return `${base}.apkg`;
}
