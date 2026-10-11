import { useEffect, useMemo, useState } from 'react';
import { useReadingPositions } from '../db/hooks';
import type { DocumentRecord } from '../db/schema';
import { getCover } from '../reader/bookCache';
import { docKind } from '../reader/addBook';
import { Icon } from '../ui/icons';

/** Book files and Anki packages the Add file button takes. */
export const BOOK_ACCEPT = '.epub,application/epub+zip,.pdf,application/pdf,.txt,text/plain,.apkg,.colpkg';

const TONES = ['#b8492f', '#5b6b58', '#3d5a6b', '#6b5b3d', '#7d4a86', '#3f5bb0', '#2f6b4f'];
function toneFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

/**
 * How many cards fit on one row of a CSS grid. `grid-template-columns` computes to an explicit
 * list of pixel tracks, so counting them is exact — no need to mirror the `minmax()`/`gap` values
 * from the stylesheet (which the mobile breakpoint overrides anyway).
 */
export function useGridColumns(ref: React.RefObject<HTMLElement>, enabled: boolean): number {
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

/** Object URLs for stored cover images, by document id (revoked on unmount). */
export function useCovers(ids: string[]): Map<string, string> {
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

/** Reading progress (percent) and last-read time per document. */
export function useProgress() {
  const { data: positions } = useReadingPositions();
  return useMemo(() => {
    const pct = new Map<string, number>();
    const readAt = new Map<string, string>();
    for (const p of positions) {
      pct.set(p.document_id, p.percent ?? 0);
      if (p.updated_at) readAt.set(p.document_id, p.updated_at);
    }
    return { pct, readAt };
  }, [positions]);
}

/** One book on a shelf: cover (or a tinted placeholder), title and progress. */
export function BookCard({ doc, pct, cover, onOpen, onMore }: { doc: DocumentRecord; pct: number; cover?: string; onOpen: () => void; onMore?: () => void }) {
  const tone = toneFor(doc.id);
  const kind = docKind(doc.type);
  return (
    <div className="bcard" onClick={onOpen}>
      <div className="cv" style={{ background: `linear-gradient(160deg, ${tone}, color-mix(in oklch, ${tone} 70%, black))` }}>
        {cover ? <img className="cover" src={cover} alt="" /> : <div className="ph"><div className="jt" lang="ja">{doc.title}</div></div>}
        <div className="spine" />
        {kind !== 'epub' && <span className="kind">{kind.toUpperCase()}</span>}
        {onMore && (
          <button className="bc-more" aria-label="Book options" title="Categories and removal" onClick={(e) => { e.stopPropagation(); onMore(); }}>
            <Icon.more s={16} w={3} />
          </button>
        )}
        {pct > 0 && <div className="pct"><i style={{ width: pct + '%' }} /></div>}
      </div>
      <button type="button" className="bt" lang="ja">{doc.title}</button>
      <div className="ba">{pct > 0 ? pct + '%' : 'New'}</div>
    </div>
  );
}
