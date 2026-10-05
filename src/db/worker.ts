/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sqlite3InitModule, { type Database, type SAHPoolUtil, type SqlValue } from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS } from './schema';
import { registerSqlFunctions } from './sqlFunctions';

/**
 * The SQLite engine, running off the UI thread. The database file lives in the Origin Private File
 * System via the "SAH pool" VFS, which works in Chrome / Android WebView without cross-origin
 * isolation headers. If OPFS is unavailable (an old WebView, a private window) the app still runs on
 * an in-memory database and the UI warns that nothing will be kept.
 *
 * Every statement reports which tables it changed (via SQLite's update hook, so triggers and
 * cascades are included); the client uses that to re-run only the live queries that depend on them.
 */

const DB_FILE = '/gakutaku.sqlite3';

let db: Database | null = null;
let poolUtil: SAHPoolUtil | null = null;
const changed = new Set<string>();

export interface OpenResult {
  persistent: boolean;
  /** Why the database is not persistent, when it isn't. */
  reason?: string;
}

export interface ExecResult {
  rows: Record<string, unknown>[];
  changed: string[];
}

async function open(): Promise<OpenResult> {
  const sqlite3 = await sqlite3InitModule();
  let persistent = false;
  let reason: string | undefined;
  const hasOpfs = typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  if (hasOpfs) {
    // Errors here (most often: another tab already holds the database) are real failures — falling
    // back to memory would silently throw away everything done in this tab.
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'gakutaku', initialCapacity: 6 });
    poolUtil = pool;
    db = new pool.OpfsSAHPoolDb(DB_FILE);
    persistent = true;
  } else {
    reason = 'Origin Private File System is not available';
    db = new sqlite3.oo1.DB(':memory:', 'c');
  }

  sqlite3.capi.sqlite3_update_hook(
    db.pointer!,
    (_ctx: number, _op: number, _db: string, table: string) => {
      changed.add(table);
    },
    0,
  );
  db.createFunction('uuid', () => crypto.randomUUID(), { deterministic: false });
  registerSqlFunctions(db);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = TRUNCATE; PRAGMA synchronous = NORMAL;');
  migrate(db);
  changed.clear();
  return { persistent, reason };
}

function migrate(d: Database): void {
  const current = Number(d.selectValue('PRAGMA user_version') ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.transaction((t) => {
      t.exec(MIGRATIONS[v]);
      t.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

function need(): Database {
  if (!db) throw new Error('Database is not open');
  return db;
}

function exec(sql: string, params: unknown[] = []): ExecResult {
  const d = need();
  changed.clear();
  const rows = d.exec({
    sql,
    bind: params.length ? (params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p)) as SqlValue[]) : undefined,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];
  const out = { rows: rows.map((r) => ({ ...r })), changed: [...changed] };
  changed.clear();
  return out;
}

/** Run one statement over many parameter rows (inside the caller's transaction, if any). */
function execMany(sql: string, rows: unknown[][]): ExecResult {
  const d = need();
  changed.clear();
  const stmt = d.prepare(sql);
  try {
    for (const params of rows) {
      stmt.bind(params.map((p) => (p === undefined ? null : p)) as SqlValue[]);
      stmt.stepReset();
      stmt.clearBindings();
    }
  } finally {
    stmt.finalize();
  }
  const out = { rows: [], changed: [...changed] };
  changed.clear();
  return out;
}

/** Several statements in one call (one round trip from the app instead of one each). */
function execBatch(statements: { sql: string; params: unknown[] }[]): ExecResult {
  const d = need();
  changed.clear();
  for (const { sql, params } of statements) {
    d.exec({ sql, bind: params.length ? (params.map((p) => (p === undefined ? null : p)) as SqlValue[]) : undefined });
  }
  const out = { rows: [], changed: [...changed] };
  changed.clear();
  return out;
}

/** The whole database file, for backups. */
function exportDb(): Uint8Array {
  if (!poolUtil) throw new Error('Backups need persistent storage, which is unavailable on this device.');
  const bytes = poolUtil.exportFile(DB_FILE);
  return Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]);
}

/** Replace the database file with a backup. The caller reloads the app afterwards. */
async function importDb(bytes: Uint8Array): Promise<void> {
  if (!poolUtil) throw new Error('Restoring needs persistent storage, which is unavailable on this device.');
  db?.close();
  db = null;
  await poolUtil.importDb(DB_FILE, bytes);
}

const api = { open, exec, execMany, execBatch, exportDb, importDb };
export type DbWorkerApi = typeof api;
Comlink.expose(api);
