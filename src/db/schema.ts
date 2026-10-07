/**
 * The on-device database schema, as an ordered list of migrations. `PRAGMA user_version` records
 * how many have run, so each one executes exactly once per device. Never edit a migration that has
 * shipped — append a new one.
 *
 * Everything lives in this one SQLite file (in the Origin Private File System), which is also what
 * a backup exports. JSON-valued columns are stored as TEXT and parsed in app code.
 */
export const MIGRATIONS: string[] = [
  // 1 — initial local schema (carried over from the old synced schema, minus the sync plumbing).
  `
  CREATE TABLE decks (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT,
    fsrs_params TEXT,
    preset_id TEXT,
    created_at TEXT
  );

  CREATE TABLE deck_presets (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT,
    config TEXT,
    created_at TEXT
  );

  CREATE TABLE note_types (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT,
    fields TEXT,
    card_templates TEXT,
    css TEXT
  );

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    deck_id TEXT,
    note_type_id TEXT,
    fields TEXT,
    tags TEXT,
    created_at TEXT
  );
  CREATE INDEX notes_by_deck ON notes(deck_id);
  CREATE INDEX notes_by_note_type ON notes(note_type_id);

  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    note_id TEXT,
    template_index INTEGER,
    due TEXT,
    stability REAL,
    difficulty REAL,
    reps INTEGER,
    lapses INTEGER,
    state INTEGER,
    last_review TEXT,
    queue INTEGER,
    flag INTEGER,
    position INTEGER,
    buried_until TEXT
  );
  CREATE INDEX cards_by_note ON cards(note_id);
  CREATE INDEX cards_by_due ON cards(due);
  CREATE INDEX cards_by_state_due ON cards(state, due);
  CREATE INDEX cards_by_queue ON cards(queue);

  CREATE TABLE review_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    card_id TEXT,
    rating INTEGER,
    review_time TEXT,
    elapsed_ms INTEGER,
    scheduled_days INTEGER
  );
  CREATE INDEX review_logs_by_card_time ON review_logs(card_id, review_time);
  CREATE INDEX review_logs_by_time ON review_logs(review_time);

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    title TEXT,
    type TEXT,
    source TEXT,
    storage_path TEXT,
    language TEXT,
    added_at TEXT
  );

  CREATE TABLE reading_positions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    document_id TEXT,
    locator TEXT,
    percent REAL,
    updated_at TEXT
  );
  CREATE INDEX reading_positions_by_document ON reading_positions(document_id);

  CREATE TABLE feeds (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    url TEXT,
    title TEXT,
    kind TEXT,
    enabled INTEGER,
    builtin_id TEXT,
    added_at TEXT
  );

  CREATE TABLE mined_words (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    term TEXT,
    reading TEXT,
    context TEXT,
    document_id TEXT,
    looked_up_at TEXT
  );
  `,
  // 2 — Anki's data model (src/anki/types.ts). Replaces the old FSRS-replay tables: cards now keep
  // their scheduling state directly, exactly as Anki stores it, and `revlog` is Anki's review log.
  // (Nothing had been studied with the old tables yet, so they are dropped rather than converted.)
  `
  DROP TABLE IF EXISTS cards;
  DROP TABLE IF EXISTS review_logs;
  DROP TABLE IF EXISTS notes;
  DROP TABLE IF EXISTS note_types;
  DROP TABLE IF EXISTS decks;
  DROP TABLE IF EXISTS deck_presets;
  DROP TABLE IF EXISTS mined_words;

  CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE deck_config (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    mtime INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO deck_config (id, name, config) VALUES (1, 'Default', '{}');

  CREATE TABLE decks (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    conf_id INTEGER NOT NULL DEFAULT 1,
    description TEXT NOT NULL DEFAULT '',
    review_limit INTEGER,
    new_limit INTEGER,
    review_limit_today TEXT,
    new_limit_today TEXT,
    desired_retention REAL,
    collapsed INTEGER NOT NULL DEFAULT 0,
    last_day_studied INTEGER NOT NULL DEFAULT 0,
    new_studied INTEGER NOT NULL DEFAULT 0,
    review_studied INTEGER NOT NULL DEFAULT 0,
    learning_studied INTEGER NOT NULL DEFAULT 0,
    ms_studied INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE notetypes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind INTEGER NOT NULL DEFAULT 0,
    fields TEXT NOT NULL,
    templates TEXT NOT NULL,
    css TEXT NOT NULL DEFAULT '',
    sort_idx INTEGER NOT NULL DEFAULT 0,
    latex_pre TEXT,
    latex_post TEXT,
    mtime INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL,
    mid INTEGER NOT NULL,
    mod INTEGER NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    flds TEXT NOT NULL,
    sfld TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX notes_mid ON notes(mid);
  CREATE INDEX notes_guid ON notes(guid);

  CREATE TABLE cards (
    id INTEGER PRIMARY KEY,
    nid INTEGER NOT NULL,
    did INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    mod INTEGER NOT NULL,
    type INTEGER NOT NULL,
    queue INTEGER NOT NULL,
    due INTEGER NOT NULL,
    ivl INTEGER NOT NULL DEFAULT 0,
    factor INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    left INTEGER NOT NULL DEFAULT 0,
    odue INTEGER NOT NULL DEFAULT 0,
    odid INTEGER NOT NULL DEFAULT 0,
    flags INTEGER NOT NULL DEFAULT 0,
    stability REAL,
    difficulty REAL,
    desired_retention REAL,
    last_review INTEGER,
    original_position INTEGER
  );
  CREATE INDEX cards_nid ON cards(nid);
  CREATE INDEX cards_sched ON cards(did, queue, due);

  CREATE TABLE revlog (
    id INTEGER PRIMARY KEY,
    cid INTEGER NOT NULL,
    ease INTEGER NOT NULL,
    ivl INTEGER NOT NULL,
    lastIvl INTEGER NOT NULL,
    factor INTEGER NOT NULL,
    time INTEGER NOT NULL,
    type INTEGER NOT NULL
  );
  CREATE INDEX revlog_cid ON revlog(cid);

  CREATE TABLE mined_words (
    id TEXT PRIMARY KEY,
    term TEXT,
    reading TEXT,
    context TEXT,
    document_id TEXT,
    note_id INTEGER,
    looked_up_at TEXT
  );
  `,
  // 3: filtered decks (Anki's filtered / custom study decks): their search terms and options as JSON.
  `
  ALTER TABLE decks ADD COLUMN filtered TEXT;
  `,
  // 4: bookmarks and highlighted sentences in books (kind 'bookmark' | 'highlight').
  `
  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    paragraph INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX bookmarks_by_document ON bookmarks(document_id);
  `,
];

/* Row types (all columns nullable, as SQLite returns them). */
type Nullable<T> = { [K in keyof T]: T[K] | null };

export type DocumentRecord = { id: string } & Nullable<{
  user_id: string;
  title: string;
  type: string;
  source: string;
  storage_path: string;
  language: string;
  added_at: string;
}>;

export type FeedRecord = { id: string } & Nullable<{
  user_id: string;
  url: string;
  title: string;
  kind: string;
  enabled: number;
  builtin_id: string;
  added_at: string;
}>;
