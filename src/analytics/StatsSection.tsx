import { useMemo, useState } from 'react';
import { appSql, col } from '../anki/appCollection';
import { useLive } from '../db/useLive';
import { loadStats, type Bucket, type Histogram, type StatsData, type StatsPeriod } from './stats';

/**
 * Anki's Statistics screen, below the dashboard: a deck and period picker, then today, reviews,
 * future due, card counts, intervals, ease or FSRS memory, hourly breakdown, answer buttons and
 * cards added. Bars are tappable: the readout above each chart shows the tapped bar's numbers.
 */

const PERIODS: [StatsPeriod, string][] = [[30, '1 month'], [90, '3 months'], [365, '1 year'], [0, 'All']];

const KIND_ORDER = ['learn', 'relearn', 'young', 'mature', 'filtered'] as const;
const KIND_NAMES: Record<(typeof KIND_ORDER)[number], string> = { learn: 'Learning', relearn: 'Relearning', young: 'Young', mature: 'Mature', filtered: 'Filtered' };

const fmtDay = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const bucketLabel = (b: Bucket) =>
  b.days === 1 ? (b.start === 0 ? 'Today' : b.start === 1 ? 'Tomorrow' : b.start === -1 ? 'Yesterday' : fmtDay(b.start)) : `${fmtDay(b.start)} – ${fmtDay(b.start + b.days - 1)}`;
const minutes = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

export function StatsSection() {
  const [deckId, setDeckId] = useState<number | null>(null);
  const [period, setPeriod] = useState<StatsPeriod>(30);
  const { data: decks } = useLive(() => col.decks(), [], ['decks']);
  const deckIds = useMemo(() => {
    if (deckId == null || !decks) return null;
    const root = decks.find((d) => d.id === deckId);
    return root ? decks.filter((d) => d.id === deckId || d.name.toLowerCase().startsWith(root.name.toLowerCase() + '::')).map((d) => d.id) : null;
  }, [deckId, decks]);
  const { data: s } = useLive(
    async () => loadStats(appSql, { deckIds, period }, Date.now(), (await col.config()).rollover),
    [deckIds?.join(','), period],
    ['revlog', 'cards', 'decks'],
    { deferWhileStudying: true },
  );

  return (
    <div className="stats">
      <div className="stats-bar">
        <h2>Statistics</h2>
        <select aria-label="Deck" value={deckId ?? ''} onChange={(e) => setDeckId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">All decks</option>
          {(decks ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="density-seg stats-period">
          {PERIODS.map(([p, label]) => (
            <div key={p} className={'d' + (period === p ? ' on' : '')} onClick={() => setPeriod(p)}>{label}</div>
          ))}
        </div>
      </div>
      {!s ? null : <StatsBody s={s} />}
    </div>
  );
}

function StatsBody({ s }: { s: StatsData }) {
  const [revMode, setRevMode] = useState<'count' | 'time'>('count');
  const [memTab, setMemTab] = useState<'difficulty' | 'stability' | 'retrievability'>('retrievability');
  const t = s.today;
  const studiedDays = s.reviews.filter((b) => KIND_ORDER.some((k) => b[k] > 0)).length;
  const totalReviews = s.reviews.reduce((x, b) => x + KIND_ORDER.reduce((y, k) => y + b[k], 0), 0);
  const totalMs = s.reviews.reduce((x, b) => x + KIND_ORDER.reduce((y, k) => y + b.ms[k], 0), 0);
  const days = s.reviews.length * (s.reviews[0]?.days ?? 1);
  const c = s.counts;
  const countSegs: [string, number, string][] = [
    ['New', c.new, 'var(--s-new)'],
    ['Learning', c.learning, 'var(--s-learn)'],
    ['Relearning', c.relearning, 'var(--s-relearn)'],
    ['Young', c.young, 'var(--s-young)'],
    ['Mature', c.mature, 'var(--s-mature)'],
    ['Suspended', c.suspended, 'var(--s-susp)'],
    ['Buried', c.buried, 'var(--s-buried)'],
  ];
  const countTotal = countSegs.reduce((x, [, v]) => x + v, 0);
  const memory: Record<typeof memTab, Histogram | null> = { difficulty: s.difficulty, stability: s.stability, retrievability: s.retrievability };
  const peakHour = s.hours.reduce((best, h, i) => (h.total > (s.hours[best]?.total ?? 0) ? i : best), 0);

  return (
    <div className="stats-grid">
      <div className="apanel">
        <div className="ap-h"><h3>Today</h3></div>
        {t.reviews === 0 ? (
          <p className="stats-text">No cards have been studied today.</p>
        ) : (
          <p className="stats-text">
            Studied <b>{t.reviews.toLocaleString()}</b> cards in <b>{t.minutes}</b> minutes today ({t.secondsPerCard}s/card).
            <br />Again: <b>{t.again}</b> ({pct(t.reviews - t.again, t.reviews)} correct).
            <br />Learn {t.learn} · Review {t.review} · Relearn {t.relearn} · Filtered {t.filtered}.
            {t.matureTotal > 0 && <><br />Mature cards: {t.matureCorrect} of {t.matureTotal} correct ({pct(t.matureCorrect, t.matureTotal)}).</>}
          </p>
        )}
      </div>

      <div className="apanel">
        <div className="ap-h">
          <h3>Reviews</h3>
          <div className="density-seg mini">
            <div className={'d' + (revMode === 'count' ? ' on' : '')} onClick={() => setRevMode('count')}>Count</div>
            <div className={'d' + (revMode === 'time' ? ' on' : '')} onClick={() => setRevMode('time')}>Time</div>
          </div>
        </div>
        <BarChart
          bars={s.reviews.map((b) => ({ label: bucketLabel(b), values: KIND_ORDER.map((k) => (revMode === 'count' ? b[k] : b.ms[k])) }))}
          series={KIND_ORDER.map((k) => ({ name: KIND_NAMES[k], color: `var(--s-${k})` }))}
          format={revMode === 'count' ? (n) => n.toLocaleString() : minutes}
        />
        <p className="stats-foot">
          Studied on {studiedDays} of {days} days · {totalReviews.toLocaleString()} reviews in {minutes(totalMs)} · {(totalReviews / Math.max(1, days)).toFixed(1)} a day
        </p>
      </div>

      <div className="apanel">
        <div className="ap-h"><h3>Future due</h3></div>
        <BarChart bars={s.forecast.map((b) => ({ label: bucketLabel(b), values: [b.n] }))} series={[{ name: 'Due', color: 'var(--s-learn)' }]} />
        <p className="stats-foot">
          Due tomorrow: {(s.forecast[0]?.days === 1 ? s.forecast[1]?.n : undefined)?.toLocaleString() ?? '—'} · total {s.forecast.reduce((x, b) => x + b.n, 0).toLocaleString()} (overdue cards count today)
        </p>
      </div>

      <div className="apanel">
        <div className="ap-h"><h3>Card counts</h3></div>
        <div className="mat-bar">
          {countSegs.map(([, v, col], i) => <i key={i} style={{ background: col, width: (v / Math.max(1, countTotal)) * 100 + '%' }} />)}
        </div>
        <div className="mat-legend">
          {countSegs.map(([l, v, col]) => (
            <div className="ml" key={l}><span className="sw" style={{ background: col }} />{l}<span className="v">{v.toLocaleString()} · {pct(v, countTotal)}</span></div>
          ))}
        </div>
      </div>

      <div className="apanel">
        <div className="ap-h"><h3>Review intervals</h3></div>
        <BarChart bars={s.intervals.labels.map((l, i) => ({ label: l, values: [s.intervals.counts[i]] }))} series={[{ name: 'Cards', color: 'var(--s-young)' }]} axisLabels />
      </div>

      {s.ease && (
        <div className="apanel">
          <div className="ap-h"><h3>Card ease</h3></div>
          <BarChart bars={s.ease.labels.map((l, i) => ({ label: l, values: [s.ease!.counts[i]] }))} series={[{ name: 'Cards', color: 'var(--s-mature)' }]} axisLabels />
        </div>
      )}
      {s.retrievability && (
        <div className="apanel">
          <div className="ap-h">
            <h3>Memory (FSRS)</h3>
            <div className="density-seg mini">
              {(['retrievability', 'stability', 'difficulty'] as const).map((k) => (
                <div key={k} className={'d' + (memTab === k ? ' on' : '')} onClick={() => setMemTab(k)}>{k[0].toUpperCase() + k.slice(1)}</div>
              ))}
            </div>
          </div>
          {memory[memTab] && (
            <BarChart bars={memory[memTab]!.labels.map((l, i) => ({ label: l, values: [memory[memTab]!.counts[i]] }))} series={[{ name: 'Cards', color: 'var(--s-mature)' }]} axisLabels />
          )}
        </div>
      )}

      <div className="apanel">
        <div className="ap-h"><h3>Hourly breakdown</h3></div>
        <BarChart
          bars={s.hours.map((h, i) => ({ label: `${String(i).padStart(2, '0')}:00`, values: [h.total], note: h.total ? `${pct(h.correct, h.total)} correct` : undefined }))}
          series={[{ name: 'Reviews', color: 'var(--s-learn)' }]}
        />
        <p className="stats-foot">
          {s.hours[peakHour]?.total ? `Most reviews around ${String(peakHour).padStart(2, '0')}:00 (${pct(s.hours[peakHour].correct, s.hours[peakHour].total)} correct). Tap a bar for its success rate.` : 'No reviews in this period.'}
        </p>
      </div>

      <div className="apanel">
        <div className="ap-h"><h3>Answer buttons</h3></div>
        <div className="btn-groups">
          {(['learning', 'young', 'mature'] as const).map((g) => {
            const v = s.buttons[g];
            const total = v.reduce((x, y) => x + y, 0);
            return (
              <div key={g} className="btn-group">
                <div className="bg-h">{g[0].toUpperCase() + g.slice(1)} <span className="muted">{pct(total - v[0], total)} correct</span></div>
                <div className="bg-bars">
                  {['Again', 'Hard', 'Good', 'Easy'].map((name, i) => (
                    <div key={name} className="bg-row">
                      <span className="bg-l">{name}</span>
                      <span className="bg-track"><i style={{ width: (v[i] / Math.max(1, total)) * 100 + '%', background: `var(--rate-${name.toLowerCase()})` }} /></span>
                      <span className="bg-v">{v[i].toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="apanel">
        <div className="ap-h"><h3>Added</h3></div>
        <BarChart bars={s.added.map((b) => ({ label: bucketLabel(b), values: [b.n] }))} series={[{ name: 'Cards added', color: 'var(--s-new)' }]} />
        <p className="stats-foot">{s.added.reduce((x, b) => x + b.n, 0).toLocaleString()} cards added in this period</p>
      </div>
    </div>
  );
}

interface Bar {
  label: string;
  values: number[];
  note?: string;
}

/** Vertical bars (stacked when there are several series), with a tap readout and a legend. */
function BarChart({ bars, series, format = (n) => n.toLocaleString(), axisLabels }: { bars: Bar[]; series: { name: string; color: string }[]; format?: (n: number) => string; axisLabels?: boolean }) {
  const [sel, setSel] = useState<number | null>(null);
  const totals = bars.map((b) => b.values.reduce((x, y) => x + y, 0));
  const max = Math.max(1, ...totals);
  const picked = sel != null ? bars[sel] : null;
  const seriesTotals = series.map((_, i) => bars.reduce((x, b) => x + (b.values[i] ?? 0), 0));
  return (
    <div className="bchart">
      <div className="bc-readout">
        {picked ? (
          <>
            <b>{picked.label}</b>: {format(totals[sel!])}
            {series.length > 1 && totals[sel!] > 0 && <> — {series.map((sr, i) => (picked.values[i] ? `${sr.name} ${format(picked.values[i])}` : null)).filter(Boolean).join(' · ')}</>}
            {picked.note && <> · {picked.note}</>}
          </>
        ) : (
          <span className="muted">Tap a bar for details</span>
        )}
      </div>
      <div className="bc-plot" role="img" aria-label={`Bar chart: ${series.map((s) => s.name).join(', ')}`}>
        {bars.map((b, i) => (
          <button key={i} className={'bc-col' + (sel === i ? ' on' : '')} onClick={() => setSel(sel === i ? null : i)} aria-label={`${b.label}: ${format(totals[i])}`}>
            <span className="bc-stack" style={{ height: (totals[i] / max) * 100 + '%' }}>
              {b.values.map((v, j) => (v > 0 ? <i key={j} style={{ flexGrow: v, background: series[j].color }} /> : null)).reverse()}
            </span>
          </button>
        ))}
      </div>
      <div className="bc-axis">
        {axisLabels ? (
          bars.map((b, i) => <span key={i}>{b.label}</span>)
        ) : (
          <>
            <span>{bars[0]?.label}</span>
            <span>{bars[bars.length - 1]?.label}</span>
          </>
        )}
      </div>
      {series.length > 1 && (
        <div className="mat-legend bc-legend">
          {series.map((sr, i) => (
            <div className="ml" key={sr.name}><span className="sw" style={{ background: sr.color }} />{sr.name}<span className="v">{format(seriesTotals[i])}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}
