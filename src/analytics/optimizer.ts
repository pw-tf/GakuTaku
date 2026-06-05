import * as Comlink from 'comlink';
import { db } from '../sync/system';
import { deckConfig, serializeDeckConfig } from '../srs/fsrs';
import type { OptimizerApi, TrainingSet } from './optimizer.worker';

/**
 * Main-thread driver for the FSRS optimizer (build plan M5). Reads a deck's append-only review_logs,
 * shapes them into per-card sequences, trains weights in {@link optimizer.worker}, and writes the
 * result back to `decks.fsrs_params`. `scheduler()` already applies `cfg.w` (src/srs/fsrs.ts), so
 * optimized weights take effect on the next review with no other wiring.
 */

const DAY_MS = 86_400_000;

/** fsrs-rs fits poorly on tiny histories; gate optimization until there's enough signal. */
export const MIN_REVIEWS_TO_OPTIMIZE = 400;

let workerApi: Comlink.Remote<OptimizerApi> | null = null;
function optimizer(): Comlink.Remote<OptimizerApi> {
  if (!workerApi) {
    const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap<OptimizerApi>(worker);
  }
  return workerApi;
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
    if (!r.card_id || r.rating == null || !r.review_time) continue;
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
    cardCount++;
    let prevMs: number | null = null;
    for (const log of logs) {
      const t = new Date(log.review_time).getTime();
      const delta = prevMs === null ? 0 : Math.max(0, Math.round((t - prevMs) / DAY_MS));
      ratings.push(log.rating);
      deltaTs.push(delta);
      prevMs = t;
      reviewCount++;
    }
    lengths.push(logs.length);
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

/** Optimize one deck's FSRS weights from its review_logs and persist them to `decks.fsrs_params`. */
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

  const { set, reviewCount } = buildTrainingSet(rows);
  if (reviewCount < MIN_REVIEWS_TO_OPTIMIZE) {
    return { ok: false, reason: `Need at least ${MIN_REVIEWS_TO_OPTIMIZE} reviews — this deck has ${reviewCount}.`, reviewCount };
  }

  let weights: number[];
  try {
    weights = await optimizer().train(set);
  } catch (e) {
    return { ok: false, reason: `Optimization failed: ${(e as Error)?.message ?? String(e)}`, reviewCount };
  }
  if (!weights?.length || weights.some((w) => !Number.isFinite(w))) {
    return { ok: false, reason: 'Optimizer returned invalid weights.', reviewCount };
  }

  // Merge into the deck's existing config so newPerDay / steps are preserved.
  const deck = await db.getOptional<{ fsrs_params: string | null }>(`SELECT fsrs_params FROM decks WHERE id = ?`, [deckId]);
  const cfg = deckConfig({ fsrs_params: deck?.fsrs_params ?? null });
  cfg.w = weights;
  await db.execute(`UPDATE decks SET fsrs_params = ? WHERE id = ?`, [serializeDeckConfig(cfg), deckId]);

  return { ok: true, weights, reviewCount };
}
