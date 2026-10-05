import type { Sql } from '../anki/collection';
import { prepareParameters, retrievability } from '../anki/fsrs';
import { timingAt } from '../anki/timing';
import { normalizeDeckConfig } from '../anki/types';

/**
 * Anki's Statistics screen (ts/routes/graphs): today, reviews, future due, card counts, intervals,
 * ease or FSRS difficulty/stability/retrievability, hourly breakdown, answer buttons and cards
 * added — for the whole collection or one deck (with subdecks), over a chosen period. Each graph is
 * one SQL aggregate; days are study days (they start at the rollover hour).
 */

export type StatsPeriod = 30 | 90 | 365 | 0; // 0 = deck life

export interface Bucket {
  /** Start of the bucket in days relative to today (0 = today, negative = past). */
  start: number;
  /** Length in days. */
  days: number;
}

export interface ReviewBucket extends Bucket {
  learn: number;
  young: number;
  mature: number;
  relearn: number;
  filtered: number;
  /** Milliseconds spent, same split. */
  ms: { learn: number; young: number; mature: number; relearn: number; filtered: number };
}

export interface Histogram {
  labels: string[];
  counts: number[];
}

export interface StatsData {
  today: { reviews: number; minutes: number; secondsPerCard: number; again: number; learn: number; review: number; relearn: number; filtered: number; matureCorrect: number; matureTotal: number };
  reviews: ReviewBucket[];
  forecast: (Bucket & { n: number })[];
  counts: { new: number; learning: number; relearning: number; young: number; mature: number; suspended: number; buried: number };
  intervals: Histogram;
  ease: Histogram | null;
  difficulty: Histogram | null;
  stability: Histogram | null;
  retrievability: Histogram | null;
  hours: { total: number; correct: number }[];
  buttons: Record<'learning' | 'young' | 'mature', [number, number, number, number]>;
  added: (Bucket & { n: number })[];
  /** Days covered by the past graphs (the period, or how far the history goes back). */
  spanDays: number;
}

const REVIEW_KINDS = ['learn', 'young', 'mature', 'relearn', 'filtered'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Bucket size for a span: days up to a month, weeks up to a year, then months. */
export function bucketDays(spanDays: number): number {
  return spanDays <= 31 ? 1 : spanDays <= 366 ? 7 : 30;
}

const INTERVAL_EDGES = [1, 2, 3, 4, 5, 6, 7, 8, 15, 22, 31, 61, 91, 181, 366, 731];
const intervalLabel = (i: number) => {
  const lo = INTERVAL_EDGES[i];
  const hi = INTERVAL_EDGES[i + 1];
  if (hi == null) return '2y+';
  if (hi - lo === 1) return `${lo}d`;
  const fmt = (d: number) => (d >= 365 ? `${Math.round(d / 365)}y` : d >= 30 ? `${Math.round(d / 30)}mo` : `${d}d`);
  return `${fmt(lo)}–${fmt(hi - 1)}`;
};

function histogram(values: number[], edges: number[], label: (i: number) => string): Histogram {
  const counts = new Array<number>(edges.length).fill(0);
  for (const v of values) {
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i--;
    if (v >= edges[0]) counts[i]++;
  }
  return { labels: edges.map((_, i) => label(i)), counts };
}

/** Percent histogram in 10-point bins (0–9 % … 90–100 %). */
function percentHistogram(values: number[]): Histogram {
  const counts = new Array<number>(10).fill(0);
  for (const v of values) counts[Math.min(9, Math.max(0, Math.floor(v * 10)))]++;
  return { labels: counts.map((_, i) => `${i * 10}%`), counts };
}

export async function loadStats(sql: Sql, opts: { deckIds: number[] | null; period: StatsPeriod }, nowMs: number, rollover: number): Promise<StatsData> {
  const t = timingAt(nowMs, rollover);
  const endMs = t.nextDayAt * 1000; // end of today
  const deckCards = opts.deckIds ? `(did IN (${opts.deckIds.join(',') || 'NULL'}) OR odid IN (${opts.deckIds.join(',') || 'NULL'}))` : '1';
  const inDeck = opts.deckIds ? `AND cid IN (SELECT id FROM cards WHERE ${deckCards})` : '';

  // How far back the graphs go: the period, or (deck life) back to the first review.
  let spanDays: number = opts.period;
  if (!spanDays) {
    const [first] = await sql.all<{ m: number | null }>(`SELECT MIN(id) AS m FROM revlog WHERE ease > 0 ${inDeck}`);
    spanDays = first?.m != null ? Math.max(1, Math.floor((endMs - 1 - first.m) / 86_400_000) + 1) : 30;
  }
  const size = bucketDays(spanDays);
  const nBuckets = Math.max(1, Math.ceil(spanDays / size));
  const startMs = endMs - nBuckets * size * 86_400_000;
  /** Days ago (0 = today) of a ms timestamp before the end of today, as SQL. */
  const daysAgo = (col: string) => `((${endMs} - 1 - ${col}) / 86400000)`;

  // ---- today -------------------------------------------------------------------------------
  const [td] = await sql.all<{ n: number; ms: number; again: number; learn: number; review: number; relearn: number; filtered: number; mt: number; mc: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(time), 0) AS ms, SUM(ease = 1) AS again,
       SUM(type = 0) AS learn, SUM(type = 1) AS review, SUM(type = 2) AS relearn, SUM(type = 3) AS filtered,
       SUM(type = 1 AND lastIvl >= 21) AS mt, SUM(type = 1 AND lastIvl >= 21 AND ease > 1) AS mc
     FROM revlog WHERE id >= ? AND ease > 0 ${inDeck}`,
    [endMs - 86_400_000],
  );

  // ---- reviews per bucket, by kind ----------------------------------------------------------
  const revRows = await sql.all<{ d: number; type: number; mature: number; n: number; ms: number }>(
    `SELECT ${daysAgo('id')} AS d, type, lastIvl >= 21 AS mature, COUNT(*) AS n, COALESCE(SUM(time), 0) AS ms
     FROM revlog WHERE id >= ? AND id < ? AND ease > 0 AND type IN (0, 1, 2, 3) ${inDeck} GROUP BY d, type, mature`,
    [startMs, endMs],
  );
  const reviews: ReviewBucket[] = Array.from({ length: nBuckets }, (_, i) => ({
    start: -(nBuckets - i) * size + 1,
    days: size,
    learn: 0, young: 0, mature: 0, relearn: 0, filtered: 0,
    ms: { learn: 0, young: 0, mature: 0, relearn: 0, filtered: 0 },
  }));
  for (const r of revRows) {
    const b = reviews[nBuckets - 1 - Math.floor(r.d / size)];
    if (!b) continue;
    const kind: ReviewKind = r.type === 0 ? 'learn' : r.type === 2 ? 'relearn' : r.type === 3 ? 'filtered' : r.mature ? 'mature' : 'young';
    b[kind] += r.n;
    b.ms[kind] += r.ms;
  }

  // ---- future due ------------------------------------------------------------------------------
  const horizon = opts.period || 365;
  const fSize = bucketDays(horizon);
  const fBuckets = Math.max(1, Math.ceil(horizon / fSize));
  const dueRows = await sql.all<{ d: number; n: number }>(
    `SELECT MAX(0, (CASE WHEN odid != 0 AND odue != 0 THEN odue ELSE due END) - ?1) AS d, COUNT(*) AS n
     FROM cards WHERE queue IN (2, 3) AND ${deckCards} GROUP BY d HAVING d < ?2`,
    [t.today, fBuckets * fSize],
  );
  const [lrn] = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cards WHERE queue IN (1, 4) AND ${deckCards}`);
  const forecast = Array.from({ length: fBuckets }, (_, i) => ({ start: i * fSize, days: fSize, n: i === 0 ? lrn.n : 0 }));
  for (const r of dueRows) forecast[Math.floor(r.d / fSize)].n += r.n;

  // ---- card counts -----------------------------------------------------------------------------
  const [cc] = await sql.all<Record<string, number | null>>(
    `SELECT SUM(type = 0 AND queue >= 0) AS new, SUM(type = 1 AND queue >= 0) AS learning, SUM(type = 3 AND queue >= 0) AS relearning,
       SUM(type = 2 AND queue >= 0 AND ivl < 21) AS young, SUM(type = 2 AND queue >= 0 AND ivl >= 21) AS mature,
       SUM(queue = -1) AS suspended, SUM(queue IN (-2, -3)) AS buried
     FROM cards WHERE ${deckCards}`,
  );
  const counts = {
    new: cc.new ?? 0, learning: cc.learning ?? 0, relearning: cc.relearning ?? 0, young: cc.young ?? 0,
    mature: cc.mature ?? 0, suspended: cc.suspended ?? 0, buried: cc.buried ?? 0,
  };

  // ---- intervals, ease, memory state ---------------------------------------------------------------
  const mem = await sql.all<{ ivl: number; factor: number; stability: number | null; difficulty: number | null; last_review: number | null; conf: string | null }>(
    `SELECT c.ivl, c.factor, c.stability, c.difficulty, c.last_review, dc.config AS conf
     FROM cards c LEFT JOIN decks d ON d.id = (CASE WHEN c.odid != 0 THEN c.odid ELSE c.did END) LEFT JOIN deck_config dc ON dc.id = d.conf_id
     WHERE c.type IN (2, 3) AND c.queue >= -3 AND ${deckCards.replace(/\b(did|odid)\b/g, 'c.$1')}`,
  );
  const intervals = histogram(mem.map((m) => m.ivl), INTERVAL_EDGES, intervalLabel);
  const withFsrs = mem.filter((m) => m.stability != null && m.difficulty != null);
  const fsrs = withFsrs.length > 0 && withFsrs.length >= mem.length / 2;
  const easeEdges = [1.3, 1.5, 1.7, 1.9, 2.1, 2.3, 2.5, 2.7, 2.9, 3.1];
  const ease = !fsrs && mem.length ? histogram(mem.filter((m) => m.factor > 0).map((m) => m.factor / 1000), easeEdges, (i) => (i === easeEdges.length - 1 ? `${Math.round(easeEdges[i] * 100)}%+` : `${Math.round(easeEdges[i] * 100)}%`)) : null;
  let difficulty: Histogram | null = null;
  let stability: Histogram | null = null;
  let retr: Histogram | null = null;
  if (fsrs) {
    difficulty = percentHistogram(withFsrs.map((m) => (m.difficulty! - 1) / 9));
    stability = histogram(withFsrs.map((m) => m.stability!), INTERVAL_EDGES, intervalLabel);
    const params = new Map<string, number[]>();
    const rs: number[] = [];
    for (const m of withFsrs) {
      if (m.last_review == null) continue;
      const key = m.conf ?? '';
      let w = params.get(key);
      if (!w) {
        let cfg = normalizeDeckConfig(null);
        try {
          cfg = normalizeDeckConfig(m.conf ? JSON.parse(m.conf) : null);
        } catch {
          /* default preset */
        }
        w = prepareParameters(cfg.fsrsParams);
        params.set(key, w);
      }
      rs.push(retrievability(w, { stability: m.stability!, difficulty: m.difficulty! }, Math.max(0, (t.now - m.last_review) / 86_400)));
    }
    retr = percentHistogram(rs);
  }

  // ---- hourly breakdown (local time) and answer buttons, over the period ----------------------------
  const offsetSecs = -new Date(nowMs).getTimezoneOffset() * 60;
  const hourRows = await sql.all<{ h: number; n: number; ok: number }>(
    `SELECT ((id / 1000 + ?) / 3600) % 24 AS h, COUNT(*) AS n, SUM(ease > 1) AS ok FROM revlog
     WHERE id >= ? AND ease > 0 AND type IN (0, 1, 2, 3) ${inDeck} GROUP BY h`,
    [offsetSecs, startMs],
  );
  const hours = Array.from({ length: 24 }, () => ({ total: 0, correct: 0 }));
  for (const r of hourRows) hours[((r.h % 24) + 24) % 24] = { total: r.n, correct: r.ok ?? 0 };

  const btnRows = await sql.all<{ g: string; ease: number; n: number }>(
    `SELECT CASE WHEN type IN (0, 2) THEN 'learning' WHEN lastIvl < 21 THEN 'young' ELSE 'mature' END AS g, ease, COUNT(*) AS n
     FROM revlog WHERE id >= ? AND ease BETWEEN 1 AND 4 AND type IN (0, 1, 2, 3) ${inDeck} GROUP BY g, ease`,
    [startMs],
  );
  const buttons: StatsData['buttons'] = { learning: [0, 0, 0, 0], young: [0, 0, 0, 0], mature: [0, 0, 0, 0] };
  for (const r of btnRows) buttons[r.g as keyof typeof buttons][r.ease - 1] = r.n;

  // ---- cards added ----------------------------------------------------------------------------------
  const addRows = await sql.all<{ d: number; n: number }>(
    `SELECT ${daysAgo('id')} AS d, COUNT(*) AS n FROM cards WHERE id >= ? AND id < ? AND ${deckCards} GROUP BY d`,
    [startMs, endMs],
  );
  const added = Array.from({ length: nBuckets }, (_, i) => ({ start: -(nBuckets - i) * size + 1, days: size, n: 0 }));
  for (const r of addRows) {
    const b = added[nBuckets - 1 - Math.floor(r.d / size)];
    if (b) b.n += r.n;
  }

  return {
    today: {
      reviews: td.n, minutes: Math.round(td.ms / 60_000), secondsPerCard: td.n ? Math.round(td.ms / td.n / 100) / 10 : 0, again: td.again ?? 0, learn: td.learn ?? 0, review: td.review ?? 0,
      relearn: td.relearn ?? 0, filtered: td.filtered ?? 0, matureCorrect: td.mc ?? 0, matureTotal: td.mt ?? 0,
    },
    reviews,
    forecast,
    counts,
    intervals,
    ease,
    difficulty,
    stability,
    retrievability: retr,
    hours,
    buttons,
    added,
    spanDays,
  };
}

export { REVIEW_KINDS };
