/**
 * Standalone verification for the Anki-alignment SRS engine. Run with `npx tsx scripts/verify-srs.ts`.
 * No test framework (same pattern as verify-analytics.ts): everything imported here is pure —
 * queue math, gather/sort/mix, preset resolution, card-op plans, .apkg mappings, and the manual-event
 * replay fold (whose only runtime dependency is ts-fsrs). Exits non-zero on the first failed assertion.
 */
import {
  ACTIVE_SQL,
  capDeckQueue,
  capTreeQueue,
  deckBudget,
  introducedTodayQuery,
  rawDeckCountsQuery,
  reviewedTodayQuery,
  studyDayEnd,
  studyDayStart,
} from '../src/srs/queue';
import { gatherSession, interleave, mulberry32, type GatherInput, type GatherRow } from '../src/srs/gather';
import {
  defaultPresetConfig,
  parsePresetConfig,
  resolveDeckConfig,
  serializePresetConfig,
  type ResolvedDeckConfig,
} from '../src/srs/presets';
import { leechPlan, parseDueDateSpec, siblingBuryPlan, type SiblingRow } from '../src/srs/cardPlans';
import { mapApkgCardState, mapDconfToPreset, mapRevlogEntry, stepsFromMinutes } from '../src/import/mapApkg';
import { deriveCard, replaySteps, State } from '../src/srs/fsrs';
import type { ReviewLogRecord } from '../src/sync/AppSchema';

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

// ---------- 1. Shared SQL invariants ----------
console.log('\n--- shared SQL builders ---');
const qMarks = (s: string) => (s.match(/\?/g) ?? []).length;
check('ACTIVE_SQL has exactly one bind', qMarks(ACTIVE_SQL), 1);
checkTrue('ACTIVE_SQL always excludes suspended', ACTIVE_SQL.includes('COALESCE(c.queue, 0) = 0'));
for (const [name, q] of [
  ['rawDeckCountsQuery', rawDeckCountsQuery('S', 'E')],
  ['introducedTodayQuery', introducedTodayQuery('S')],
  ['reviewedTodayQuery', reviewedTodayQuery('S')],
] as const) {
  check(`${name}: placeholder count == params count`, qMarks(q.sql), q.params.length);
}
checkTrue('introduced/reviewed skip manual events', introducedTodayQuery('S').sql.includes('rating >= 1') && reviewedTodayQuery('S').sql.includes('rating >= 1'));
checkTrue('reviewed counts distinct cards (v3 per-card limits)', reviewedTodayQuery('S').sql.includes('COUNT(DISTINCT rl.card_id)'));

// ---------- 2. Study-day boundaries ----------
console.log('\n--- study day ---');
const at = (h: number) => {
  const d = new Date(2026, 6, 27, h, 30, 0, 0);
  return d;
};
check('3:30am belongs to previous day (4am cutoff)', studyDayStart(at(3), 4).getDate(), 26);
check('4:30am belongs to today', studyDayStart(at(4), 4).getDate(), 27);
check('day end is next rollover', studyDayEnd(at(12), 4).getDate(), 28);

// ---------- 3. v3 daily-limit interactions ----------
console.log('\n--- v3 limits ---');
const limits = (over: Partial<ResolvedDeckConfig> = {}) => ({ ...defaultPresetConfig(), presetId: null, ...over });
{
  // Review limit caps new intake: 200 limit, 195 due reviews → at most 5 new.
  const b = deckBudget(limits(), { newCount: 30, learnIntraday: 0, learnInterday: 0, reviewCount: 195 }, { introduced: 0, reviewed: 0 });
  check('review headroom caps new (200 limit, 195 due → 5 new)', [b.due, b.new], [195, 5]);
}
{
  // Cards already reviewed today consume the limit; interday learning consumes it first.
  const b = deckBudget(limits({ reviewsPerDay: 10 }), { newCount: 9, learnIntraday: 3, learnInterday: 4, reviewCount: 20 }, { introduced: 0, reviewed: 0 });
  check('interday learning first, then reviews, then new', [b.interday, b.due, b.new], [4, 6, 0]);
}
{
  const b = deckBudget(limits({ newIgnoreReviewLimit: true }), { newCount: 30, learnIntraday: 0, learnInterday: 0, reviewCount: 200 }, { introduced: 0, reviewed: 0 });
  check('newIgnoreReviewLimit bypasses the headroom', b.new, 20);
}
{
  const q = capDeckQueue(limits({ reviewsPerDay: 5 }), { newCount: 0, learnIntraday: 7, learnInterday: 9, reviewCount: 0 }, { introduced: 0, reviewed: 5 });
  check('intraday learning never capped; interday capped by spent limit', q.learning, 7);
}
{
  const b = deckBudget(limits(), { newCount: 10, learnIntraday: 0, learnInterday: 0, reviewCount: 0 }, { introduced: 18, reviewed: 18 });
  check('introduced-today consumes the new limit', b.new, 2);
}
{
  const t = capTreeQueue(limits({ newPerDay: 5, reviewsPerDay: 10 }), { new: 20, learning: 3, due: 30 }, { introduced: 0, reviewed: 0 });
  check('selected deck limits cap the subtree sum', [t.new, t.due, t.learning], [0, 10, 3]);
  const t2 = capTreeQueue(limits({ newPerDay: 5, reviewsPerDay: 100 }), { new: 20, learning: 3, due: 30 }, { introduced: 0, reviewed: 0 });
  check('tree cap with headroom', [t2.new, t2.due], [5, 30]);
}

// ---------- 4. Gather / sort / mix ----------
console.log('\n--- gather / sort / mix ---');
const NOW = new Date(2026, 6, 27, 12, 0, 0).getTime();
const dayStartMs = NOW - 8 * 3600_000; // 4am
const row = (id: string, p: Partial<GatherRow>): GatherRow => ({
  id,
  noteId: `note-${id}`,
  deckId: 'd1',
  state: 0,
  reps: 0,
  dueMs: NOW,
  position: null,
  createdMs: NOW,
  templateIndex: 0,
  stability: null,
  lastReviewMs: null,
  difficulty: null,
  ...p,
});
const freshBudgets = (newLeft = 10, due = 10, interday = 10) =>
  new Map([
    ['d1', { new: newLeft, due, interday }],
    ['d2', { new: newLeft, due, interday }],
  ]);
const gatherInput = (over: Partial<GatherInput>): GatherInput => ({
  newRows: [],
  dueRows: [],
  budgets: freshBudgets(),
  treeBudget: null,
  cfg: limits(),
  deckOrder: ['d1', 'd2'],
  dayStartMs,
  rng: mulberry32(42),
  ...over,
});

const newRows = [
  row('n1', { position: 1, createdMs: NOW - 3000 }),
  row('n2', { position: 2, createdMs: NOW - 2000 }),
  row('n3', { deckId: 'd2', position: 3, createdMs: NOW - 1000 }),
];
{
  const out = gatherSession(gatherInput({ newRows, cfg: limits({ newReviewMix: 'afterReviews' }) }));
  check('deck gather order (default): d1 by position, then d2', out.seq, ['n1', 'n2', 'n3']);
}
{
  const out = gatherSession(gatherInput({ newRows, cfg: limits({ newGatherPriority: 'positionDesc', newSortOrder: 'gathered', newReviewMix: 'afterReviews' }) }));
  check('positionDesc gather', out.seq, ['n3', 'n2', 'n1']);
}
{
  const b = freshBudgets();
  b.get('d1')!.new = 1;
  const out = gatherSession(gatherInput({ newRows, budgets: b, cfg: limits({ newReviewMix: 'afterReviews' }) }));
  check('per-deck new budget consumed during gather', out.seq, ['n1', 'n3']);
}
{
  const out = gatherSession(
    gatherInput({ newRows, treeBudget: { new: 2, due: 10, interday: 10 }, cfg: limits({ newReviewMix: 'afterReviews' }) }),
  );
  check('tree budget stops the gather', out.seq, ['n1', 'n2']);
}
{
  // randomNotes keeps a note's cards adjacent in template order.
  const sib = [
    row('a0', { noteId: 'N', templateIndex: 0 }),
    row('b0', { noteId: 'M', templateIndex: 0 }),
    row('a1', { noteId: 'N', templateIndex: 1 }),
  ];
  const out = gatherSession(gatherInput({ newRows: sib, cfg: limits({ newGatherPriority: 'randomNotes', newSortOrder: 'gathered', newReviewMix: 'afterReviews' }) }));
  const i0 = out.seq.indexOf('a0');
  const i1 = out.seq.indexOf('a1');
  check('randomNotes keeps siblings adjacent, template order', i1 - i0, 1);
  const out2 = gatherSession(gatherInput({ newRows: sib, cfg: limits({ newGatherPriority: 'randomNotes', newSortOrder: 'gathered', newReviewMix: 'afterReviews' }) }));
  check('seeded rng → deterministic', out.seq, out2.seq);
}
{
  // Sort: template default groups by template index over the gathered order.
  const tmpl = [
    row('t1', { templateIndex: 1, position: 1 }),
    row('t0', { templateIndex: 0, position: 2 }),
    row('t2', { templateIndex: 1, position: 3 }),
  ];
  const out = gatherSession(gatherInput({ newRows: tmpl, cfg: limits({ newSortOrder: 'template', newReviewMix: 'afterReviews' }) }));
  check('newSortOrder template: card type then gathered', out.seq, ['t0', 't1', 't2']);
}

const reviews = [
  row('rOld', { state: 2, reps: 5, dueMs: NOW - 3 * DAY, lastReviewMs: NOW - 10 * DAY }),
  row('rNew', { state: 2, reps: 5, dueMs: NOW - 1 * DAY, lastReviewMs: NOW - 4 * DAY }),
];
{
  const out = gatherSession(gatherInput({ dueRows: reviews }));
  check('dueDateRandom groups by due day (older due first)', out.seq, ['rOld', 'rNew']);
}
{
  const out = gatherSession(gatherInput({ dueRows: reviews, cfg: limits({ reviewSortOrder: 'intervalsDesc' }) }));
  check('intervalsDesc: longest interval first', out.seq, ['rOld', 'rNew']);
  const out2 = gatherSession(gatherInput({ dueRows: reviews, cfg: limits({ reviewSortOrder: 'intervalsAsc' }) }));
  check('intervalsAsc: shortest interval first', out2.seq, ['rNew', 'rOld']);
}
{
  // Learning split: interday goes into seq (against the review limit); intraday is timed.
  const learn = [
    row('Linter', { state: 1, reps: 2, dueMs: NOW - DAY, lastReviewMs: NOW - 2 * DAY }),
    row('Lintra', { state: 3, reps: 4, dueMs: NOW + 5 * 60_000, lastReviewMs: dayStartMs + 3600_000 }),
  ];
  const out = gatherSession(gatherInput({ dueRows: [...reviews, ...learn], cfg: limits({ interdayLearningMix: 'beforeReviews' }) }));
  check('intraday learning is timed, not in seq', out.timed, ['Lintra']);
  check('interday learning mixes before reviews', out.seq, ['Linter', 'rOld', 'rNew']);
}
check('interleave mix spreads proportionally', interleave(['a', 'b', 'c', 'd'], ['x', 'y'], 'mix'), ['a', 'b', 'x', 'c', 'd', 'y']);
check('interleave beforeReviews', interleave(['a'], ['x'], 'beforeReviews'), ['x', 'a']);
check('interleave afterReviews', interleave(['a'], ['x'], 'afterReviews'), ['a', 'x']);

// ---------- 5. Sibling bury plan ----------
console.log('\n--- sibling burying ---');
const dayEndMs = dayStartMs + DAY;
const sibs: SiblingRow[] = [
  { id: 'sNew', state: 0, reps: 0, dueMs: NOW, queue: 0, lastReviewMs: null },
  { id: 'sRevToday', state: 2, reps: 5, dueMs: NOW - DAY, queue: 0, lastReviewMs: NOW - 5 * DAY },
  { id: 'sRevLater', state: 2, reps: 5, dueMs: NOW + 10 * DAY, queue: 0, lastReviewMs: NOW - 5 * DAY },
  { id: 'sInterday', state: 1, reps: 2, dueMs: NOW - DAY, queue: 0, lastReviewMs: NOW - 2 * DAY },
  { id: 'sIntraday', state: 1, reps: 2, dueMs: NOW + 600_000, queue: 0, lastReviewMs: dayStartMs + 3600_000 },
  { id: 'sSuspended', state: 0, reps: 0, dueMs: NOW, queue: -1, lastReviewMs: null },
];
check('all bury options off → nothing buried', siblingBuryPlan(sibs, limits(), dayStartMs, dayEndMs), []);
check(
  'buryNewSiblings only',
  siblingBuryPlan(sibs, limits({ buryNewSiblings: true }), dayStartMs, dayEndMs),
  ['sNew'],
);
check(
  'buryReviewSiblings: only cards in today\'s queue',
  siblingBuryPlan(sibs, limits({ buryReviewSiblings: true }), dayStartMs, dayEndMs),
  ['sRevToday'],
);
check(
  'buryInterdayLearningSiblings: intraday never buried',
  siblingBuryPlan(sibs, limits({ buryInterdayLearningSiblings: true }), dayStartMs, dayEndMs),
  ['sInterday'],
);
check(
  'all options on: suspended sibling still skipped',
  siblingBuryPlan(sibs, limits({ buryNewSiblings: true, buryReviewSiblings: true, buryInterdayLearningSiblings: true }), dayStartMs, dayEndMs),
  ['sNew', 'sRevToday', 'sInterday'],
);

// ---------- 6. Leech plan ----------
console.log('\n--- leeches ---');
const leechCfg = { leechThreshold: 8, leechAction: 'suspend' as const };
check('no lapse → no action', leechPlan(8, 8, leechCfg, ''), { tag: false, suspend: false });
check('triggers at threshold', leechPlan(7, 8, leechCfg, ''), { tag: true, suspend: true });
check('no trigger between waypoints', leechPlan(8, 9, leechCfg, ''), { tag: false, suspend: false });
check('re-triggers every half threshold (12)', leechPlan(11, 12, leechCfg, 'leech'), { tag: false, suspend: true });
check('re-triggers at 16', leechPlan(15, 16, leechCfg, ''), { tag: true, suspend: true });
check('tagOnly action never suspends', leechPlan(7, 8, { leechThreshold: 8, leechAction: 'tagOnly' }, ''), { tag: true, suspend: false });
check('custom threshold 4 re-triggers every 2', leechPlan(5, 6, { leechThreshold: 4, leechAction: 'suspend' }, 'leech'), { tag: false, suspend: true });

// ---------- 7. Manual events in the replay fold ----------
console.log('\n--- manual events (forget / set due date) ---');
const T0 = new Date(2026, 0, 1, 12).toISOString();
const T = (days: number) => new Date(new Date(T0).getTime() + days * DAY).toISOString();
const log = (rating: number, time: string, scheduledDays: number | null = 0): ReviewLogRecord =>
  ({ id: `log-${time}-${rating}`, user_id: 'u', card_id: 'X', rating, review_time: time, elapsed_ms: 0, scheduled_days: scheduledDays }) as ReviewLogRecord;

{
  const c = deriveCard([log(0, T(0), 5)], T0, undefined, 'X');
  check('set-due on a new card → Review state', c.state, State.Review);
  check('set-due due date = event + N days', c.due.toISOString(), T(5));
  checkTrue('set-due stability ≥ N', c.stability >= 5);
}
{
  const c = deriveCard([log(3, T(0)), log(3, T(3)), log(0, T(5), -1)], T0, undefined, 'X');
  check('forget resets to New', [c.state, c.reps, c.lapses], [State.New, 0, 0]);
  const c2 = deriveCard([log(3, T(0)), log(3, T(3)), log(0, T(5), -1), log(3, T(6))], T0, undefined, 'X');
  check('review after forget starts from empty (reps 1)', c2.reps, 1);
}
{
  const logs = [log(3, T(0)), log(3, T(3)), log(1, T(10))];
  const steps = replaySteps(logs, T0, undefined, 'X');
  const derivedBefore = deriveCard(logs.slice(0, 2), T0, undefined, 'X');
  check('replaySteps and deriveCard share the fuzz seed (same pre-state)', [steps[2].prevState, steps[2].prevReps], [derivedBefore.state, derivedBefore.reps]);
  const withManual = replaySteps([log(0, T(0), 3), ...logs.map((l, i) => ({ ...l, review_time: T(20 + i) }))], T0, undefined, 'X');
  check('manual events emit no replay step', withManual.length, 3);
}

// ---------- 8. Import mappings ----------
console.log('\n--- .apkg mappings ---');
check('active new card', mapApkgCardState({ type: 0, queue: 0, due: 42, flags: 0 }), { queue: 0, flag: 0, position: 42, buried: false });
check('suspended survives import', mapApkgCardState({ type: 2, queue: -1, due: 120, flags: 0 }), { queue: -1, flag: 0, position: null, buried: false });
check('sched-buried', mapApkgCardState({ type: 2, queue: -2, due: 120, flags: 0 }).buried, true);
check('user-buried', mapApkgCardState({ type: 1, queue: -3, due: 120, flags: 0 }).buried, true);
check('flag = low 3 bits', mapApkgCardState({ type: 0, queue: 0, due: 1, flags: 0b1101 }).flag, 5);
check('review answer maps to rating', mapRevlogEntry({ ease: 3, ivl: 10, factor: 2500, type: 1 }), { kind: 'review', rating: 3 });
check('manual forget (ivl ≤ 0)', mapRevlogEntry({ ease: 0, ivl: 0, factor: 0, type: 4 }), { kind: 'manual', scheduledDays: -1 });
check('manual set-due (ivl > 0)', mapRevlogEntry({ ease: 0, ivl: 7, factor: 0, type: 4 }), { kind: 'manual', scheduledDays: 7 });
check('non-rescheduling filtered review skipped', mapRevlogEntry({ ease: 3, ivl: 10, factor: 0, type: 3 }), { kind: 'skip' });
check('steps from minutes', stepsFromMinutes([0.5, 1, 10, 60, 1440]), ['30s', '1m', '10m', '1h', '1d']);
{
  const p = mapDconfToPreset({
    id: '1', name: 'x', newPerDay: 15, revPerDay: 120, learnSteps: [1, 10], relearnSteps: [10],
    leechFails: 6, leechAction: 1, buryNew: true, buryRev: false, newOrder: 0,
  });
  check('dconf → preset', [p.newPerDay, p.reviewsPerDay, p.leechThreshold, p.leechAction, p.buryNewSiblings, p.insertionOrder],
    [15, 120, 6, 'tagOnly', true, 'random']);
  check('dconf steps', [p.learningSteps, p.relearningSteps], [['1m', '10m'], ['10m']]);
  check('dconf leech default is suspend (Anki)', mapDconfToPreset({ id: '2', name: 'y' }).leechAction, 'suspend');
}

// ---------- 9. Preset resolution ----------
console.log('\n--- preset resolution ---');
{
  const d = parsePresetConfig(null);
  check('defaults are Anki defaults', [d.newPerDay, d.reviewsPerDay, d.leechThreshold, d.leechAction, d.newGatherPriority, d.reviewSortOrder, d.desiredRetention],
    [20, 200, 8, 'suspend', 'deck', 'dueDateRandom', 0.9]);
  check('defaults serialize to {}', serializePresetConfig(d), '{}');
}
{
  const cfg = parsePresetConfig('{"newPerDay":50,"buryNewSiblings":true,"reviewSortOrder":"intervalsAsc"}');
  const round = parsePresetConfig(serializePresetConfig(cfg));
  check('serialize/parse round-trip', round, cfg);
}
{
  const preset = parsePresetConfig('{"newPerDay":50,"reviewsPerDay":500}');
  const r = resolveDeckConfig({ preset_id: 'p1', fsrs_params: '{"newPerDayOverride":7,"description":"hi"}' }, preset);
  check('per-deck override beats preset', [r.newPerDay, r.reviewsPerDay, r.description], [7, 500, 'hi']);
}
{
  const r = resolveDeckConfig({ preset_id: null, fsrs_params: '{"newPerDay":9,"learningSteps":["2m"],"w":[1,2]}' }, null);
  check('legacy fallback keeps old config', [r.newPerDay, r.learningSteps, r.w], [9, ['2m'], [1, 2]]);
  check('legacy fallback keeps tag-only leech behavior', r.leechAction, 'tagOnly');
}

// ---------- 10. Set-due-date spec ----------
console.log('\n--- set due date spec ---');
check('"5"', parseDueDateSpec('5'), { min: 5, max: 5 });
check('"3-7"', parseDueDateSpec('3-7'), { min: 3, max: 7 });
check('"0" (today)', parseDueDateSpec('0'), { min: 0, max: 0 });
check('reversed range rejected', parseDueDateSpec('7-3'), null);
check('garbage rejected', parseDueDateSpec('abc'), null);

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All SRS checks passed.');
