import { useEffect, useRef, useState } from 'react';
import { subscribe } from './index';

/**
 * Run an async loader and re-run it whenever a write touches one of `tables` (or `deps` change).
 * Like {@link import('./useQuery').useQuery}, but for results built by code rather than one SQL query
 * — e.g. the deck tree with Anki's limit-adjusted counts.
 */
export function useLive<T>(load: () => Promise<T>, deps: unknown[], tables: string[]): { data: T | undefined; loading: boolean; error: Error | null } {
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: Error | null }>({ data: undefined, loading: true, error: null });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    let version = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      const v = ++version;
      loadRef.current().then(
        (data) => alive && v === version && setState({ data, loading: false, error: null }),
        (e: unknown) => {
          console.error(e);
          if (alive && v === version) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e : new Error(String(e)) }));
        },
      );
    };
    run();
    const watched = new Set(tables);
    const unsubscribe = subscribe((changed) => {
      for (const t of changed) {
        if (watched.has(t)) {
          // Coalesce bursts (an import writes thousands of rows in chunks).
          if (timer) clearTimeout(timer);
          timer = setTimeout(run, 120);
          return;
        }
      }
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tables.join(',')]);

  return state;
}
