import { appSql, col } from '../anki/appCollection';
import { splitFields } from '../anki/notetype';
import { VOCAB_FIELDS, VOCAB_NOTETYPE_NAME, ensureStockNotetypes } from '../anki/stock';
import { escapeHtml } from '../books/sentence';
import { fetchWordAudio, recordSentenceAudio } from './mineAudio';

/**
 * Mining: turn a looked-up word into a note of the "Japanese Vocab (GakuTaku)" note type in the
 * chosen deck, with the sentence it was found in and where it came from. A word already in the
 * collection as that note type is not added twice. Audio is fetched afterwards, in the background,
 * and attached to the note when it arrives.
 */

export const DEFAULT_MINING_DECK = 'Mined';

export interface MineInput {
  deckId: number;
  term: string;
  reading: string;
  meaning: string;
  /** The sentence in Anki furigana syntax (HTML, word in <b>). */
  sentence?: string;
  /** The sentence as plain text, for recording its audio. */
  sentencePlain?: string;
  source?: string;
  documentId?: string | null;
  /** Fetch/record audio after adding (defaults: on). */
  wordAudio?: boolean;
  sentenceAudio?: boolean;
}

export interface MineResult {
  cardId: number;
  noteId: number;
  created: boolean;
  /** Settles once any audio has been fetched and attached (never rejects). */
  audio: Promise<{ word: boolean; sentence: boolean }>;
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
  const word = escapeHtml(input.term);
  const [dupe] = await appSql.all<{ nid: number; cid: number }>(
    `SELECT n.id AS nid, c.id AS cid FROM notes n JOIN cards c ON c.nid = n.id WHERE n.mid = ? AND n.sfld = ? LIMIT 1`,
    [mid, word],
  );
  if (dupe) return { noteId: dupe.nid, cardId: dupe.cid, created: false, audio: Promise.resolve({ word: false, sentence: false }) };
  const values: Record<string, string> = {
    Word: word,
    Reading: escapeHtml(input.reading),
    Meaning: escapeHtml(input.meaning),
    Sentence: input.sentence ?? '',
    Source: escapeHtml(input.source ?? ''),
  };
  const fields = VOCAB_FIELDS.map((f) => values[f] ?? '');
  const { noteId, cardIds } = await col.addNote(mid, fields, ['mined'], input.deckId);
  await appSql.run(
    'INSERT INTO mined_words (id, term, reading, context, document_id, note_id, looked_up_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), input.term, input.reading, input.sentencePlain ?? '', input.documentId ?? null, noteId, new Date().toISOString()],
  );
  const audio = attachAudio(noteId, input).catch(() => ({ word: false, sentence: false }));
  return { noteId, cardId: cardIds[0], created: true, audio };
}

async function attachAudio(noteId: number, input: MineInput): Promise<{ word: boolean; sentence: boolean }> {
  const [wordFile, sentenceFile] = await Promise.all([
    input.wordAudio === false ? null : fetchWordAudio(input.term, input.reading),
    input.sentenceAudio === false || !input.sentencePlain ? null : recordSentenceAudio(input.sentencePlain),
  ]);
  if (!wordFile && !sentenceFile) return { word: false, sentence: false };
  // Re-read the note: it may have been edited while the audio was on its way.
  const note = await col.note(noteId);
  if (!note) return { word: false, sentence: false };
  const nt = await col.notetype(note.mid);
  if (!nt) return { word: false, sentence: false };
  const fields = splitFields(note.flds);
  const set = (name: string, file: string | null) => {
    const i = nt.fields.findIndex((f) => f.name === name);
    if (file && i >= 0 && !fields[i]) fields[i] = `[sound:${file}]`;
  };
  set('Word Audio', wordFile);
  set('Sentence Audio', sentenceFile);
  await col.updateNote(noteId, fields);
  return { word: !!wordFile, sentence: !!sentenceFile };
}
