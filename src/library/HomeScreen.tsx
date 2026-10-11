import { useMemo, useRef, useState } from 'react';
import { LOCAL_USER_ID } from '../app/localUser';
import { fileAccept } from '../app/platform';
import { Btn, Kicker, Spinner } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { importFile, useImporting } from '../import/runImport';
import { useDocuments } from '../db/hooks';
import type { DocumentRecord } from '../db/schema';
import { FeedsSection } from '../feeds/FeedsSection';
import { useBackHandler } from '../app/back';
import { FeedArticles } from '../feeds/FeedArticles';
import type { FeedArticle } from '../feeds/parse';
import type { FeedView } from '../feeds/useFeeds';
import { BOOK_ACCEPT, BookCard, useCovers, useGridColumns, useProgress } from './shelf';

interface Props {
  onOpenBook: (doc: DocumentRecord) => void;
  onOpenArticle: (article: FeedArticle, feed: FeedView) => void;
  due: number;
  dueLoading: boolean;
  streak: number;
  /** Open the "Study what?" picker (the Today tile). */
  onStudy: () => void;
  /** Go to the Library tab (every book). */
  onOpenLibrary: () => void;
}

/** Home: continue reading, today's reviews, the books you read last, and feeds. */
export function HomeScreen({ onOpenBook, onOpenArticle, onStudy, onOpenLibrary, due, dueLoading, streak }: Props) {
  const { data: docs } = useDocuments();
  const { pct: pctById, readAt } = useProgress();
  const fileRef = useRef<HTMLInputElement>(null);
  // Progress lives in the global task store (BackgroundTasks banner) so it survives navigating away.
  const busy = useImporting();
  // Drill-down into one feed's article list (survives opening/closing the article overlay).
  const [openFeed, setOpenFeed] = useState<FeedView | null>(null);
  useBackHandler(openFeed != null, () => setOpenFeed(null));
  // Most recently read first, then newest added (docs come newest first).
  const recent = useMemo(() => [...docs].sort((a, b) => (readAt.get(b.id) ?? '').localeCompare(readAt.get(a.id) ?? '')), [docs, readAt]);
  // One row only, so the Feeds section stays near the top; the Library tab has the rest.
  const gridRef = useRef<HTMLDivElement>(null);
  const cols = useGridColumns(gridRef, docs.length > 0);
  const shelf = recent.slice(0, cols);
  const covers = useCovers(recent.slice(0, 12).map((d) => d.id));
  const cont = recent[0];

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await importFile(file, LOCAL_USER_ID);
  }

  return (
    <div className="page">
      <input ref={fileRef} type="file" accept={fileAccept(BOOK_ACCEPT)} hidden onChange={onFile} />

      <div className="lib-hero">
        <div className="cont-card" onClick={() => cont && onOpenBook(cont)} style={{ cursor: cont ? 'pointer' : 'default' }}>
          {cont && covers.get(cont.id) ? (
            <img className="cc-cover cc-img" src={covers.get(cont.id)} alt="" />
          ) : (
            <div className="cc-cover"><div className="sp" /></div>
          )}
          <div className="cc-meta">
            <div className="k">{cont ? 'Continue reading' : 'Your reader'}</div>
            <div className="t" lang="ja">{cont?.title ?? 'Add your first book'}</div>
            <div className="a">{cont ? `${pctById.get(cont.id) ?? 0}% read` : 'ePUB, PDF or TXT, from your Downloads or anywhere else.'}</div>
            {cont && <div className="pr"><i style={{ width: (pctById.get(cont.id) ?? 0) + '%' }} /></div>}
            {cont ? (
              <Btn variant="primary" size="sm">Resume <Icon.chevR s={15} /></Btn>
            ) : (
              <Btn variant="primary" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Icon.upload s={15} /> Add a book
              </Btn>
            )}
          </div>
        </div>
        <div className="daily" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={onStudy}>
          <div>
            <Kicker accent>Today</Kicker>
            <div className="big-num">{dueLoading ? <Spinner size={26} /> : due}<span className="u">due</span></div>
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', gap: 18, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>
              <Icon.flame s={16} /> {streak > 0 ? `${streak}-day streak` : 'Start a streak today'}
            </span>
          </div>
        </div>
      </div>

      <section className="home-sec">
      <div className="sec-bar">
        <h2>Recently read</h2>
        <span className="more" style={{ display: 'flex', gap: 8 }}>
          <Btn size="sm" disabled={busy} title="Add a book (ePUB, PDF, TXT) or an Anki deck (.apkg, .colpkg)" onClick={() => fileRef.current?.click()}>
            <Icon.upload s={15} /> {busy ? 'Working…' : 'Add file'}
          </Btn>
        </span>
      </div>

      {docs.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>No books yet. Add a Japanese ePUB, PDF or TXT file to start reading.</p>
      ) : (
        <div className="book-grid" ref={gridRef}>
          {shelf.map((b) => <BookCard key={b.id} doc={b} pct={pctById.get(b.id) ?? 0} cover={covers.get(b.id)} onOpen={() => onOpenBook(b)} />)}
        </div>
      )}

      {docs.length > 0 && (
        <button className="shelf-more" onClick={onOpenLibrary}>
          {docs.length > shelf.length ? `All ${docs.length} books in your library` : 'Open your library'}
          <Icon.chevR s={14} />
        </button>
      )}
      </section>

      <section className="home-sec">
      {openFeed ? (
        <FeedArticles
          feed={openFeed}
          onBack={() => setOpenFeed(null)}
          onOpenArticle={(a) => onOpenArticle(a, openFeed)}
        />
      ) : (
        <FeedsSection onOpenFeed={setOpenFeed} />
      )}
      </section>
    </div>
  );
}
