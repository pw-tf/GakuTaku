import { useEffect, useState, type CSSProperties } from 'react';
import { openDb } from '../db';
import { AppShell } from './AppShell';
import { useEffectiveTheme, usePrefs } from './prefs';

type DbState = { status: 'opening' } | { status: 'ready'; persistent: boolean } | { status: 'error'; message: string };

export function App() {
  const accent = usePrefs((s) => s.accent);
  const theme = useEffectiveTheme();
  const dark = theme !== 'light';
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

  // Accent is a runtime-swappable CSS variable; the theme classes swap the colour tokens. Both also go
  // on <html>, so dialogs (rendered into <body>, outside .app) and the page background match.
  const style = {
    '--rust': accent,
    '--accent': accent,
    '--rust-ink': `color-mix(in oklch, ${accent} 84%, black)`,
  } as CSSProperties;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('theme-dark', dark);
    root.classList.toggle('theme-black', theme === 'black');
    root.style.setProperty('--rust', accent);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--rust-ink', `color-mix(in oklch, ${accent} 84%, black)`);
    root.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--paper').trim() || (dark ? '#1b1815' : '#f7f3ec'));
  }, [dark, theme, accent]);

  return (
    <div className={'app' + (dark ? ' theme-dark' : '') + (theme === 'black' ? ' theme-black' : '')} style={style}>
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
