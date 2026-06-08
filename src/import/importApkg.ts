import { db } from '../sync/system';
import { deckConfig, deriveCard, serializeDeckConfig, type DeckConfig } from '../srs/fsrs';
import type { ReviewLogRecord } from '../sync/AppSchema';
import type { ParsedApkg } from './apkg';
import { rewriteMediaRefs, uploadMedia } from './media';

/**
 * Map a parsed `.apkg` into our schema and persist it (build plan M6). Anki models→`note_types`,
 * decks→`decks`, notes→`notes`, cards→`cards`, and the `revlog`→append-only `review_logs`. Card FSRS
 * state is then *derived* from those logs via {@link deriveCard} (§3.3) rather than copied from Anki,
 * so scheduling is FSRS-native and converges across devices. Media is uploaded + cached separately.
 */

export interface ImportSummary {
  decks: number;
  noteTypes: number;
  notes: number;
  cards: number;
  reviews: number;
  mediaFiles: number;
  skipped: number;
}

export type ImportPhase = 'mapping' | 'writing' | 'media' | 'done';
export interface ImportProgress {
  phase: ImportPhase;
  done?: number;
  total?: number;
}

type Row = (string | number | null)[];

/** Insert rows in bounded transactions so a huge deck doesn't build one giant write. */
async function insertChunked(sql: string, rows: Row[], onChunk?: (done: number) => void): Promise<void> {
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    await db.writeTransaction(async (tx) => {
      for (const params of batch) await tx.execute(sql, params);
    });
    onChunk?.(Math.min(i + CHUNK, rows.length));
  }
}

export async function importApkg(
  parsed: ParsedApkg,
  userId: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportSummary> {
  const importId = crypto.randomUUID();
  const now = new Date().toISOString();
  const defaultCfg: DeckConfig = deckConfig({ fsrs_params: null });
  const defaultParams = serializeDeckConfig(defaultCfg);
  onProgress?.({ phase: 'mapping' });

  // --- note types (Anki models) ---
  const noteTypeRows: Row[] = [];
  const modelById = new Map<string, { noteTypeId: string; fields: string[] }>();
  for (const m of parsed.models) {
    const noteTypeId = crypto.randomUUID();
    modelById.set(m.id, { noteTypeId, fields: m.fields });
    const templates = m.templates.map((t) => ({ name: t.name, front: t.qfmt, back: t.afmt }));
    noteTypeRows.push([noteTypeId, userId, m.name || 'Imported note type', JSON.stringify(m.fields), JSON.stringify(templates)]);
  }

  // --- decks (only those a card actually lives in) ---
  const usedDeckIds = new Set(parsed.cards.map((c) => c.did));
  const deckRows: Row[] = [];
  const deckIdMap = new Map<string, string>();
  for (const d of parsed.decks) {
    if (!usedDeckIds.has(d.id)) continue;
    const deckId = crypto.randomUUID();
    deckIdMap.set(d.id, deckId);
    deckRows.push([deckId, userId, d.name || 'Imported', defaultParams, now]);
  }
  let fallbackDeckId: string | null = null;
  const deckForAnki = (did: string): string => {
    const mapped = deckIdMap.get(did);
    if (mapped) return mapped;
    if (!fallbackDeckId) {
      fallbackDeckId = crypto.randomUUID();
      deckRows.push([fallbackDeckId, userId, 'Imported', defaultParams, now]);
    }
    return fallbackDeckId;
  };

  // A note's deck in our schema = the deck of its first card (Anki scopes decks per card).
  const firstDeckByNote = new Map<string, string>();
  for (const c of parsed.cards) if (!firstDeckByNote.has(c.nid)) firstDeckByNote.set(c.nid, c.did);

  // --- notes (with media refs rewritten) ---
  const referenced = new Set<string>();
  const noteRows: Row[] = [];
  const noteIdMap = new Map<string, string>();
  const noteCreated = new Map<string, string>();
  let skipped = 0;
  for (const n of parsed.notes) {
    const model = modelById.get(n.mid);
    if (!model) { skipped++; continue; }
    const noteId = crypto.randomUUID();
    noteIdMap.set(String(n.id), noteId);
    const created = new Date(n.id).toISOString();
    noteCreated.set(noteId, created);
    const fields: Record<string, string> = {};
    model.fields.forEach((name, i) => { fields[name] = rewriteMediaRefs(n.flds[i] ?? '', importId, referenced); });
    const deckId = deckForAnki(firstDeckByNote.get(String(n.id)) ?? '');
    noteRows.push([noteId, userId, deckId, model.noteTypeId, JSON.stringify(fields), n.tags || null, created]);
  }

  // --- cards (FSRS columns filled after deriving from logs) ---
  const cardIdMap = new Map<string, string>();
  const cardInfo: { id: string; noteId: string; created: string; ord: number }[] = [];
  for (const c of parsed.cards) {
    const noteId = noteIdMap.get(c.nid);
    if (!noteId) { skipped++; continue; }
    const id = crypto.randomUUID();
    cardIdMap.set(c.id, id);
    cardInfo.push({ id, noteId, created: noteCreated.get(noteId) ?? now, ord: c.ord });
  }

  // --- review_logs (revlog), skipping manual reschedules (ease 0) and cram (type 3) ---
  const reviewRows: Row[] = [];
  const logsByCard = new Map<string, ReviewLogRecord[]>();
  for (const r of parsed.revlog) {
    if (r.ease < 1 || r.type === 3) continue;
    const cardId = cardIdMap.get(r.cid);
    if (!cardId) continue;
    const id = crypto.randomUUID();
    const reviewTime = new Date(r.id).toISOString();
    const log: ReviewLogRecord = {
      id, user_id: userId, card_id: cardId, rating: r.ease,
      review_time: reviewTime, elapsed_ms: r.time ?? 0, scheduled_days: r.ivl ?? 0,
    };
    const list = logsByCard.get(cardId);
    if (list) list.push(log); else logsByCard.set(cardId, [log]);
    reviewRows.push([id, userId, cardId, r.ease, reviewTime, r.time ?? 0, r.ivl ?? 0]);
  }

  // Derive each card's current FSRS state from its imported logs (no history → New/due-now).
  // Replaying every card is CPU-heavy on a large deck, so yield to the event loop periodically
  // (and report progress) to keep the UI responsive.
  onProgress?.({ phase: 'mapping', done: 0, total: cardInfo.length });
  const cardRows: Row[] = [];
  for (let i = 0; i < cardInfo.length; i++) {
    const { id, noteId, created, ord } = cardInfo[i];
    const card = deriveCard(logsByCard.get(id) ?? [], created, defaultCfg);
    cardRows.push([
      id, userId, noteId, ord,
      card.due.toISOString(),
      card.stability ?? null,
      card.difficulty ?? null,
      card.reps,
      card.lapses,
      card.state,
      card.last_review ? card.last_review.toISOString() : null,
    ]);
    if ((i & 511) === 511) {
      onProgress?.({ phase: 'mapping', done: i + 1, total: cardInfo.length });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // --- persist (FK-safe order: note_types, decks, notes, cards, review_logs) ---
  onProgress?.({ phase: 'writing', done: 0, total: noteRows.length + cardRows.length + reviewRows.length });
  await insertChunked('INSERT INTO note_types (id, user_id, name, fields, card_templates) VALUES (?, ?, ?, ?, ?)', noteTypeRows);
  await insertChunked('INSERT INTO decks (id, user_id, name, fsrs_params, created_at) VALUES (?, ?, ?, ?, ?)', deckRows);
  const grandTotal = noteRows.length + cardRows.length + reviewRows.length;
  await insertChunked('INSERT INTO notes (id, user_id, deck_id, note_type_id, fields, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', noteRows,
    (d) => onProgress?.({ phase: 'writing', done: d, total: grandTotal }));
  const writtenAfterNotes = noteRows.length;
  await insertChunked('INSERT INTO cards (id, user_id, note_id, template_index, due, stability, difficulty, reps, lapses, state, last_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', cardRows,
    (d) => onProgress?.({ phase: 'writing', done: writtenAfterNotes + d, total: noteRows.length + cardRows.length + reviewRows.length }));
  await insertChunked('INSERT INTO review_logs (id, user_id, card_id, rating, review_time, elapsed_ms, scheduled_days) VALUES (?, ?, ?, ?, ?, ?, ?)', reviewRows,
    (d) => onProgress?.({ phase: 'writing', done: writtenAfterNotes + cardRows.length + d, total: noteRows.length + cardRows.length + reviewRows.length }));

  // --- media: upload referenced blobs + cache locally for offline rendering ---
  let mediaFiles = 0;
  if (referenced.size > 0) {
    onProgress?.({ phase: 'media', done: 0, total: referenced.size });
    mediaFiles = await uploadMedia(parsed.zip, parsed.media, referenced, userId, importId,
      (done, total) => onProgress?.({ phase: 'media', done, total }));
  }

  onProgress?.({ phase: 'done' });
  return {
    decks: deckRows.length,
    noteTypes: noteTypeRows.length,
    notes: noteRows.length,
    cards: cardRows.length,
    reviews: reviewRows.length,
    mediaFiles,
    skipped,
  };
}
