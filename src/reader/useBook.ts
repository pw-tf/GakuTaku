import { useEffect, useRef, useState } from 'react';
import { supabase } from '../sync/supabase';
import { db } from '../sync/system';
import { jpCore } from '../jp-core/client';
import type { FuriToken } from '../jp-core/worker';
import type { DocumentRecord } from '../sync/AppSchema';
import { openEpub, type EpubBook } from './epub';
import { getBlob, putBlob } from './bookCache';

const BUCKET = 'documents';

/** Where to land when a chapter's paragraphs render. */
export type RestoreTarget =
  | { kind: 'anchor'; paragraphIndex: number; fraction: number }
  | { kind: 'top' }
  | { kind: 'end' };

/** A reading position reported by the Reader after layout: leading paragraph + progress. */
export interface ReadingPos {
  paragraphIndex: number;
  /** 0..1 within the leading paragraph (for sub-paragraph precision). */
  fraction: number;
  /** 0..1 progress through the current chapter (drives the whole-book percent). */
  chapterFraction: number;
}

interface BookState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  title: string;
  direction: 'ltr' | 'rtl';
  chapterIndex: number;
  chapterCount: number;
  paragraphs: FuriToken[][];
  loadingChapter: boolean;
  /** Target the Reader applies once the chapter's paragraphs are on screen. */
  restore: RestoreTarget;
}

async function resolveBlob(doc: DocumentRecord): Promise<ArrayBuffer> {
  const cached = await getBlob(doc.id);
  if (cached) return cached.arrayBuffer();
  const { data, error } = await supabase.storage.from(BUCKET).download(doc.storage_path ?? '');
  if (error || !data) throw new Error(`Could not download book: ${error?.message ?? 'missing'}`);
  await putBlob(doc.id, data);
  return data.arrayBuffer();
}

/**
 * Parse a saved locator. New format `"<chapter>#p<paraIndex>@<fraction>"` anchors to a paragraph,
 * so it survives font/width/orientation changes. Legacy `"<chapter>:<scrollFraction>"` rows (from
 * before paragraph anchoring) load at the chapter top — close enough, and they re-save on first read.
 */
function parseLocator(loc: string): { chapter: number; anchor: { paragraphIndex: number; fraction: number } } {
  const m = /^(\d+)#p(\d+)@([\d.]+)$/.exec(loc);
  if (m) return { chapter: Number(m[1]), anchor: { paragraphIndex: Number(m[2]), fraction: Number(m[3]) || 0 } };
  const [ch] = loc.split(':');
  return { chapter: Number(ch) || 0, anchor: { paragraphIndex: 0, fraction: 0 } };
}

async function readPosition(docId: string): Promise<{ chapter: number; anchor: { paragraphIndex: number; fraction: number } }> {
  const rows = await db.getAll<{ locator: string | null }>(
    'SELECT locator FROM reading_positions WHERE document_id = ? LIMIT 1',
    [docId],
  );
  return parseLocator(rows[0]?.locator ?? '');
}

export function useBook(doc: DocumentRecord, userId: string) {
  const [state, setState] = useState<BookState>({
    status: 'loading',
    error: null,
    title: doc.title ?? 'Untitled',
    direction: 'ltr',
    chapterIndex: 0,
    chapterCount: 0,
    paragraphs: [],
    loadingChapter: false,
    restore: { kind: 'top' },
  });
  const bookRef = useRef<EpubBook | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ chapter: number; pos: ReadingPos } | null>(null);
  const chapterRef = useRef(0);

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
          direction: book.direction,
          chapterCount: book.chapterCount,
          chapterIndex: startChapter,
        }));
        await loadChapter(startChapter, { kind: 'anchor', ...pos.anchor });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      cancelled = true;
      // Flush the last reading position before the reader unmounts (debounced saves would be lost).
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pendingRef.current) {
        persistPosition(pendingRef.current.chapter, pendingRef.current.pos);
        pendingRef.current = null;
      }
      bookRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  async function loadChapter(index: number, restore: RestoreTarget) {
    const book = bookRef.current;
    if (!book) return;
    // Changing chapters: drop any pending intra-chapter save — the new chapter's settle is authoritative.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pendingRef.current = null;
    chapterRef.current = index;
    setState((s) => ({ ...s, loadingChapter: true }));
    const texts = await book.loadChapter(index);
    const tokens = texts.length ? await jpCore.furiganaForMany(texts) : [];
    setState((s) => ({
      ...s,
      status: 'ready',
      chapterIndex: index,
      paragraphs: tokens,
      loadingChapter: false,
      restore,
    }));
  }

  function persistPosition(chapter: number, pos: ReadingPos) {
    const count = state.chapterCount || bookRef.current?.chapterCount || 1;
    const frac = Math.min(Math.max(pos.chapterFraction, 0), 1);
    const percent = Math.round(((chapter + frac) / count) * 100);
    const locator = `${chapter}#p${pos.paragraphIndex}@${pos.fraction.toFixed(3)}`;
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

  function goChapter(index: number, edge: 'top' | 'end' = 'top') {
    const count = state.chapterCount || bookRef.current?.chapterCount || 0;
    if (index < 0 || index >= count) return;
    loadChapter(index, { kind: edge });
  }

  /** Save a reported position. Debounced while reading; immediate on chapter settle. */
  function saveProgress(pos: ReadingPos, immediate = false) {
    pendingRef.current = { chapter: chapterRef.current, pos };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const run = () => {
      const p = pendingRef.current;
      if (p) persistPosition(p.chapter, p.pos);
      pendingRef.current = null;
    };
    if (immediate) run();
    else saveTimer.current = setTimeout(run, 700);
  }

  return {
    ...state,
    goChapter,
    nextChapter: () => goChapter(state.chapterIndex + 1, 'top'),
    prevChapter: () => goChapter(state.chapterIndex - 1, 'top'),
    prevChapterEnd: () => goChapter(state.chapterIndex - 1, 'end'),
    saveProgress,
  };
}
