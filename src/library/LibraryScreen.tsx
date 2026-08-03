import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Btn, Kicker, Spinner } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { importFile, useImporting } from '../import/runImport';
import { useDocuments, useReadingPositions } from '../sync/hooks';
import type { DocumentRecord } from '../sync/AppSchema';
import { FeedsSection } from '../feeds/FeedsSection';
import { FeedArticles } from '../feeds/FeedArticles';
import type { FeedArticle } from '../feeds/parse';
import type { FeedView } from '../feeds/useFeeds';

const TONES = ['#b8492f', '#5b6b58', '#3d5a6b', '#6b5b3d', '#7d4a86', '#3f5bb0', '#2f6b4f'];
function toneFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

/**
 * How many cards fit on one row of a CSS grid. `grid-template-columns` computes to an explicit
 * list of pixel tracks, so counting them is exact — no need to mirror the `minmax()`/`gap` values
 * from the stylesheet (which the mobile breakpoint overrides anyway). The collapsed shelf shows
 * exactly one row at any width, so the library can't push the Feeds section below the fold.
 */
function useGridColumns(ref: React.RefObject<HTMLElement>, enabled: boolean): number {
  const [cols, setCols] = useState(6);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const measure = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length;
      if (tracks > 0) setCols(tracks);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return cols;
}

interface Props {
  onOpenBook: (doc: DocumentRecord) => void;
  onOpenArticle: (article: FeedArticle, feed: FeedView) => void;
  due: number;
  dueLoading: boolean;
  streak: number;
}

export function LibraryScreen({ onOpenBook, onOpenArticle, due, dueLoading, streak }: Props) {
  const { session } = useAuth();
  const { data: docs } = useDocuments();
  const { data: positions } = useReadingPositions();
  const fileRef = useRef<HTMLInputElement>(null);
  // Progress lives in the global task store (BackgroundTasks banner) so it survives navigating away.
  const busy = useImporting();
  // Drill-down into one feed's article list (survives opening/closing the article overlay).
  const [openFeed, setOpenFeed] = useState<FeedView | null>(null);
  // The shelf shows one row until expanded, so a big library doesn't bury the Feeds section.
  const [showAllBooks, setShowAllBooks] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const cols = useGridColumns(gridRef, docs.length > 0);
  const visibleDocs = showAllBooks ? docs : docs.slice(0, cols);
  const hiddenCount = docs.length - visibleDocs.length;

  const pctById = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of positions) m.set(p.document_id, p.percent ?? 0);
    return m;
  }, [positions]);

  // Continue = the doc with the most recently updated reading position, else most recent upload.
  const cont = useMemo(() => {
    const latest = [...positions].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0];
    return (latest && docs.find((d) => d.id === latest.document_id)) ?? docs[0];
  }, [positions, docs]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !session) return;
    e.target.value = '';
    await importFile(file, session.user.id);
  }

  return (
    <div className="page">
      <input ref={fileRef} type="file" accept=".epub,application/epub+zip,.apkg" hidden onChange={onFile} />

      <div className="lib-hero">
        <div className="cont-card" onClick={() => cont && onOpenBook(cont)} style={{ cursor: cont ? 'pointer' : 'default' }}>
          <div className="cc-cover"><div className="sp" /></div>
          <div className="cc-meta">
            <div className="k">{cont ? 'Continue reading' : 'Your reader'}</div>
            <div className="t" lang="ja">{cont?.title ?? 'Upload your first ePUB'}</div>
            <div className="a">{cont ? `${pctById.get(cont.id) ?? 0}% read` : 'Tap “Upload ePUB” to get started.'}</div>
            {cont && <div className="pr"><i style={{ width: (pctById.get(cont.id) ?? 0) + '%' }} /></div>}
            {cont ? (
              <Btn variant="primary" size="sm">Resume <Icon.chevR s={15} /></Btn>
            ) : (
              <Btn variant="primary" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Icon.upload s={15} /> Upload ePUB
              </Btn>
            )}
          </div>
        </div>
        <div className="daily">
          <div>
            <Kicker accent>Today</Kicker>
            <div className="big-num">{dueLoading ? <Spinner size={26} /> : due}<span className="u">due</span></div>
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', gap: 18, alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>
              <Icon.flame s={16} /> {streak}-day streak
            </span>
          </div>
        </div>
      </div>

      <div className="sec-bar">
        <h2>Your library</h2>
        <span className="count">{docs.length} {docs.length === 1 ? 'book' : 'books'}</span>
        <span className="more" style={{ display: 'flex', gap: 8 }}>
          <Btn size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Icon.upload s={15} /> {busy ? 'Working…' : 'Upload ePUB / Anki deck'}
          </Btn>
        </span>
      </div>

      {docs.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>No books yet. Upload a Japanese ePUB to start reading.</p>
      ) : (
        <div className="book-grid" ref={gridRef}>
          {visibleDocs.map((b) => {
            const pct = pctById.get(b.id) ?? 0;
            const tone = toneFor(b.id);
            return (
              <div className="bcard" key={b.id} onClick={() => onOpenBook(b)}>
                <div className="cv" style={{ background: `linear-gradient(160deg, ${tone}, color-mix(in oklch, ${tone} 70%, black))` }}>
                  <div className="spine" />
                  <div className="ph"><div className="jt" lang="ja">{b.title}</div></div>
                  {pct > 0 && <div className="pct"><i style={{ width: pct + '%' }} /></div>}
                </div>
                <div className="bt" lang="ja">{b.title}</div>
                <div className="ba">{pct > 0 ? pct + '%' : 'New'}</div>
              </div>
            );
          })}
        </div>
      )}

      {(hiddenCount > 0 || showAllBooks) && (
        <button className="shelf-more" onClick={() => setShowAllBooks((s) => !s)}>
          {showAllBooks ? 'Show less' : `Show all ${docs.length} books`}
          <Icon.chevR s={14} />
        </button>
      )}

      {openFeed ? (
        <FeedArticles
          feed={openFeed}
          onBack={() => setOpenFeed(null)}
          onOpenArticle={(a) => onOpenArticle(a, openFeed)}
        />
      ) : (
        <FeedsSection onOpenFeed={setOpenFeed} />
      )}
    </div>
  );
}
