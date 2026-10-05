import * as Comlink from 'comlink';
import type { FsrsItem } from './fsrs';
import { chooseParameters, computeParameters, evaluate, type OptimizeResult } from './fsrsOptimizer';

/** Runs the FSRS optimizer off the UI thread (cancel by terminating the worker). */
const api = {
  optimize(
    items: FsrsItem[],
    cardIds: number[],
    numRelearningSteps: number,
    currentParams: number[],
    onProgress: (fraction: number) => void,
  ): OptimizeResult {
    let last = 0;
    const optimized = computeParameters({
      items,
      cardIds,
      numRelearningSteps,
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          onProgress(done / total);
        }
      },
    });
    return chooseParameters(currentParams, optimized, items, numRelearningSteps);
  },
  evaluate(items: FsrsItem[], params: number[]) {
    return evaluate(params, items);
  },
};

export type OptimizerWorkerApi = typeof api;
Comlink.expose(api);
