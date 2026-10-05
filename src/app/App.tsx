import { useEffect, useState, type CSSProperties } from 'react';
import { openDb } from '../db';
import { AppShell } from './AppShell';
import { usePrefs } from './prefs';

type DbState = { status: 'opening' } | { status: 'ready'; persistent: boolean } | { status: 'error'; message: string };

export function App() {
  const { accent, dark } = usePrefs();
  const [dbState, setDbState] = useState<DbState>({ status: 'opening' });

  useEffect(() => {
    openDb().then(
      (r) => {
        if (!r.persistent) console.warn('Database is in memory only:', r.reason);
        setDbState({ status: 'ready', persistent: r.persistent });
      },
      (e: unknown) => setDbState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    // Ask the browser not to evict our data under storage pressure (a no-op inside the Android app).
    void navigator.storage?.persist?.().catch(() => undefined);
  }, []);

  // Accent is a runtime-swappable CSS variable; dark theme toggles the token overrides.
  const style = {
    '--rust': accent,
    '--accent': accent,
    '--rust-ink': `color-mix(in oklch, ${accent} 84%, black)`,
  } as CSSProperties;

  return (
    <div className={'app' + (dark ? ' theme-dark' : '')} style={style}>
      {dbState.status === 'opening' ? (
        <div className="app-msg">Loading…</div>
      ) : dbState.status === 'error' ? (
        <div className="app-msg">
          <p>GakuTaku couldn’t open its database.</p>
          <p style={{ fontSize: 13 }}>{dbState.message}</p>
          <p style={{ fontSize: 13 }}>If the app is open in another tab or window, close it and reload.</p>
        </div>
      ) : (
        <>
          {!dbState.persistent && (
            <div className="storage-warning">
              This browser can’t store data permanently — anything you do here is lost when the page closes.
            </div>
          )}
          <AppShell />
        </>
      )}
    </div>
  );
}
