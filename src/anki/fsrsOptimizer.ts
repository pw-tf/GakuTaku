/**
 * The FSRS optimizer: a port of fsrs-rs 6.6.2 (the version Anki pins) — `compute_parameters`,
 * its analytic loss/gradient (`analytic.rs`), outlier filtering and recency weighting
 * (`dataset.rs`), initial-stability search (`parameter_initialization.rs`), parameter clipping,
 * cosine-annealed Adam (`training.rs`), and `FSRS::evaluate` for Anki's "keep the better
 * parameters" check.
 *
 * Parameters are held as f32 like fsrs-rs; the arithmetic runs in f64. The only intended difference
 * from fsrs-rs is the batch-shuffle RNG (fsrs-rs uses rand's ChaCha12), so optimized parameters are
 * statistically, not bit-for-bit, the same as Anki's.
 */
import { DEFAULT_PARAMETERS, nextStates, prepareParameters, type FsrsItem } from './fsrs';

const S_MIN = 0.001;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;
const INIT_S_MAX = 100;
const MIN_PROB = Math.fround(1e-7);
const MAX_PROB = Math.fround(1 - 1e-7);

const PARAMS_STDDEV = [
  6.43, 9.66, 17.58, 27.85, 0.57, 0.28, 0.6, 0.12, 0.39, 0.18, 0.33, 0.3, 0.09, 0.16, 0.57, 0.25, 1.03, 0.31, 0.32, 0.14, 0.27,
].map(Math.fround);

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
/** Burn/PyTorch clamp gradient: passes on the boundary, stops outside it. */
const clampGrad = (x: number, lo: number, hi: number) => (x >= lo && x <= hi ? 1 : 0);

// ---- Items ----------------------------------------------------------------------------------

const current = (item: FsrsItem) => item.reviews[item.reviews.length - 1];
export const longTermReviewCount = (item: FsrsItem) => item.reviews.reduce((n, r) => n + (r.deltaT > 0 ? 1 : 0), 0);
const firstLongTermReview = (item: FsrsItem) => item.reviews.find((r) => r.deltaT > 0)!;

interface WeightedItem {
  weight: number;
  cardId: number;
  item: FsrsItem;
}

// ---- Analytic loss and gradient (analytic.rs) -----------------------------------------------

interface Runtime {
  w: Float32Array;
  decay: number;
  factor: number;
  dfactorDdecay: number;
  expW8: number;
  failureFloorDivisor: number;
  easyD: number;
  exp3w5: number;
}

const initDifficulty = (w: ArrayLike<number>, rating: number) => w[4] - Math.exp(w[5] * Math.max(rating - 1, 0)) + 1;

function runtime(w: Float32Array): Runtime {
  const decay = -w[20];
  const c = Math.log(0.9);
  return {
    w,
    decay,
    factor: Math.exp(c / decay) - 1,
    dfactorDdecay: Math.exp(c / decay) * (-c / (decay * decay)),
    expW8: Math.exp(w[8]),
    failureFloorDivisor: Math.exp(w[17] * w[18]),
    easyD: initDifficulty(w, 4),
    exp3w5: Math.exp(3 * w[5]),
  };
}

interface Curve {
  t: number;
  s: number;
  base: number;
  r: number;
}

function curveForward(p: Runtime, t: number, s: number): Curve {
  t = Math.max(t, 0);
  const base = (t / s) * p.factor + 1;
  return { t, s, base, r: Math.pow(base, p.decay) };
}

/** Accumulates dL/dw20; returns dL/ds. */
function curveBackward(p: Runtime, c: Curve, gR: number, gw: Float64Array): number {
  if (gR === 0) return 0;
  const dbDs = (-c.t * p.factor) / (c.s * c.s);
  const gS = ((gR * c.r * p.decay) / c.base) * dbDs;
  const dbDdecay = (c.t / c.s) * p.dfactorDdecay;
  const drDdecay = c.r * (Math.log(c.base) + (p.decay / c.base) * dbDdecay);
  gw[20] += -gR * drDdecay;
  return gS;
}

function bce(rRaw: number, label: number, weight: number): [number, number] {
  if (weight === 0) return [0, 0];
  const r = clamp(rRaw, MIN_PROB, MAX_PROB);
  const loss = -(label * Math.log(r) + (1 - label) * Math.log(1 - r)) * weight;
  const grad = -weight * (label / r - (1 - label) / (1 - r));
  return [loss, rRaw > MIN_PROB && rRaw < MAX_PROB ? grad : 0];
}

interface Step {
  stateS: number;
  stateD: number;
  lastS: number;
  lastD: number;
  deltaT: number;
  rating: number;
  r: number;
  failureRaw: number;
  failureFloor: number;
  failureUsedFloor: boolean;
  shortRaw: number;
  shortValue: number;
  shortRawActive: boolean;
  useShort: boolean;
  useFailure: boolean;
  init: boolean;
  padding: boolean;
  preClampS: number;
  meanPreClampD: number;
  initRating: number;
}

function stepForward(p: Runtime, s0: number, d0: number, deltaT: number, rating: number, nth: number): { s: number; d: number; c: Step } {
  const w = p.w;
  const lastS = clamp(s0, S_MIN, S_MAX);
  const lastD = clamp(d0, D_MIN, D_MAX);
  const c: Step = {
    stateS: s0, stateD: d0, lastS, lastD, deltaT, rating, r: 0, failureRaw: 0, failureFloor: 0, failureUsedFloor: false,
    shortRaw: 0, shortValue: 0, shortRawActive: false, useShort: false, useFailure: false, init: false, padding: false,
    preClampS: lastS, meanPreClampD: lastD, initRating: 1,
  };
  if (rating === 0) {
    c.padding = true;
    return { s: lastS, d: lastD, c };
  }
  const initRating = Math.trunc(clamp(rating, 1, 4));
  c.initRating = initRating;
  if (nth === 0 && s0 === 0) {
    const newS = w[initRating - 1];
    const rawD = initDifficulty(w, initRating);
    c.init = true;
    c.preClampS = newS;
    c.meanPreClampD = rawD;
    return { s: clamp(newS, S_MIN, S_MAX), d: clamp(rawD, D_MIN, D_MAX), c };
  }

  const r = curveForward(p, deltaT, lastS).r;
  c.r = r;
  c.useShort = deltaT === 0;
  c.useFailure = rating === 1;
  let newS: number;
  if (c.useShort) {
    c.shortRaw = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(lastS, -w[19]);
    c.shortRawActive = !(rating >= 2 && c.shortRaw < 1);
    c.shortValue = rating >= 2 ? Math.max(c.shortRaw, 1) : c.shortRaw;
    newS = lastS * c.shortValue;
  } else if (c.useFailure) {
    c.failureRaw = w[11] * Math.pow(lastD, -w[12]) * (Math.pow(lastS + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
    c.failureFloor = lastS / p.failureFloorDivisor;
    c.failureUsedFloor = c.failureFloor < c.failureRaw;
    newS = c.failureUsedFloor ? c.failureFloor : c.failureRaw;
  } else {
    const hard = rating === 2 ? w[15] : 1;
    const easy = rating === 4 ? w[16] : 1;
    const inc = p.expW8 * (11 - lastD) * Math.pow(lastS, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy;
    newS = lastS * (inc + 1);
  }
  const deltaD = -w[6] * (rating - 3);
  const nextD = lastD + ((10 - lastD) * deltaD) / 9;
  const meanD = w[7] * (p.easyD - nextD) + nextD;
  c.preClampS = newS;
  c.meanPreClampD = meanD;
  return { s: clamp(newS, S_MIN, S_MAX), d: clamp(meanD, D_MIN, D_MAX), c };
}

function backwardSuccess(p: Runtime, c: Step, g: number, gw: Float64Array): [number, number, number] {
  if (g === 0) return [0, 0, 0];
  const w = p.w;
  const s = c.lastS;
  const d = c.lastD;
  const r = c.r;
  const a = p.expW8;
  const b = 11 - d;
  const cs = Math.pow(s, -w[9]);
  const expE = Math.exp((1 - r) * w[10]);
  const e = expE - 1;
  const hp = c.rating === 2 ? w[15] : 1;
  const eb = c.rating === 4 ? w[16] : 1;
  const inc = a * b * cs * e * hp * eb;
  const gInc = g * s;
  let gS = g * (inc + 1);
  gS += gInc * inc * (-w[9] / s);
  const gD = -(gInc * a * cs * e * hp * eb);
  const gR = gInc * a * b * cs * hp * eb * (-w[10] * expE);
  gw[8] += gInc * inc;
  gw[9] += gInc * inc * -Math.log(s);
  gw[10] += gInc * a * b * cs * hp * eb * ((1 - r) * expE);
  if (c.rating === 2) gw[15] += gInc * a * b * cs * e * eb;
  if (c.rating === 4) gw[16] += gInc * a * b * cs * e * hp;
  return [gS, gD, gR];
}

function backwardFailure(p: Runtime, c: Step, g: number, gw: Float64Array): [number, number, number] {
  if (g === 0) return [0, 0, 0];
  const w = p.w;
  const s = c.lastS;
  const d = c.lastD;
  const r = c.r;
  if (c.failureUsedFloor) {
    const floor = c.failureFloor;
    gw[17] += g * floor * -w[18];
    gw[18] += g * floor * -w[17];
    return [(g * floor) / s, 0, 0];
  }
  const raw = c.failureRaw;
  const base = s + 1;
  const pw = Math.pow(base, w[13]);
  const lastDPow = Math.pow(d, -w[12]);
  const er = Math.exp((1 - r) * w[14]);
  gw[11] += (g * raw) / w[11];
  gw[12] += g * raw * -Math.log(d);
  gw[13] += g * w[11] * lastDPow * er * pw * Math.log(base);
  gw[14] += g * raw * (1 - r);
  return [(g * w[11] * lastDPow * er * w[13] * pw) / base, g * raw * (-w[12] / d), g * raw * -w[14]];
}

function backwardShort(p: Runtime, c: Step, g: number, gw: Float64Array): number {
  if (g === 0) return 0;
  const w = p.w;
  const s = c.lastS;
  let gS = g * c.shortValue;
  if (c.shortRawActive) {
    const gRaw = g * s;
    const raw = c.shortRaw;
    gw[17] += gRaw * raw * (c.rating - 3 + w[18]);
    gw[18] += gRaw * raw * w[17];
    gw[19] += gRaw * raw * -Math.log(s);
    gS += gRaw * raw * (-w[19] / s);
  }
  return gS;
}

function backwardDifficulty(p: Runtime, c: Step, gOut: number, gw: Float64Array): number {
  if (gOut === 0) return 0;
  const w = p.w;
  const gMean = gOut * clampGrad(c.meanPreClampD, D_MIN, D_MAX);
  if (gMean === 0) return 0;
  const rm3 = c.rating - 3;
  const lastD = c.lastD;
  const deltaD = -w[6] * rm3;
  const nextD = lastD + ((10 - lastD) * deltaD) / 9;
  gw[7] += gMean * (p.easyD - nextD);
  gw[4] += gMean * w[7];
  gw[5] += gMean * w[7] * -3 * p.exp3w5;
  const gNext = gMean * (1 - w[7]);
  gw[6] += (gNext * (10 - lastD) * -rm3) / 9;
  return gNext * (1 - deltaD / 9);
}

function backwardInit(p: Runtime, rating: number, gS: number, gD: number, gw: Float64Array) {
  const w = p.w;
  gw[rating - 1] += gS;
  const gRawD = gD * clampGrad(initDifficulty(w, rating), D_MIN, D_MAX);
  if (gRawD !== 0) {
    const offset = rating - 1;
    gw[4] += gRawD;
    gw[5] += gRawD * -offset * Math.exp(offset * w[5]);
  }
}

function stepBackward(p: Runtime, c: Step, gOutS: number, gOutD: number, gRExtra: number, gw: Float64Array): [number, number] {
  const gPreS = gOutS * clampGrad(c.preClampS, S_MIN, S_MAX);
  let gLastS = 0;
  let gLastD = 0;
  let gR = gRExtra;
  if (c.padding) {
    gLastS += gPreS;
    gLastD += gOutD;
  } else if (c.init) {
    backwardInit(p, c.initRating, gPreS, gOutD, gw);
  } else {
    if (c.useShort) gLastS += backwardShort(p, c, gPreS, gw);
    else {
      const [gs, gd, gr] = c.useFailure ? backwardFailure(p, c, gPreS, gw) : backwardSuccess(p, c, gPreS, gw);
      gLastS += gs;
      gLastD += gd;
      gR += gr;
    }
    gLastD += backwardDifficulty(p, c, gOutD, gw);
  }
  const t = Math.max(c.deltaT, 0);
  gLastS += curveBackward(p, { t, s: c.lastS, base: (t / c.lastS) * p.factor + 1, r: c.r }, gR, gw);
  return [gLastS * clampGrad(c.stateS, S_MIN, S_MAX), gLastD * clampGrad(c.stateD, D_MIN, D_MAX)];
}

/** A batch in fsrs-rs's time-major layout (`idx = time * batchSize + column`). */
export interface Batch {
  seqLen: number;
  batchSize: number;
  realBatchSize: number;
  columnLengths: number[];
  t: Float32Array;
  r: Float32Array;
  /** Plain batches: the predicted review's delta_t, label and weight per column. */
  deltaTs: Float32Array;
  labels: Float32Array;
  weights: Float32Array;
  windowed: boolean;
}

/** Summed loss of a batch; adds its gradient into `gw`. */
export function batchLossAndGrad(w: Float32Array, b: Batch, gw: Float64Array): number {
  const p = runtime(w);
  let loss = 0;
  const caches: Step[] = [];
  const gRLosses: number[] = [];
  for (let col = 0; col < b.batchSize; col++) {
    const len = Math.min(b.columnLengths[col], b.seqLen);
    let s = 0;
    let d = 0;
    caches.length = 0;
    if (!b.windowed) {
      for (let t = 0; t < len; t++) {
        const idx = t * b.batchSize + col;
        const out = stepForward(p, s, d, b.t[idx], b.r[idx], t);
        s = out.s;
        d = out.d;
        caches.push(out.c);
      }
      const curve = curveForward(p, b.deltaTs[col], s);
      const [l, gR] = bce(curve.r, b.labels[col], b.weights[col]);
      loss += l;
      let gS = curveBackward(p, curve, gR, gw);
      let gD = 0;
      for (let i = caches.length - 1; i >= 0; i--) [gS, gD] = stepBackward(p, caches[i], gS, gD, 0, gw);
      continue;
    }
    // Windowed: one pass over the whole card scores every review after the first.
    gRLosses.length = len;
    gRLosses.fill(0);
    for (let t = 0; t < len; t++) {
      const idx = t * b.batchSize + col;
      if (t + 1 === len) {
        let finalGS = 0;
        if (t !== 0 && b.weights[idx] !== 0) {
          const curve = curveForward(p, b.t[idx], clamp(s, S_MIN, S_MAX));
          const [l, gR] = bce(curve.r, b.labels[idx], b.weights[idx]);
          loss += l;
          finalGS = curveBackward(p, curve, gR, gw) * clampGrad(s, S_MIN, S_MAX);
        }
        let gS = finalGS;
        let gD = 0;
        for (let i = caches.length - 1; i >= 0; i--) [gS, gD] = stepBackward(p, caches[i], gS, gD, gRLosses[i], gw);
        break;
      }
      const out = stepForward(p, s, d, b.t[idx], b.r[idx], t);
      if (t !== 0) {
        const [l, gR] = bce(out.c.r, b.labels[idx], b.weights[idx]);
        loss += l;
        gRLosses[t] = gR;
      }
      caches.push(out.c);
      s = out.s;
      d = out.d;
    }
  }
  return loss;
}

// ---- Batches (training.rs) ------------------------------------------------------------------

/** fsrs-rs `build_plain_batch`: one column per item (history → predicted review). */
export function buildPlainBatch(items: WeightedItem[]): Batch {
  const batchSize = items.length;
  const seqLen = Math.max(...items.map((x) => x.item.reviews.length - 1));
  const b: Batch = {
    seqLen, batchSize, realBatchSize: batchSize, columnLengths: [], windowed: false,
    t: new Float32Array(seqLen * batchSize), r: new Float32Array(seqLen * batchSize),
    deltaTs: new Float32Array(batchSize), labels: new Float32Array(batchSize), weights: new Float32Array(batchSize),
  };
  items.forEach((x, col) => {
    const rv = x.item.reviews;
    b.columnLengths.push(rv.length - 1);
    for (let t = 0; t < rv.length - 1; t++) {
      b.t[t * batchSize + col] = rv[t].deltaT;
      b.r[t * batchSize + col] = rv[t].rating;
    }
    const cur = current(x.item);
    b.deltaTs[col] = cur.deltaT;
    b.labels[col] = cur.rating > 1 ? 1 : 0;
    b.weights[col] = x.weight;
  });
  return b;
}

/** fsrs-rs `build_windowed_batch`: one column per card, labelling each of its items in place. */
function buildWindowedBatch(cards: WeightedItem[][]): Batch {
  const batchSize = cards.length;
  const seqLen = Math.max(...cards.map((c) => c[c.length - 1].item.reviews.length));
  const b: Batch = {
    seqLen, batchSize, realBatchSize: cards.reduce((n, c) => n + c.length, 0), columnLengths: [], windowed: true,
    t: new Float32Array(seqLen * batchSize), r: new Float32Array(seqLen * batchSize),
    deltaTs: new Float32Array(0), labels: new Float32Array(seqLen * batchSize), weights: new Float32Array(seqLen * batchSize),
  };
  cards.forEach((card, col) => {
    const full = card[card.length - 1].item.reviews;
    b.columnLengths.push(full.length);
    full.forEach((rv, t) => {
      b.t[t * batchSize + col] = rv.deltaT;
      b.r[t * batchSize + col] = rv.rating;
    });
    for (const x of card) {
      const idx = (x.item.reviews.length - 1) * batchSize + col;
      b.labels[idx] = current(x.item).rating > 1 ? 1 : 0;
      b.weights[idx] = x.weight;
    }
  });
  return b;
}

/** Stable sort by a numeric key (Rust's `sort_by_cached_key` is stable). */
const sortedBy = <T>(xs: T[], key: (x: T) => number) =>
  xs.map((x, i) => [key(x), i, x] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((e) => e[2]);

function buildBatches(items: WeightedItem[], batchSize: number): Batch[] {
  if (items.every((x) => x.cardId === -1)) {
    const sorted = sortedBy(items, (x) => x.item.reviews.length);
    const out: Batch[] = [];
    for (let i = 0; i < sorted.length; i += batchSize) out.push(buildPlainBatch(sorted.slice(i, i + batchSize)));
    return out;
  }
  const grouped = new Map<number, WeightedItem[]>();
  for (const x of items) (grouped.get(x.cardId) ?? grouped.set(x.cardId, []).get(x.cardId)!).push(x);
  const cards = sortedBy(
    [...grouped.keys()].sort((a, b) => a - b).map((k) => sortedBy(grouped.get(k)!, (x) => x.item.reviews.length)),
    (c) => c[c.length - 1].item.reviews.length,
  );
  const batches: Batch[] = [];
  let cur: WeightedItem[][] = [];
  let predictions = 0;
  for (const card of cards) {
    if (cur.length && predictions + card.length > batchSize) {
      batches.push(buildWindowedBatch(cur));
      cur = [];
      predictions = 0;
    }
    predictions += card.length;
    cur.push(card);
  }
  if (cur.length) batches.push(buildWindowedBatch(cur));
  return batches;
}

// ---- Optimizer pieces -----------------------------------------------------------------------

/** fsrs-rs `clip_parameters_in_place`. */
export function clipParameters(w: Float32Array, numRelearningSteps: number, enableShortTerm: boolean): void {
  const ceiling =
    numRelearningSteps > 1
      ? Math.min(Math.sqrt(Math.max(-(Math.log(w[11]) + Math.log(Math.pow(2, w[13]) - 1) + w[14] * 0.3) / numRelearningSteps, 0.01)), 2)
      : 2;
  const clamps: [number, number][] = [
    [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX],
    [D_MIN, D_MAX], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5],
    [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, ceiling], [0, ceiling], [enableShortTerm ? 0.01 : 0, 0.8], [0.1, 0.8],
  ];
  for (let i = 0; i < 21; i++) w[i] = clamp(w[i], Math.fround(clamps[i][0]), Math.fround(clamps[i][1]));
}

/** L2 pull towards the starting parameters (fsrs-rs `add_l2_gradient`). */
export function addL2Gradient(w: Float32Array, init: Float32Array, batchSize: number, totalSize: number, gamma: number, gw: Float64Array) {
  const scale = (gamma * batchSize) / totalSize;
  for (let i = 0; i < 21; i++) gw[i] += ((2 * (w[i] - init[i])) / (PARAMS_STDDEV[i] * PARAMS_STDDEV[i])) * scale;
}

export class Adam {
  private m = new Float64Array(21);
  private v = new Float64Array(21);
  private t = 0;
  step(w: Float32Array, grad: Float64Array, lr: number) {
    this.t++;
    const b1 = 1 - Math.pow(0.9, this.t);
    const b2 = 1 - Math.pow(0.999, this.t);
    for (let i = 0; i < 21; i++) {
      this.m[i] = 0.9 * this.m[i] + 0.1 * grad[i];
      this.v[i] = 0.999 * this.v[i] + 0.001 * grad[i] * grad[i];
      w[i] -= Math.fround((lr * (this.m[i] / b1)) / (Math.sqrt(this.v[i] / b2) + 1e-8));
    }
  }
}

/** fsrs-rs `CosineAnnealingLR` (eta_min 0). */
export class CosineAnnealing {
  private stepCount = -1;
  private lr: number;
  constructor(
    private readonly tMax: number,
    private readonly initLr: number,
  ) {
    this.lr = initLr;
  }
  step(): number {
    this.stepCount++;
    const n = this.stepCount;
    if (n === 0) this.lr = this.initLr;
    else if ((n - 1 - this.tMax) % (2 * this.tMax) === 0) this.lr = (this.initLr * (1 - Math.cos(Math.PI / this.tMax))) / 2;
    else this.lr = ((1 + Math.cos((Math.PI * n) / this.tMax)) / (1 + Math.cos((Math.PI * (n - 1)) / this.tMax))) * this.lr;
    return this.lr;
  }
}

// ---- Data preparation (dataset.rs) ----------------------------------------------------------

/** fsrs-rs `compute_outlier_analysis` → `prepare_training_data_with_card_ids`. */
export function prepareTrainingData(items: FsrsItem[], cardIds: number[]): { init: FsrsItem[]; train: FsrsItem[]; trainCardIds: number[] } {
  const groups = new Map<number, Map<number, number[]>>();
  items.forEach((item, i) => {
    if (longTermReviewCount(item) !== 1) return;
    const rating = item.reviews[0].rating;
    const dt = current(item).deltaT;
    const g = groups.get(rating) ?? groups.set(rating, new Map()).get(rating)!;
    (g.get(dt) ?? g.set(dt, []).get(dt)!).push(i);
  });
  const removed: Set<number>[] = [0, 1, 2, 3, 4].map(() => new Set());
  const keptInit: number[] = [];
  for (const rating of [...groups.keys()].sort((a, b) => a - b)) {
    // Largest groups first, ties by longer delta_t first; then walked smallest-first.
    const sub = [...groups.get(rating)!].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);
    const total = sub.reduce((n, [, xs]) => n + xs.length, 0);
    let removedCount = 0;
    for (let k = sub.length - 1; k >= 0; k--) {
      const [dt, xs] = sub[k];
      if (removedCount + xs.length >= Math.max(20, Math.floor(total / 20))) {
        if (xs.length >= 6 && dt <= (rating !== 4 ? 100 : 365)) keptInit.push(...xs);
        else removed[rating].add(dt);
      } else {
        removedCount += xs.length;
        removed[rating].add(dt);
      }
    }
  }
  const train: FsrsItem[] = [];
  const trainCardIds: number[] = [];
  items.forEach((item, i) => {
    if (!removed[item.reviews[0].rating]?.has(firstLongTermReview(item).deltaT)) {
      train.push(item);
      trainCardIds.push(cardIds[i]);
    }
  });
  return { init: keptInit.map((i) => items[i]), train, trainCardIds };
}

/** fsrs-rs `recency_weighted_fsrs_items_with_card_ids`: later reviews count up to 4× more. */
export function recencyWeighted(items: FsrsItem[], cardIds: number[] | null): WeightedItem[] {
  const length = Math.max(items.length - 1, 1);
  return items.map((item, i) => ({ weight: Math.fround(0.25 + 0.75 * Math.pow(i / length, 3)), cardId: cardIds ? cardIds[i] : -1, item }));
}

// ---- Initial stability (parameter_initialization.rs) ----------------------------------------

interface AverageRecall {
  deltaT: number;
  recall: number;
  count: number;
}

function curveDefault(t: number, s: number): number {
  const decay = -Math.fround(DEFAULT_PARAMETERS[20]);
  const factor = Math.pow(0.9, 1 / decay) - 1;
  return Math.pow((t / s) * factor + 1, decay);
}

export function initLoss(data: AverageRecall[], recall: number[], s0: number, defaultS0: number): number {
  let logloss = 0;
  data.forEach((d, i) => {
    const y = curveDefault(d.deltaT, s0);
    logloss += -(recall[i] * Math.log(y) + (1 - recall[i]) * Math.log(1 - y)) * d.count;
  });
  return logloss + Math.abs(s0 - defaultS0) / 16;
}

export function searchStability(data: AverageRecall[], averageRecall: number, defaultS0: number): number {
  const recall = data.map((d) => (d.recall * d.count + Math.fround(averageRecall)) / (d.count + 1));
  let low = S_MIN;
  let high = INIT_S_MAX;
  let best = defaultS0;
  for (let iter = 0; high - low > Number.EPSILON && iter < 1000; iter++) {
    const mid1 = low + (high - low) / 3;
    const mid2 = high - (high - low) / 3;
    if (initLoss(data, recall, mid1, defaultS0) < initLoss(data, recall, mid2, defaultS0)) high = mid2;
    else low = mid1;
    best = (high + low) / 2;
  }
  return Math.fround(best);
}

/** fsrs-rs `smooth_and_fill`: make S0 increase with the rating and infer missing ratings. */
export function smoothAndFill(stability: Map<number, number>, counts: Map<number, number>): number[] {
  for (const k of [...stability.keys()]) if (!counts.has(k)) stability.delete(k);
  for (const [small, big] of [[1, 2], [2, 3], [3, 4], [1, 3], [2, 4], [1, 4]]) {
    const sv = stability.get(small);
    const bv = stability.get(big);
    if (sv != null && bv != null && sv > bv) {
      if (counts.get(small)! > counts.get(big)!) stability.set(big, sv);
      else stability.set(small, bv);
    }
  }
  const w1 = 0.41;
  const w2 = 0.54;
  const P = (x: number, y: number) => Math.fround(Math.pow(x, y));
  const F = Math.fround;
  const defaults = DEFAULT_PARAMETERS.slice(0, 4).map(Math.fround);
  const a: (number | undefined)[] = [undefined, stability.get(1), stability.get(2), stability.get(3), stability.get(4)];
  let out: number[] = [];
  const has = (i: number) => a[i] != null;
  switch (stability.size) {
    case 0:
      throw new Error('Not enough data');
    case 1: {
      const rating = [...stability.keys()][0];
      const factor = F(stability.get(rating)! / defaults[rating - 1]);
      out = defaults.map((x) => F(x * factor)).sort((x, y) => x - y);
      break;
    }
    case 2: {
      const [r1, r2, r3, r4] = [a[1]!, a[2]!, a[3]!, a[4]!];
      const k = w1 - w1 * w2 + w2; // w1.mul_add(-w2, w1 + w2)
      if (!has(1) && !has(2) && has(3) && has(4)) {
        a[2] = F(P(r3, 1 / (1 - w2)) * P(r4, 1 - 1 / (1 - w2)));
        a[1] = F(P(a[2]!, 1 / w1) * P(r3, 1 - 1 / w1));
      } else if (!has(1) && has(2) && !has(3) && has(4)) {
        a[3] = F(P(r2, 1 - w2) * P(r4, w2));
        a[1] = F(P(r2, 1 / w1) * P(a[3]!, 1 - 1 / w1));
      } else if (!has(1) && has(2) && has(3) && !has(4)) {
        a[4] = F(P(r2, 1 - 1 / w2) * P(r3, 1 / w2));
        a[1] = F(P(r2, 1 / w1) * P(r3, 1 - 1 / w1));
      } else if (has(1) && !has(2) && !has(3) && has(4)) {
        a[2] = F(P(r1, w1 / k) * P(r4, 1 - w1 / k));
        a[3] = F(P(r1, 1 - w2 / k) * P(r4, w2 / k));
      } else if (has(1) && !has(2) && has(3) && !has(4)) {
        a[2] = F(P(r1, w1) * P(r3, 1 - w1));
        a[4] = F(P(a[2]!, 1 - 1 / w2) * P(r3, 1 / w2));
      } else if (has(1) && has(2) && !has(3) && !has(4)) {
        a[3] = F(P(r1, 1 - 1 / (1 - w1)) * P(r2, 1 / (1 - w1)));
        a[4] = F(P(r2, 1 - 1 / w2) * P(a[3]!, 1 / w2));
      }
      out = a.filter((x): x is number => x != null);
      break;
    }
    case 3: {
      if (!has(1) && has(2) && has(3)) a[1] = F(P(a[2]!, 1 / w1) * P(a[3]!, 1 - 1 / w1));
      else if (has(1) && !has(2) && has(3)) a[2] = F(P(a[1]!, w1) * P(a[3]!, 1 - w1));
      else if (has(2) && !has(3) && has(4)) a[3] = F(P(a[2]!, 1 - w2) * P(a[4]!, w2));
      else if (has(2) && has(3) && !has(4)) a[4] = F(P(a[2]!, 1 - 1 / w2) * P(a[3]!, 1 / w2));
      out = a.filter((x): x is number => x != null);
      break;
    }
    default:
      out = a.filter((x): x is number => x != null);
  }
  return out.slice(0, 4).map((v) => clamp(v, Math.fround(S_MIN), INIT_S_MAX));
}

/** fsrs-rs `initialize_stability_parameters`: S0 per first rating, fitted on first intervals. */
export function initializeStability(items: FsrsItem[], averageRecall: number): { s0: number[]; counts: Map<number, number> } {
  const groups = new Map<number, Map<number, number[]>>();
  for (const item of items) {
    if (longTermReviewCount(item) !== 1) continue;
    const first = item.reviews[0].rating;
    const lt = firstLongTermReview(item);
    const g = groups.get(first) ?? groups.set(first, new Map()).get(first)!;
    (g.get(lt.deltaT) ?? g.set(lt.deltaT, []).get(lt.deltaT)!).push(lt.rating > 1 ? 1 : 0);
  }
  const counts = new Map<number, number>();
  const stability = new Map<number, number>();
  for (const [rating, byDt] of groups) {
    const data: AverageRecall[] = [...byDt]
      .map(([dt, xs]) => ({ deltaT: dt, recall: xs.reduce((a, b) => a + b, 0) / xs.length, count: xs.length }))
      .sort((a, b) => a.deltaT - b.deltaT);
    counts.set(rating, data.reduce((n, d) => n + d.count, 0));
    stability.set(rating, searchStability(data, averageRecall, Math.fround(DEFAULT_PARAMETERS[rating - 1])));
  }
  return { s0: smoothAndFill(stability, counts), counts };
}

// ---- compute_parameters ---------------------------------------------------------------------

export interface OptimizeInput {
  items: FsrsItem[];
  cardIds: number[] | null;
  numRelearningSteps?: number;
  /** Anki trains for 8 epochs. */
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  /** Called after each batch; return false to stop. */
  onProgress?: (done: number, total: number) => boolean | void;
  /** Seed for the batch shuffle. */
  seed?: number;
}

/** A small deterministic RNG for the batch shuffle (splitmix32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

export class OptimizeCancelled extends Error {}

/** fsrs-rs `compute_parameters` with `enable_short_term: true`, as Anki calls it. */
export function computeParameters(input: OptimizeInput): number[] {
  const { items, numRelearningSteps = 1, epochs = 8, batchSize = 512, learningRate = 4e-2, seed = 2023 } = input;
  if (items.some((it) => it.reviews.length === 0 || it.reviews.some((r) => r.rating < 1 || r.rating > 4))) throw new Error('Invalid review history.');
  const cardIds = input.cardIds ?? items.map(() => -1);
  const { init, train, trainCardIds } = prepareTrainingData(items, cardIds);
  const averageRecall = train.length ? train.reduce((n, it) => n + (current(it).rating > 1 ? 1 : 0), 0) / train.length : 0;
  if (train.length < 8) return [...DEFAULT_PARAMETERS];

  const { s0, counts } = initializeStability(init, averageRecall);
  const initialized = [...s0, ...DEFAULT_PARAMETERS.slice(4)];
  if (train.length === init.length || train.length < 64) return initialized.map((x) => Math.fround(x));

  const initial = Float32Array.from(initialized);
  const weighted = recencyWeighted(train, input.cardIds ? trainCardIds : null).filter((x) => x.item.reviews.length <= 256);
  const total = weighted.length;
  const batches = buildBatches(weighted, batchSize);
  const lr = new CosineAnnealing((Math.floor(total / batchSize) + 1) * epochs, learningRate);
  const w = Float32Array.from(initial);
  const adam = new Adam();
  const random = rng(seed);
  const order = batches.map((_, i) => i);
  const grad = new Float64Array(21);
  let done = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const bi of order) {
      const b = batches[bi];
      const rate = lr.step();
      grad.fill(0);
      batchLossAndGrad(w, b, grad);
      addL2Gradient(w, initial, b.realBatchSize, total, 1, grad);
      adam.step(w, grad, rate);
      clipParameters(w, numRelearningSteps, true);
      done += b.realBatchSize;
      if (input.onProgress?.(Math.min(done, total * epochs), total * epochs) === false) throw new OptimizeCancelled('Cancelled');
    }
  }
  if (![...w].every(Number.isFinite)) throw new Error('Optimization failed (non-finite parameters).');
  const trained = new Map([1, 2, 3, 4].map((r) => [r, w[r - 1]] as [number, number]));
  return [...smoothAndFill(trained, counts), ...[...w].slice(4)];
}

// ---- Evaluation (inference.rs) --------------------------------------------------------------

/** Memory state after a review history (fsrs-rs `forward_reviews` from no state). */
function forward(w: Float32Array, reviews: FsrsItem['reviews']): number {
  if (reviews.length === 0) return 0;
  const p = runtime(w);
  const r0 = reviews[0].rating;
  let s = r0 === 0 ? S_MIN : clamp(w[clamp(r0, 1, 4) - 1], S_MIN, S_MAX);
  let d = r0 === 0 ? D_MIN : clamp(initDifficulty(w, clamp(r0, 1, 4)), D_MIN, D_MAX);
  for (let i = 1; i < reviews.length; i++) {
    const out = stepForward(p, s, d, reviews[i].deltaT, reviews[i].rating, i);
    s = out.s;
    d = out.d;
  }
  return s;
}

/** fsrs-rs `FSRS::evaluate`: recency-weighted log loss and binned RMSE of `params` on `items`. */
export function evaluate(params: readonly number[], items: FsrsItem[]): { logLoss: number; rmseBins: number } {
  if (!items.length) throw new Error('Not enough data');
  const w = Float32Array.from(params);
  const p = runtime(w);
  const weighted = recencyWeighted(items, null);
  let loss = 0;
  let weightSum = 0;
  const bins = new Map<string, { predicted: number; actual: number; count: number; weight: number }>();
  for (const { item, weight } of weighted) {
    const s = forward(w, item.reviews.slice(0, -1));
    const cur = current(item);
    const pr = curveForward(p, cur.deltaT, s).r;
    const y = cur.rating > 1 ? 1 : 0;
    loss += (y * Math.log(pr) + (1 - y) * Math.log(1 - pr)) * weight;
    weightSum += weight;
    const key = rMatrixIndex(item).join(',');
    const v = bins.get(key) ?? bins.set(key, { predicted: 0, actual: 0, count: 0, weight: 0 }).get(key)!;
    v.predicted += pr;
    v.actual += y;
    v.count++;
    v.weight += weight;
  }
  let num = 0;
  let den = 0;
  for (const v of bins.values()) {
    num += Math.pow(v.predicted / v.count - v.actual / v.count, 2) * v.weight;
    den += v.weight;
  }
  return { logLoss: -loss / weightSum, rmseBins: Math.sqrt(num / den) };
}

function rMatrixIndex(item: FsrsItem): [number, number, number] {
  const dt = current(item).deltaT;
  const logBase = (x: number, b: number) => Math.log(x) / Math.log(b);
  const dtBin = Math.round(2.48 * Math.pow(3.62, Math.floor(logBase(dt, 3.62))) * 100);
  const length = longTermReviewCount(item) + 1;
  const lengthBin = Math.round(1.99 * Math.pow(1.89, Math.floor(logBase(length, 1.89))));
  const lapses = item.reviews.slice(0, -1).filter((r) => r.rating === 1 && r.deltaT > 0).length;
  if (lapses === 0) return [dtBin, lengthBin, 0];
  return [dtBin, lengthBin, Math.round(1.65 * Math.pow(1.73, Math.floor(logBase(lapses, 1.73))))];
}

// ---- Anki's acceptance check (compute_params) -----------------------------------------------

export interface OptimizeResult {
  /** The parameters to use: the optimized ones, or the current ones if those fit better. */
  params: number[];
  /** True when the optimized parameters were rejected in favour of the current ones. */
  keptCurrent: boolean;
  currentLogLoss: number;
  optimizedLogLoss: number;
}

/**
 * Anki keeps the current parameters when they already predict the reviews at least as well. With
 * several relearning steps it only does so if the current parameters keep a lapsed card's
 * stability from growing through those steps.
 */
export function chooseParameters(current: readonly number[], optimized: number[], items: FsrsItem[], numRelearningSteps: number): OptimizeResult {
  const cur = prepareParameters(current);
  const currentLogLoss = evaluate(cur, items).logLoss;
  const optimizedLogLoss = evaluate(optimized, items).logLoss;
  let params = optimized;
  let keptCurrent = false;
  if (currentLogLoss <= optimizedLogLoss) {
    if (numRelearningSteps <= 1) keptCurrent = true;
    else {
      let s = nextStates(cur, { stability: 1, difficulty: 1 }, 0.9, 2).again.memory;
      for (let i = 0; i < numRelearningSteps; i++) s = nextStates(cur, s, 0.9, 0).good.memory;
      if (s.stability < 1) keptCurrent = true;
    }
  }
  if (keptCurrent) params = current.length ? [...current] : [...DEFAULT_PARAMETERS];
  return { params, keptCurrent, currentLogLoss, optimizedLogLoss };
}
