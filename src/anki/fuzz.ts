/**
 * Interval fuzz — a port of rslib/src/scheduler/states/fuzz.rs plus the seed/factor helpers from
 * rslib/src/scheduler/answering/mod.rs.
 *
 * The ranges and bounds are Anki's exactly. Anki draws the factor from Rust's `StdRng` seeded with
 * `card id + reps`; we use a different (but likewise deterministic, uniform) generator with the same
 * seed, so a given card at a given review always gets the same fuzz — just not the identical draw
 * Anki would make.
 */

const FUZZ_RANGES = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Number.MAX_VALUE, factor: 0.05 },
];

function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0;
  return FUZZ_RANGES.reduce((delta, r) => delta + r.factor * Math.max(0, Math.min(interval, r.end) - r.start), 1);
}

export function fuzzBounds(interval: number): [number, number] {
  const delta = fuzzDelta(interval);
  return [Math.round(interval - delta), Math.round(interval + delta)];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The fuzz range, respecting `minimum` and `maximum`. */
export function constrainedFuzzBounds(interval: number, minimum: number, maximum: number): [number, number] {
  minimum = Math.min(minimum, maximum);
  interval = clamp(interval, minimum, maximum);
  let [lower, upper] = fuzzBounds(interval);
  lower = clamp(lower, minimum, maximum);
  upper = clamp(upper, minimum, maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}

export function withReviewFuzz(fuzzFactor: number | null, interval: number, minimum: number, maximum: number): number {
  if (fuzzFactor != null) {
    const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum);
    return Math.floor(lower + fuzzFactor * (1 + upper - lower));
  }
  return clamp(Math.round(interval), minimum, maximum);
}

/** Minimum interval when fuzzing a review, based on the previously scheduled interval. */
export function minimumReviewFuzzInterval(interval: number, previousInterval: number, maximumInterval: number): number {
  const rounded = Math.round(interval);
  const [, upper] = constrainedFuzzBounds(interval, 1, maximumInterval);
  if (rounded > previousInterval) return previousInterval + 1;
  if (previousInterval <= upper) return previousInterval;
  return 0;
}

// ---- Deterministic randomness ------------------------------------------------

/** SplitMix64 over a 64-bit seed; returns a float in [0, 1). */
export function seededUnit(seed: number): number {
  let x = BigInt.asUintN(64, BigInt(Math.trunc(seed)) + 0x9e3779b97f4a7c15n);
  x = BigInt.asUintN(64, (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n);
  x = BigInt.asUintN(64, (x ^ (x >> 27n)) * 0x94d049bb133111ebn);
  x = x ^ (x >> 31n);
  return Number(x >> 11n) / 2 ** 53;
}

let fuzzEnabled = true;
/** Tests turn fuzz off, as Anki's own test suites do. */
export function setFuzzEnabled(on: boolean): void {
  fuzzEnabled = on;
}

/** Anki `get_fuzz_seed`: card id + reps (reps − 1 when re-deriving a past review); null when fuzz is off. */
export function fuzzSeed(cardId: number, reps: number): number | null {
  return fuzzEnabled ? cardId + Math.max(0, reps) : null;
}

export function fuzzFactor(seed: number | null): number | null {
  return seed == null ? null : seededUnit(seed);
}

/** Anki `learning_ivl_with_fuzz`: add up to 25% (max 5 minutes) to a learning delay. */
export function learningIvlWithFuzz(seed: number | null, secs: number): number {
  if (seed == null) return secs;
  const upperExclusive = secs + Math.floor(Math.min(secs * 0.25, 300));
  if (secs >= upperExclusive) return secs;
  // A second, independent draw from the same seed.
  return secs + Math.floor(seededUnit(seed * 2 + 1) * (upperExclusive - secs));
}
