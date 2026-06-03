import * as Comlink from 'comlink';
import type { JpCoreApi } from './worker';

/**
 * Main-thread handle to the jp-core Web Worker (tokenizer + dictionary). The worker keeps the
 * CPU-heavy tokenization and IndexedDB queries off the UI thread (build plan §3.4).
 */
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

export const jpCore = Comlink.wrap<JpCoreApi>(worker);

/** Helper to pass a progress callback across the Comlink boundary. */
export { proxy } from 'comlink';
