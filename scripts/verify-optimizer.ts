/**
 * Checks for the FSRS optimizer port (src/anki/fsrsOptimizer.ts), with fsrs-rs 6.6.2's own test
 * vectors: loss and analytic gradient, an Adam step with parameter clipping, the L2 penalty
 * gradient, a second step, the parameter clipper, the cosine-annealing schedule and the
 * initial-stability search. Then an end-to-end run on simulated review histories, and a check that
 * per-card ("windowed") batches give the same loss and gradient as per-item batches.
 *
 *   npm run verify:optimizer
 */
import {
  Adam,
  addL2Gradient,
  batchLossAndGrad,
  buildPlainBatch,
  clipParameters,
  chooseParameters,
  computeParameters,
  CosineAnnealing,
  evaluate,
  initLoss,
  recencyWeighted,
  searchStability,
  smoothAndFill,
  type Batch,
} from '../src/anki/fsrsOptimizer';
import { DEFAULT_PARAMETERS, fsrsItemsForTraining, memoryStateFromHistory, nextInterval, powerForgettingCurve, prepareParameters, step, type FsrsItem } from '../src/anki/fsrs';
import { RevlogKind, type RevlogEntry, type Rating } from '../src/anki/types';
import { Collection } from '../src/anki/collection';
import { setFuzzEnabled } from '../src/anki/fuzz';
import { openTestDb } from './sqliteNode';

let failures = 0;
let passes = 0;
function close(label: string, actual: ArrayLike<number>, expected: ArrayLike<number>, tol = 1e-4) {
  const bad = expected.length !== actual.length || Array.from(expected).some((e, i) => !(Math.abs(actual[i] - e) <= tol));
  if (!bad) passes++;
  else {
    failures++;
    console.error(`✗ ${label}`);
    Array.from(expected).forEach((e, i) => {
      if (!(Math.abs(actual[i] - e) <= tol)) console.error(`    [${i}] expected ${e}, actual ${actual[i]}`);
    });
  }
}
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) passes++;
  else {
    failures++;
    console.error(`✗ ${label}`, detail ?? '');
  }
}

// ---- training.rs test_loss_and_grad -----------------------------------------------------------
const T = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 1],
  [0, 1, 1, 3],
  [1, 3, 3, 5],
  [3, 6, 6, 12],
];
const R = [
  [1, 2, 3, 4],
  [3, 4, 2, 4],
  [1, 4, 4, 3],
  [4, 3, 3, 3],
  [3, 1, 3, 3],
  [2, 3, 3, 4],
];
const batch: Batch = {
  seqLen: 6, batchSize: 4, realBatchSize: 4, columnLengths: [6, 6, 6, 6], windowed: false,
  t: Float32Array.from(T.flat()), r: Float32Array.from(R.flat()),
  deltaTs: Float32Array.from([4, 11, 12, 23]), labels: Float32Array.from([1, 1, 1, 0]), weights: Float32Array.from([1, 1, 1, 1]),
};
const init = Float32Array.from(DEFAULT_PARAMETERS);
const w = Float32Array.from(DEFAULT_PARAMETERS);
const g = new Float64Array(21);
close('loss (default parameters)', [batchLossAndGrad(w, batch, g)], [4.0466027]);
close('gradient', g, [
  -0.095688485, -0.0051607806, -0.0012249565, 0.007462064, 0.03650761, -0.082112335, 0.0593964, -2.1474836, 0.57626534, -2.8751316,
  0.7154875, -0.028993709, 0.0099172965, -0.2189217, -0.0017800558, -0.089381434, 0.299141, 0.068104014, -0.011605468, -0.25398168,
  0.27700496,
]);
const adam = new Adam();
adam.step(w, g, 0.04);
clipParameters(w, 1, true);
close('parameters after one Adam step + clip', w, [
  0.252, 1.3331, 2.3464994, 8.2556, 6.3733, 0.87340003, 2.9794, 0.040999997, 1.8322, 0.20660001, 0.756, 1.5235, 0.021400042, 0.3029,
  1.6882998, 0.64140004, 1.8329, 0.5025, 0.13119997, 0.1058, 0.1142,
]);
const l2 = new Float64Array(21);
addL2Gradient(w, init, 512, 1000, 2.0, l2);
close('L2 penalty gradient', l2, [
  0.0019813816, 0.00087788026, 0.00026506148, -0.000105618295, -0.25213888, 1.0448985, -0.22755535, 5.688889, -0.5385926, 2.5283954,
  -0.75225013, 0.9102214, -10.113569, 3.1999993, 0.2521374, 1.3107208, -0.07721739, -0.85244584, 0.79999936, 4.1795917, -1.1237311,
], 1e-3);
g.fill(0);
close('loss after one step', [batchLossAndGrad(w, batch, g)], [3.767796]);
close('gradient after one step', g, [
  -0.040530164, -0.0041278866, -0.0010157757, 0.007239434, 0.009321215, -0.120117955, 0.039143264, -0.8628009, 0.5794302, -2.5713828,
  0.7669307, -0.024242667, 0.0, -0.16912507, -0.0017008218, -0.061857328, 0.28093633, 0.064058185, 0.0063592787, -0.1903223,
  0.6257775,
]);
adam.step(w, g, 0.04);
clipParameters(w, 1, true);
close('parameters after a second step', w, [
  0.2882918, 1.3726242, 2.3861322, 8.215636, 6.339965, 0.9130969, 2.940639, 0.07696985, 1.7921946, 0.2464217, 0.71595186, 1.5631561,
  0.001, 0.34230903, 1.7282416, 0.68038, 1.7929853, 0.46258268, 0.14039303, 0.14509967, 0.1,
]);

// ---- parameter_clipper.rs ---------------------------------------------------------------------
const clipped = Float32Array.from([0, -1000, 1000, 0, 1000, -1000, 1, 0.25, -0.1, ...DEFAULT_PARAMETERS.slice(9)]);
clipParameters(clipped, 1, true);
close('clipper', clipped.slice(0, 9), [0.001, 0.001, 100, 0.001, 10, 0.001, 1, 0.25, 0]);
const twoSteps = Float32Array.from(DEFAULT_PARAMETERS);
clipParameters(twoSteps, 2, true);
close('clipper with two relearning steps', twoSteps.slice(17, 20), [0.5425, 0.0912, 0.0658]);

// ---- cosine_annealing.rs ----------------------------------------------------------------------
const sched = new CosineAnnealing(5, 4e-2);
close('cosine annealing', Array.from({ length: 11 }, () => sched.step()), [
  0.04, 0.03618033988749895, 0.026180339887498946, 0.013819660112501051, 0.0038196601125010526, 0.0, 0.003819660112501051,
  0.013819660112501048, 0.026180339887498943, 0.03618033988749895, 0.039999999999999994,
], 1e-9);

// ---- parameter_initialization.rs --------------------------------------------------------------
const initData = [
  { deltaT: 1, recall: 0.86666667, count: 435 },
  { deltaT: 2, recall: 0.90721649, count: 97 },
  { deltaT: 3, recall: 0.73015873, count: 63 },
  { deltaT: 4, recall: 0.76315789, count: 38 },
  { deltaT: 5, recall: 0.67857143, count: 28 },
];
close('initial-stability loss', [initLoss(initData, initData.map((d) => d.recall), 0.7840586, Math.fround(DEFAULT_PARAMETERS[0]))], [279.9206961069712], 1e-6);
close('initial-stability search', [searchStability(initData, 0.943_028_57, Math.fround(DEFAULT_PARAMETERS[0]))], [0.7355089]);
close('smooth and fill (3 ratings)', smoothAndFill(new Map([[1, 0.4], [3, 2.3], [4, 10.9]]), new Map([[1, 1], [2, 1], [3, 1], [4, 1]])), [0.4, 1.1227008, 2.3, 10.9], 1e-6);
close('smooth and fill (1 rating)', smoothAndFill(new Map([[2, 0.35]]), new Map([[2, 1]])), [0.05738148, 0.35, 0.6242943, 2.2453482], 1e-6);

// ---- Windowed (per-card) batches equal per-item batches ---------------------------------------
{
  const card: FsrsItem = { reviews: [{ rating: 3, deltaT: 0 }, { rating: 3, deltaT: 2 }, { rating: 1, deltaT: 5 }, { rating: 3, deltaT: 0 }, { rating: 4, deltaT: 3 }] };
  const prefixes = [2, 3, 5].map((n) => ({ reviews: card.reviews.slice(0, n) }));
  const weighted = recencyWeighted(prefixes, [7, 7, 7]);
  const gPlain = new Float64Array(21);
  const lPlain = weighted.reduce((n, x) => n + batchLossAndGrad(Float32Array.from(DEFAULT_PARAMETERS), buildPlainBatch([x]), gPlain), 0);
  // Build the windowed batch the way the optimizer does (one column holding the whole card).
  const len = card.reviews.length;
  const wb: Batch = {
    seqLen: len, batchSize: 1, realBatchSize: 3, columnLengths: [len], windowed: true,
    t: Float32Array.from(card.reviews.map((r) => r.deltaT)), r: Float32Array.from(card.reviews.map((r) => r.rating)),
    deltaTs: new Float32Array(0), labels: new Float32Array(len), weights: new Float32Array(len),
  };
  for (const x of weighted) {
    wb.labels[x.item.reviews.length - 1] = x.item.reviews[x.item.reviews.length - 1].rating > 1 ? 1 : 0;
    wb.weights[x.item.reviews.length - 1] = x.weight;
  }
  const gWin = new Float64Array(21);
  const lWin = batchLossAndGrad(Float32Array.from(DEFAULT_PARAMETERS), wb, gWin);
  close('windowed loss = per-item loss', [lWin], [lPlain], 1e-9);
  close('windowed gradient = per-item gradient', gWin, gPlain, 1e-9);
}

// ---- Training items from a revlog (Anki fsrs_items_for_training) ------------------------------
{
  const DAY = 86_400_000;
  const nextDayAt = Date.UTC(2026, 0, 31, 4) / 1000;
  const at = (day: number, h = 10) => Date.UTC(2026, 0, day, h);
  const e = (id: number, ease: number, type: number, ivl = 0): RevlogEntry => ({ id, cid: 1, ease, ivl, lastIvl: 0, factor: 2500, time: 5000, type });
  const revlog = new Map([
    [1, [e(at(1), 3, RevlogKind.Learning, -600), e(at(1, 11), 3, RevlogKind.Learning, 1), e(at(2), 3, RevlogKind.Review, 3), e(at(5), 1, RevlogKind.Review, -600), e(at(5, 11), 3, RevlogKind.Relearning, 1), e(at(6), 3, RevlogKind.Review, 4)]],
    // No learning steps → not used for training.
    [2, [e(at(3), 3, RevlogKind.Review, 5), e(at(8), 3, RevlogKind.Review, 10)]],
  ]);
  const { items, cardIds, reviewCount } = fsrsItemsForTraining(revlog, nextDayAt, 0);
  ok('one item per interday review', items.length === 3, items);
  ok('items carry their card ids', cardIds.every((c) => c === 1), cardIds);
  ok('review count', reviewCount === 6, reviewCount);
  ok('delta_t in days', JSON.stringify(items[2].reviews.map((r) => r.deltaT)) === JSON.stringify([0, 0, 1, 3, 0, 1]), items[2]);
  const ignored = fsrsItemsForTraining(revlog, nextDayAt, at(2));
  ok('cards first learnt before the ignore date are skipped', ignored.items.length === 0, ignored);
  void DAY;
}

// ---- End to end: optimize on simulated reviews ------------------------------------------------
{
  // A learner whose memory follows "true" parameters different from the defaults.
  const truth = [...DEFAULT_PARAMETERS];
  truth[0] = 0.6;
  truth[2] = 4.5;
  truth[8] = 1.4;
  truth[10] = 1.2;
  let seed = 42;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const items: FsrsItem[] = [];
  const cardIds: number[] = [];
  for (let card = 0; card < 700; card++) {
    const reviews = [{ rating: rand() < 0.7 ? 3 : rand() < 0.5 ? 1 : 4, deltaT: 0 }];
    let state = { stability: truth[reviews[0].rating - 1], difficulty: Math.min(10, Math.max(1, truth[4] - Math.exp(truth[5] * (reviews[0].rating - 1)) + 1)) };
    for (let n = 1; n < 10; n++) {
      // Reviews at the scheduled interval with some jitter (and occasionally late).
      const ivl = Math.max(1, Math.round(nextInterval(truth, state.stability, 0.9) * (0.7 + rand() * 0.8)));
      const recalled = rand() < powerForgettingCurve(truth, ivl, state.stability);
      const rating = recalled ? (rand() < 0.1 ? 2 : rand() < 0.15 ? 4 : 3) : 1;
      reviews.push({ rating, deltaT: ivl });
      items.push({ reviews: reviews.map((r) => ({ ...r })) });
      cardIds.push(card);
      state = step(truth, ivl, rating, state, n);
    }
  }
  let progressCalls = 0;
  const optimized = computeParameters({ items, cardIds, onProgress: () => void progressCalls++ });
  const before = evaluate(DEFAULT_PARAMETERS, items);
  const after = evaluate(optimized, items);
  const truthEval = evaluate(truth, items);
  ok('optimized parameters are 21 finite numbers', optimized.length === 21 && optimized.every(Number.isFinite), optimized);
  ok('optimizing lowers the log loss', after.logLoss < before.logLoss, { before, after });
  ok('…to near the true parameters’ log loss', after.logLoss < truthEval.logLoss + 0.01, { after, truthEval });
  ok('…and lowers the binned RMSE', after.rmseBins < before.rmseBins, { before, after });
  ok('progress reported', progressCalls > 0);
  ok('S0 for Good moved towards the truth', Math.abs(optimized[2] - truth[2]) < Math.abs(DEFAULT_PARAMETERS[2] - truth[2]), optimized[2]);
  // Deterministic for the same input.
  ok('deterministic', JSON.stringify(computeParameters({ items, cardIds })) === JSON.stringify(optimized));
  // Too little data: defaults.
  ok('fewer than 8 items → defaults', JSON.stringify(computeParameters({ items: items.slice(0, 5), cardIds: cardIds.slice(0, 5) })) === JSON.stringify([...DEFAULT_PARAMETERS]));
}

// ---- Anki's acceptance check ------------------------------------------------------------------
{
  const items: FsrsItem[] = [];
  for (let i = 0; i < 50; i++) items.push({ reviews: [{ rating: 3, deltaT: 0 }, { rating: i % 5 ? 3 : 1, deltaT: 3 + (i % 4) }] });
  const worse = [...DEFAULT_PARAMETERS];
  worse[2] = 0.01; // predicts nearly everything forgotten
  const kept = chooseParameters([...DEFAULT_PARAMETERS], worse, items, 1);
  ok('worse optimized parameters are rejected', kept.keptCurrent && JSON.stringify(kept.params) === JSON.stringify([...DEFAULT_PARAMETERS]), kept);
  const taken = chooseParameters(worse, [...DEFAULT_PARAMETERS], items, 1);
  ok('better optimized parameters are taken', !taken.keptCurrent && taken.optimizedLogLoss < taken.currentLogLoss, taken);
  const fromDefaults = chooseParameters([], worse, items, 1);
  ok('empty current parameters mean the defaults', fromDefaults.keptCurrent && fromDefaults.params.length === 21, fromDefaults);
}

// ---- The collection side: training data and memory states ------------------------------------
{
  setFuzzEnabled(false);
  const { sql } = await openTestDb();
  const col = new Collection(sql);
  await col.setConfig({ fsrs: true });
  const deckId = await col.getOrCreateDeck('Vocab');
  const mid = await col.addNotetype({ name: 'Basic', kind: 0, css: '', sortIdx: 0, fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }], templates: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}' }] });
  const cids: number[] = [];
  for (let i = 0; i < 6; i++) cids.push(...(await col.addNote(mid, [`w${i}`, 'x'], [], deckId)).cardIds);
  const DAYS = 86_400_000;
  let now = Date.UTC(2026, 2, 1, 12);
  // Learn each card (Good twice through the 1m/10m steps), then review on later days.
  for (const cid of cids) for (let i = 0; i < 2; i++) await col.answer((await col.studyCard(cid, now))!, 3, 1000, (now += 11 * 60_000));
  for (let day = 0; day < 4; day++) {
    now += 6 * DAYS;
    for (const [i, cid] of cids.entries()) {
      const s = (await col.studyCard(cid, now))!;
      await col.answer(s, ((i + day) % 4 === 0 ? 1 : 3) as Rating, 1000, now);
      if ((i + day) % 4 === 0) await col.answer((await col.studyCard(cid, now + 11 * 60_000))!, 3, 1000, now + 11 * 60_000);
    }
  }
  const presetId = (await col.deck(deckId))!.conf_id;
  const data = await col.fsrsTrainingData(presetId, { nowMs: now });
  ok('training data: one item per interday review', data.items.length === cids.length * 4, data.items.length);
  ok('training data: card ids line up', data.cardIds.length === data.items.length && data.cardIds.every((c) => cids.includes(c)));
  await col.buryOrSuspend([cids[0]], 'suspend');
  ok('suspended cards are left out (Anki: -is:suspended)', (await col.fsrsTrainingData(presetId, { nowMs: now })).items.length === (cids.length - 1) * 4);
  ok('the ignore date leaves out cards learnt before it', (await col.fsrsTrainingData(presetId, { nowMs: now, ignoreRevlogsBeforeDate: '2026-12-31' })).items.length === 0);

  // New parameters → every reviewed card's memory state follows them.
  const cfg = (await col.deckConfigMap()).get(presetId)!;
  const params = [...DEFAULT_PARAMETERS];
  params[8] = 2.2;
  await col.updateDeckConfig(presetId, 'Default', { ...cfg, fsrsParams: params });
  const n = await col.updateMemoryStates(presetId, now);
  ok('memory states recomputed for every reviewed card', n === cids.length, n);
  const t = await col.timing(now);
  let match = true;
  for (const cid of cids) {
    const card = (await col.card(cid))!;
    const revlog = await sql.all<RevlogEntry>('SELECT * FROM revlog WHERE cid = ? ORDER BY id', [cid]);
    const m = memoryStateFromHistory(prepareParameters(params), revlog, t.nextDayAt, cfg.historicalRetention, card)!;
    if (Math.abs(card.stability! - m.stability) > 1e-9 || Math.abs(card.difficulty! - m.difficulty) > 1e-9) match = false;
  }
  ok('…matching a replay of each card’s history with the new parameters', match);
  await col.clearMemoryStates();
  ok('FSRS off clears memory states', (await sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM cards WHERE stability IS NOT NULL'))[0].n === 0);
}

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
