/**
 * Standalone verification for src/analytics/analytics.ts (build plan M5 acceptance: "stats match a
 * hand-computed sample"). Run with `npx tsx scripts/verify-analytics.ts`. No test framework — the
 * analytics module's only runtime dependency is ts-fsrs (the PowerSync imports are type-only), so it
 * runs directly under tsx. Exits non-zero on the first failed assertion.
 */
import { computeAnalytics, type AnalyticsCard, type AnalyticsLog } from '../src/analytics/analytics';

const DAY = 86_400_000;
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
function checkTrue(label: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// Fixed "now" at local noon today, so day bucketing is timezone-stable within this run.
const now = new Date();
now.setHours(12, 0, 0, 0);
/** ISO timestamp for local noon `n` days before today. */
const day = (n: number) => new Date(now.getTime() - n * DAY).toISOString();

// ---------- Scenario 1: aggregations over a hand-built fixture ----------
const cards1: AnalyticsCard[] = [
  // A: Review, interval 5d (<21) → young; due +5d (forecast index 5)
  { id: 'A', createdAt: day(40), fsrsParams: null, due: day(-5), reps: 3, state: 2, lastReview: day(0) },
  // B: Review, interval 30d (≥21) → mature; due +30d (outside 7d forecast)
  { id: 'B', createdAt: day(40), fsrsParams: null, due: day(-30), reps: 5, state: 2, lastReview: day(0) },
  // C: New
  { id: 'C', createdAt: day(1), fsrsParams: null, due: day(0), reps: 0, state: 0, lastReview: null },
  // D: Learning; due +2d (forecast index 2)
  { id: 'D', createdAt: day(1), fsrsParams: null, due: day(-2), reps: 1, state: 1, lastReview: day(0) },
];
const logs1: AnalyticsLog[] = [
  { card_id: 'A', rating: 3, review_time: day(0), elapsed_ms: 30_000 },
  { card_id: 'A', rating: 3, review_time: day(1), elapsed_ms: 0 },
  { card_id: 'A', rating: 1, review_time: day(2), elapsed_ms: 0 },
  { card_id: 'B', rating: 3, review_time: day(0), elapsed_ms: 90_000 },
  { card_id: 'B', rating: 3, review_time: day(3), elapsed_ms: 0 },
];

const a = computeAnalytics(cards1, logs1, now);
check('totalReviews', a.totalReviews, 5);
check('totalCards', a.totalCards, 4);
check('reviewsToday', a.reviewsToday, 2);
check('minutesToday', a.minutesToday, 2); // (30000 + 90000) / 60000 = 2
check('tod hour 12', a.tod[12], 5);
check('tod elsewhere zero', a.tod.reduce((s, n) => s + n, 0), 5);
check('streak (today..3d back)', a.streak, 4);
check('maturity {mature,young,learning,new}', [a.mature, a.young, a.learning, a.newCards], [1, 1, 1, 1]);

// Heatmap: today's cell sits at week 17, row = today's weekday → index 119 + dow.
const dow = now.getDay();
check('heatmap length', a.heatmap.length, 126);
check('heatmap today cell = max intensity', a.heatmap[119 + dow], 4); // count 2 = maxDaily → 4
check('heatmap nonzero cells', a.heatmap.filter((n) => n > 0).length, 4); // today + 3 prior review days

// Forecast: A due +5d, D due +2d; B (+30d) excluded.
check('forecast length', a.forecast.length, 7);
check('forecast total in-window', a.forecast.reduce((s, f) => s + f.n, 0), 2);
check('forecast day 2 (D)', a.forecast[2].n, 1);
check('forecast day 5 (A)', a.forecast[5].n, 1);

// ---------- Scenario 2: true retention responds to a lapse on a graduated card ----------
const eCard: AnalyticsCard[] = [
  { id: 'E', createdAt: day(60), fsrsParams: null, due: day(-5), reps: 6, state: 2, lastReview: day(10) },
];
const goodDays = [60, 58, 54, 46, 30, 10];
const eLogsAllGood: AnalyticsLog[] = goodDays.map((d) => ({ card_id: 'E', rating: 3, review_time: day(d), elapsed_ms: 0 }));
const eLogsLapse: AnalyticsLog[] = eLogsAllGood.map((l, i) =>
  i === eLogsAllGood.length - 1 ? { ...l, rating: 1 } : l,
);

const rGood = computeAnalytics(eCard, eLogsAllGood, now).retention;
const rLapse = computeAnalytics(eCard, eLogsLapse, now).retention;
checkTrue(`retention in [0,100] (got ${rGood})`, Number.isInteger(rGood) && rGood >= 0 && rGood <= 100);
check('all-Good graduated card → 100% retention', rGood, 100);
checkTrue(`a lapse lowers retention (${rLapse} < ${rGood})`, rLapse < rGood);

// ---------- Determinism: same input → identical output (event-sourcing property) ----------
checkTrue(
  'deterministic recompute',
  JSON.stringify(computeAnalytics(cards1, logs1, now)) === JSON.stringify(a),
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll analytics assertions passed.');
