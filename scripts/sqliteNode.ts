/**
 * A Node-side {@link Sql} adapter over an in-memory SQLite database (the same official WASM build the
 * app uses), with the app's migrations applied. It throws if the outer handle is used while a
 * transaction is open — in the app that would deadlock the single-connection queue (src/db/index.ts).
 */
import sqlite3InitModule, { type SqlValue } from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS } from '../src/db/schema';
import type { Sql } from '../src/anki/collection';

export async function openTestDb(): Promise<{
  sql: Sql;
  raw: { exec(sql: string, params?: unknown[]): Record<string, unknown>[]; bytes(): Uint8Array };
}> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  db.createFunction('uuid', () => crypto.randomUUID(), { deterministic: false });
  for (const m of MIGRATIONS) db.exec(m);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

  const exec = (sql: string, params: unknown[] = []) =>
    (db.exec({
      sql,
      bind: params.length ? (params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p)) as SqlValue[]) : undefined,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Record<string, unknown>[]).map((r) => ({ ...r }));

  let depth = 0;
  const make = (inner: boolean): Sql => {
    const guard = () => {
      if (!inner && depth > 0) throw new Error('Outer Sql handle used inside a transaction (would deadlock in the app)');
    };
    const self: Sql = {
      async all<T>(sql: string, params?: unknown[]) {
        guard();
        return exec(sql, params) as T[];
      },
      async run(sql: string, params?: unknown[]) {
        guard();
        exec(sql, params);
      },
      async runMany(sql: string, rows: unknown[][]) {
        guard();
        for (const r of rows) exec(sql, r);
      },
      async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
        if (inner) return fn(self);
        guard();
        exec('BEGIN');
        depth++;
        try {
          const v = await fn(make(true));
          depth--;
          exec('COMMIT');
          return v;
        } catch (e) {
          depth--;
          exec('ROLLBACK');
          throw e;
        }
      },
    };
    return self;
  };
  return { sql: make(false), raw: { exec, bytes: () => sqlite3.capi.sqlite3_js_db_export(db.pointer!) } };
}
