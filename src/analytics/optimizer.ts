import * as Comlink from 'comlink';
import { db } from '../sync/system';
import { deckConfig, serializeDeckConfig } from '../srs/fsrs';
import { parsePresetConfig, serializePresetConfig } from '../srs/presets';
import type { OptimizerApi, TrainingSet } from './optimizer.worker';

/**
 * Main-thread driver for the FSRS optimizer (build plan M5). Reads the append-only review_logs,
 * shapes them into per-card sequences, trains weights in {@link optimizer.worker}, and writes the
 * result back. Like Anki, FSRS weights live on the deck options *preset*: {@link optimizePreset}
 * trains on the combined history of every deck using the preset and stores `w` in its config.
 * `scheduler()` already applies `cfg.w` (src/srs/fsrs.ts), so optimized weights take effect on the
 * next review with no other wiring. {@link optimizeDeck} remains for legacy decks without a preset.
 */

const DAY_MS = 86_400_000;

let workerInstance: Worker | null = null;
let workerApi: Comlink.Remote<OptimizerApi> | null = null;
function optimizer(): Comlink.Remote<OptimizerApi> {
  if (!workerApi) {
    workerInstance = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap<OptimizerApi>(workerInstance);
  }
  return workerApi;
}

/** A Rust panic poisons the wasm module/thread pool — drop the worker so the next attempt starts clean. */
function resetOptimizer(): void {
  workerInstance?.terminate();
  workerInstance = null;
  workerApi = null;
}

interface LogRow {
  card_id: string;
  rating: number;
  review_time: string;
}

/**
 * Group logs by card (chronological) into the flattened arrays fsrs-rs expects. One sequence per
 * card — fsrs-rs expands prefixes itself. Cards with <2 reviews are skipped (no prediction target).
 */
export function buildTrainingSet(rows: LogRow[]): { set: TrainingSet; reviewCount: number; cardCount: number } {
  const byCard = new Map<string, LogRow[]>();
  for (const r of rows) {
    // rating < 1 rows are manual events (forget / set due date), not reviews — fsrs-rs only
    // understands the four answer grades.
    if (!r.card_id || r.rating == null || r.rating < 1 || !r.review_time) continue;
    const arr = byCard.get(r.card_id) ?? [];
    arr.push(r);
    byCard.set(r.card_id, arr);
  }

  const ratings: number[] = [];
  const deltaTs: number[] = [];
  const lengths: number[] = [];
  let reviewCount = 0;
  let cardCount = 0;

  for (const logs of byCard.values()) {
    if (logs.length < 2) continue;
    logs.sort((a, b) => a.review_time.localeCompare(b.review_time));

    const cardRatings: number[] = [];
    const cardDeltas: number[] = [];
    let prevMs: number | null = null;
    let hasSpaced = false;
    for (const log of logs) {
      const t = new Date(log.review_time).getTime();
      const delta = prevMs === null ? 0 : Math.max(0, Math.round((t - prevMs) / DAY_MS));
      if (delta > 0) hasSpaced = true;
      cardRatings.push(log.rating);
      cardDeltas.push(delta);
      prevMs = t;
    }
    // fsrs-rs learns the forgetting curve from intervals, so it requires at least one review with
    // delta_t > 0 (a real gap of ≥1 day). A card reviewed only within a single day contributes none
    // and makes the trainer panic — skip it. (If every card is same-day, the set ends up empty and
    // optimizeDeck reports it gracefully instead of crashing.)
    if (!hasSpaced) continue;

    for (let i = 0; i < logs.length; i++) {
      ratings.push(cardRatings[i]);
      deltaTs.push(cardDeltas[i]);
      reviewCount++;
    }
    lengths.push(logs.length);
    cardCount++;
  }

  return {
    set: {
      ratings: Uint32Array.from(ratings),
      deltaTs: Uint32Array.from(deltaTs),
      lengths: Uint32Array.from(lengths),
    },
    reviewCount,
    cardCount,
  };
}

export interface OptimizeResult {
  ok: boolean;
  reason?: string;
  weights?: number[];
  reviewCount: number;
}

/** Train weights from a set of log rows; shared by the preset and legacy-deck paths. */
async function trainWeights(rows: LogRow[]): Promise<OptimizeResult> {
  const { set, reviewCount, cardCount } = buildTrainingSet(rows);
  if (cardCount === 0) {
    return {
      ok: false,
      reason: 'No spaced reviews yet — FSRS needs cards reviewed across multiple days before it can optimize.',
      reviewCount,
    };
  }
  // No minimum review count, matching current Anki: with little data fsrs-rs falls back to
  // pretraining only the initial-stability parameters (or the defaults), so it's always safe to run.

  let weights: number[];
  try {
    weights = await optimizer().train(set);
  } catch (e) {
    resetOptimizer();
    return { ok: false, reason: `Optimization failed: ${(e as Error)?.message ?? String(e)}`, reviewCount };
  }
  if (!weights?.length || weights.some((w) => !Number.isFinite(w))) {
    return { ok: false, reason: 'Optimizer returned invalid weights.', reviewCount };
  }
  return { ok: true, weights, reviewCount };
}

/**
 * Optimize a preset's FSRS weights from the review history of every deck using it, and persist
 * them into `deck_presets.config` — Anki's model exactly (FSRS params belong to the options group).
 */
export async function optimizePreset(presetId: string): Promise<OptimizeResult> {
  const rows = await db.getAll<LogRow>(
    `SELECT rl.card_id, rl.rating, rl.review_time
     FROM review_logs rl
     JOIN cards c ON c.id = rl.card_id
     JOIN notes n ON n.id = c.note_id
     JOIN decks d ON d.id = n.deck_id
     WHERE d.preset_id = ? AND rl.review_time IS NOT NULL
     ORDER BY rl.review_time ASC`,
    [presetId],
  );
  const result = await trainWeights(rows);
  if (!result.ok || !result.weights) return result;

  const preset = await db.getOptional<{ config: string | null }>(`SELECT config FROM deck_presets WHERE id = ?`, [presetId]);
  const cfg = parsePresetConfig(preset?.config);
  cfg.w = result.weights;
  await db.execute(`UPDATE deck_presets SET config = ? WHERE id = ?`, [serializePresetConfig(cfg), presetId]);
  return result;
}

/** Legacy path: optimize a preset-less deck from its own logs into `decks.fsrs_params`. */
export async function optimizeDeck(deckId: string): Promise<OptimizeResult> {
  const rows = await db.getAll<LogRow>(
    `SELECT rl.card_id, rl.rating, rl.review_time
     FROM review_logs rl
     JOIN cards c ON c.id = rl.card_id
     JOIN notes n ON n.id = c.note_id
     WHERE n.deck_id = ? AND rl.review_time IS NOT NULL
     ORDER BY rl.review_time ASC`,
    [deckId],
  );
  const result = await trainWeights(rows);
  if (!result.ok || !result.weights) return result;

  // Merge into the deck's existing config so newPerDay / steps are preserved.
  const deck = await db.getOptional<{ fsrs_params: string | null }>(`SELECT fsrs_params FROM decks WHERE id = ?`, [deckId]);
  const cfg = deckConfig({ fsrs_params: deck?.fsrs_params ?? null });
  cfg.w = result.weights;
  await db.execute(`UPDATE decks SET fsrs_params = ? WHERE id = ?`, [serializeDeckConfig(cfg), deckId]);
  return result;
}
