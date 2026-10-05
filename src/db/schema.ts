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
];

/* Row types (all columns nullable, as SQLite returns them). */
type Nullable<T> = { [K in keyof T]: T[K] | null };

export type DeckRecord = { id: string } & Nullable<{
  user_id: string;
  name: string;
  fsrs_params: string;
  preset_id: string;
  created_at: string;
}>;

export type DeckPresetRecord = { id: string } & Nullable<{
  user_id: string;
  name: string;
  config: string;
  created_at: string;
}>;

export type NoteRecord = { id: string } & Nullable<{
  user_id: string;
  deck_id: string;
  note_type_id: string;
  fields: string;
  tags: string;
  created_at: string;
}>;

export type CardRecord = { id: string } & Nullable<{
  user_id: string;
  note_id: string;
  template_index: number;
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string;
  queue: number;
  flag: number;
  position: number;
  buried_until: string;
}>;

export type ReviewLogRecord = { id: string } & Nullable<{
  user_id: string;
  card_id: string;
  rating: number;
  review_time: string;
  elapsed_ms: number;
  scheduled_days: number;
}>;

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
