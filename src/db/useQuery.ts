import { useEffect, useState } from 'react';
import { db, subscribe } from './index';
import { MIGRATIONS } from './schema';

/** Every table the schema creates, for working out which tables a query reads. */
const TABLES = [...new Set(MIGRATIONS.join('\n').match(/CREATE TABLE (\w+)/gi)?.map((m) => m.split(/\s+/)[2]) ?? [])];

const depsCache = new Map<string, Set<string>>();
function tablesIn(sql: string): Set<string> {
  let deps = depsCache.get(sql);
  if (!deps) {
    deps = new Set(TABLES.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(sql)));
    depsCache.set(sql, deps);
  }
  return deps;
}

const EMPTY: never[] = [];

interface QueryState<T> {
  key: string;
  data: T[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * A live query: returns the rows of `sql`, re-running whenever a write commits to one of the
 * tables it reads. While a changed query (new SQL or params) loads, the previous rows stay visible
 * so screens don't flash empty.
 */
export function useQuery<T>(sql: string, params: unknown[] = EMPTY): { data: T[]; isLoading: boolean; error: Error | null } {
  const key = sql + '\u0000' + JSON.stringify(params);
  const [state, setState] = useState<QueryState<T>>({ key, data: EMPTY, isLoading: true, error: null });

  useEffect(() => {
    let alive = true;
    let version = 0;
    const deps = tablesIn(sql);
    const run = () => {
      const v = ++version;
      db.getAll<T>(sql, params).then(
        (rows) => {
          if (alive && v === version) setState({ key, data: rows, isLoading: false, error: null });
        },
        (err: unknown) => {
          if (!alive || v !== version) return;
          console.error('Query failed', sql, err);
          setState((s) => ({ ...s, key, isLoading: false, error: err instanceof Error ? err : new Error(String(err)) }));
        },
      );
    };
    run();
    const unsubscribe = subscribe((changed) => {
      for (const t of changed) {
        if (deps.has(t)) {
          run();
          return;
        }
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
    // `key` captures sql + params by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { data: state.data, isLoading: state.isLoading || state.key !== key, error: state.error };
}
