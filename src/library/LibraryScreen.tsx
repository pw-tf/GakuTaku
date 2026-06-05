import { useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { useDocuments, useReadingPositions } from '../sync/hooks';
import type { DocumentRecord } from '../sync/AppSchema';
import { SAMPLE_FEEDS } from '../data/sample';

const TONES = ['#b8492f', '#5b6b58', '#3d5a6b', '#6b5b3d', '#7d4a86', '#3f5bb0', '#2f6b4f'];
function toneFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

interface Props {
  onOpenBook: (doc: DocumentRecord) => void;
  due: number;
  streak: number;
}

export function LibraryScreen({ onOpenBook, due, streak }: Props) {
  const { session } = useAuth();
  const { data: docs } = useDocuments();
  const { data: positions } = useReadingPositions();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

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
    setUploading(true);
    setError(null);
    setImportMsg(null);
    try {
      // Dynamic imports keep the heavy ePUB / Anki-import stacks out of the initial bundle.
      if (/\.apkg$/i.test(file.name)) {
        const { importApkgFile } = await import('../import');
        setImportMsg('Reading deck…');
        const s = await importApkgFile(file, session.user.id, (p) => {
          if (p.phase === 'mapping') setImportMsg('Reading collection…');
          else if (p.phase === 'writing') setImportMsg(`Importing cards… ${p.done ?? 0}/${p.total ?? 0}`);
          else if (p.phase === 'media') setImportMsg(`Uploading media… ${p.done ?? 0}/${p.total ?? 0}`);
        });
        const bits = [`${s.decks} deck${s.decks === 1 ? '' : 's'}`, `${s.cards} cards`];
        if (s.reviews) bits.push(`${s.reviews.toLocaleString()} reviews`);
        if (s.mediaFiles) bits.push(`${s.mediaFiles} media`);
        setImportMsg(`Imported ${bits.join(', ')}.`);
      } else {
        const { uploadEpub } = await import('../reader/uploadEpub');
        await uploadEpub(file, session.user.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
      setImportMsg(null);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
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
              <Btn variant="primary" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                <Icon.upload s={15} /> Upload ePUB
              </Btn>
            )}
          </div>
        </div>
        <div className="daily">
          <div>
            <Kicker accent>Today</Kicker>
            <div className="big-num">{due}<span className="u">due</span></div>
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
          <Btn size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Icon.upload s={15} /> {uploading ? 'Working…' : 'Upload ePUB / Anki deck'}
          </Btn>
        </span>
      </div>
      {error && <p style={{ color: 'var(--rate-again)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {importMsg && <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginBottom: 12 }}>{importMsg}</p>}

      {docs.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>No books yet. Upload a Japanese ePUB to start reading.</p>
      ) : (
        <div className="book-grid">
          {docs.map((b) => {
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

      <div className="sec-bar" style={{ marginTop: 40 }}>
        <h2>Feeds</h2>
        <span className="count">articles</span>
        <span className="more"><Btn size="sm" disabled title="Coming in M7"><Icon.plus s={15} /> Add feed</Btn></span>
      </div>
      <div className="feed-list">
        {SAMPLE_FEEDS.map((f) => (
          <div className="feed-row" key={f.id}>
            <div className="fic"><Icon.rss s={18} /></div>
            <div className="fmeta">
              <div className="ft" lang="ja">
                {f.title} <Chip>{f.level}</Chip> {f.unread > 0 && <Chip accent>{f.unread} new</Chip>}
              </div>
              <div className="fl" lang="ja">{f.latest}</div>
            </div>
            <div className="ftime" lang="ja">{f.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
