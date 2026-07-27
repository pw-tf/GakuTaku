import { db } from '../sync/system';
import { parseJsonObject } from './fsrs';
import { ensureDefaultPreset, resolveDeckConfigById } from './presetOps';
import { nextNewPosition } from './cardOps';

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

/** Insert a new deck assigned to the user's Default preset (Anki: new decks use the default options group). */
export async function createDeck(userId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  const presetId = await ensureDefaultPreset(userId);
  await db.execute(
    'INSERT INTO decks (id, user_id, name, fsrs_params, preset_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, name.trim() || DEFAULT_DECK_NAME, '{}', presetId, new Date().toISOString()],
  );
  return id;
}

/** A card's note opened for editing: the note type's ordered field names + current values. */
export interface EditableCard {
  cardId: string;
  noteId: string;
  fieldNames: string[];
  values: Record<string, string>;
}

function asStrMap(text: string | null | undefined): Record<string, string> {
  const obj = parseJsonObject(text);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? v : String(v ?? '');
  return out;
}

/** Load a card's editable fields (note values keyed by the note type's field order). */
export async function loadCardForEdit(cardId: string): Promise<EditableCard | null> {
  const rows = await db.getAll<{ note_id: string; fields: string; nt_fields: string | null }>(
    `SELECT n.id AS note_id, n.fields AS fields, nt.fields AS nt_fields
     FROM cards c JOIN notes n ON n.id = c.note_id LEFT JOIN note_types nt ON nt.id = n.note_type_id
     WHERE c.id = ? LIMIT 1`,
    [cardId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const values = asStrMap(r.fields);
  let fieldNames = Object.keys(values);
  try {
    const v = parseJsonObject(r.nt_fields) as unknown;
    if (Array.isArray(v) && v.length) fieldNames = v.map(String);
  } catch { /* fall back to value keys */ }
  return { cardId, noteId: r.note_id, fieldNames, values };
}

/** Persist edited note field values. */
export async function updateNoteFields(noteId: string, values: Record<string, string>): Promise<void> {
  await db.execute('UPDATE notes SET fields = ? WHERE id = ?', [JSON.stringify(values), noteId]);
}

/** Delete a card (and its logs); if its note has no other cards, remove the note too. */
export async function deleteCard(cardId: string): Promise<void> {
  const rows = await db.getAll<{ note_id: string }>('SELECT note_id FROM cards WHERE id = ?', [cardId]);
  const noteId = rows[0]?.note_id;
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM review_logs WHERE card_id = ?', [cardId]);
    await tx.execute('DELETE FROM cards WHERE id = ?', [cardId]);
  });
  if (noteId) {
    const left = await db.getAll<{ n: number }>('SELECT COUNT(*) AS n FROM cards WHERE note_id = ?', [noteId]);
    if ((left[0]?.n ?? 0) === 0) await db.execute('DELETE FROM notes WHERE id = ?', [noteId]);
  }
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
  // Anki position ordinal, per the deck preset's insertion order (sequential = oldest first).
  const cfg = await resolveDeckConfigById(deckId);
  const position = await nextNewPosition(cfg.insertionOrder);
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
      `INSERT INTO cards (id, user_id, note_id, template_index, due, stability, difficulty, reps, lapses, state, last_review, queue, flag, position)
       VALUES (?, ?, ?, 0, ?, NULL, NULL, 0, 0, 0, NULL, 0, 0, ?)`,
      [cardId, userId, noteId, now, position],
    );
    await tx.execute(
      `INSERT INTO mined_words (id, user_id, term, reading, context, document_id, looked_up_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), userId, input.term, input.reading, input.context ?? '', input.documentId ?? null, now],
    );
  });

  return { cardId, deckId, created: true };
}
