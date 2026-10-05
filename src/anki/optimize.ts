import * as Comlink from 'comlink';
import { col } from './appCollection';
import { prepareParameters } from './fsrs';
import type { OptimizeResult } from './fsrsOptimizer';
import type { OptimizerWorkerApi } from './optimizer.worker';
import type { DeckConfig } from './types';

/** Reviews below this: Anki optimizes anyway but the result is unreliable, so warn. */
export const FEW_REVIEWS = 400;

export interface OptimizeOutcome extends OptimizeResult {
  items: number;
  reviews: number;
}

/**
 * Optimize a preset's FSRS parameters from its review history, as Anki's "Optimize" button does.
 * Training runs in a worker; `signal` aborts it. The config isn't saved here — the caller shows the
 * result and saves it with the rest of the deck options.
 */
export async function optimizePreset(presetId: number, config: DeckConfig, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<OptimizeOutcome | null> {
  const data = await col.fsrsTrainingData(presetId, { ignoreRevlogsBeforeDate: config.ignoreRevlogsBeforeDate });
  if (data.items.length === 0) return null;
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  const abort = () => worker.terminate();
  signal?.addEventListener('abort', abort);
  try {
    const api = Comlink.wrap<OptimizerWorkerApi>(worker);
    const result = await Promise.race([
      api.optimize(data.items, data.cardIds, Math.max(config.relearnSteps.length, 1), config.fsrsParams, Comlink.proxy(onProgress)),
      new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))),
    ]);
    return { ...result, items: data.items.length, reviews: data.reviewCount };
  } finally {
    signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
}

/** Anki's "Evaluate": how well parameters predict this preset's reviews. */
export async function evaluatePreset(presetId: number, config: DeckConfig, params: number[]): Promise<{ logLoss: number; rmseBins: number; items: number } | null> {
  const data = await col.fsrsTrainingData(presetId, { ignoreRevlogsBeforeDate: config.ignoreRevlogsBeforeDate });
  if (data.items.length === 0) return null;
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  try {
    const api = Comlink.wrap<OptimizerWorkerApi>(worker);
    return { ...(await api.evaluate(data.items, prepareParameters(params))), items: data.items.length };
  } finally {
    worker.terminate();
  }
}
