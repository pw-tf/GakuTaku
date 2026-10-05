/**
 * Verification for src/analytics/analytics.ts against a hand-built collection on an in-memory SQLite
 * database (the app's own migrations). Exits non-zero on any failed check.
 *
 *   npm run verify:analytics
 */
import { loadAnalytics, loadStreak, HEATMAP_DAYS } from '../src/analytics/analytics';
import { loadStats } from '../src/analytics/stats';
import { timingAt } from '../src/anki/timing';
import { openTestDb } from './sqliteNode';

let failures = 0;
let passes = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passes++;
  else {
    failures++;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  }
}

const DAY = 86_400_000;
const ROLLOVER = 4;
// Local noon today, so every bucket below is well clear of the rollover hour.
const noon = new Date();
noon.setHours(12, 0, 0, 0);
const NOW = noon.getTime();
const t = timingAt(NOW, ROLLOVER);

const { sql } = await openTestDb();

// Cards: 2 new, 1 learning (due now), 1 relearning, 2 young reviews, 1 mature, 1 suspended review.
const card = (id: number, type: number, queue: number, due: number, ivl: number) =>
  sql.run(
    `INSERT INTO cards (id, nid, did, ord, mod, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags)
     VALUES (?, 1, 1, 0, 0, ?, ?, ?, ?, 2500, 0, 0, 0, 0, 0, 0)`,
    [id, type, queue, due, ivl],
  );
await card(1, 0, 0, 1, 0);
await card(2, 0, 0, 2, 0);
await card(3, 1, 1, t.now - 60, 0);
await card(4, 3, 1, t.now + 600, 1);
await card(5, 2, 2, t.today - 2, 3); // overdue → counted today
await card(6, 2, 2, t.today + 1, 10);
await card(7, 2, 2, t.today + 3, 40);
await card(8, 2, -1, t.today, 30);

// Reviews: today 3 (one of a review card failed), yesterday 1, two days ago 1, four days ago 1.
const rev = (ms: number, cid: number, ease: number, type: number, time = 10_000) =>
  sql.run('INSERT INTO revlog (id, cid, ease, ivl, lastIvl, factor, time, type) VALUES (?, ?, ?, 1, 1, 2500, ?, ?)', [ms, cid, ease, time, type]);
await rev(NOW - 1000, 5, 1, 1, 30_000);
await rev(NOW - 2000, 6, 3, 1, 30_000);
await rev(NOW - 3000, 3, 3, 0, 60_000);
await rev(NOW - DAY, 7, 3, 1);
await rev(NOW - 2 * DAY, 7, 4, 1);
await rev(NOW - 4 * DAY, 6, 3, 1);
// A manual reschedule (ease 0) is not a review.
await rev(NOW - 4000, 8, 0, 4);

const a = await loadAnalytics(sql, NOW, ROLLOVER);
eq('total cards', a.totalCards, 8);
eq('new', a.newCards, 2);
eq('learning', a.learning, 2);
eq('young', a.young, 2);
eq('mature', a.mature, 1);
eq('suspended', a.suspended, 1);
eq('reviews today', a.reviewsToday, 3);
eq('minutes today', a.minutesToday, 2);
eq('total reviews', a.totalReviews, 6);
// Retention over review-card reviews only: 4 passed of 5.
eq('true retention', a.retention, 80);
eq('streak (3 consecutive days, gap before)', a.streak, 3);
eq('forecast today = overdue/due reviews + learning due today', a.forecast[0].n, 1 + 2);
eq('forecast +1', a.forecast[1].n, 1);
eq('forecast +3', a.forecast[3].n, 1);
eq('forecast length', a.forecast.length, 7);
eq('heatmap length', a.heatmap.length, HEATMAP_DAYS);
eq('heatmap today is the max bucket', a.heatmap[HEATMAP_DAYS - 1], 4);
eq('heatmap 3 days ago empty', a.heatmap[HEATMAP_DAYS - 4], 0);
eq('heatmap yesterday', a.heatmap[HEATMAP_DAYS - 2], 2);
eq('time-of-day total', a.tod.reduce((x, y) => x + y, 0), 6);

// Streak survives "not studied yet today" (counts back from yesterday).
eq('streak tomorrow before studying', await loadStreak(sql, NOW + DAY, ROLLOVER), 3);
eq('streak broken after a missed day', await loadStreak(sql, NOW + 2 * DAY, ROLLOVER), 0);

// ---- Detailed statistics (Anki's Statistics screen) ----
const st = await loadStats(sql, { deckIds: null, period: 30 }, NOW, ROLLOVER);
eq('stats today', st.today, { reviews: 3, minutes: 2, secondsPerCard: 40, again: 1, learn: 1, review: 2, relearn: 0, filtered: 0, matureCorrect: 0, matureTotal: 0 });
eq('stats: 30 daily review buckets', [st.reviews.length, st.reviews[29].start, st.reviews[0].start], [30, 0, -29]);
eq('stats: today by kind', [st.reviews[29].learn, st.reviews[29].young], [1, 2]);
eq('stats: past days', [st.reviews[28].young, st.reviews[27].young, st.reviews[26].young, st.reviews[25].young], [1, 1, 0, 1]);
eq('stats: time per kind today', st.reviews[29].ms.young, 60_000);
eq('stats: forecast today (learning + overdue), +1, +3', [st.forecast[0].n, st.forecast[1].n, st.forecast[3].n, st.forecast.length], [3, 1, 1, 30]);
eq('stats: card counts', st.counts, { new: 2, learning: 1, relearning: 1, young: 2, mature: 1, suspended: 1, buried: 0 });
eq('stats: intervals cover all review cards', st.intervals.counts.reduce((x, y) => x + y, 0), 5);
eq('stats: interval bins', [st.intervals.counts[0], st.intervals.counts[2], st.intervals.labels[7], st.intervals.counts[7]], [1, 1, '8d–14d', 1]);
eq('stats: ease (no FSRS)', [st.ease?.labels[6], st.ease?.counts[6], st.difficulty], ['250%', 5, null]);
eq('stats: hours total', st.hours.reduce((x, h) => x + h.total, 0), 6);
eq('stats: answer buttons', st.buttons, { learning: [0, 0, 1, 0], young: [1, 0, 3, 1], mature: [0, 0, 0, 0] });
eq('stats: weekly buckets for a year', (await loadStats(sql, { deckIds: null, period: 365 }, NOW, ROLLOVER)).reviews[0].days, 7);
eq('stats: deck life spans back to the first review', (await loadStats(sql, { deckIds: null, period: 0 }, NOW, ROLLOVER)).spanDays, 5);
const other = await loadStats(sql, { deckIds: [999], period: 30 }, NOW, ROLLOVER);
eq('stats: another deck has none of it', [other.today.reviews, other.counts.new, other.forecast[0].n], [0, 0, 0]);
eq('stats: this deck has it all', (await loadStats(sql, { deckIds: [1], period: 30 }, NOW, ROLLOVER)).today.reviews, 3);

// An empty collection has no retention figure.
const empty = await openTestDb();
const e = await loadAnalytics(empty.sql, NOW, ROLLOVER);
eq('empty retention is null', e.retention, null);
eq('empty streak', e.streak, 0);

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
