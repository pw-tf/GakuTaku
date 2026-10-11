import { appSql, col } from '../anki/appCollection';
import { useLive } from '../db/useLive';
import { Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { Heatmap, heatDayLabel } from './AnalyticsScreen';
import { loadReading, type ReadingDay } from './reading';

const fmtChars = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString());
const fmtTime = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : ms > 0 && min < 1 ? "<1m" : `${min}m`;
};
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

/** Analytics › Reading: chapters and articles finished, characters, time, words mined, books. */
export function ReadingTab() {
  const { data: r } = useLive(
    async () => loadReading(appSql, Date.now(), (await col.config()).rollover),
    [],
    ['reading_log', 'mined_words', 'documents', 'reading_positions'],
  );
  if (!r) return null;
  if (r.total.chapters + r.total.articles === 0) {
    return (
      <div className="empty-analytics">
        <Icon.reader s={40} />
        <h3>No reading recorded yet</h3>
        <p>Finish a chapter or a news article and it will show up here: chapters, characters read and reading time.</p>
      </div>
    );
  }
  const detail = (i: number) => {
    const d: ReadingDay = r.days[i];
    const label = heatDayLabel(i, r.days.length);
    if (!d.chapters && !d.articles) return `${label} · nothing read`;
    const what = [d.chapters && plural(d.chapters, 'chapter'), d.articles && plural(d.articles, 'article')].filter(Boolean).join(', ');
    return `${label} · ${what} · ${fmtChars(d.chars)} characters · ${fmtTime(d.ms)}`;
  };
  return (
    <>
      <div className="stat-row">
        <div className="stat"><div className="sv">{r.total.chapters.toLocaleString()}</div><div className="sl">Chapters read</div><div className="sk">{r.last30.chapters} in 30 days</div></div>
        <div className="stat"><div className="sv">{r.total.articles.toLocaleString()}</div><div className="sl">Articles read</div><div className="sk">{r.last30.articles} in 30 days</div></div>
        <div className="stat"><div className="sv">{fmtChars(r.total.chars)}</div><div className="sl">Characters read</div><div className="sk">{fmtChars(r.last30.chars)} in 30 days</div></div>
        <div className="stat"><div className="sv">{fmtTime(r.total.ms)}</div><div className="sl">Reading time</div><div className="sk">{r.minedTotal.toLocaleString()} words mined</div></div>
      </div>

      <div className="panel-row">
        <div className="apanel">
          <div className="ap-h"><h3>Reading activity</h3><Kicker>18 weeks</Kicker></div>
          <Heatmap levels={r.heatmap} detail={detail} />
        </div>
        <div className="apanel">
          <div className="ap-h"><h3>Books</h3><Kicker>{r.books.length}</Kicker></div>
          <div className="rd-books">
            {r.books.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No books in your library.</p>}
            {r.books.map((b) => (
              <div className="rd-book" key={b.id}>
                <span className="t" lang="ja">{b.title}</span>
                <span className="m">{plural(b.chapters, 'chapter')} · {b.percent}%</span>
                <div className="pr"><i style={{ width: `${b.percent}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
