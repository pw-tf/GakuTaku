import { applyAnswer, prepareCard, type PreparedCard } from './answer';
import { deckTreeWithCounts, dueCountsSql, type DeckTreeNode, type RawDueCounts } from './deckTree';
import { compareDeckNames, parentName } from './limits';
import { buildQueues, WHOLE_COLLECTION, type CardQueues, type QueueCard } from './queue';
import { timingAt, type Timing } from './timing';
import { fsrsItemsForTraining, ignoreBeforeMs, memoryStateFromHistory, prepareParameters, type FsrsItem } from './fsrs';
import { FIELD_SEP, joinFields, sortFieldValue, splitFields, type Notetype } from './notetype';
import { generatedOrdinals } from './template';
import {
  CardQueue,
  CardType,
  defaultCollectionConfig,
  normalizeDeckConfig,
  RevlogKind,
  type Card,
  type CollectionConfig,
  type DayLimit,
  type Deck,
  type DeckConfig,
  type Rating,
  type RevlogEntry,
} from './types';

/**
 * Anki's collection operations over GakuTaku's SQLite database: decks, presets, notes, cards,
 * studying (queue + answer + undo) and the card actions (bury, suspend, flag, forget, set due date,
 * reposition). Ported from rslib (see the individual functions); written against a tiny {@link Sql}
 * interface so the same code runs in the app and in the Node test suite.
 */

export interface Sql {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  runMany(sql: string, rows: unknown[][]): Promise<void>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

export const DEFAULT_DECK_ID = 1;
export const DEFAULT_CONFIG_ID = 1;

const CARD_COLS =
  'id, nid, did, ord, mod, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, stability, difficulty, desired_retention, last_review, original_position';

interface DeckRow {
  id: number;
  name: string;
  conf_id: number;
  description: string;
  review_limit: number | null;
  new_limit: number | null;
  review_limit_today: string | null;
  new_limit_today: string | null;
  desired_retention: number | null;
  collapsed: number;
  last_day_studied: number;
  new_studied: number;
  review_studied: number;
  learning_studied: number;
  ms_studied: number;
}

function parseDayLimit(text: string | null): DayLimit | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as DayLimit;
    return typeof v?.limit === 'number' && typeof v?.today === 'number' ? v : null;
  } catch {
    return null;
  }
}

export function deckFromRow(r: DeckRow): Deck {
  return {
    ...r,
    collapsed: !!r.collapsed,
    review_limit_today: parseDayLimit(r.review_limit_today),
    new_limit_today: parseDayLimit(r.new_limit_today),
  };
}

export interface DeckConfigRow {
  id: number;
  name: string;
  config: DeckConfig;
}

export interface NoteRow {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  tags: string;
  flds: string;
}

/** Everything needed to show and answer one card. */
export interface StudyCard {
  prepared: PreparedCard;
  deck: Deck;
  config: DeckConfig;
  desiredRetention: number;
  note: NoteRow;
  notetype: Notetype;
}

/** What {@link Collection.undoAnswer} needs to reverse an answer exactly. */
export interface AnswerUndo {
  card: Card;
  revlogId: number;
  decks: DeckRow[];
  buriedSiblings: { id: number; queue: number }[];
  leechTagAdded: boolean;
}

/** Normalize a deck name the way Anki does: trim each `::` component, drop empty ones. */
export function normalizeDeckName(name: string): string {
  return name
    .split('::')
    .map((c) => c.trim())
    .filter(Boolean)
    .join('::');
}

/** Anki-style ids: epoch milliseconds, bumped past any existing id. */
async function freshId(sql: Sql, table: 'cards' | 'notes' | 'decks' | 'deck_config' | 'notetypes'): Promise<number> {
  const [row] = await sql.all<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`);
  return Math.max(Date.now(), (row?.m ?? 0) + 1);
}

function randomGuid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

const tagList = (tags: string) => tags.trim().split(/\s+/).filter(Boolean);
const tagString = (tags: string[]) => (tags.length ? ` ${[...new Set(tags)].join(' ')} ` : '');

export class Collection {
  constructor(private readonly sql: Sql) {}

  // ---- config ------------------------------------------------------------------------

  async config(sql: Sql = this.sql): Promise<CollectionConfig> {
    const [row] = await sql.all<{ value: string }>(`SELECT value FROM config WHERE key = 'col'`);
    const d = defaultCollectionConfig();
    if (!row) return d;
    try {
      return { ...d, ...(JSON.parse(row.value) as Partial<CollectionConfig>) };
    } catch {
      return d;
    }
  }

  async setConfig(patch: Partial<CollectionConfig>, sql: Sql = this.sql): Promise<void> {
    const next = { ...(await this.config(sql)), ...patch };
    await sql.run(`INSERT OR REPLACE INTO config (key, value) VALUES ('col', ?)`, [JSON.stringify(next)]);
  }

  async timing(nowMs = Date.now()): Promise<Timing> {
    const cfg = await this.config();
    return timingAt(nowMs, cfg.rollover);
  }

  /** Anki `unbury_if_day_rolled_over`: buried cards return on the next study day. */
  async unburyIfDayRolledOver(nowMs = Date.now()): Promise<void> {
    const t = await this.timing(nowMs);
    const [row] = await this.sql.all<{ value: string }>(`SELECT value FROM config WHERE key = 'lastUnburied'`);
    if (!row) {
      // First run: nothing can have been buried on an earlier day.
      await this.sql.run(`INSERT OR REPLACE INTO config (key, value) VALUES ('lastUnburied', ?)`, [String(t.today)]);
      return;
    }
    const last = Number(row.value);
    if (last < t.today || t.today + 7 < last) {
      await this.sql.transaction(async (tx) => {
        await tx.run(`UPDATE cards SET queue = ${RESTORE_QUEUE_SQL} WHERE queue IN (-2, -3)`);
        await tx.run(`INSERT OR REPLACE INTO config (key, value) VALUES ('lastUnburied', ?)`, [String(t.today)]);
      });
    }
  }

  // ---- deck configs (presets) ----------------------------------------------------------

  async deckConfigs(sql: Sql = this.sql): Promise<DeckConfigRow[]> {
    const rows = await sql.all<{ id: number; name: string; config: string }>('SELECT id, name, config FROM deck_config ORDER BY name COLLATE NOCASE');
    return rows.map((r) => ({ id: r.id, name: r.name, config: parseConfig(r.config) }));
  }

  async deckConfigMap(sql: Sql = this.sql): Promise<Map<number, DeckConfig>> {
    return new Map((await this.deckConfigs(sql)).map((c) => [c.id, c.config]));
  }

  async addDeckConfig(name: string, config: DeckConfig): Promise<number> {
    const id = await freshId(this.sql, 'deck_config');
    await this.sql.run('INSERT INTO deck_config (id, name, config, mtime) VALUES (?, ?, ?, ?)', [id, name, JSON.stringify(config), nowSecs()]);
    return id;
  }

  async updateDeckConfig(id: number, name: string, config: DeckConfig): Promise<void> {
    await this.sql.run('UPDATE deck_config SET name = ?, config = ?, mtime = ? WHERE id = ?', [name, JSON.stringify(config), nowSecs(), id]);
  }

  /** Remove a preset; decks using it fall back to Default (Anki behaviour). */
  async removeDeckConfig(id: number): Promise<void> {
    if (id === DEFAULT_CONFIG_ID) throw new Error('The Default preset can’t be removed.');
    await this.sql.transaction(async (tx) => {
      await tx.run('UPDATE decks SET conf_id = ? WHERE conf_id = ?', [DEFAULT_CONFIG_ID, id]);
      await tx.run('DELETE FROM deck_config WHERE id = ?', [id]);
    });
  }

  // ---- FSRS per preset -----------------------------------------------------------------

  /** Ids of the decks using a preset (Anki's `preset:"name"` search). */
  private async presetDeckIds(presetId: number, sql: Sql = this.sql): Promise<number[]> {
    return (await sql.all<{ id: number }>('SELECT id FROM decks WHERE conf_id = ?', [presetId])).map((r) => r.id);
  }

  private async revlogByCard(where: string, params: unknown[], sql: Sql = this.sql): Promise<Map<number, RevlogEntry[]>> {
    const rows = await sql.all<RevlogEntry>(
      `SELECT r.* FROM revlog r JOIN cards c ON c.id = r.cid WHERE ${where} ORDER BY r.cid, r.id`,
      params,
    );
    const out = new Map<number, RevlogEntry[]>();
    for (const r of rows) (out.get(r.cid) ?? out.set(r.cid, []).get(r.cid)!).push(r);
    return out;
  }

  /**
   * The optimizer's training data for a preset (Anki `compute_params` with its default search,
   * `preset:"name" -is:suspended`).
   */
  async fsrsTrainingData(
    presetId: number,
    opts: { ignoreRevlogsBeforeDate?: string; nowMs?: number } = {},
  ): Promise<{ items: FsrsItem[]; cardIds: number[]; reviewCount: number }> {
    const cfg = (await this.deckConfigMap()).get(presetId) ?? normalizeDeckConfig(null);
    const ignoreDate = opts.ignoreRevlogsBeforeDate ?? cfg.ignoreRevlogsBeforeDate;
    const dids = await this.presetDeckIds(presetId);
    if (!dids.length) return { items: [], cardIds: [], reviewCount: 0 };
    const t = await this.timing(opts.nowMs ?? Date.now());
    const revlog = await this.revlogByCard(`c.did IN (${dids.map(() => '?').join(',')}) AND c.queue != ${CardQueue.Suspended}`, dids);
    return fsrsItemsForTraining(revlog, t.nextDayAt, ignoreBeforeMs(ignoreDate));
  }

  /**
   * Anki `update_memory_state` for one preset: recompute every reviewed card's stability and
   * difficulty from its history with the preset's current parameters (after the parameters,
   * historical retention or ignore date change, or FSRS is switched on). Due dates are unchanged.
   * Returns the number of cards updated.
   */
  async updateMemoryStates(presetId: number, nowMs = Date.now()): Promise<number> {
    const cfg = (await this.deckConfigMap()).get(presetId) ?? normalizeDeckConfig(null);
    const decks = (await this.decks()).filter((d) => d.conf_id === presetId);
    if (!decks.length) return 0;
    const t = await this.timing(nowMs);
    const w = prepareParameters(cfg.fsrsParams);
    const dids = decks.map((d) => d.id);
    const deckRetention = new Map(decks.map((d) => [d.id, d.desired_retention ?? cfg.desiredRetention]));
    const revlog = await this.revlogByCard(`c.did IN (${dids.map(() => '?').join(',')}) AND c.type != ${CardType.New}`, dids);
    if (!revlog.size) return 0;
    const ids = [...revlog.keys()];
    const cards = new Map<number, { id: number; did: number; type: number; ivl: number; factor: number }>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await this.sql.all<{ id: number; did: number; type: number; ivl: number; factor: number }>(
        `SELECT id, did, type, ivl, factor FROM cards WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      );
      for (const r of rows) cards.set(r.id, r);
    }
    const ignore = ignoreBeforeMs(cfg.ignoreRevlogsBeforeDate);
    const updates: unknown[][] = [];
    for (const [cid, entries] of revlog) {
      const card = cards.get(cid);
      if (!card) continue;
      const m = memoryStateFromHistory(w, entries, t.nextDayAt, cfg.historicalRetention, card, ignore);
      updates.push([m?.stability ?? null, m?.difficulty ?? null, deckRetention.get(card.did) ?? cfg.desiredRetention, cid]);
    }
    await this.sql.transaction((tx) => tx.runMany('UPDATE cards SET stability = ?, difficulty = ?, desired_retention = ? WHERE id = ?', updates));
    return updates.length;
  }

  /** FSRS switched off: drop every card's memory state (Anki `clear_fsrs_data_for_cards`). */
  async clearMemoryStates(): Promise<void> {
    await this.sql.run('UPDATE cards SET stability = NULL, difficulty = NULL, desired_retention = NULL WHERE stability IS NOT NULL OR difficulty IS NOT NULL OR desired_retention IS NOT NULL');
  }

  // ---- decks ---------------------------------------------------------------------------

  async decks(sql: Sql = this.sql): Promise<Deck[]> {
    const rows = await sql.all<DeckRow>('SELECT * FROM decks');
    return rows.map(deckFromRow).sort((a, b) => compareDeckNames(a.name, b.name));
  }

  async deck(id: number, sql: Sql = this.sql): Promise<Deck | null> {
    const [row] = await sql.all<DeckRow>('SELECT * FROM decks WHERE id = ?', [id]);
    return row ? deckFromRow(row) : null;
  }

  /** Anki `get_or_create_normal_deck`: also creates any missing parents. */
  async getOrCreateDeck(rawName: string, sql: Sql = this.sql, confId = DEFAULT_CONFIG_ID): Promise<number> {
    const name = normalizeDeckName(rawName) || 'Default';
    const [existing] = await sql.all<{ id: number }>('SELECT id FROM decks WHERE name = ?', [name]);
    if (existing) return existing.id;
    const parent = parentName(name);
    if (parent) await this.getOrCreateDeck(parent, sql, confId);
    // "Default" keeps Anki's well-known id 1 when it's free.
    const id = name === 'Default' && !(await this.deck(DEFAULT_DECK_ID, sql)) ? DEFAULT_DECK_ID : await freshId(sql, 'decks');
    await sql.run('INSERT INTO decks (id, name, conf_id, mtime) VALUES (?, ?, ?, ?)', [id, name, confId, nowSecs()]);
    return id;
  }

  /** Rename a deck and all of its subdecks. */
  async renameDeck(id: number, newName: string): Promise<void> {
    const name = normalizeDeckName(newName);
    if (!name) throw new Error('Deck name can’t be empty.');
    await this.sql.transaction(async (tx) => {
      const deck = await this.deck(id, tx);
      if (!deck) return;
      const [clash] = await tx.all<{ id: number }>('SELECT id FROM decks WHERE name = ? AND id != ?', [name, id]);
      if (clash) throw new Error('A deck with that name already exists.');
      const parent = parentName(name);
      if (parent) await this.getOrCreateDeck(parent, tx);
      const old = deck.name;
      const children = (await this.decks(tx)).filter((d) => d.name.toLowerCase().startsWith(old.toLowerCase() + '::'));
      await tx.run('UPDATE decks SET name = ?, mtime = ? WHERE id = ?', [name, nowSecs(), id]);
      for (const c of children) await tx.run('UPDATE decks SET name = ? WHERE id = ?', [name + c.name.slice(old.length), c.id]);
    });
  }

  /** Delete a deck, its subdecks, and their cards (notes left without cards go too). Review history is kept, as in Anki. */
  async removeDeck(id: number): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const deck = await this.deck(id, tx);
      if (!deck) return;
      const ids = (await this.decks(tx)).filter((d) => d.id === id || d.name.toLowerCase().startsWith(deck.name.toLowerCase() + '::')).map((d) => d.id);
      const ph = ids.map(() => '?').join(',');
      const nids = (await tx.all<{ nid: number }>(`SELECT DISTINCT nid FROM cards WHERE did IN (${ph})`, ids)).map((r) => r.nid);
      await tx.run(`DELETE FROM cards WHERE did IN (${ph})`, ids);
      await this.removeOrphanNotes(tx, nids);
      await tx.run(`DELETE FROM decks WHERE id IN (${ph})`, ids);
    });
  }

  async updateDeck(id: number, patch: Partial<Pick<Deck, 'conf_id' | 'description' | 'review_limit' | 'new_limit' | 'review_limit_today' | 'new_limit_today' | 'desired_retention' | 'collapsed'>>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      params.push(k.endsWith('_today') ? (v ? JSON.stringify(v) : null) : k === 'collapsed' ? (v ? 1 : 0) : v);
    }
    if (!sets.length) return;
    await this.sql.run(`UPDATE decks SET ${sets.join(', ')}, mtime = ? WHERE id = ?`, [...params, nowSecs(), id]);
  }

  /** The deck list with Anki's due counts. */
  async deckTree(nowMs = Date.now()): Promise<DeckTreeNode[]> {
    await this.unburyIfDayRolledOver(nowMs);
    const cfg = await this.config();
    const t = timingAt(nowMs, cfg.rollover);
    const [decks, configs, raw] = await Promise.all([
      this.decks(),
      this.deckConfigMap(),
      this.sql.all<{ did: number; new: number; review: number; interday: number; intraday: number; total: number }>(dueCountsSql, [t.today, t.now + cfg.learnAheadSecs]),
    ]);
    const counts = new Map<number, RawDueCounts>(
      raw.map((r) => [r.did, { new: r.new ?? 0, review: r.review ?? 0, interdayLearning: r.interday ?? 0, intradayLearning: r.intraday ?? 0, total: r.total ?? 0 }]),
    );
    // Hide the Default deck when it's empty and has no children (Anki `hide_default_deck`).
    const visible = decks.filter((d) => !(d.id === DEFAULT_DECK_ID && !counts.get(d.id)?.total && !decks.some((c) => c.name.startsWith(d.name + '::')) && decks.length > 1));
    return deckTreeWithCounts(visible, configs, counts, t.today, {
      newCardsIgnoreReviewLimit: cfg.newCardsIgnoreReviewLimit,
      applyAllParentLimits: cfg.applyAllParentLimits,
    });
  }

  // ---- notetypes & notes -----------------------------------------------------------------

  async notetypes(sql: Sql = this.sql): Promise<Notetype[]> {
    const rows = await sql.all<NotetypeRow>('SELECT * FROM notetypes ORDER BY name COLLATE NOCASE');
    return rows.map(notetypeFromRow);
  }

  async notetype(id: number, sql: Sql = this.sql): Promise<Notetype | null> {
    const [row] = await sql.all<NotetypeRow>('SELECT * FROM notetypes WHERE id = ?', [id]);
    return row ? notetypeFromRow(row) : null;
  }

  async addNotetype(nt: Omit<Notetype, 'id'> & { id?: number }, sql: Sql = this.sql): Promise<number> {
    const id = nt.id ?? (await freshId(sql, 'notetypes'));
    await sql.run(
      'INSERT INTO notetypes (id, name, kind, fields, templates, css, sort_idx, latex_pre, latex_post, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, nt.name, nt.kind, JSON.stringify(nt.fields), JSON.stringify(nt.templates), nt.css, nt.sortIdx, nt.latexPre ?? null, nt.latexPost ?? null, nowSecs()],
    );
    return id;
  }

  async updateNotetype(nt: Notetype): Promise<void> {
    await this.sql.run('UPDATE notetypes SET name = ?, fields = ?, templates = ?, css = ?, sort_idx = ?, mtime = ? WHERE id = ?', [
      nt.name, JSON.stringify(nt.fields), JSON.stringify(nt.templates), nt.css, nt.sortIdx, nowSecs(), nt.id,
    ]);
  }

  async note(id: number, sql: Sql = this.sql): Promise<NoteRow | null> {
    const [row] = await sql.all<NoteRow>('SELECT id, guid, mid, mod, tags, flds FROM notes WHERE id = ?', [id]);
    return row ?? null;
  }

  /** Next new-card position(s) (Anki `nextPos`, or random when the preset inserts randomly). */
  private async allocPositions(sql: Sql, count: number, random: boolean): Promise<number[]> {
    if (random) return Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 999_999));
    const cfg = await this.config(sql);
    const start = cfg.nextPos;
    await this.setConfig({ nextPos: start + count }, sql);
    return Array.from({ length: count }, (_, i) => start + i);
  }

  /** Add a note and generate its cards (Anki `add_note`). Returns the note and card ids. */
  async addNote(mid: number, fields: string[], tags: string[], deckId: number): Promise<{ noteId: number; cardIds: number[] }> {
    return this.sql.transaction(async (tx) => {
      const nt = await this.notetype(mid, tx);
      if (!nt) throw new Error('Note type not found');
      const ords = generatedOrdinals(nt, joinFields(fields));
      if (!ords.length) throw new Error('This note would produce no cards — check that the front fields aren’t empty.');
      const noteId = await freshId(tx, 'notes');
      await tx.run('INSERT INTO notes (id, guid, mid, mod, tags, flds, sfld) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        noteId, randomGuid(), mid, nowSecs(), tagString(tags), joinFields(fields), sortFieldValue(nt, fields),
      ]);
      const deck = await this.deck(deckId, tx);
      const conf = (await this.deckConfigMap(tx)).get(deck?.conf_id ?? DEFAULT_CONFIG_ID);
      const positions = await this.allocPositions(tx, 1, conf?.newCardInsertOrder === 'random');
      const cardIds: number[] = [];
      let cid = await freshId(tx, 'cards');
      for (const ord of ords) {
        await tx.run(
          `INSERT INTO cards (id, nid, did, ord, mod, type, queue, due) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
          [cid, noteId, deckId, ord, nowSecs(), positions[0]],
        );
        cardIds.push(cid++);
      }
      return { noteId, cardIds };
    });
  }

  async updateNote(noteId: number, fields: string[], tags?: string[]): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const note = await this.note(noteId, tx);
      if (!note) return;
      const nt = await this.notetype(note.mid, tx);
      if (!nt) return;
      await tx.run('UPDATE notes SET flds = ?, sfld = ?, tags = COALESCE(?, tags), mod = ? WHERE id = ?', [
        joinFields(fields), sortFieldValue(nt, fields), tags ? tagString(tags) : null, nowSecs(), noteId,
      ]);
      // Generate any cards the edit made non-empty (Anki does this on note update too).
      const existing = new Set((await tx.all<{ ord: number }>('SELECT ord FROM cards WHERE nid = ?', [noteId])).map((r) => r.ord));
      const missing = generatedOrdinals(nt, joinFields(fields)).filter((o) => !existing.has(o));
      if (missing.length) {
        const [sib] = await tx.all<{ did: number; due: number }>('SELECT did, due FROM cards WHERE nid = ? ORDER BY ord LIMIT 1', [noteId]);
        let cid = await freshId(tx, 'cards');
        for (const ord of missing) {
          await tx.run('INSERT INTO cards (id, nid, did, ord, mod, type, queue, due) VALUES (?, ?, ?, ?, ?, 0, 0, ?)', [
            cid++, noteId, sib?.did ?? DEFAULT_DECK_ID, ord, nowSecs(), sib?.due ?? 0,
          ]);
        }
      }
    });
  }

  async setNoteTags(noteId: number, tags: string[], sql: Sql = this.sql): Promise<void> {
    await sql.run('UPDATE notes SET tags = ?, mod = ? WHERE id = ?', [tagString(tags), nowSecs(), noteId]);
  }

  private async removeOrphanNotes(tx: Sql, nids: number[]): Promise<void> {
    for (let i = 0; i < nids.length; i += 500) {
      const chunk = nids.slice(i, i + 500);
      await tx.run(`DELETE FROM notes WHERE id IN (${chunk.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM cards WHERE cards.nid = notes.id)`, chunk);
    }
  }

  /** Delete notes and all their cards. */
  async removeNotes(nids: number[]): Promise<void> {
    if (!nids.length) return;
    await this.sql.transaction(async (tx) => {
      const ph = nids.map(() => '?').join(',');
      await tx.run(`DELETE FROM cards WHERE nid IN (${ph})`, nids);
      await tx.run(`DELETE FROM notes WHERE id IN (${ph})`, nids);
    });
  }

  // ---- cards -------------------------------------------------------------------------------

  async card(id: number, sql: Sql = this.sql): Promise<Card | null> {
    const [row] = await sql.all<Card>(`SELECT ${CARD_COLS} FROM cards WHERE id = ?`, [id]);
    return row ?? null;
  }

  async cardIdsOfNote(nid: number): Promise<number[]> {
    return (await this.sql.all<{ id: number }>('SELECT id FROM cards WHERE nid = ? ORDER BY ord', [nid])).map((r) => r.id);
  }

  private async writeCard(tx: Sql, c: Card): Promise<void> {
    await tx.run(
      `UPDATE cards SET nid=?, did=?, ord=?, mod=?, type=?, queue=?, due=?, ivl=?, factor=?, reps=?, lapses=?, left=?, odue=?, odid=?, flags=?,
         stability=?, difficulty=?, desired_retention=?, last_review=?, original_position=? WHERE id=?`,
      [c.nid, c.did, c.ord, c.mod, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.left, c.odue, c.odid, c.flags,
        c.stability, c.difficulty, c.desired_retention, c.last_review, c.original_position, c.id],
    );
  }

  /** Anki `bury_or_suspend_cards`: never buries a suspended card (that would unsuspend it). */
  async buryOrSuspend(cids: number[], mode: 'suspend' | 'buryUser' | 'burySched'): Promise<void> {
    if (!cids.length) return;
    const queue = mode === 'suspend' ? CardQueue.Suspended : mode === 'buryUser' ? CardQueue.UserBuried : CardQueue.SchedBuried;
    const ph = cids.map(() => '?').join(',');
    await this.sql.run(`UPDATE cards SET queue = ?, mod = ? WHERE id IN (${ph}) AND queue != ? AND queue != -1`, [queue, nowSecs(), ...cids, queue]);
  }

  /** Anki `unbury_or_unsuspend_cards`. */
  async unburyOrUnsuspend(cids: number[]): Promise<void> {
    if (!cids.length) return;
    const ph = cids.map(() => '?').join(',');
    await this.sql.run(`UPDATE cards SET queue = ${RESTORE_QUEUE_SQL}, mod = ? WHERE id IN (${ph}) AND queue < 0`, [nowSecs(), ...cids]);
  }

  /** Unbury everything in a deck and its subdecks (Anki "Unbury" on the overview screen). */
  async unburyDeck(deckId: number): Promise<void> {
    const deck = await this.deck(deckId);
    if (!deck) return;
    const ids = (await this.decks()).filter((d) => d.id === deckId || d.name.toLowerCase().startsWith(deck.name.toLowerCase() + '::')).map((d) => d.id);
    await this.sql.run(`UPDATE cards SET queue = ${RESTORE_QUEUE_SQL} WHERE did IN (${ids.map(() => '?').join(',')}) AND queue IN (-2, -3)`, ids);
  }

  async setFlag(cids: number[], flag: number): Promise<void> {
    if (!cids.length) return;
    const ph = cids.map(() => '?').join(',');
    await this.sql.run(`UPDATE cards SET flags = (flags & ~7) | ?, mod = ? WHERE id IN (${ph})`, [flag & 7, nowSecs(), ...cids]);
  }

  async moveCards(cids: number[], deckId: number): Promise<void> {
    if (!cids.length) return;
    await this.sql.run(`UPDATE cards SET did = ?, mod = ? WHERE id IN (${cids.map(() => '?').join(',')})`, [deckId, nowSecs(), ...cids]);
  }

  /** Delete cards; notes left with none are deleted too. */
  async removeCards(cids: number[]): Promise<void> {
    if (!cids.length) return;
    await this.sql.transaction(async (tx) => {
      const ph = cids.map(() => '?').join(',');
      const nids = (await tx.all<{ nid: number }>(`SELECT DISTINCT nid FROM cards WHERE id IN (${ph})`, cids)).map((r) => r.nid);
      await tx.run(`DELETE FROM cards WHERE id IN (${ph})`, cids);
      await this.removeOrphanNotes(tx, nids);
    });
  }

  private async logManual(tx: Sql, card: Card, ivl: number, factor: number): Promise<void> {
    let id = Date.now();
    const [taken] = await tx.all<{ id: number }>('SELECT id FROM revlog WHERE id >= ? ORDER BY id DESC LIMIT 1', [id]);
    if (taken) id = taken.id + 1;
    await tx.run('INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (?, ?, 0, ?, ?, ?, 0, ?)', [
      id, card.id, ivl, card.ivl, factor, RevlogKind.Manual,
    ]);
  }

  /** Anki "Forget" (`reschedule_cards_as_new`): back to new at the end of the new queue. */
  async forget(cids: number[], opts: { resetCounts: boolean; restorePosition: boolean }): Promise<void> {
    await this.sql.transaction(async (tx) => {
      for (const id of cids) {
        const c = await this.card(id, tx);
        if (!c) continue;
        const [pos] = opts.restorePosition && c.original_position != null ? [c.original_position] : await this.allocPositions(tx, 1, false);
        await this.logManual(tx, c, 0, 0);
        await this.writeCard(tx, {
          ...c,
          type: CardType.New,
          queue: CardQueue.New,
          due: pos,
          ivl: 0,
          factor: 0,
          left: 0,
          reps: opts.resetCounts ? 0 : c.reps,
          lapses: opts.resetCounts ? 0 : c.lapses,
          stability: null,
          difficulty: null,
          last_review: null,
          original_position: null,
          mod: nowSecs(),
        });
      }
    });
  }

  /**
   * Anki "Set due date" (`set_due_date`): `days` is a range like "0", "1-7", and a trailing `!`
   * also sets the interval to the new delay.
   */
  async setDueDate(cids: number[], spec: string, nowMs = Date.now()): Promise<void> {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*(!)?\s*$/.exec(spec);
    if (!m) throw new Error('Use a number of days, a range like 1-7, and optionally ! to also set the interval.');
    const lo = Number(m[1]);
    const hi = m[2] != null ? Number(m[2]) : lo;
    const setIvl = !!m[3];
    const t = await this.timing(nowMs);
    const configs = await this.deckConfigMap();
    const decks = new Map((await this.decks()).map((d) => [d.id, d]));
    await this.sql.transaction(async (tx) => {
      for (const id of cids) {
        const c = await this.card(id, tx);
        if (!c) continue;
        const days = lo + Math.floor(Math.random() * (Math.max(hi, lo) - lo + 1));
        const due = t.today + days;
        const conf = configs.get(decks.get(c.did)?.conf_id ?? 1);
        let ivl = c.ivl;
        if (c.type === CardType.Review || c.type === CardType.Relearn) {
          const daysSinceReview = c.last_review != null ? Math.max(0, Math.floor((t.nextDayAt - c.last_review) / 86_400)) : Math.max(0, c.ivl - (c.due - t.today));
          if (setIvl) ivl = Math.max(days + daysSinceReview, 1);
        } else {
          ivl = Math.max(days, 1);
        }
        const factor = c.factor || Math.round((conf?.initialEase ?? 2.5) * 1000);
        await this.logManual(tx, c, ivl, factor);
        await this.writeCard(tx, {
          ...c,
          type: CardType.Review,
          queue: CardQueue.Review,
          due,
          ivl,
          factor,
          left: 0,
          original_position: c.type === CardType.New ? c.due : c.original_position,
          mod: nowSecs(),
        });
      }
    });
  }

  /** Anki "Reposition" for new cards. */
  async repositionNew(cids: number[], start: number, step: number, randomize: boolean, shiftExisting: boolean): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const ph = cids.map(() => '?').join(',');
      const cards = await tx.all<{ id: number; nid: number }>(`SELECT id, nid FROM cards WHERE id IN (${ph}) AND type = 0 ORDER BY due, ord`, cids);
      const nids = [...new Set(cards.map((c) => c.nid))];
      if (randomize) nids.sort(() => Math.random() - 0.5);
      const posOf = new Map(nids.map((n, i) => [n, start + i * step]));
      if (shiftExisting) {
        await tx.run(`UPDATE cards SET due = due + ? WHERE type = 0 AND due >= ? AND id NOT IN (${ph})`, [nids.length * step, start, ...cids]);
      }
      for (const c of cards) await tx.run('UPDATE cards SET due = ?, mod = ? WHERE id = ?', [posOf.get(c.nid)!, nowSecs(), c.id]);
      const cfg = await this.config(tx);
      const maxPos = start + Math.max(0, nids.length - 1) * step;
      if (maxPos >= cfg.nextPos) await this.setConfig({ nextPos: maxPos + 1 }, tx);
    });
  }

  // ---- studying ------------------------------------------------------------------------

  /** Build today's queue for a deck (and its subdecks). */
  async buildQueues(deckId: number, nowMs = Date.now()): Promise<CardQueues> {
    await this.unburyIfDayRolledOver(nowMs);
    const cfg = await this.config();
    const t = timingAt(nowMs, cfg.rollover);
    const decks = await this.decks();
    let ids: number[];
    if (deckId === WHOLE_COLLECTION) ids = decks.map((d) => d.id);
    else {
      const root = decks.find((d) => d.id === deckId);
      if (!root) throw new Error('Deck not found');
      ids = decks.filter((d) => d.id === deckId || d.name.toLowerCase().startsWith(root.name.toLowerCase() + '::')).map((d) => d.id);
    }
    if (!ids.length) ids = [-1];
    const ph = ids.map(() => '?').join(',');
    const cards = await this.sql.all<QueueCard>(
      `SELECT id, nid, did, ord, queue, due, ivl, factor, mod, reps, stability, difficulty, last_review FROM cards
       WHERE did IN (${ph}) AND (queue = 0 OR (queue IN (2, 3) AND due <= ?) OR (queue IN (1, 4) AND due <= ?))`,
      [...ids, t.today, t.nextDayAt],
    );
    return buildQueues({
      timing: t,
      learnAheadSecs: cfg.learnAheadSecs,
      rootDeckId: deckId,
      decks,
      configs: await this.deckConfigMap(),
      cards,
      newCardsIgnoreReviewLimit: cfg.newCardsIgnoreReviewLimit,
      applyAllParentLimits: cfg.applyAllParentLimits,
      fsrs: cfg.fsrs,
    });
  }

  /** Load a card with everything needed to show it and its four button outcomes. */
  async studyCard(cardId: number, nowMs = Date.now()): Promise<StudyCard | null> {
    const card = await this.card(cardId);
    if (!card) return null;
    const cfg = await this.config();
    const t = timingAt(nowMs, cfg.rollover);
    const deck = (await this.deck(card.did)) ?? null;
    if (!deck) return null;
    const configs = await this.deckConfigMap();
    const config = configs.get(deck.conf_id) ?? configs.get(DEFAULT_CONFIG_ID) ?? normalizeDeckConfig(null);
    const desiredRetention = deck.desired_retention ?? config.desiredRetention;
    const needsHistory = cfg.fsrs && card.type !== CardType.New && (card.stability == null || card.last_review == null);
    const revlog = needsHistory ? await this.sql.all<RevlogEntry>('SELECT * FROM revlog WHERE cid = ? ORDER BY id', [card.id]) : undefined;
    const prepared = prepareCard({ card, config, desiredRetention, timing: t, fsrs: cfg.fsrs, fsrsShortTermWithSteps: cfg.fsrsShortTermWithSteps, revlog });
    const note = await this.note(card.nid);
    const notetype = note ? await this.notetype(note.mid) : null;
    if (!note || !notetype) return null;
    return { prepared, deck, config, desiredRetention, note, notetype };
  }

  /**
   * Answer a card (Anki `answer_card`): update it, log the review, count it toward the deck's
   * (and parents') daily limits, bury siblings per the preset, and tag leeches. Returns undo info.
   */
  async answer(study: StudyCard, rating: Rating, millisecondsTaken: number, nowMs = Date.now()): Promise<{ undo: AnswerUndo; card: Card }> {
    const cfg = await this.config();
    const t = timingAt(nowMs, cfg.rollover);
    return this.sql.transaction(async (tx) => {
      const original = (await this.card(study.prepared.card.id, tx))!;
      let answeredAt = nowMs;
      const [clash] = await tx.all<{ id: number }>('SELECT id FROM revlog WHERE id >= ? ORDER BY id DESC LIMIT 1', [answeredAt]);
      if (clash) answeredAt = clash.id + 1;
      const result = applyAnswer(study.prepared, rating, { config: study.config, timing: t, fsrs: cfg.fsrs, desiredRetention: study.desiredRetention }, answeredAt, millisecondsTaken);
      await this.writeCard(tx, result.card);
      const r = result.revlog;
      await tx.run('INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type,
      ]);

      // Deck stats ("studied today") for the deck and its parents.
      const decks = await this.decks(tx);
      const deck = decks.find((d) => d.id === original.did);
      const affected = deck ? decks.filter((d) => d.id === deck.id || deck.name.toLowerCase().startsWith(d.name.toLowerCase() + '::')) : [];
      const deckRows = await tx.all<DeckRow>(`SELECT * FROM decks WHERE id IN (${affected.map(() => '?').join(',') || 'NULL'})`, affected.map((d) => d.id));
      const newDelta = original.queue === CardQueue.New ? 1 : 0;
      const reviewDelta = original.queue === CardQueue.Review || original.queue === CardQueue.DayLearn ? 1 : 0;
      for (const d of affected) {
        const reset = d.last_day_studied !== t.today;
        await tx.run(
          'UPDATE decks SET last_day_studied = ?, new_studied = ?, review_studied = ?, learning_studied = ?, ms_studied = ? WHERE id = ?',
          [
            t.today,
            (reset ? 0 : d.new_studied) + newDelta,
            (reset ? 0 : d.review_studied) + reviewDelta,
            reset ? 0 : d.learning_studied,
            (reset ? 0 : d.ms_studied) + r.time,
            d.id,
          ],
        );
      }

      // Bury siblings (Anki `maybe_bury_siblings` + `exclude_earlier_gathered_queues`).
      const buried: { id: number; queue: number }[] = [];
      const c = study.config;
      if (c.buryNew || c.buryReviews || c.buryInterdayLearning) {
        const ord = gatherOrd(original.queue);
        const buryInterday = c.buryInterdayLearning && ord <= 1;
        const buryReviews = c.buryReviews && ord <= 2;
        const sibs = await tx.all<{ id: number; queue: number }>(
          `SELECT id, queue FROM cards WHERE nid = ? AND id != ? AND ((? AND queue = 0) OR (? AND queue = 2) OR (? AND queue = 3))`,
          [original.nid, original.id, c.buryNew ? 1 : 0, buryReviews ? 1 : 0, buryInterday ? 1 : 0],
        );
        for (const s of sibs) {
          await tx.run('UPDATE cards SET queue = -2, mod = ? WHERE id = ?', [nowSecs(), s.id]);
          buried.push(s);
        }
      }

      // Leech tag.
      let leechTagAdded = false;
      if (result.leeched) {
        const note = await this.note(original.nid, tx);
        if (note && !tagList(note.tags).some((t) => t.toLowerCase() === 'leech')) {
          await this.setNoteTags(note.id, [...tagList(note.tags), 'leech'], tx);
          leechTagAdded = true;
        }
      }
      return { undo: { card: original, revlogId: r.id, decks: deckRows, buriedSiblings: buried, leechTagAdded }, card: result.card };
    });
  }

  /** Reverse an answer exactly (Anki's undo of `AnswerCard`). */
  async undoAnswer(u: AnswerUndo): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await this.writeCard(tx, u.card);
      await tx.run('DELETE FROM revlog WHERE id = ?', [u.revlogId]);
      for (const d of u.decks) {
        await tx.run('UPDATE decks SET last_day_studied = ?, new_studied = ?, review_studied = ?, learning_studied = ?, ms_studied = ? WHERE id = ?', [
          d.last_day_studied, d.new_studied, d.review_studied, d.learning_studied, d.ms_studied, d.id,
        ]);
      }
      for (const s of u.buriedSiblings) await tx.run('UPDATE cards SET queue = ? WHERE id = ?', [s.queue, s.id]);
      if (u.leechTagAdded) {
        const note = await this.note(u.card.nid, tx);
        if (note) await this.setNoteTags(note.id, tagList(note.tags).filter((t) => t.toLowerCase() !== 'leech'), tx);
      }
    });
  }

  /** Total due counts across all top-level decks (for the Review tab badge). */
  async totalDue(nowMs = Date.now()): Promise<{ new: number; learning: number; review: number }> {
    const roots = await this.deckTree(nowMs);
    return roots.reduce((a, n) => ({ new: a.new + n.newCount, learning: a.learning + n.learnCount, review: a.review + n.reviewCount }), { new: 0, learning: 0, review: 0 });
  }
}

/** Anki `restore_queue_from_type`, as SQL. */
export const RESTORE_QUEUE_SQL = `(CASE WHEN type IN (1, 3) THEN (CASE WHEN due > 1000000000 THEN 1 ELSE 3 END) ELSE type END)`;

/** Anki `CardQueue::gather_ord`. */
function gatherOrd(queue: number): number {
  switch (queue) {
    case CardQueue.Learn:
    case CardQueue.PreviewRepeat:
      return 0;
    case CardQueue.DayLearn:
      return 1;
    case CardQueue.Review:
      return 2;
    case CardQueue.New:
      return 3;
    default:
      return 255;
  }
}

const nowSecs = () => Math.floor(Date.now() / 1000);

function parseConfig(text: string): DeckConfig {
  try {
    return normalizeDeckConfig(JSON.parse(text) as Partial<DeckConfig>);
  } catch {
    return normalizeDeckConfig(null);
  }
}

interface NotetypeRow {
  id: number;
  name: string;
  kind: number;
  fields: string;
  templates: string;
  css: string;
  sort_idx: number;
  latex_pre: string | null;
  latex_post: string | null;
}

function notetypeFromRow(r: NotetypeRow): Notetype {
  const parse = <T,>(s: string, d: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return d;
    }
  };
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === 1 ? 1 : 0,
    fields: parse(r.fields, []),
    templates: parse(r.templates, []),
    css: r.css,
    sortIdx: r.sort_idx,
    latexPre: r.latex_pre ?? undefined,
    latexPost: r.latex_post ?? undefined,
  };
}

export { FIELD_SEP, splitFields };
