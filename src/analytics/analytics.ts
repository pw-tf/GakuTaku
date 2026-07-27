import type { ReviewLogRecord } from '../sync/AppSchema';
import { Rating, State, cardStateLabel, deckConfig, replaySteps } from '../srs/fsrs';

/**
 * Analytics computation (build plan M5). Pure functions over the synced `review_logs` + `cards`
 * caches — no React, no I/O — so they're unit-testable against fixed fixtures and reusable.
 *
 * Most metrics are plain aggregations over log timestamps. The one exception is *true retention*,
 * which must count only reviews of already-graduated (Review-state) cards; raw logs don't store the
 * state at review time, so we recover it per card via {@link replaySteps} (§3.3 event-sourcing).
 */

export const HEATMAP_WEEKS = 18;
const DAYS_PER_WEEK = 7;
export const HEATMAP_DAYS = HEATMAP_WEEKS * DAYS_PER_WEEK; // 126
const FORECAST_DAYS = 7;
const DAY_MS = 86_400_000;

/** A card row (current cache state) needed for maturity buckets, the forecast, and retention replay. */
export interface AnalyticsCard {
  id: string;
  createdAt: string;
  fsrsParams: string | null;
  due: string | null;
  reps: number;
  state: number;
  lastReview: string | null;
}

/** A review log row. `card_id` groups logs per card for the retention replay. */
export type AnalyticsLog = Pick<ReviewLogRecord, 'card_id' | 'rating' | 'review_time' | 'elapsed_ms'>;

export interface AnalyticsData {
  retention: number; // true retention %, integer
  streak: number; // consecutive days with ≥1 review, ending today/yesterday
  reviewsToday: number;
  minutesToday: number;
  mature: number;
  young: number;
  learning: number;
  newCards: number;
  forecast: { d: string; n: number }[]; // next 7 days
  heatmap: number[]; // HEATMAP_DAYS cells, intensity 0–4, column-major (see .heat CSS)
  tod: number[]; // 24 hourly review counts
  totalReviews: number; // gates the empty/low-data state
  totalCards: number;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local midnight for a date, as ms. */
function startOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** Local `YYYY-M-D` key (calendar day in the user's timezone, not UTC). */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Consecutive calendar days with ≥1 review, ending today (or yesterday if nothing yet today, so the
 * streak isn't shown broken before the day's first review). Shared by the dashboard and the cheap
 * {@link useStreak} library-header hook.
 */
export function computeStreak(reviewTimes: Array<string | null | undefined>, now: Date = new Date()): number {
  const days = new Set<string>();
  for (const t of reviewTimes) {
    if (!t) continue;
    const ms = new Date(t).getTime();
    if (!Number.isNaN(ms)) days.add(dayKey(ms));
  }
  const todayStart = startOfDay(now);
  let cursor = days.has(dayKey(todayStart)) ? todayStart : todayStart - DAY_MS;
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor -= DAY_MS;
  }
  return streak;
}

export function computeAnalytics(cards: AnalyticsCard[], logs: AnalyticsLog[], now: Date = new Date()): AnalyticsData {
  const todayStart = startOfDay(now);

  // --- Per-day / per-hour aggregations over all logs (no replay needed) ---
  const perDay = new Map<string, number>();
  const tod = new Array<number>(24).fill(0);
  let reviewsToday = 0;
  let minutesTodayMs = 0;
  let totalReviews = 0;

  for (const log of logs) {
    if (!log.review_time) continue;
    const t = new Date(log.review_time).getTime();
    if (Number.isNaN(t)) continue;
    totalReviews++;
    perDay.set(dayKey(t), (perDay.get(dayKey(t)) ?? 0) + 1);
    tod[new Date(t).getHours()]++;
    if (t >= todayStart) {
      reviewsToday++;
      minutesTodayMs += log.elapsed_ms ?? 0;
    }
  }

  // --- Heatmap: HEATMAP_DAYS cells ending today. Column-major (7 rows = weekdays); the grid's
  // last column is the current week, so cell (week w, row r) is `todayDow - r` days into that week. ---
  const todayDow = now.getDay();
  const dailyCounts: number[] = new Array<number>(HEATMAP_DAYS).fill(0);
  for (let i = 0; i < HEATMAP_DAYS; i++) {
    const w = Math.floor(i / DAYS_PER_WEEK);
    const r = i % DAYS_PER_WEEK;
    const offset = (HEATMAP_WEEKS - 1 - w) * DAYS_PER_WEEK + (todayDow - r);
    if (offset < 0) continue; // future days in the current (partial) week
    dailyCounts[i] = perDay.get(dayKey(todayStart - offset * DAY_MS)) ?? 0;
  }
  const maxDaily = Math.max(0, ...dailyCounts.filter((n) => n > 0));
  const heatmap = dailyCounts.map((count) =>
    count === 0 || maxDaily === 0 ? 0 : Math.min(4, 1 + Math.floor((count / maxDaily) * 3)),
  );

  const streak = computeStreak(
    logs.map((l) => l.review_time),
    now,
  );

  // --- Maturity buckets + forecast over current cards ---
  let mature = 0;
  let young = 0;
  let learning = 0;
  let newCards = 0;
  const forecastCounts = new Array<number>(FORECAST_DAYS).fill(0);

  for (const c of cards) {
    const label = cardStateLabel({
      state: c.state,
      reps: c.reps,
      due: c.due ? new Date(c.due) : new Date(0),
      last_review: c.lastReview ? new Date(c.lastReview) : null,
    });
    if (label === 'mature') mature++;
    else if (label === 'young') young++;
    else if (label === 'learning') learning++;
    else newCards++;

    // Forecast: scheduled (reps>0) cards due in the next 7 days; overdue lump into today (day 0).
    if (c.reps > 0 && c.due) {
      const dueMs = new Date(c.due).getTime();
      if (!Number.isNaN(dueMs)) {
        const dayIdx = dueMs < todayStart + DAY_MS ? 0 : Math.floor((startOfDay(new Date(dueMs)) - todayStart) / DAY_MS);
        if (dayIdx >= 0 && dayIdx < FORECAST_DAYS) forecastCounts[dayIdx]++;
      }
    }
  }
  const forecast = forecastCounts.map((n, i) => ({ d: WEEKDAY[new Date(todayStart + i * DAY_MS).getDay()], n }));

  // --- True retention: pass-rate over reviews whose card was already in the Review state ---
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const logsByCard = new Map<string, AnalyticsLog[]>();
  for (const log of logs) {
    if (!log.card_id) continue;
    const arr = logsByCard.get(log.card_id) ?? [];
    arr.push(log);
    logsByCard.set(log.card_id, arr);
  }
  let retTotal = 0;
  let retPass = 0;
  for (const [cardId, cardLogs] of logsByCard) {
    const meta = cardById.get(cardId);
    const createdAt = meta?.createdAt ?? cardLogs[0]?.review_time ?? new Date(0).toISOString();
    const cfg = deckConfig({ fsrs_params: meta?.fsrsParams ?? null });
    for (const step of replaySteps(cardLogs as ReviewLogRecord[], createdAt, cfg, cardId)) {
      if (step.prevState !== State.Review) continue;
      retTotal++;
      if (step.rating !== Rating.Again) retPass++;
    }
  }
  const retention = retTotal === 0 ? 0 : Math.round((retPass / retTotal) * 100);

  return {
    retention,
    streak,
    reviewsToday,
    minutesToday: Math.round(minutesTodayMs / 60000),
    mature,
    young,
    learning,
    newCards,
    forecast,
    heatmap,
    tod,
    totalReviews,
    totalCards: cards.length,
  };
}
