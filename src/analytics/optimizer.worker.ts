import * as Comlink from 'comlink';
import init, { Fsrs, initThreadPool } from 'fsrs-browser/fsrs_browser';

/**
 * FSRS parameter optimizer worker (build plan M5). Wraps `fsrs-browser` (fsrs-rs compiled to wasm)
 * and trains FSRS weights from the user's review history. Runs in a Web Worker so the synchronous
 * `computeParameters` call — which blocks its thread until the rayon pool finishes — never freezes
 * the UI. fsrs-rs expands each card's full sequence into prefix training items internally, so the
 * caller passes one flattened sequence per card (see optimizer.ts `buildTrainingSet`).
 */

/** Flattened per-card review sequences: `ratings`/`deltaTs` concatenated, split by `lengths`. */
export interface TrainingSet {
  ratings: Uint32Array;
  deltaTs: Uint32Array; // days since the previous review (first review of a card = 0)
  lengths: Uint32Array; // review count per card
}

let booted: Promise<void> | null = null;
function boot(): Promise<void> {
  if (!booted) {
    booted = (async () => {
      await init();
      // Rayon thread pool — relies on SharedArrayBuffer, hence the cross-origin isolation headers
      // configured in vite.config.ts / public/_headers. Cap threads to keep memory reasonable.
      await initThreadPool(Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 8)));
    })();
  }
  return booted;
}

const api = {
  /** Train and return the optimized FSRS weight vector. `enable_short_term` mirrors our scheduler. */
  async train(set: TrainingSet): Promise<number[]> {
    await boot();
    const fsrs = new Fsrs();
    const weights = fsrs.computeParameters(set.ratings, set.deltaTs, set.lengths, undefined, true);
    return Array.from(weights);
  },
};

export type OptimizerApi = typeof api;
Comlink.expose(api);
