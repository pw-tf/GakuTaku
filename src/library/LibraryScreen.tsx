import { useEffect, useMemo, useRef, useState } from 'react';
import { LOCAL_USER_ID } from '../app/localUser';
import { fileAccept } from '../app/platform';
import { Btn, Kicker, Spinner } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { importFile, useImporting } from '../import/runImport';
import { useDocuments, useReadingPositions } from '../db/hooks';
import type { DocumentRecord } from '../db/schema';
import { FeedsSection } from '../feeds/FeedsSection';
import { getCover } from '../reader/bookCache';
import { docKind, removeBook } from '../reader/addBook';
import { ConfirmModal } from '../ui/Modal';
import { useBackHandler } from '../app/back';
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

const BOOK_ACCEPT = '.epub,application/epub+zip,.pdf,application/pdf,.txt,text/plain,.apkg,.colpkg';

/** Object URLs for stored cover images, by document id (revoked on unmount). */
function useCovers(ids: string[]): Map<string, string> {
  const [covers, setCovers] = useState<Map<string, string>>(new Map());
  const key = ids.join(',');
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      const m = new Map<string, string>();
      for (const id of ids) {
        const blob = await getCover(id).catch(() => undefined);
        if (blob) {
          const url = URL.createObjectURL(blob);
          urls.push(url);
          m.set(id, url);
        }
      }
      if (!cancelled) setCovers(m);
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return covers;
}

interface Props {
  onOpenBook: (doc: DocumentRecord) => void;
  onOpenArticle: (article: FeedArticle, feed: FeedView) => void;
  due: number;
  dueLoading: boolean;
  streak: number;
}

export function LibraryScreen({ onOpenBook, onOpenArticle, due, dueLoading, streak }: Props) {
  const { data: docs } = useDocuments();
  const { data: positions } = useReadingPositions();
  const fileRef = useRef<HTMLInputElement>(null);
  // Progress lives in the global task store (BackgroundTasks banner) so it survives navigating away.
  const busy = useImporting();
  // Drill-down into one feed's article list (survives opening/closing the article overlay).
  const [openFeed, setOpenFeed] = useState<FeedView | null>(null);
  useBackHandler(openFeed != null, () => setOpenFeed(null));
  // The shelf shows one row until expanded, so a big library doesn't bury the Feeds section.
  const [showAllBooks, setShowAllBooks] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const cols = useGridColumns(gridRef, docs.length > 0);
  const visibleDocs = showAllBooks ? docs : docs.slice(0, cols);
  const hiddenCount = docs.length - visibleDocs.length;
  const covers = useCovers(docs.map((d) => d.id));
  const [removing, setRemoving] = useState<DocumentRecord | null>(null);

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
        <div className="daily">
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

      <div className="sec-bar">
        <h2>Your library</h2>
        <span className="count">{docs.length} {docs.length === 1 ? 'book' : 'books'}</span>
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
          {visibleDocs.map((b) => {
            const pct = pctById.get(b.id) ?? 0;
            const tone = toneFor(b.id);
            const cover = covers.get(b.id);
            const kind = docKind(b.type);
            return (
              <div className="bcard" key={b.id} onClick={() => onOpenBook(b)}>
                <div className="cv" style={{ background: `linear-gradient(160deg, ${tone}, color-mix(in oklch, ${tone} 70%, black))` }}>
                  {cover ? <img className="cover" src={cover} alt="" /> : <div className="ph"><div className="jt" lang="ja">{b.title}</div></div>}
                  <div className="spine" />
                  {kind !== 'epub' && <span className="kind">{kind.toUpperCase()}</span>}
                  <button className="bc-more" aria-label="Remove book" title="Remove book" onClick={(e) => { e.stopPropagation(); setRemoving(b); }}>
                    <Icon.trash s={14} />
                  </button>
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

      {removing && (
        <ConfirmModal
          title="Remove book?"
          message={`“${removing.title}” and your place in it will be removed from this device. Cards you mined from it stay.`}
          confirmLabel="Remove"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => removeBook(removing.id)}
        />
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
