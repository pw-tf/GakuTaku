import { db } from '../sync/system';
import { MANUAL_RATING, deriveCard } from '../srs/fsrs';
import { serializeDeckOverrides, serializePresetConfig, defaultPresetConfig, type DeckPresetConfig } from '../srs/presets';
import { ensureDefaultPreset } from '../srs/presetOps';
import { studyDayEnd } from '../srs/queue';
import { usePrefs } from '../app/prefs';
import type { ReviewLogRecord } from '../sync/AppSchema';
import type { ParsedApkg } from './apkg';
import { mapApkgCardState, mapDconfToPreset, mapRevlogEntry } from './mapApkg';
import { rewriteMediaRefs, uploadMedia } from './media';

/**
 * Map a parsed `.apkg` into our schema and persist it (build plan M6). Anki models→`note_types`,
 * decks→`decks` (options groups→`deck_presets`), notes→`notes`, cards→`cards` (with suspended/
 * buried/flag state and the new-card position preserved), and the `revlog`→append-only
 * `review_logs`, including Anki's manual (ease 0) entries as rating-0 events. Card FSRS state is
 * then *derived* from those logs via {@link deriveCard} (§3.3) rather than copied from Anki, so
 * scheduling is FSRS-native and converges across devices. Media is uploaded + cached separately.
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
  const defaultCfg = defaultPresetConfig();
  onProgress?.({ phase: 'mapping' });

  // --- note types (Anki models) ---
  const noteTypeRows: Row[] = [];
  const modelById = new Map<string, { noteTypeId: string; fields: string[] }>();
  for (const m of parsed.models) {
    const noteTypeId = crypto.randomUUID();
    modelById.set(m.id, { noteTypeId, fields: m.fields });
    const templates = m.templates.map((t) => ({ name: t.name, front: t.qfmt, back: t.afmt }));
    noteTypeRows.push([noteTypeId, userId, m.name || 'Imported note type', JSON.stringify(m.fields), JSON.stringify(templates), m.css || null]);
  }

  // --- deck option presets (Anki options groups) + decks (only those a card actually lives in) ---
  // Legacy packages carry their dconf; one deck_presets row is created per options group that an
  // imported deck actually uses. Decks without a parseable group join the user's Default preset.
  const defaultPresetId = await ensureDefaultPreset(userId);
  const dconfById = new Map(parsed.dconfs.map((d) => [d.id, d]));
  const presetRows: Row[] = [];
  const presetIdByConf = new Map<string, string>();
  const presetCfgByConf = new Map<string, DeckPresetConfig>();
  const presetForConf = (confId: string | undefined): string => {
    if (!confId) return defaultPresetId;
    const dconf = dconfById.get(confId);
    if (!dconf) return defaultPresetId;
    let id = presetIdByConf.get(confId);
    if (!id) {
      id = crypto.randomUUID();
      presetIdByConf.set(confId, id);
      const cfg = mapDconfToPreset(dconf);
      presetCfgByConf.set(confId, cfg);
      presetRows.push([id, userId, dconf.name, serializePresetConfig(cfg), now]);
    }
    return id;
  };

  const usedDeckIds = new Set(parsed.cards.map((c) => c.did));
  const deckRows: Row[] = [];
  const deckIdMap = new Map<string, string>();
  /** Effective config per Anki deck id — the replay below must use the deck's own steps. */
  const cfgByAnkiDeck = new Map<string, DeckPresetConfig>();
  for (const d of parsed.decks) {
    if (!usedDeckIds.has(d.id)) continue;
    const deckId = crypto.randomUUID();
    deckIdMap.set(d.id, deckId);
    if (d.confId && dconfById.has(d.confId)) {
      presetForConf(d.confId);
      cfgByAnkiDeck.set(d.id, presetCfgByConf.get(d.confId) ?? defaultCfg);
    }
    const overrides = serializeDeckOverrides({ description: d.desc || undefined });
    deckRows.push([deckId, userId, d.name || 'Imported', overrides, presetForConf(d.confId), now]);
  }
  let fallbackDeckId: string | null = null;
  const deckForAnki = (did: string): string => {
    const mapped = deckIdMap.get(did);
    if (mapped) return mapped;
    if (!fallbackDeckId) {
      fallbackDeckId = crypto.randomUUID();
      deckRows.push([fallbackDeckId, userId, 'Imported', '{}', defaultPresetId, now]);
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

  // --- cards (FSRS columns filled after deriving from logs; user state mapped 1:1) ---
  const buriedUntil = studyDayEnd(new Date(), usePrefs.getState().dayCutoffHour).toISOString();
  const cardIdMap = new Map<string, string>();
  const cardInfo: {
    id: string;
    noteId: string;
    created: string;
    ord: number;
    did: string;
    queue: number;
    flag: number;
    position: number | null;
    buried: boolean;
  }[] = [];
  for (const c of parsed.cards) {
    const noteId = noteIdMap.get(c.nid);
    if (!noteId) { skipped++; continue; }
    const id = crypto.randomUUID();
    cardIdMap.set(c.id, id);
    const state = mapApkgCardState(c);
    cardInfo.push({ id, noteId, created: noteCreated.get(noteId) ?? now, ord: c.ord, did: c.did, ...state });
  }

  // --- review_logs (revlog) --- Answers import as rating 1–4; Anki's manual entries (ease 0:
  // forget / set due date) import as rating-0 events so the replay reproduces Anki's post-forget
  // state. Filtered-deck reviews done with rescheduling disabled (type 3, factor 0) never affected
  // scheduling and are skipped, matching what Anki feeds FSRS.
  const reviewRows: Row[] = [];
  const logsByCard = new Map<string, ReviewLogRecord[]>();
  for (const r of parsed.revlog) {
    const mapping = mapRevlogEntry(r);
    if (mapping.kind === 'skip') continue;
    const cardId = cardIdMap.get(r.cid);
    if (!cardId) continue;
    const id = crypto.randomUUID();
    const reviewTime = new Date(r.id).toISOString();
    const rating = mapping.kind === 'review' ? mapping.rating : MANUAL_RATING;
    const elapsedMs = mapping.kind === 'review' ? (r.time ?? 0) : null;
    const scheduledDays = mapping.kind === 'review' ? (r.ivl ?? 0) : mapping.scheduledDays;
    const log: ReviewLogRecord = {
      id, user_id: userId, card_id: cardId, rating,
      review_time: reviewTime, elapsed_ms: elapsedMs, scheduled_days: scheduledDays,
    };
    const list = logsByCard.get(cardId);
    if (list) list.push(log); else logsByCard.set(cardId, [log]);
    reviewRows.push([id, userId, cardId, rating, reviewTime, elapsedMs, scheduledDays]);
  }

  // Derive each card's current FSRS state from its imported logs (no history → New/due-now),
  // using the card's own deck config — its learning steps change what the replay produces.
  // Replaying every card is CPU-heavy on a large deck, so yield to the event loop periodically
  // (and report progress) to keep the UI responsive.
  onProgress?.({ phase: 'mapping', done: 0, total: cardInfo.length });
  const cardRows: Row[] = [];
  for (let i = 0; i < cardInfo.length; i++) {
    const { id, noteId, created, ord, did, queue, flag, position, buried } = cardInfo[i];
    const card = deriveCard(logsByCard.get(id) ?? [], created, cfgByAnkiDeck.get(did) ?? defaultCfg, id);
    cardRows.push([
      id, userId, noteId, ord,
      card.due.toISOString(),
      card.stability ?? null,
      card.difficulty ?? null,
      card.reps,
      card.lapses,
      card.state,
      card.last_review ? card.last_review.toISOString() : null,
      queue,
      flag,
      position,
      buried ? buriedUntil : null,
    ]);
    if ((i & 511) === 511) {
      onProgress?.({ phase: 'mapping', done: i + 1, total: cardInfo.length });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // --- persist (FK-safe order: presets, note_types, decks, notes, cards, review_logs) ---
  onProgress?.({ phase: 'writing', done: 0, total: noteRows.length + cardRows.length + reviewRows.length });
  await insertChunked('INSERT INTO deck_presets (id, user_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)', presetRows);
  await insertChunked('INSERT INTO note_types (id, user_id, name, fields, card_templates, css) VALUES (?, ?, ?, ?, ?, ?)', noteTypeRows);
  await insertChunked('INSERT INTO decks (id, user_id, name, fsrs_params, preset_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', deckRows);
  const grandTotal = noteRows.length + cardRows.length + reviewRows.length;
  await insertChunked('INSERT INTO notes (id, user_id, deck_id, note_type_id, fields, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', noteRows,
    (d) => onProgress?.({ phase: 'writing', done: d, total: grandTotal }));
  const writtenAfterNotes = noteRows.length;
  await insertChunked('INSERT INTO cards (id, user_id, note_id, template_index, due, stability, difficulty, reps, lapses, state, last_review, queue, flag, position, buried_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', cardRows,
    (d) => onProgress?.({ phase: 'writing', done: writtenAfterNotes + d, total: noteRows.length + cardRows.length + reviewRows.length }));
  await insertChunked('INSERT INTO review_logs (id, user_id, card_id, rating, review_time, elapsed_ms, scheduled_days) VALUES (?, ?, ?, ?, ?, ?, ?)', reviewRows,
    (d) => onProgress?.({ phase: 'writing', done: writtenAfterNotes + cardRows.length + d, total: noteRows.length + cardRows.length + reviewRows.length }));

  // --- media: upload referenced blobs + cache locally for offline rendering ---
  let mediaFiles = 0;
  if (referenced.size > 0) {
    onProgress?.({ phase: 'media', done: 0, total: referenced.size });
    mediaFiles = await uploadMedia(parsed.zip, parsed.media, referenced, userId, importId, parsed.mediaCompressed,
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
