import { Collection, DEFAULT_CONFIG_ID, normalizeDeckName, type Sql } from '../anki/collection';
import { splitFields, sortFieldValue, joinFields } from '../anki/notetype';
import { ankiDaysElapsed, timingAt } from '../anki/timing';
import { CardQueue, CardType, type DeckConfig } from '../anki/types';
import type { ParsedPackage } from './apkg';

/**
 * Write a parsed Anki package into the collection — a port of the behaviour of Anki's own importer
 * (rslib/src/import_export/package/apkg/import/*): cards keep their scheduling state exactly
 * (review due dates are shifted from the source collection's day count onto ours), review history
 * is kept, notes already present (same GUID) are skipped, decks are matched by name, and deck
 * options come along as presets.
 */

export interface ImportSummary {
  decks: number;
  notes: number;
  cards: number;
  reviews: number;
  mediaFiles: number;
  skippedNotes: number;
}

export type ImportPhase = 'reading' | 'media' | 'writing' | 'done';
export interface ImportProgress {
  phase: ImportPhase;
  done?: number;
  total?: number;
}

export interface MediaSink {
  has(name: string): Promise<{ size: number } | null>;
  putMany(files: { name: string; data: Uint8Array }[]): Promise<void>;
  rename(name: string, data: Uint8Array): string;
}

const CHUNK = 2000;

async function insertMany(sql: Sql, statement: string, rows: unknown[][], onChunk?: (n: number) => void): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    await sql.transaction((tx) => tx.runMany(statement, batch));
    onChunk?.(Math.min(i + CHUNK, rows.length));
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function importPackage(
  col: Collection,
  sql: Sql,
  pkg: ParsedPackage,
  media: MediaSink,
  opts: { isCollection: boolean; nowMs?: number; onProgress?: (p: ImportProgress) => void },
): Promise<ImportSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const report = opts.onProgress ?? (() => undefined);

  // ---- collection settings (whole-collection backups only) ----
  if (opts.isCollection) {
    const patch: Parameters<Collection['setConfig']>[0] = {};
    if (pkg.fsrs != null) patch.fsrs = pkg.fsrs;
    patch.rollover = pkg.rollover;
    if (pkg.learnAheadSecs != null) patch.learnAheadSecs = pkg.learnAheadSecs;
    if (pkg.newCardsIgnoreReviewLimit != null) patch.newCardsIgnoreReviewLimit = pkg.newCardsIgnoreReviewLimit;
    if (pkg.applyAllParentLimits != null) patch.applyAllParentLimits = pkg.applyAllParentLimits;
    await col.setConfig(patch);
  }
  const cfg = await col.config();
  const ourToday = timingAt(nowMs, cfg.rollover).today;
  const srcToday = ankiDaysElapsed(pkg.crt, Math.floor(nowMs / 1000), pkg.rollover, pkg.creationOffset, new Date(nowMs).getTimezoneOffset());
  /** Days the source collection is ahead of ours (Anki `collection_delta`). */
  const delta = srcToday - ourToday;

  // ---- media first, so renamed files can be rewritten in note fields ----
  const renames = new Map<string, string>();
  let mediaFiles = 0;
  const entries = [...pkg.media.entries()];
  report({ phase: 'media', done: 0, total: entries.length });
  let batch: { name: string; data: Uint8Array }[] = [];
  let batchBytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const [zipName, name] = entries[i];
    const data = await pkg.readMedia(zipName);
    if (data) {
      const existing = await media.has(name);
      if (!existing) {
        batch.push({ name, data });
        batchBytes += data.length;
        mediaFiles++;
      } else if (existing.size !== data.length) {
        const renamed = media.rename(name, data);
        renames.set(name, renamed);
        if (!(await media.has(renamed))) batch.push({ name: renamed, data });
        mediaFiles++;
      }
    }
    if (batch.length >= 50 || batchBytes > 20_000_000) {
      await media.putMany(batch);
      batch = [];
      batchBytes = 0;
    }
    if (i % 25 === 0) report({ phase: 'media', done: i + 1, total: entries.length });
  }
  if (batch.length) await media.putMany(batch);
  await pkg.close();

  report({ phase: 'writing', done: 0, total: pkg.cards.length });

  // ---- presets ----
  const ourConfigs = await col.deckConfigs();
  const confMap = new Map<number, number>();
  const [defaultRow] = await sql.all<{ mtime: number }>('SELECT mtime FROM deck_config WHERE id = 1');
  const defaultUntouched = (defaultRow?.mtime ?? 0) === 0;
  for (const c of pkg.deckConfigs) {
    if (c.id === DEFAULT_CONFIG_ID && defaultUntouched) {
      await col.updateDeckConfig(DEFAULT_CONFIG_ID, 'Default', c.config);
      confMap.set(c.id, DEFAULT_CONFIG_ID);
      continue;
    }
    const sameName = ourConfigs.find((o) => o.name.toLowerCase() === c.name.toLowerCase());
    if (sameName) {
      confMap.set(c.id, sameName.id);
      continue;
    }
    confMap.set(c.id, await col.addDeckConfig(c.name, c.config as DeckConfig));
  }

  // ---- decks (matched by name; filtered decks are not imported) ----
  const deckMap = new Map<number, number>();
  const usedDecks = new Set(pkg.cards.map((c) => (c.odid ? c.odid : c.did)));
  let decksCreated = 0;
  const existingDeckNames = new Set((await col.decks()).map((d) => d.name.toLowerCase()));
  const sortedDecks = [...pkg.decks].filter((d) => !d.filtered).sort((a, b) => a.name.split('::').length - b.name.split('::').length);
  for (const d of sortedDecks) {
    const name = normalizeDeckName(d.name);
    // Skip an empty source "Default" deck with no children.
    if (d.id === 1 && !usedDecks.has(1) && !pkg.decks.some((x) => x.name.startsWith(d.name + '::'))) continue;
    const isNew = !existingDeckNames.has(name.toLowerCase());
    const id = await col.getOrCreateDeck(name, sql, confMap.get(d.confId) ?? DEFAULT_CONFIG_ID);
    deckMap.set(d.id, id);
    if (isNew) {
      decksCreated++;
      existingDeckNames.add(name.toLowerCase());
      await col.updateDeck(id, {
        description: d.description,
        review_limit: d.reviewLimit,
        new_limit: d.newLimit,
        desired_retention: d.desiredRetention,
        collapsed: d.collapsed,
      });
    }
  }
  const fallbackDeck = deckMap.values().next().value ?? (await col.getOrCreateDeck('Default'));

  // ---- note types ----
  const ntMap = new Map<number, number>();
  const ourNts = await col.notetypes();
  for (const nt of pkg.notetypes) {
    const fieldsKey = nt.fields.map((f) => f.name).join('\x1f');
    const sameId = ourNts.find((o) => o.id === nt.id);
    if (sameId && sameId.fields.map((f) => f.name).join('\x1f') === fieldsKey && sameId.templates.length === nt.templates.length) {
      // Same note type: take the incoming templates/styling (an updated shared deck).
      await col.updateNotetype({ ...nt, id: sameId.id, name: sameId.name });
      ntMap.set(nt.id, sameId.id);
      continue;
    }
    const sameShape = ourNts.find((o) => o.name === nt.name && o.fields.map((f) => f.name).join('\x1f') === fieldsKey && o.templates.length === nt.templates.length);
    if (sameShape) {
      ntMap.set(nt.id, sameShape.id);
      continue;
    }
    const id = sameId ? undefined : nt.id;
    ntMap.set(nt.id, await col.addNotetype({ ...nt, id }, sql));
  }
  const ntById = new Map((await col.notetypes()).map((n) => [n.id, n]));

  // ---- notes ----
  const guidToNid = new Map<string, number>();
  for (const r of await sql.all<{ guid: string; id: number }>('SELECT guid, id FROM notes')) guidToNid.set(r.guid, r.id);
  const existingNoteIds = new Set((await sql.all<{ id: number }>('SELECT id FROM notes')).map((r) => r.id));
  const noteMap = new Map<number, number>();
  const skippedNoteIds = new Set<number>();
  const noteRows: unknown[][] = [];
  const renameRes = [...renames].map(([from, to]) => [new RegExp(`(["'=:])${escapeRegExp(from)}(["'\\]\\s>])`, 'g'), to] as const);
  for (const n of pkg.notes) {
    const existing = guidToNid.get(n.guid);
    if (existing != null) {
      noteMap.set(n.id, existing);
      skippedNoteIds.add(n.id);
      continue;
    }
    const mid = ntMap.get(n.mid);
    const nt = mid != null ? ntById.get(mid) : undefined;
    if (!nt) continue;
    let id = n.id;
    while (existingNoteIds.has(id)) id += 999;
    existingNoteIds.add(id);
    noteMap.set(n.id, id);
    guidToNid.set(n.guid, id);
    let flds = n.flds;
    for (const [re, to] of renameRes) flds = flds.replace(re, `$1${to}$2`);
    const fields = splitFields(flds);
    while (fields.length < nt.fields.length) fields.push('');
    noteRows.push([id, n.guid, mid, n.mod, n.tags, joinFields(fields.slice(0, Math.max(nt.fields.length, 1))), sortFieldValue(nt, fields)]);
  }
  await insertMany(sql, 'INSERT INTO notes (id, guid, mid, mod, tags, flds, sfld) VALUES (?, ?, ?, ?, ?, ?, ?)', noteRows);

  // ---- cards ----
  const existingCards = new Set((await sql.all<{ nid: number; ord: number }>('SELECT nid, ord FROM cards')).map((r) => `${r.nid}:${r.ord}`));
  const existingCardIds = new Set((await sql.all<{ id: number }>('SELECT id FROM cards')).map((r) => r.id));
  const cardMap = new Map<number, number>();
  const cardRows: unknown[][] = [];
  let maxNewPos = 0;
  for (const c of pkg.cards) {
    const nid = noteMap.get(c.nid);
    if (nid == null || skippedNoteIds.has(c.nid)) continue;
    if (existingCards.has(`${nid}:${c.ord}`)) continue;
    let did = c.did;
    let due = c.due;
    let queue = c.queue;
    // Cards in a filtered deck go back to their home deck (Anki `restore_cards_from_filtered_decks`).
    if (c.odid) {
      did = c.odid;
      if (c.odue) due = c.odue;
      if (queue === CardQueue.PreviewRepeat) queue = CardQueue.Learn;
      if (c.type === CardType.New) queue = CardQueue.New;
    }
    const ourDid = deckMap.get(did) ?? fallbackDeck;
    // Anki `due_in_days_since_collection_creation` (timestamps are left alone).
    const dayBased = queue === CardQueue.Review || queue === CardQueue.DayLearn || c.type === CardType.Review;
    if (dayBased && due < 1_000_000_000) due -= delta;
    if (c.type === CardType.New && due > maxNewPos) maxNewPos = due;
    let id = c.id;
    while (existingCardIds.has(id)) id += 999;
    existingCardIds.add(id);
    cardMap.set(c.id, id);
    existingCards.add(`${nid}:${c.ord}`);
    cardRows.push([
      id, nid, ourDid, c.ord, c.mod, c.type, queue, due, c.ivl, c.factor, c.reps, c.lapses, c.left, 0, 0, c.flags,
      c.stability, c.difficulty, c.desiredRetention, c.lastReview, c.originalPosition,
    ]);
  }
  await insertMany(
    sql,
    `INSERT INTO cards (id, nid, did, ord, mod, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, stability, difficulty, desired_retention, last_review, original_position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cardRows,
    (n) => report({ phase: 'writing', done: n, total: cardRows.length }),
  );
  if (maxNewPos >= cfg.nextPos) await col.setConfig({ nextPos: maxNewPos + 1 });

  // ---- review history ----
  const revRows = pkg.revlog.filter((r) => cardMap.has(r.cid)).map((r) => [r.id, cardMap.get(r.cid), r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type]);
  await insertMany(sql, 'INSERT OR IGNORE INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', revRows);

  // Cards that were studied but carry no last-review time: take it from their history (FSRS needs it).
  await sql.run(
    `UPDATE cards SET last_review = (SELECT MAX(id) / 1000 FROM revlog WHERE revlog.cid = cards.id AND revlog.ease > 0)
     WHERE last_review IS NULL AND type != 0`,
  );

  report({ phase: 'done' });
  return {
    decks: decksCreated,
    notes: noteRows.length,
    cards: cardRows.length,
    reviews: revRows.length,
    mediaFiles,
    skippedNotes: skippedNoteIds.size,
  };
}
