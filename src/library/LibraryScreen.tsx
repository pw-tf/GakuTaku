import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { SAMPLE_BOOKS, SAMPLE_FEEDS, type SampleBook } from '../data/sample';

interface Props {
  onOpenBook: (book: SampleBook) => void;
  due: number;
  streak: number;
}

/** Library/Home. Books & feeds are sample data until M3 (ePUB upload) / M7 (RSS). */
export function LibraryScreen({ onOpenBook, due, streak }: Props) {
  const cont = SAMPLE_BOOKS.find((b) => b.current) ?? SAMPLE_BOOKS[0];

  return (
    <div className="page">
      <div className="lib-hero">
        <div className="cont-card" onClick={() => onOpenBook(cont)} style={{ cursor: 'pointer' }}>
          <div className="cc-cover"><div className="sp" /></div>
          <div className="cc-meta">
            <div className="k">Continue reading · {cont.chapter}</div>
            <div className="t" lang="ja">{cont.title}</div>
            <div className="a" lang="ja">{cont.author} · {cont.romaji}</div>
            <div className="pr"><i style={{ width: cont.pct + '%' }} /></div>
            <Btn variant="primary" size="sm">Resume at {cont.pct}% <Icon.chevR s={15} /></Btn>
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
        <span className="count">{SAMPLE_BOOKS.length} books</span>
        <span className="more"><Btn size="sm" disabled title="Coming in M3"><Icon.upload s={15} /> Upload ePUB</Btn></span>
      </div>
      <div className="book-grid">
        {SAMPLE_BOOKS.map((b) => (
          <div className="bcard" key={b.id} onClick={() => onOpenBook(b)}>
            <div className="cv" style={{ background: `linear-gradient(160deg, ${b.tone}, color-mix(in oklch, ${b.tone} 70%, black))` }}>
              <div className="spine" />
              <div className="ph"><div className="jt" lang="ja">{b.title}</div></div>
              {b.pct > 0 && <div className="pct"><i style={{ width: b.pct + '%' }} /></div>}
            </div>
            <div className="bt" lang="ja">{b.title}</div>
            <div className="ba" lang="ja">{b.author} · {b.pct > 0 ? b.pct + '%' : 'New'}</div>
          </div>
        ))}
      </div>

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
