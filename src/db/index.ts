import * as Comlink from 'comlink';
import type { DbWorkerApi, ExecResult, OpenResult } from './worker';

/**
 * The app's database: one SQLite file on this device (see ./worker.ts), behind a small async API.
 *
 * All statements run one at a time through a single queue, so a transaction never interleaves with
 * other work. Code inside `writeTransaction` must use the `tx` it is given — calling `db.*` from
 * inside a transaction would wait on itself.
 *
 * Writes publish the set of tables they touched; {@link subscribe} (and the `useQuery` hook built on
 * it) re-runs only the queries that read those tables.
 */

type Params = unknown[];

export interface Tx {
  execute(sql: string, params?: Params): Promise<{ rows: Record<string, unknown>[] }>;
  executeMany(sql: string, rows: Params[]): Promise<void>;
  /** Run several statements in one round trip to the worker. */
  executeBatch(statements: { sql: string; params: Params }[]): Promise<void>;
  getAll<T>(sql: string, params?: Params): Promise<T[]>;
  getOptional<T>(sql: string, params?: Params): Promise<T | null>;
}

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'gakutaku-db' });
const remote = Comlink.wrap<DbWorkerApi>(worker);

let opened: Promise<OpenResult> | null = null;
/** Opens (and migrates) the database once; every call awaits the same result. */
export function openDb(): Promise<OpenResult> {
  opened ??= remote.open();
  return opened;
}

// ---- Serial queue -------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => undefined);
  return run;
}

// ---- Change notifications ------------------------------------------------------

type Listener = (tables: Set<string>) => void;
const listeners = new Set<Listener>();
let pending: Set<string> | null = null;

function publish(tables: Iterable<string>): void {
  const list = [...tables];
  if (list.length === 0) return;
  if (!pending) {
    pending = new Set();
    // Coalesce a burst of writes (an import's chunks, a transaction's statements) into one refresh.
    queueMicrotask(() => {
      const batch = pending!;
      pending = null;
      for (const l of listeners) l(batch);
    });
  }
  for (const t of list) pending.add(t);
}

/** Listen for committed changes; the callback receives the set of tables written. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- Public API ---------------------------------------------------------------

async function rawExec(sql: string, params: Params = []): Promise<ExecResult> {
  await openDb();
  return remote.exec(sql, params);
}

function makeTx(collect: Set<string>): Tx {
  const execute = async (sql: string, params: Params = []) => {
    const res = await rawExec(sql, params);
    for (const t of res.changed) collect.add(t);
    return { rows: res.rows };
  };
  return {
    execute,
    async executeMany(sql, rows) {
      await openDb();
      const res = await remote.execMany(sql, rows);
      for (const t of res.changed) collect.add(t);
    },
    async executeBatch(statements) {
      await openDb();
      const res = await remote.execBatch(statements);
      for (const t of res.changed) collect.add(t);
    },
    async getAll<T>(sql: string, params?: Params) {
      return (await execute(sql, params)).rows as T[];
    },
    async getOptional<T>(sql: string, params?: Params) {
      return ((await execute(sql, params)).rows[0] as T | undefined) ?? null;
    },
  };
}

export const db = {
  async execute(sql: string, params: Params = []): Promise<{ rows: Record<string, unknown>[] }> {
    const res = await enqueue(() => rawExec(sql, params));
    publish(res.changed);
    return { rows: res.rows };
  },

  async getAll<T>(sql: string, params: Params = []): Promise<T[]> {
    const res = await enqueue(() => rawExec(sql, params));
    publish(res.changed);
    return res.rows as T[];
  },

  async getOptional<T>(sql: string, params: Params = []): Promise<T | null> {
    return ((await db.getAll<T>(sql, params))[0] as T | undefined) ?? null;
  },

  /** Run `fn` inside BEGIN … COMMIT (rolled back if it throws). */
  async writeTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const touched = new Set<string>();
    const result = await enqueue(async () => {
      await rawExec('BEGIN IMMEDIATE');
      try {
        const value = await fn(makeTx(touched));
        await rawExec('COMMIT');
        return value;
      } catch (e) {
        await rawExec('ROLLBACK').catch(() => undefined);
        touched.clear();
        throw e;
      }
    });
    publish(touched);
    return result;
  },

  /** The raw database file (for backups). */
  exportFile(): Promise<Uint8Array> {
    return enqueue(async () => {
      await openDb();
      return remote.exportDb();
    });
  },

  /** Replace the database with a backup file; the caller must reload the app afterwards. */
  importFile(bytes: Uint8Array): Promise<void> {
    return enqueue(async () => {
      await openDb();
      await remote.importDb(Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]));
    });
  },
};

export type Db = typeof db;
