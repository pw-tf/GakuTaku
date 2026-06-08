import { db } from '../sync/system';
import { parseJsonObject, serializeDeckConfig } from './fsrs';

/**
 * Mining: turn a looked-up word into a real note + card (build plan M4). The lookup popup's
 * "＋ Add to deck" calls {@link addCardForWord} with a chosen deck. Cards are created in the New
 * state, due now, so they surface in the next review session. A `mined_words` history row is kept (§4).
 */

export const DEFAULT_DECK_NAME = 'Reading · Mined';
/** The app's built-in vocab note type. Review renders this with its styled UI; other (imported)
 *  note types render via the generic Anki template renderer. */
export const NOTE_TYPE_NAME = 'Japanese vocab';
const NOTE_FIELDS = ['Term', 'Reading', 'Meaning', 'Pos'];
const CARD_TEMPLATES = [
  { name: 'Recognition', front: '{{Term}}', back: '{{Reading}}<br>{{Meaning}}' },
];

/** The shape stored in `notes.fields` (jsonb). */
export interface NoteFields {
  Term: string;
  Reading: string;
  Meaning: string;
  Pos: string;
}

/** Parse `notes.fields` text into typed fields (tolerates the legacy double-encoding bug). */
export function parseNoteFields(json: string | null | undefined): NoteFields {
  const f = parseJsonObject(json) as Partial<Record<keyof NoteFields, unknown>>;
  return {
    Term: typeof f.Term === 'string' ? f.Term : '',
    Reading: typeof f.Reading === 'string' ? f.Reading : '',
    Meaning: typeof f.Meaning === 'string' ? f.Meaning : '',
    Pos: typeof f.Pos === 'string' ? f.Pos : '',
  };
}

/** Insert a new deck with default config; returns its id. */
export async function createDeck(userId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    'INSERT INTO decks (id, user_id, name, fsrs_params, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, name.trim() || DEFAULT_DECK_NAME, serializeDeckConfig({ newPerDay: 20 }), new Date().toISOString()],
  );
  return id;
}

/** Rename a deck. */
export async function renameDeck(deckId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await db.execute('UPDATE decks SET name = ? WHERE id = ?', [trimmed, deckId]);
}

/**
 * Delete a deck and everything under it — its notes, their cards, and those cards' review_logs.
 * Done in one transaction so the synced tables never end up with orphaned rows. Destructive and
 * irreversible (the caller should confirm first).
 */
export async function deleteDeck(deckId: string): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute(
      `DELETE FROM review_logs WHERE card_id IN (
         SELECT c.id FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.deck_id = ?)`,
      [deckId],
    );
    await tx.execute('DELETE FROM cards WHERE note_id IN (SELECT id FROM notes WHERE deck_id = ?)', [deckId]);
    await tx.execute('DELETE FROM notes WHERE deck_id = ?', [deckId]);
    await tx.execute('DELETE FROM decks WHERE id = ?', [deckId]);
  });
}

/** Find-or-create the default mining deck (used as a first-run fallback target). */
export async function ensureDefaultDeck(userId: string): Promise<string> {
  const rows = await db.getAll<{ id: string }>(
    'SELECT id FROM decks WHERE user_id = ? AND name = ? LIMIT 1',
    [userId, DEFAULT_DECK_NAME],
  );
  return rows.length ? rows[0].id : createDeck(userId, DEFAULT_DECK_NAME);
}

/** Find-or-create the default vocab note type (mirrors Anki's model for clean .apkg import later). */
async function ensureNoteType(userId: string): Promise<string> {
  const rows = await db.getAll<{ id: string }>(
    'SELECT id FROM note_types WHERE user_id = ? AND name = ? LIMIT 1',
    [userId, NOTE_TYPE_NAME],
  );
  if (rows.length) return rows[0].id;
  const id = crypto.randomUUID();
  await db.execute(
    'INSERT INTO note_types (id, user_id, name, fields, card_templates) VALUES (?, ?, ?, ?, ?)',
    [id, userId, NOTE_TYPE_NAME, JSON.stringify(NOTE_FIELDS), JSON.stringify(CARD_TEMPLATES)],
  );
  return id;
}

export interface AddWordInput {
  deckId: string;
  term: string;
  reading: string;
  gloss: string;
  pos?: string;
  context?: string;
  documentId?: string | null;
}

export interface AddWordResult {
  cardId: string;
  deckId: string;
  created: boolean;
}

/**
 * Create a note + card for a mined word in the given deck (idempotent per term within that deck).
 * Writes the note, card, and a mined_words history row atomically.
 */
export async function addCardForWord(userId: string, input: AddWordInput): Promise<AddWordResult> {
  const { deckId } = input;

  // Dedup: if a note in this deck already has the same Term, reuse its card.
  const existing = await db.getAll<{ cid: string; fields: string }>(
    'SELECT c.id AS cid, n.fields AS fields FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.deck_id = ?',
    [deckId],
  );
  for (const row of existing) {
    if (parseNoteFields(row.fields).Term === input.term) {
      return { cardId: row.cid, deckId, created: false };
    }
  }

  const noteTypeId = await ensureNoteType(userId);
  const noteId = crypto.randomUUID();
  const cardId = crypto.randomUUID();
  const now = new Date().toISOString();
  const fields: NoteFields = {
    Term: input.term,
    Reading: input.reading,
    Meaning: input.gloss,
    Pos: input.pos ?? '',
  };

  await db.writeTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO notes (id, user_id, deck_id, note_type_id, fields, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [noteId, userId, deckId, noteTypeId, JSON.stringify(fields), 'mined', now],
    );
    // New card: due now, state New (0), no reviews yet. FSRS columns are derived from review_logs.
    await tx.execute(
      `INSERT INTO cards (id, user_id, note_id, template_index, due, stability, difficulty, reps, lapses, state, last_review)
       VALUES (?, ?, ?, 0, ?, NULL, NULL, 0, 0, 0, NULL)`,
      [cardId, userId, noteId, now],
    );
    await tx.execute(
      `INSERT INTO mined_words (id, user_id, term, reading, context, document_id, looked_up_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), userId, input.term, input.reading, input.context ?? '', input.documentId ?? null, now],
    );
  });

  return { cardId, deckId, created: true };
}
