import type { CSSProperties } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { AuthScreen } from '../auth/AuthScreen';
import { SystemProvider } from '../sync/SystemProvider';
import { AppShell } from './AppShell';
import { usePrefs } from './prefs';

export function App() {
  const { session, loading } = useAuth();
  const { accent, dark } = usePrefs();

  // Accent is a runtime-swappable CSS variable; dark theme toggles the token overrides.
  const style = {
    '--rust': accent,
    '--accent': accent,
    '--rust-ink': `color-mix(in oklch, ${accent} 84%, black)`,
  } as CSSProperties;

  return (
    <div className={'app' + (dark ? ' theme-dark' : '')} style={style}>
      {loading ? (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-faint)' }}>
          Loading…
        </div>
      ) : !session ? (
        <AuthScreen />
      ) : (
        <SystemProvider>
          <AppShell />
        </SystemProvider>
      )}
    </div>
  );
}
