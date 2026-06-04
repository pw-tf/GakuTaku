import { useEffect, useRef, useState } from 'react';
import { supabase } from '../sync/supabase';
import { db } from '../sync/system';
import { jpCore } from '../jp-core/client';
import type { FuriToken } from '../jp-core/worker';
import type { DocumentRecord } from '../sync/AppSchema';
import { openEpub, type EpubBook } from './epub';
import { getBlob, putBlob } from './bookCache';

const BUCKET = 'documents';

interface BookState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  title: string;
  chapterIndex: number;
  chapterCount: number;
  paragraphs: FuriToken[][];
  loadingChapter: boolean;
  restoreScroll: number;
}

async function resolveBlob(doc: DocumentRecord): Promise<ArrayBuffer> {
  const cached = await getBlob(doc.id);
  if (cached) return cached.arrayBuffer();
  const { data, error } = await supabase.storage.from(BUCKET).download(doc.storage_path ?? '');
  if (error || !data) throw new Error(`Could not download book: ${error?.message ?? 'missing'}`);
  await putBlob(doc.id, data);
  return data.arrayBuffer();
}

/** Reads the saved position: locator is "chapterIndex:scrollFraction". */
async function readPosition(docId: string): Promise<{ chapter: number; scroll: number }> {
  const rows = await db.getAll<{ locator: string | null }>(
    'SELECT locator FROM reading_positions WHERE document_id = ? LIMIT 1',
    [docId],
  );
  const loc = rows[0]?.locator ?? '';
  const [ch, sc] = loc.split(':');
  return { chapter: Number(ch) || 0, scroll: Number(sc) || 0 };
}

export function useBook(doc: DocumentRecord, userId: string) {
  const [state, setState] = useState<BookState>({
    status: 'loading',
    error: null,
    title: doc.title ?? 'Untitled',
    chapterIndex: 0,
    chapterCount: 0,
    paragraphs: [],
    loadingChapter: false,
    restoreScroll: 0,
  });
  const bookRef = useRef<EpubBook | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Open the book once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const buffer = await resolveBlob(doc);
        const book = await openEpub(buffer);
        if (cancelled) {
          book.destroy();
          return;
        }
        bookRef.current = book;
        const pos = await readPosition(doc.id);
        const startChapter = Math.min(pos.chapter, Math.max(0, book.chapterCount - 1));
        setState((s) => ({
          ...s,
          title: book.title || s.title,
          chapterCount: book.chapterCount,
          chapterIndex: startChapter,
          restoreScroll: pos.scroll,
        }));
        await loadChapter(startChapter, pos.scroll);
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      cancelled = true;
      bookRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  async function loadChapter(index: number, restoreScroll = 0) {
    const book = bookRef.current;
    if (!book) return;
    setState((s) => ({ ...s, loadingChapter: true }));
    const texts = await book.loadChapter(index);
    const tokens = texts.length ? await jpCore.furiganaForMany(texts) : [];
    setState((s) => ({
      ...s,
      status: 'ready',
      chapterIndex: index,
      paragraphs: tokens,
      loadingChapter: false,
      restoreScroll,
    }));
    persistPosition(index, restoreScroll);
  }

  function persistPosition(chapter: number, scroll: number) {
    const count = state.chapterCount || bookRef.current?.chapterCount || 1;
    const percent = Math.round(((chapter + Math.min(scroll, 1)) / count) * 100);
    const locator = `${chapter}:${scroll.toFixed(3)}`;
    const now = new Date().toISOString();
    (async () => {
      const rows = await db.getAll<{ id: string }>(
        'SELECT id FROM reading_positions WHERE document_id = ? LIMIT 1',
        [doc.id],
      );
      if (rows.length) {
        await db.execute('UPDATE reading_positions SET locator=?, percent=?, updated_at=? WHERE id=?', [locator, percent, now, rows[0].id]);
      } else {
        await db.execute(
          'INSERT INTO reading_positions (id, user_id, document_id, locator, percent, updated_at) VALUES (uuid(), ?, ?, ?, ?, ?)',
          [userId, doc.id, locator, percent, now],
        );
      }
    })();
  }

  function goChapter(index: number) {
    if (index < 0 || index >= state.chapterCount) return;
    loadChapter(index, 0);
  }

  /** Debounced intra-chapter scroll save. */
  function saveScroll(fraction: number) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persistPosition(state.chapterIndex, fraction), 700);
  }

  return {
    ...state,
    goChapter,
    nextChapter: () => goChapter(state.chapterIndex + 1),
    prevChapter: () => goChapter(state.chapterIndex - 1),
    saveScroll,
  };
}
