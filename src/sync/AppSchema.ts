import { column, Schema, Table } from '@powersync/web';

/**
 * PowerSync client schema. Mirrors the *synced* Supabase tables only (see §4 of the
 * build plan). The dictionary / tokenizer assets are intentionally NOT synced — they
 * live in IndexedDB / Cache API, not Postgres.
 *
 * Notes on types:
 * - Every table has an implicit `id` text primary key (do not declare it here).
 * - PowerSync supports only text / integer / real. Postgres `jsonb` columns are stored
 *   as serialized text client-side (`column.text`) and parsed in app code.
 * - Timestamps are ISO strings (`column.text`).
 */

const decks = new Table({
  user_id: column.text,
  name: column.text,
  fsrs_params: column.text, // jsonb — per-deck data only (description + limit overrides); scheduling lives on the preset
  preset_id: column.text, // deck_presets.id; null = legacy deck whose fsrs_params still carries full config
  created_at: column.text,
});

// Anki's shared "options group": all scheduling config, referenced by many decks.
const deck_presets = new Table({
  user_id: column.text,
  name: column.text,
  config: column.text, // jsonb (DeckPresetConfig)
  created_at: column.text,
});

const note_types = new Table({
  user_id: column.text,
  name: column.text,
  fields: column.text, // jsonb
  card_templates: column.text, // jsonb
  css: column.text, // the note type's stylesheet (Anki model CSS), applied at render time
});

const notes = new Table(
  {
    user_id: column.text,
    deck_id: column.text,
    note_type_id: column.text,
    fields: column.text, // jsonb
    tags: column.text,
    created_at: column.text,
  },
  { indexes: { by_deck: ['deck_id'], by_note_type: ['note_type_id'] } },
);

const cards = new Table(
  {
    user_id: column.text,
    note_id: column.text,
    template_index: column.integer,
    // FSRS fields — derived by replaying review_logs (see §3.3); stored for query speed.
    due: column.text,
    stability: column.real,
    difficulty: column.real,
    reps: column.integer,
    lapses: column.integer,
    state: column.integer,
    last_review: column.text,
    // USER state, deliberately not derivable from review_logs (no revlog entry in Anki either).
    // queue matches Anki's values: 0 active, -1 suspended, -2 sched-buried, -3 user-buried.
    // Synced columns are nullable client-side — always read via COALESCE(queue, 0) etc.
    queue: column.integer,
    flag: column.integer, // Anki colored flags, 0 = none, 1..7
    position: column.integer, // Anki new-card ordinal; null = legacy (created_at order)
    buried_until: column.text, // study-day end at bury time; buried iff queue <= -2 AND buried_until > now
  },
  { indexes: { by_note: ['note_id'], by_due: ['due'], by_state_due: ['state', 'due'], by_queue: ['queue'] } },
);

const review_logs = new Table(
  {
    user_id: column.text,
    card_id: column.text,
    rating: column.integer,
    review_time: column.text,
    elapsed_ms: column.integer,
    scheduled_days: column.integer,
  },
  { indexes: { by_card: ['card_id'], by_card_time: ['card_id', 'review_time'], by_time: ['review_time'] } },
);

const documents = new Table({
  user_id: column.text,
  title: column.text,
  type: column.text,
  source: column.text, // 'upload' | 'rss'
  storage_path: column.text,
  language: column.text,
  added_at: column.text,
});

const reading_positions = new Table(
  {
    user_id: column.text,
    document_id: column.text,
    locator: column.text, // CFI
    percent: column.real,
    updated_at: column.text,
  },
  { indexes: { by_document: ['document_id'] } },
);

const feeds = new Table({
  user_id: column.text,
  url: column.text,
  title: column.text,
  kind: column.text, // 'rss' (generic RSS/Atom/RDF) | 'nhk-easy' (NHK News Web Easy JSON list)
  enabled: column.integer, // 1|0 — 0 hides the feed from the Library list
  builtin_id: column.text, // set when this row overrides a built-in default feed's state
  added_at: column.text,
});

const mined_words = new Table({
  user_id: column.text,
  term: column.text,
  reading: column.text,
  context: column.text,
  document_id: column.text,
  looked_up_at: column.text,
});

const user_settings = new Table({
  user_id: column.text,
  furigana_default: column.integer,
  theme: column.text,
  vertical_text: column.integer,
});

export const AppSchema = new Schema({
  decks,
  deck_presets,
  note_types,
  notes,
  cards,
  review_logs,
  documents,
  reading_positions,
  feeds,
  mined_words,
  user_settings,
});

export type Database = (typeof AppSchema)['types'];
export type DeckRecord = Database['decks'];
export type DeckPresetRecord = Database['deck_presets'];
export type NoteRecord = Database['notes'];
export type CardRecord = Database['cards'];
export type ReviewLogRecord = Database['review_logs'];
export type DocumentRecord = Database['documents'];
export type FeedRecord = Database['feeds'];
