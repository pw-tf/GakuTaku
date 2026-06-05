import { Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { useAnalytics } from './analyticsHooks';

/** Analytics dashboard (build plan M5) — computed live from the user's real review_logs + cards. */
export function AnalyticsScreen() {
  const s = useAnalytics();
  const heatColor = (n: number) =>
    n === 0 ? 'var(--paper-sunk)' : `color-mix(in oklch, var(--accent) ${18 + n * 20}%, var(--paper))`;
  const fcMax = Math.max(1, ...s.forecast.map((f) => f.n));
  const todMax = Math.max(1, ...s.tod);
  const matTotal = Math.max(1, s.mature + s.young + s.learning + s.newCards);

  // Nothing reviewed yet — charts would be misleading zeros, so show a gentle prompt instead.
  if (s.totalReviews === 0) {
    return (
      <div className="page">
        <div className="empty-analytics">
          <Icon.chart s={40} />
          <h3>No review history yet</h3>
          <p>Mine words while reading and review them — your retention, forecast, and activity stats will appear here.</p>
        </div>
      </div>
    );
  }
  const matSegs: [string, number, string][] = [
    ['Mature', s.mature, 'var(--ink-soft)'],
    ['Young', s.young, 'var(--sage)'],
    ['Learning', s.learning, 'var(--amber)'],
    ['New', s.newCards, 'var(--azure)'],
  ];

  return (
    <div className="page">
      <div className="stat-row">
        <div className="stat"><div className="sv">{s.retention}<span className="su">%</span></div><div className="sl">True retention</div></div>
        <div className="stat"><div className="sv">{s.reviewsToday}</div><div className="sl">Reviews today</div><div className="sk"><Icon.flame s={13} />{s.streak}-day streak</div></div>
        <div className="stat"><div className="sv">{s.minutesToday}<span className="su">min</span></div><div className="sl">Time today</div></div>
        <div className="stat"><div className="sv">{(matTotal / 1000).toFixed(1)}<span className="su">k</span></div><div className="sl">Cards total</div></div>
      </div>

      <div className="panel-row">
        <div className="apanel">
          <div className="ap-h"><h3>Upcoming reviews</h3><Kicker>Next 7 days</Kicker></div>
          <div className="fc-chart">
            {s.forecast.map((f, i) => (
              <div className="fc-col" key={i}>
                <div className="fc-bar" style={{ height: (f.n / fcMax) * 100 + '%' }}><span className="fc-n">{f.n}</span></div>
                <span className="fc-d">{f.d}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="apanel">
          <div className="ap-h"><h3>Card maturity</h3></div>
          <div className="mat-bar">
            {matSegs.map(([, v, c], i) => <i key={i} style={{ background: c, width: (v / matTotal) * 100 + '%' }} />)}
          </div>
          <div className="mat-legend">
            {matSegs.map(([l, v, c], i) => (
              <div className="ml" key={i}><span className="sw" style={{ background: c }} />{l}<span className="v">{v.toLocaleString()}</span></div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-row">
        <div className="apanel">
          <div className="ap-h"><h3>Review activity</h3><Kicker>18 weeks</Kicker></div>
          <div className="heat">
            {s.heatmap.map((n, i) => <div className="cell" key={i} style={{ background: heatColor(n) }} />)}
          </div>
          <div className="heat-legend" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            Less {[0, 1, 2, 3, 4].map((n) => <span className="cell" key={n} style={{ background: heatColor(n) }} />)} More
          </div>
        </div>
        <div className="apanel">
          <div className="ap-h"><h3>Time of day</h3><Kicker>Reviews / hour</Kicker></div>
          <div className="tod">
            {s.tod.map((v, i) => <div className="tb" key={i} style={{ height: Math.max((v / todMax) * 100, 3) + '%' }} />)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-faint)', marginTop: 8 }}>
            <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
          </div>
        </div>
      </div>
    </div>
  );
}
