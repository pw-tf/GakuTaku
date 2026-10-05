import { appSql, col } from '../anki/appCollection';
import { VOCAB_FIELDS, VOCAB_NOTETYPE_NAME, ensureStockNotetypes } from '../anki/stock';

/**
 * Mining: turn a looked-up word into a note of the "Japanese Vocab (GakuTaku)" note type in the
 * chosen deck. A word already in the collection as that note type is not added twice.
 */

export const DEFAULT_MINING_DECK = 'Mined';

export interface MineInput {
  deckId: number;
  term: string;
  reading: string;
  meaning: string;
  sentence?: string;
  source?: string;
  documentId?: string | null;
}

export interface MineResult {
  cardId: number;
  noteId: number;
  created: boolean;
}

async function vocabNotetypeId(): Promise<number> {
  let nt = (await col.notetypes()).find((n) => n.name === VOCAB_NOTETYPE_NAME);
  if (!nt) {
    await ensureStockNotetypes(col);
    nt = (await col.notetypes()).find((n) => n.name === VOCAB_NOTETYPE_NAME)!;
  }
  return nt.id;
}

export async function mineWord(input: MineInput): Promise<MineResult> {
  const mid = await vocabNotetypeId();
  const [dupe] = await appSql.all<{ nid: number; cid: number }>(
    `SELECT n.id AS nid, c.id AS cid FROM notes n JOIN cards c ON c.nid = n.id WHERE n.mid = ? AND n.sfld = ? LIMIT 1`,
    [mid, input.term],
  );
  if (dupe) return { noteId: dupe.nid, cardId: dupe.cid, created: false };
  const values: Record<string, string> = {
    Word: input.term,
    Reading: input.reading,
    Meaning: input.meaning,
    Sentence: input.sentence ?? '',
    Source: input.source ?? '',
  };
  const fields = VOCAB_FIELDS.map((f) => values[f] ?? '');
  const { noteId, cardIds } = await col.addNote(mid, fields, ['mined'], input.deckId);
  await appSql.run(
    'INSERT INTO mined_words (id, term, reading, context, document_id, note_id, looked_up_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), input.term, input.reading, input.sentence ?? '', input.documentId ?? null, noteId, new Date().toISOString()],
  );
  return { noteId, cardId: cardIds[0], created: true };
}
