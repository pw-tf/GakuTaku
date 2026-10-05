import type { Sql } from '../anki/collection';
import { timingAt } from '../anki/timing';

/**
 * The analytics dashboard's numbers, computed with SQL aggregates over Anki's `revlog` and `cards`
 * (so a collection with hundreds of thousands of reviews stays fast). Definitions follow Anki's
 * statistics screen: "true retention" counts only reviews of review cards (revlog type 1), a card
 * is mature at an interval of 21 days, and days are study days (they start at the rollover hour).
 */

export const HEATMAP_WEEKS = 18;
export const HEATMAP_DAYS = HEATMAP_WEEKS * 7;
const FORECAST_DAYS = 7;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface AnalyticsData {
  /** True retention over the last 30 days, %, or null with no reviews of review cards. */
  retention: number | null;
  streak: number;
  reviewsToday: number;
  minutesToday: number;
  mature: number;
  young: number;
  learning: number;
  newCards: number;
  suspended: number;
  forecast: { d: string; n: number }[];
  /** HEATMAP_DAYS cells (oldest first), intensity 0–4. */
  heatmap: number[];
  /** Reviews per hour of day. */
  tod: number[];
  totalReviews: number;
  totalCards: number;
}

/** Study-day number of a revlog id (ms), matching {@link timingAt}'s day numbering. */
function studyDayOf(ms: number, rollover: number): number {
  return timingAt(ms, rollover).today;
}

export async function loadAnalytics(sql: Sql, nowMs: number, rollover: number): Promise<AnalyticsData> {
  const t = timingAt(nowMs, rollover);
  const dayStartMs = (t.nextDayAt - 86_400) * 1000;
  const heatStartMs = dayStartMs - (HEATMAP_DAYS - 1) * 86_400_000;

  const [cards] = await sql.all<{ total: number; newc: number; learning: number; young: number; mature: number; suspended: number }>(
    `SELECT COUNT(*) AS total,
       SUM(type = 0 AND queue >= 0) AS newc,
       SUM(type IN (1, 3) AND queue >= 0) AS learning,
       SUM(type = 2 AND queue >= 0 AND ivl < 21) AS young,
       SUM(type = 2 AND queue >= 0 AND ivl >= 21) AS mature,
       SUM(queue = -1) AS suspended
     FROM cards`,
  );
  const [today] = await sql.all<{ n: number; ms: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(time), 0) AS ms FROM revlog WHERE id >= ? AND ease > 0`, [dayStartMs]);
  const [ret] = await sql.all<{ total: number; passed: number }>(
    `SELECT COUNT(*) AS total, SUM(ease > 1) AS passed FROM revlog WHERE type = 1 AND ease > 0 AND id >= ?`,
    [dayStartMs - 29 * 86_400_000],
  );
  const [{ n: totalReviews }] = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM revlog WHERE ease > 0`);

  // Forecast: reviews (and interday learning) due over the next week; today includes overdue.
  const due = await sql.all<{ day: number; n: number }>(
    `SELECT MAX(due, ?1) AS day, COUNT(*) AS n FROM cards WHERE queue IN (2, 3) AND due < ?1 + ?2 GROUP BY MAX(due, ?1)`,
    [t.today, FORECAST_DAYS],
  );
  const [lrn] = await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cards WHERE queue IN (1, 4) AND due < ?`, [t.nextDayAt]);
  const byDay = new Map(due.map((r) => [r.day, r.n]));
  const forecast = Array.from({ length: FORECAST_DAYS }, (_, i) => {
    const d = new Date(nowMs + i * 86_400_000);
    return { d: i === 0 ? 'Today' : WEEKDAY[d.getDay()], n: (byDay.get(t.today + i) ?? 0) + (i === 0 ? lrn.n : 0) };
  });

  // Activity: reviews per day (bucketed in JS so day boundaries follow the rollover hour and DST).
  const recent = await sql.all<{ id: number }>(`SELECT id FROM revlog WHERE id >= ? AND ease > 0`, [heatStartMs]);
  const perDay = new Map<number, number>();
  for (const r of recent) {
    const d = studyDayOf(r.id, rollover);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const counts = Array.from({ length: HEATMAP_DAYS }, (_, i) => perDay.get(t.today - (HEATMAP_DAYS - 1 - i)) ?? 0);
  const max = Math.max(1, ...counts);
  const heatmap = counts.map((n) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4))));

  const streak = await loadStreak(sql, nowMs, rollover);

  const tod = new Array<number>(24).fill(0);
  for (const r of recent) tod[new Date(r.id).getHours()]++;

  return {
    retention: ret.total ? Math.round((100 * (ret.passed ?? 0)) / ret.total) : null,
    streak,
    reviewsToday: today.n,
    minutesToday: Math.round(today.ms / 60_000),
    mature: cards.mature ?? 0,
    young: cards.young ?? 0,
    learning: cards.learning ?? 0,
    newCards: cards.newc ?? 0,
    suspended: cards.suspended ?? 0,
    forecast,
    heatmap,
    tod,
    totalReviews,
    totalCards: cards.total ?? 0,
  };
}

/** Consecutive study days with at least one review, ending today (or yesterday if not yet studied today). */
export async function loadStreak(sql: Sql, nowMs: number, rollover: number): Promise<number> {
  const t = timingAt(nowMs, rollover);
  // One representative review per UTC hour is enough to know which study days had reviews.
  const rows = await sql.all<{ id: number }>(`SELECT MAX(id) AS id FROM revlog WHERE ease > 0 GROUP BY id / 3600000`);
  const studied = new Set(rows.map((r) => studyDayOf(r.id, rollover)));
  let streak = 0;
  let day = studied.has(t.today) ? t.today : t.today - 1;
  while (studied.has(day)) {
    streak++;
    day--;
  }
  return streak;
}
