import { applyAnswer, prepareCard, type PreparedCard } from './answer';
import { deckTreeWithCounts, dueCountsSql, type DeckTreeNode, type RawDueCounts } from './deckTree';
import { compareDeckNames, parentName } from './limits';
import { buildQueues, WHOLE_COLLECTION, type CardQueues, type QueueCard } from './queue';
import { timingAt, type Timing } from './timing';
import { fsrsItemsForTraining, ignoreBeforeMs, memoryStateFromHistory, prepareParameters, retrievability, type FsrsItem } from './fsrs';
import { compileSearch, deckSearch, sortSql, type SearchContext, type SortColumn } from './search';
import { stripHtmlText } from '../db/sqlFunctions';
import { FIELD_SEP, joinFields, sortFieldValue, splitFields, type Notetype } from './notetype';
import { generatedOrdinals } from './template';
import {
  CardQueue,
  CardType,
  defaultCollectionConfig,
  defaultFilteredConfig,
  normalizeDeckConfig,
  RevlogKind,
  type Card,
  type CollectionConfig,
  type DayLimit,
  type Deck,
  type DeckConfig,
  type FilteredDeckConfig,
  type FilteredOrder,
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
  /** Several different statements in one go (one worker round trip in the app). */
  runBatch(statements: [string, unknown[]][]): Promise<void>;
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
  filtered?: string | null;
}

function parseFiltered(text: string | null | undefined): FilteredDeckConfig | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<FilteredDeckConfig>;
    const d = defaultFilteredConfig();
    return { ...d, ...v, terms: Array.isArray(v.terms) && v.terms.length ? v.terms.slice(0, 2) : d.terms };
  } catch {
    return null;
  }
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
    filtered: parseFiltered(r.filtered),
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

/** Cards (and notes) as they were before a card action, for undo. */
export interface CardsSnapshot {
  cids: number[];
  cards: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  /** Review-log entries newer than this (for these cards) were written by the action. */
  revlogAfter: number;
}

/** Everything Anki's Card Info screen shows. */
export interface CardInfo {
  card: Card;
  note: NoteRow;
  notetype: Notetype;
  deckName: string;
  /** The home deck of a card in a filtered deck. */
  originalDeckName: string | null;
  templateName: string;
  presetName: string;
  revlog: RevlogEntry[];
  /** FSRS: the chance of recalling it now (0–1); null without a memory state. */
  retrievability: number | null;
  timing: Timing;
}

/** Everything needed to show and answer one card. */
export interface StudyCard {
  prepared: PreparedCard;
  deck: Deck;
  config: DeckConfig;
  desiredRetention: number;
  note: NoteRow;
  notetype: Notetype;
  /** The card as stored when loaded (what undo restores). */
  original: Card;
  /** Review history, when FSRS needed it to derive a memory state. */
  revlog?: RevlogEntry[];
  /** The note's other cards and their queues when loaded (for sibling burying). */
  siblings: { id: number; queue: number }[];
  /** Collection settings when loaded. */
  colConfig: CollectionConfig;
}

/** An answer worked out in memory (see {@link Collection.planAnswer}), not yet saved. */
export interface AnswerPlan {
  study: StudyCard;
  /** The answered card. */
  card: Card;
  revlog: RevlogEntry;
  /** Siblings to bury, with the queue each had. */
  bury: { id: number; queue: number }[];
  /** New tags for the note when the card became a leech and lacks the tag; null otherwise. */
  leechTags: string[] | null;
  today: number;
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

/** Anki's Custom Study choices. */
export type CustomStudyRequest =
  | { kind: 'newLimit'; delta: number }
  | { kind: 'reviewLimit'; delta: number }
  | { kind: 'forgot'; days: number }
  | { kind: 'ahead'; days: number }
  | { kind: 'preview'; days: number }
  | { kind: 'cram'; cram: 'new' | 'due' | 'review' | 'all'; limit: number; includeTags: string[]; excludeTags: string[] };

/** ORDER BY for a filtered deck search (Anki `order_and_limit_for_search`). */
function filteredOrderSql(order: FilteredOrder, t: Timing): string {
  switch (order) {
    case 'oldestSeen':
      return '(SELECT MAX(id) FROM revlog WHERE cid = c.id)';
    case 'random':
      return 'random()';
    case 'ivlAsc':
      return 'c.ivl';
    case 'ivlDesc':
      return 'c.ivl DESC';
    case 'lapses':
      return 'c.lapses DESC';
    case 'added':
      return 'n.id, c.ord';
    case 'reverseAdded':
      return 'n.id DESC, c.ord ASC';
    case 'due':
      return `(CASE WHEN c.due > 1000000000 THEN c.due ELSE (c.due - ${t.today}) * 86400 + ${t.now} END), c.ord`;
  }
}

/** A tag or name for a search term, quoted if it has spaces. */
const quoteTerm = (s: string) => (/[\s()"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** A field as Anki's duplicate check compares it (same as the strip_html SQL function). */
const stripForDupe = stripHtmlText;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Point a template's references to a field at its new name ({{F}}, {{#F}}, {{/F}}, {{text:F}}…). */
export function renameFieldRefs(template: string, from: string, to: string): string {
  return template.replace(new RegExp(`\\{\\{([#^/]?)((?:[^{}:]*:)*)${escapeRegExp(from)}\\}\\}`, 'g'), (_m, sigil: string, filters: string) => `{{${sigil}${filters}${to}}}`);
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
      const old = deck.name;
      // Anki refuses to move a deck inside itself (its own parent would be the deck being renamed).
      if (name.toLowerCase().startsWith(old.toLowerCase() + '::')) throw new Error('A deck can’t be moved inside itself.');
      const parent = parentName(name);
      if (parent) {
        const pid = await this.getOrCreateDeck(parent, tx);
        if ((await this.deck(pid, tx))?.filtered) throw new Error('A filtered deck can’t contain other decks.');
      }
      const children = (await this.decks(tx)).filter((d) => d.name.toLowerCase().startsWith(old.toLowerCase() + '::'));
      await tx.run('UPDATE decks SET name = ?, mtime = ? WHERE id = ?', [name, nowSecs(), id]);
      for (const c of children) await tx.run('UPDATE decks SET name = ? WHERE id = ?', [name + c.name.slice(old.length), c.id]);
    });
  }

  /**
   * Delete a deck, its subdecks, and their cards (notes left without cards go too). Review history is
   * kept, as in Anki. A filtered deck's cards go back to their own decks instead.
   */
  async removeDeck(id: number): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const deck = await this.deck(id, tx);
      if (!deck) return;
      const ids = (await this.decks(tx)).filter((d) => d.id === id || d.name.toLowerCase().startsWith(deck.name.toLowerCase() + '::')).map((d) => d.id);
      const ph = ids.map(() => '?').join(',');
      // Cards borrowed by filtered decks being deleted go home first.
      await this.returnCardsHome(tx, `did IN (${ph})`, ids);
      const where = `did IN (${ph}) OR odid IN (${ph})`;
      const nids = (await tx.all<{ nid: number }>(`SELECT DISTINCT nid FROM cards WHERE ${where}`, [...ids, ...ids])).map((r) => r.nid);
      await tx.run(`DELETE FROM cards WHERE ${where}`, [...ids, ...ids]);
      await this.removeOrphanNotes(tx, nids);
      await tx.run(`DELETE FROM decks WHERE id IN (${ph})`, ids);
    });
  }

  // ---- filtered decks (rslib/src/scheduler/filtered) ------------------------------------------

  /**
   * Put cards in filtered decks back in their own decks with their old due dates (Anki
   * `remove_from_filtered_deck_restoring_queue`). `where` selects among cards.
   */
  private async returnCardsHome(tx: Sql, where: string, params: unknown[]): Promise<void> {
    // SET expressions all see the row as it was, so `due`/`odue` below are the pre-update values.
    await tx.run(
      `UPDATE cards SET
         did = odid,
         odid = 0,
         due = CASE WHEN odue != 0 THEN odue ELSE due END,
         queue = CASE
           WHEN queue < 0 THEN queue
           WHEN type IN (1, 3) THEN (CASE WHEN (CASE WHEN odue != 0 THEN odue ELSE due END) > 1000000000 THEN 1 ELSE 3 END)
           WHEN type = 0 THEN 0
           ELSE 2 END,
         odue = 0,
         mod = ?
       WHERE odid != 0 AND (${where})`,
      [nowSecs(), ...params],
    );
  }

  /** Move a filtered deck's cards back to their own decks (Anki "Empty"). */
  async emptyFilteredDeck(id: number): Promise<void> {
    await this.sql.transaction((tx) => this.returnCardsHome(tx, 'did = ?', [id]));
  }

  /** Empty and refill a filtered deck from its searches (Anki "Rebuild"). Returns the card count. */
  async rebuildFilteredDeck(id: number, nowMs = Date.now()): Promise<number> {
    return this.sql.transaction(async (tx) => {
      const deck = await this.deck(id, tx);
      if (!deck?.filtered) throw new Error('Not a filtered deck.');
      return this.fillFilteredDeck(tx, deck, nowMs);
    });
  }

  private async fillFilteredDeck(tx: Sql, deck: Deck, nowMs: number): Promise<number> {
    const cfg = deck.filtered!;
    await this.returnCardsHome(tx, 'did = ?', [deck.id]);
    const colCfg = await this.config(tx);
    const t = timingAt(nowMs, colCfg.rollover);
    const [decks, notetypes] = await Promise.all([this.decks(tx), this.notetypes(tx)]);
    const ctx: SearchContext = { decks, notetypes, today: t.today, nextDayAt: t.nextDayAt, nowSecs: t.now, learnAheadSecs: colCfg.learnAheadSecs };
    const start = -100_000;
    let position = start;
    for (const term of cfg.terms.slice(0, 2)) {
      // Anki: suspended, buried and already-filtered cards are never pulled in.
      const { where, params } = compileSearch(`${term.search.trim() ? `(${term.search}) ` : ''}-is:suspended -is:buried -deck:filtered`, ctx);
      const rows = await tx.all<{ id: number }>(
        `SELECT c.id FROM cards c JOIN notes n ON n.id = c.nid WHERE ${where} ORDER BY ${filteredOrderSql(term.order, t)}, c.id LIMIT ${Math.max(0, Math.floor(term.limit))}`,
        params,
      );
      const mod = nowSecs();
      const statements: [string, unknown[]][] = rows.map((r) => [
        // Anki `move_into_filtered_deck`: remember the home deck and due; without rescheduling every
        // card waits in the review queue; positive dues become the build order.
        `UPDATE cards SET odid = did, did = ?, odue = due, queue = CASE WHEN ? THEN queue ELSE 2 END, due = CASE WHEN due > 0 THEN ? ELSE due END, mod = ? WHERE id = ? AND odid = 0`,
        [deck.id, cfg.reschedule ? 1 : 0, position++, mod, r.id],
      ]);
      if (statements.length) await tx.runBatch(statements);
    }
    return position - start;
  }

  /**
   * Create a filtered deck and fill it. Throws (creating nothing) when the searches are invalid or
   * match no cards, as Anki does.
   */
  async addFilteredDeck(rawName: string, cfg: FilteredDeckConfig, nowMs = Date.now()): Promise<{ id: number; count: number }> {
    const name = normalizeDeckName(rawName);
    if (!name) throw new Error('Deck name can’t be empty.');
    return this.sql.transaction(async (tx) => {
      const [clash] = await tx.all<{ id: number }>('SELECT id FROM decks WHERE name = ?', [name]);
      if (clash) throw new Error('A deck with that name already exists.');
      const parent = parentName(name);
      if (parent) {
        const pid = await this.getOrCreateDeck(parent, tx);
        if ((await this.deck(pid, tx))?.filtered) throw new Error('A filtered deck can’t contain other decks.');
      }
      const id = await freshId(tx, 'decks');
      await tx.run('INSERT INTO decks (id, name, conf_id, collapsed, filtered, mtime) VALUES (?, ?, 0, 0, ?, ?)', [id, name, JSON.stringify(cfg), nowSecs()]);
      const count = await this.fillFilteredDeck(tx, (await this.deck(id, tx))!, nowMs);
      if (count === 0) throw new Error('No cards matched the search. Try a different search, or check that the cards aren’t suspended or buried.');
      return { id, count };
    });
  }

  /** Change a filtered deck's name and settings, and rebuild it (unchanged if nothing matches). */
  async updateFilteredDeck(id: number, rawName: string, cfg: FilteredDeckConfig, nowMs = Date.now()): Promise<number> {
    const name = normalizeDeckName(rawName);
    if (!name) throw new Error('Deck name can’t be empty.');
    return this.sql.transaction(async (tx) => {
      const deck = await this.deck(id, tx);
      if (!deck?.filtered) throw new Error('Not a filtered deck.');
      const [clash] = await tx.all<{ id: number }>('SELECT id FROM decks WHERE name = ? AND id != ?', [name, id]);
      if (clash) throw new Error('A deck with that name already exists.');
      await tx.run('UPDATE decks SET name = ?, filtered = ?, mtime = ? WHERE id = ?', [name, JSON.stringify(cfg), nowSecs(), id]);
      const count = await this.fillFilteredDeck(tx, { ...deck, name, filtered: cfg }, nowMs);
      if (count === 0) throw new Error('No cards matched the search. Try a different search, or check that the cards aren’t suspended or buried.');
      return count;
    });
  }

  /**
   * Anki's Custom Study: more new or review cards today for a deck, or a "Custom Study Session"
   * filtered deck (reusing it if one exists).
   */
  async customStudy(deckId: number, req: CustomStudyRequest, nowMs = Date.now()): Promise<{ id: number; count: number } | null> {
    const deck = await this.deck(deckId);
    if (!deck || deck.filtered) throw new Error('Custom study works on normal decks.');
    if (req.kind === 'newLimit' || req.kind === 'reviewLimit') {
      const cfg = await this.config();
      const t = timingAt(nowMs, cfg.rollover);
      await this.sql.transaction(async (tx) => {
        const targets = [deck, ...(cfg.applyAllParentLimits ? (await this.decks(tx)).filter((d) => deck.name.toLowerCase().startsWith(d.name.toLowerCase() + '::')) : [])];
        for (const d of targets) {
          // Anki `extend_limits`: today's studied counts go down, so more cards fit under the limit.
          const fresh = d.last_day_studied === t.today;
          const newStudied = (fresh ? d.new_studied : 0) - (req.kind === 'newLimit' ? req.delta : 0);
          const reviewStudied = (fresh ? d.review_studied : 0) - (req.kind === 'reviewLimit' ? req.delta : 0);
          await tx.run('UPDATE decks SET last_day_studied = ?, new_studied = ?, review_studied = ?, learning_studied = ?, ms_studied = ?, mtime = ? WHERE id = ?', [
            t.today, newStudied, reviewStudied, fresh ? d.learning_studied : 0, fresh ? d.ms_studied : 0, nowSecs(), d.id,
          ]);
        }
      });
      return null;
    }
    const search = deckSearch(deck.name);
    let cfg: FilteredDeckConfig;
    const session = (reschedule: boolean, s: string, order: FilteredOrder, limit = 99_999): FilteredDeckConfig => ({
      ...defaultFilteredConfig(),
      reschedule,
      terms: [{ search: s, limit, order }],
    });
    switch (req.kind) {
      case 'forgot':
        cfg = session(false, `rated:${req.days}:1 ${search}`, 'random');
        break;
      case 'ahead':
        cfg = session(true, `prop:due<=${req.days} ${search}`, 'due');
        break;
      case 'preview':
        cfg = session(false, `is:new added:${req.days} ${search}`, 'added');
        break;
      case 'cram': {
        const kind = req.cram === 'new' ? 'is:new' : req.cram === 'due' ? 'is:due' : req.cram === 'review' ? '-is:new' : '';
        const include = req.includeTags.length ? `(${req.includeTags.map((t) => `tag:${quoteTerm(t)}`).join(' or ')})` : '';
        const exclude = req.excludeTags.map((t) => `-tag:${quoteTerm(t)}`).join(' ');
        const order: FilteredOrder = req.cram === 'new' ? 'added' : req.cram === 'due' ? 'due' : 'random';
        cfg = session(req.cram !== 'all', [kind, search, include, exclude].filter(Boolean).join(' '), order, req.limit);
        break;
      }
    }
    return this.sessionDeck('Custom Study Session', cfg, nowMs);
  }

  /**
   * A session deck holding exactly these cards, studied with normal scheduling (the reader's
   * "Review mined" button). Remove it with {@link removeDeck} afterwards to send the cards home.
   */
  async cardSession(name: string, cids: number[], nowMs = Date.now()): Promise<{ id: number; count: number }> {
    if (cids.length === 0) throw new Error('No cards to study.');
    const cfg: FilteredDeckConfig = { ...defaultFilteredConfig(), reschedule: true, terms: [{ search: `cid:${cids.join(',')}`, limit: 99_999, order: 'added' }] };
    return this.sessionDeck(name, cfg, nowMs);
  }

  /** Build (or rebuild) the filtered deck called `name`, refusing to touch a normal deck by that name. */
  private async sessionDeck(name: string, cfg: FilteredDeckConfig, nowMs: number): Promise<{ id: number; count: number }> {
    const [existing] = await this.sql.all<{ id: number; filtered: string | null }>('SELECT id, filtered FROM decks WHERE name = ?', [name]);
    if (existing && !existing.filtered) throw new Error(`Rename the deck called “${name}” first: this uses that name.`);
    if (existing) return { id: existing.id, count: await this.updateFilteredDeck(existing.id, name, cfg, nowMs) };
    return this.addFilteredDeck(name, cfg, nowMs);
  }

  /** Counts for the Custom Study dialog (Anki `custom_study_defaults`): what's left beyond today's limits. */
  async customStudyInfo(deckId: number, nowMs = Date.now()): Promise<{ newAvailable: number; reviewAvailable: number; tags: string[] }> {
    const deck = await this.deck(deckId);
    if (!deck) return { newAvailable: 0, reviewAvailable: 0, tags: [] };
    const t = await this.timing(nowMs);
    const ids = (await this.decks()).filter((d) => d.id === deckId || d.name.toLowerCase().startsWith(deck.name.toLowerCase() + '::')).map((d) => d.id);
    const ph = ids.map(() => '?').join(',');
    const [row] = await this.sql.all<{ n: number; r: number }>(
      `SELECT SUM(queue = 0) AS n, SUM(queue IN (2, 3) AND due <= ?) AS r FROM cards WHERE did IN (${ph})`,
      [t.today, ...ids],
    );
    const tagRows = await this.sql.all<{ tags: string }>(`SELECT DISTINCT n.tags FROM notes n JOIN cards c ON c.nid = n.id WHERE c.did IN (${ph}) AND trim(n.tags) != ''`, ids);
    const tags = new Map<string, string>();
    for (const r of tagRows) for (const tag of tagList(r.tags)) if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
    return { newAvailable: row?.n ?? 0, reviewAvailable: row?.r ?? 0, tags: [...tags.values()].sort((a, b) => a.localeCompare(b)) };
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

  // ---- note type management (Anki's Manage Note Types) ---------------------------------------

  /** How many notes use each note type. */
  async notetypeUseCounts(): Promise<Map<number, number>> {
    const rows = await this.sql.all<{ mid: number; n: number }>('SELECT mid, COUNT(*) AS n FROM notes GROUP BY mid');
    return new Map(rows.map((r) => [r.mid, r.n]));
  }

  async renameNotetype(id: number, name: string): Promise<void> {
    const nt = await this.notetype(id);
    if (!nt) return;
    const clean = name.trim();
    if (!clean) throw new Error('Enter a name.');
    await this.updateNotetype({ ...nt, name: clean });
  }

  /** Delete a note type with all its notes and cards. The last note type can't be removed. */
  async removeNotetype(id: number): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const [{ n }] = await tx.all<{ n: number }>('SELECT COUNT(*) AS n FROM notetypes');
      if (n <= 1) throw new Error('The last note type can’t be deleted.');
      await tx.run('DELETE FROM cards WHERE nid IN (SELECT id FROM notes WHERE mid = ?)', [id]);
      await tx.run('DELETE FROM notes WHERE mid = ?', [id]);
      await tx.run('DELETE FROM notetypes WHERE id = ?', [id]);
    });
  }

  /**
   * Change a note type's fields (Anki's Fields dialog): `fields` lists the new fields in order, each
   * with the index of the old field it continues (null = new, empty). Notes are rewritten to match,
   * and templates follow renamed fields.
   */
  async changeNotetypeFields(id: number, fields: { name: string; from: number | null }[], sortIdx: number): Promise<void> {
    const names = fields.map((f) => f.name.trim());
    if (!names.length) throw new Error('A note type needs at least one field.');
    if (names.some((n) => !n)) throw new Error('Field names can’t be empty.');
    if (names.some((n) => /[:{}"]/.test(n) || /^[#/^]/.test(n))) throw new Error('Field names can’t contain : { } " or start with # / ^.');
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new Error('Field names must be different.');
    await this.sql.transaction(async (tx) => {
      const nt = await this.notetype(id, tx);
      if (!nt) throw new Error('Note type not found');
      const old = [...nt.fields].sort((a, b) => a.ord - b.ord);
      let templates = nt.templates;
      for (const [i, f] of fields.entries()) {
        const before = f.from != null ? old[f.from]?.name : undefined;
        if (before && before !== names[i]) templates = templates.map((t) => ({ ...t, qfmt: renameFieldRefs(t.qfmt, before, names[i]), afmt: renameFieldRefs(t.afmt, before, names[i]) }));
      }
      const next: Notetype = {
        ...nt,
        fields: names.map((name, ord) => ({ name, ord })),
        templates,
        sortIdx: Math.min(Math.max(0, sortIdx), names.length - 1),
      };
      await tx.run('UPDATE notetypes SET fields = ?, templates = ?, sort_idx = ?, mtime = ? WHERE id = ?', [
        JSON.stringify(next.fields), JSON.stringify(next.templates), next.sortIdx, nowSecs(), id,
      ]);
      const notes = await tx.all<{ id: number; flds: string }>('SELECT id, flds FROM notes WHERE mid = ?', [id]);
      const mod = nowSecs();
      const statements: [string, unknown[]][] = [];
      for (const n of notes) {
        const vals = splitFields(n.flds);
        const out = fields.map((f) => (f.from != null ? vals[f.from] ?? '' : ''));
        statements.push(['UPDATE notes SET flds = ?, sfld = ?, mod = ? WHERE id = ?', [joinFields(out), sortFieldValue(next, out), mod, n.id]]);
        if (statements.length >= 500) await tx.runBatch(statements.splice(0));
      }
      if (statements.length) await tx.runBatch(statements);
    });
  }

  /**
   * Change a note type's card types and styling (Anki's Cards screen): `templates` in their new
   * order, each with the index of the card type it continues (null = new). Cards follow their card
   * type; removed card types' cards are deleted (and notes left without cards with them); new card
   * types get cards for the notes they aren't empty for.
   */
  async changeNotetypeTemplates(id: number, templates: { name: string; qfmt: string; afmt: string; from: number | null }[], css: string): Promise<void> {
    if (!templates.length) throw new Error('A note type needs at least one card type.');
    if (templates.some((t) => !t.name.trim())) throw new Error('Card type names can’t be empty.');
    await this.sql.transaction(async (tx) => {
      const nt = await this.notetype(id, tx);
      if (!nt) throw new Error('Note type not found');
      if (nt.kind === 1 && templates.length !== 1) throw new Error('A cloze note type has exactly one card type.');
      const next: Notetype = { ...nt, css, templates: templates.map((t, ord) => ({ name: t.name.trim(), ord, qfmt: t.qfmt, afmt: t.afmt })) };
      await tx.run('UPDATE notetypes SET templates = ?, css = ?, mtime = ? WHERE id = ?', [JSON.stringify(next.templates), css, nowSecs(), id]);
      if (nt.kind === 1) return; // cloze cards are numbered by their clozes, not by card type

      // Renumber kept card types' cards and delete removed ones'.
      const kept = new Map<number, number>();
      templates.forEach((t, ord) => t.from != null && kept.set(t.from, ord));
      const removed = nt.templates.map((t) => t.ord).filter((o) => !kept.has(o));
      const inType = 'nid IN (SELECT id FROM notes WHERE mid = ?)';
      if (removed.length) await tx.run(`DELETE FROM cards WHERE ${inType} AND ord IN (${removed.join(',')})`, [id]);
      const moves = [...kept].filter(([from, to]) => from !== to);
      if (moves.length) await tx.run(`UPDATE cards SET ord = CASE ord ${moves.map(([f, t]) => `WHEN ${f} THEN ${t}`).join(' ')} ELSE ord END, mod = ? WHERE ${inType}`, [nowSecs(), id]);
      if (removed.length) {
        const orphans = await tx.all<{ id: number }>('SELECT id FROM notes WHERE mid = ? AND NOT EXISTS (SELECT 1 FROM cards WHERE cards.nid = notes.id)', [id]);
        await this.removeOrphanNotes(tx, orphans.map((o) => o.id));
      }

      // New card types: cards for every note they render for, next to the note's other cards.
      const added = templates.map((t, ord) => (t.from == null ? ord : -1)).filter((o) => o >= 0);
      if (!added.length) return;
      const notes = await tx.all<{ id: number; flds: string; did: number | null; due: number | null }>(
        'SELECT n.id, n.flds, (SELECT did FROM cards WHERE nid = n.id ORDER BY ord LIMIT 1) AS did, (SELECT due FROM cards WHERE nid = n.id AND type = 0 ORDER BY ord LIMIT 1) AS due FROM notes n WHERE n.mid = ?',
        [id],
      );
      let cid = await freshId(tx, 'cards');
      const mod = nowSecs();
      const statements: [string, unknown[]][] = [];
      for (const n of notes) {
        const ords = new Set(generatedOrdinals(next, n.flds));
        for (const ord of added) {
          if (!ords.has(ord)) continue;
          const due = n.due ?? (await this.allocPositions(tx, 1, false))[0];
          statements.push(['INSERT INTO cards (id, nid, did, ord, mod, type, queue, due) VALUES (?, ?, ?, ?, ?, 0, 0, ?)', [cid++, n.id, n.did ?? DEFAULT_DECK_ID, ord, mod, due]]);
          if (statements.length >= 500) await tx.runBatch(statements.splice(0));
        }
      }
      if (statements.length) await tx.runBatch(statements);
    });
  }

  /** Note ids with the same first field (HTML ignored) and note type: Anki's duplicate check. */
  async findDuplicates(mid: number, firstField: string, excludeNid = 0): Promise<number[]> {
    const text = stripForDupe(firstField);
    if (!text) return [];
    const rows = await this.sql.all<{ id: number }>('SELECT id FROM notes WHERE mid = ? AND id != ? AND strip_html(field_at(flds, 0)) = ?', [mid, excludeNid, text]);
    return rows.map((r) => r.id);
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

  /** Add tags to notes (existing tags are kept; matching ignores case). */
  async addTags(nids: number[], tags: string[]): Promise<void> {
    const add = tags.map((t) => t.trim()).filter(Boolean);
    if (!add.length || !nids.length) return;
    await this.editTags(nids, (cur) => {
      const have = new Set(cur.map((t) => t.toLowerCase()));
      return [...cur, ...add.filter((t) => !have.has(t.toLowerCase()) && (have.add(t.toLowerCase()), true))];
    });
  }

  /** Remove tags from notes (ignoring case; removing `a` also removes its child tags `a::b`). */
  async removeTags(nids: number[], tags: string[]): Promise<void> {
    const drop = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!drop.length || !nids.length) return;
    await this.editTags(nids, (cur) => cur.filter((t) => !drop.some((d) => t.toLowerCase() === d || t.toLowerCase().startsWith(d + '::'))));
  }

  private async editTags(nids: number[], edit: (tags: string[]) => string[]): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const mod = nowSecs();
      for (let i = 0; i < nids.length; i += 500) {
        const chunk = nids.slice(i, i + 500);
        const rows = await tx.all<{ id: number; tags: string }>(`SELECT id, tags FROM notes WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
        const statements: [string, unknown[]][] = [];
        for (const r of rows) {
          const before = tagList(r.tags);
          const after = edit(before);
          if (after.join(' ') !== before.join(' ')) statements.push(['UPDATE notes SET tags = ?, mod = ? WHERE id = ?', [tagString(after), mod, r.id]]);
        }
        if (statements.length) await tx.runBatch(statements);
      }
    });
  }

  /** Every tag in the collection, sorted. */
  async allTags(): Promise<string[]> {
    const rows = await this.sql.all<{ tags: string }>(`SELECT DISTINCT tags FROM notes WHERE trim(tags) != ''`);
    const seen = new Map<string, string>();
    for (const r of rows) for (const t of tagList(r.tags)) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  // ---- undo for card actions -----------------------------------------------------------------

  /** Remember some cards (and notes) so a following action on them can be undone. */
  async snapshot(cids: number[], nids: number[] = []): Promise<CardsSnapshot> {
    const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');
    const cards = cids.length ? await this.sql.all<Record<string, unknown>>(`SELECT * FROM cards WHERE id IN (${inList(cids.length)})`, cids) : [];
    const notes = nids.length ? await this.sql.all<Record<string, unknown>>(`SELECT * FROM notes WHERE id IN (${inList(nids.length)})`, nids) : [];
    const [{ m }] = await this.sql.all<{ m: number | null }>('SELECT MAX(id) AS m FROM revlog');
    return { cids, cards, notes, revlogAfter: m ?? 0 };
  }

  /** Put cards and notes back as a snapshot had them (bringing back deleted ones too). */
  async restoreSnapshot(snap: CardsSnapshot): Promise<void> {
    const upsert = (table: string, row: Record<string, unknown>): [string, unknown[]] => {
      const cols = Object.keys(row);
      return [`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c])];
    };
    await this.sql.transaction(async (tx) => {
      const statements: [string, unknown[]][] = [...snap.notes.map((n) => upsert('notes', n)), ...snap.cards.map((c) => upsert('cards', c))];
      for (let i = 0; i < snap.cids.length; i += 500) {
        const chunk = snap.cids.slice(i, i + 500);
        statements.push([`DELETE FROM revlog WHERE id > ? AND cid IN (${chunk.map(() => '?').join(',')})`, [snap.revlogAfter, ...chunk]]);
      }
      if (statements.length) await tx.runBatch(statements);
    });
  }

  /** Toggle Anki's "marked" tag on a note. Returns whether it is now marked. */
  async toggleMark(nid: number): Promise<boolean> {
    const note = await this.note(nid);
    if (!note) return false;
    const tags = tagList(note.tags);
    const marked = tags.some((t) => t.toLowerCase() === 'marked');
    await this.setNoteTags(nid, marked ? tags.filter((t) => t.toLowerCase() !== 'marked') : [...tags, 'marked']);
    return !marked;
  }

  // ---- search ------------------------------------------------------------------------------

  async searchContext(nowMs = Date.now(), currentDeckId?: number): Promise<SearchContext> {
    const cfg = await this.config();
    const t = timingAt(nowMs, cfg.rollover);
    const [decks, notetypes] = await Promise.all([this.decks(), this.notetypes()]);
    return { decks, notetypes, today: t.today, nextDayAt: t.nextDayAt, nowSecs: t.now, learnAheadSecs: cfg.learnAheadSecs, currentDeckId };
  }

  /** Card ids matching an Anki search, in browser order. Throws SearchError for a bad search. */
  async searchCards(query: string, opts: { sort?: SortColumn; desc?: boolean; limit?: number; currentDeckId?: number } = {}, nowMs = Date.now()): Promise<number[]> {
    const ctx = await this.searchContext(nowMs, opts.currentDeckId);
    const { where, params } = compileSearch(query, ctx);
    const order = sortSql(opts.sort ?? 'sortField', opts.desc ?? false, ctx);
    const rows = await this.sql.all<{ id: number }>(
      `SELECT c.id FROM cards c JOIN notes n ON n.id = c.nid LEFT JOIN decks d ON d.id = c.did WHERE ${where} ORDER BY ${order}${opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ''}`,
      params,
    );
    return rows.map((r) => r.id);
  }

  /** Note ids of some cards. */
  async noteIdsOfCards(cids: number[]): Promise<number[]> {
    const out = new Set<number>();
    for (let i = 0; i < cids.length; i += 500) {
      const chunk = cids.slice(i, i + 500);
      const rows = await this.sql.all<{ nid: number }>(`SELECT DISTINCT nid FROM cards WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
      for (const r of rows) out.add(r.nid);
    }
    return [...out];
  }

  /** Anki's Card Info. */
  async cardInfo(cid: number, nowMs = Date.now()): Promise<CardInfo | null> {
    const card = await this.card(cid);
    if (!card) return null;
    const [note, deck, cfg] = await Promise.all([this.note(card.nid), this.deck(card.did), this.config()]);
    const notetype = note ? await this.notetype(note.mid) : null;
    if (!note || !notetype) return null;
    const original = card.odid ? await this.deck(card.odid) : null;
    const configs = await this.deckConfigs();
    const home = original ?? deck;
    const preset = configs.find((c) => c.id === home?.conf_id) ?? configs.find((c) => c.id === DEFAULT_CONFIG_ID);
    const revlog = await this.sql.all<RevlogEntry>('SELECT * FROM revlog WHERE cid = ? ORDER BY id DESC', [cid]);
    const t = timingAt(nowMs, cfg.rollover);
    let r: number | null = null;
    if (card.stability != null && card.difficulty != null && card.last_review != null && card.type !== CardType.New) {
      const w = prepareParameters(preset?.config.fsrsParams ?? []);
      r = retrievability(w, { stability: card.stability, difficulty: card.difficulty }, Math.max(0, (t.now - card.last_review) / 86_400));
    }
    return {
      card,
      note,
      notetype,
      deckName: deck?.name ?? '(deleted deck)',
      originalDeckName: original?.name ?? null,
      templateName: notetype.kind === 1 ? `Cloze ${card.ord + 1}` : notetype.templates.find((x) => x.ord === card.ord)?.name ?? `Card ${card.ord + 1}`,
      presetName: preset?.name ?? 'Default',
      revlog,
      retrievability: r,
      timing: t,
    };
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

  /** Move cards to a deck (Anki `set_deck`: cards in a filtered deck leave it first). */
  async moveCards(cids: number[], deckId: number): Promise<void> {
    if (!cids.length) return;
    if ((await this.deck(deckId))?.filtered) throw new Error('Cards can’t be moved into a filtered deck; it fills itself from its search.');
    await this.sql.transaction(async (tx) => {
      for (let i = 0; i < cids.length; i += 500) {
        const chunk = cids.slice(i, i + 500);
        const ph = chunk.map(() => '?').join(',');
        await this.returnCardsHome(tx, `id IN (${ph})`, chunk);
        await tx.run(`UPDATE cards SET did = ?, mod = ? WHERE id IN (${ph})`, [deckId, nowSecs(), ...chunk]);
      }
    });
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
      if (cids.length) await this.returnCardsHome(tx, `id IN (${cids.map(() => '?').join(',')})`, cids);
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
      // Rescheduled cards leave any filtered deck (Anki `remove_from_filtered_deck_before_reschedule`).
      if (cids.length) await this.returnCardsHome(tx, `id IN (${cids.map(() => '?').join(',')})`, cids);
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
    const deck = (await this.deck(card.did)) ?? null;
    if (!deck) return null;
    // A card in a filtered deck is scheduled with its own deck's preset.
    const home = card.odid ? ((await this.deck(card.odid)) ?? deck) : deck;
    const configs = await this.deckConfigMap();
    const config = configs.get(home.conf_id) ?? configs.get(DEFAULT_CONFIG_ID) ?? normalizeDeckConfig(null);
    const needsHistory = cfg.fsrs && card.type !== CardType.New && (card.stability == null || card.last_review == null);
    const revlog = needsHistory ? await this.sql.all<RevlogEntry>('SELECT * FROM revlog WHERE cid = ? ORDER BY id', [card.id]) : undefined;
    const note = await this.note(card.nid);
    const notetype = note ? await this.notetype(note.mid) : null;
    if (!note || !notetype) return null;
    const siblings = await this.sql.all<{ id: number; queue: number }>('SELECT id, queue FROM cards WHERE nid = ? AND id != ?', [card.nid, card.id]);
    const desiredRetention = home.desired_retention ?? config.desiredRetention;
    const base = { deck, config, desiredRetention, note, notetype, original: card, revlog, siblings, colConfig: cfg };
    return { ...base, prepared: this.prepare(base, nowMs) };
  }

  /** The card's scheduling states at `nowMs` (Anki computes them when the card is shown). */
  private prepare(s: Omit<StudyCard, 'prepared'>, nowMs: number): PreparedCard {
    const cfg = s.colConfig;
    return prepareCard({
      card: s.original,
      config: s.config,
      desiredRetention: s.desiredRetention,
      timing: timingAt(nowMs, cfg.rollover),
      fsrs: cfg.fsrs,
      fsrsShortTermWithSteps: cfg.fsrsShortTermWithSteps,
      revlog: s.revlog,
      filtered: s.original.odid ? s.deck.filtered : null,
    });
  }

  /** Recompute a loaded card's states for the moment it is actually shown (cards are prefetched). */
  reprepare(study: StudyCard, nowMs = Date.now()): StudyCard {
    return { ...study, prepared: this.prepare(study, nowMs) };
  }

  /**
   * Answer a card (Anki `answer_card`): update it, log the review, count it toward the deck's
   * (and parents') daily limits, bury siblings per the preset, and tag leeches. Returns undo info.
   */
  async answer(study: StudyCard, rating: Rating, millisecondsTaken: number, nowMs = Date.now()): Promise<{ undo: AnswerUndo; card: Card }> {
    return this.commitAnswer(this.planAnswer(study, rating, millisecondsTaken, nowMs));
  }

  /**
   * Work out an answer without touching the database: the answered card, its review log entry,
   * the siblings to bury and any leech tag. The review screen uses this to move on to the next
   * card at once, while {@link commitAnswer} saves it.
   */
  planAnswer(study: StudyCard, rating: Rating, millisecondsTaken: number, nowMs = Date.now()): AnswerPlan {
    const cfg = study.colConfig;
    const t = timingAt(nowMs, cfg.rollover);
    const result = applyAnswer(study.prepared, rating, { config: study.config, timing: t, fsrs: cfg.fsrs, desiredRetention: study.desiredRetention }, nowMs, millisecondsTaken);
    const original = study.original;

    // Bury siblings (Anki `maybe_bury_siblings` + `exclude_earlier_gathered_queues`).
    const c = study.config;
    const ord = gatherOrd(original.queue);
    const buryInterday = c.buryInterdayLearning && ord <= 1;
    const buryReviews = c.buryReviews && ord <= 2;
    const bury = study.siblings.filter(
      (s) => (c.buryNew && s.queue === CardQueue.New) || (buryReviews && s.queue === CardQueue.Review) || (buryInterday && s.queue === CardQueue.DayLearn),
    );

    const tags = tagList(study.note.tags);
    const leechTags = result.leeched && !tags.some((x) => x.toLowerCase() === 'leech') ? [...tags, 'leech'] : null;
    return { study, card: result.card, revlog: result.revlog, bury, leechTags, today: t.today };
  }

  /** Save a planned answer. */
  async commitAnswer(plan: AnswerPlan): Promise<{ undo: AnswerUndo; card: Card }> {
    const { study, card, revlog: r, bury, leechTags, today } = plan;
    const original = study.original;
    return this.sql.transaction(async (tx) => {
      // Review log ids are unique answer times; nudge past an existing one (rapid answers).
      const [{ id: revlogId }] = await tx.all<{ id: number }>(
        `INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type)
         VALUES ((SELECT MAX(?1, COALESCE(MAX(id) + 1, 0)) FROM revlog WHERE id >= ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
        [r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type],
      );
      // Deck stats ("studied today") for the deck and its parents.
      const deckRows = await tx.all<DeckRow>(`SELECT * FROM decks WHERE id = ?1 OR substr(lower(?2), 1, length(name) + 2) = lower(name) || '::'`, [original.did, study.deck.name]);
      const newDelta = original.queue === CardQueue.New ? 1 : 0;
      const reviewDelta = original.queue === CardQueue.Review || original.queue === CardQueue.DayLearn ? 1 : 0;
      const c = card;
      const statements: [string, unknown[]][] = [
        [
          `UPDATE cards SET nid=?, did=?, ord=?, mod=?, type=?, queue=?, due=?, ivl=?, factor=?, reps=?, lapses=?, left=?, odue=?, odid=?, flags=?,
             stability=?, difficulty=?, desired_retention=?, last_review=?, original_position=? WHERE id=?`,
          [c.nid, c.did, c.ord, c.mod, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.left, c.odue, c.odid, c.flags,
            c.stability, c.difficulty, c.desired_retention, c.last_review, c.original_position, c.id],
        ],
      ];
      for (const d of deckRows) {
        const reset = d.last_day_studied !== today;
        statements.push([
          'UPDATE decks SET last_day_studied = ?, new_studied = ?, review_studied = ?, learning_studied = ?, ms_studied = ? WHERE id = ?',
          [
            today,
            (reset ? 0 : d.new_studied) + newDelta,
            (reset ? 0 : d.review_studied) + reviewDelta,
            reset ? 0 : d.learning_studied,
            (reset ? 0 : d.ms_studied) + r.time,
            d.id,
          ],
        ]);
      }
      // Only siblings still in the queue they were in when loaded.
      for (const s of bury) statements.push(['UPDATE cards SET queue = -2, mod = ? WHERE id = ? AND queue = ?', [nowSecs(), s.id, s.queue]]);
      if (leechTags) statements.push(['UPDATE notes SET tags = ?, mod = ? WHERE id = ?', [tagString(leechTags), nowSecs(), original.nid]]);
      await tx.runBatch(statements);
      return {
        undo: { card: original, revlogId, decks: deckRows, buriedSiblings: bury, leechTagAdded: leechTags != null },
        card,
      };
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
