import { useEffect, useState, type ReactNode } from 'react';
import { jpCore, proxy } from '../jp-core/client';
import type { LoadProgress } from '../dictionary/loader';

type Status = 'checking' | 'needs-download' | 'downloading' | 'ready' | 'error';

/**
 * Gates dictionary-dependent UI behind a one-time download. The full JMdict + JMnedict +
 * KANJIDIC is large (~80–120 MB), so we don't auto-fetch — the user taps to start, then it's
 * cached in IndexedDB forever and works offline.
 */
export function DictionaryLoader({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    jpCore.isDictionaryLoaded().then((loaded) => setStatus(loaded ? 'ready' : 'needs-download'));
  }, []);

  async function download() {
    setStatus('downloading');
    setError(null);
    try {
      await jpCore.ensureDictionary(proxy((p: LoadProgress) => setProgress(p)));
      setStatus('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  if (status === 'ready') return <>{children}</>;

  const pct =
    progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-200">
      {status === 'checking' && <p className="text-sm text-slate-400">Checking dictionary…</p>}

      {status === 'needs-download' && (
        <>
          <p className="mb-3 text-sm">
            The offline dictionary (JMdict + names + kanji) needs a one-time download. It's then
            stored on this device and works offline.
          </p>
          <button
            onClick={download}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500"
          >
            Download dictionary
          </button>
        </>
      )}

      {status === 'downloading' && (
        <>
          <p className="mb-2 text-sm">
            {progress?.phase === 'manifest' ? 'Preparing…' : `Importing ${progress?.loaded.toLocaleString() ?? 0} / ${progress?.total.toLocaleString() ?? '…'} entries`}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}

      {status === 'error' && (
        <>
          <p className="mb-3 text-sm text-red-400">Download failed: {error}</p>
          <button
            onClick={download}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500"
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}
