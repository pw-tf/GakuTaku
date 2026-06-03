import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { LoginScreen } from '../auth/LoginScreen';
import { SystemProvider } from '../sync/SystemProvider';
import { DeckListDemo } from '../ui/DeckListDemo';
import { JpCoreTestPage } from '../ui/JpCoreTestPage';
import { Attribution } from '../ui/Attribution';

type Tab = 'decks' | 'jp-core' | 'credits';

const TABS: { id: Tab; label: string }[] = [
  { id: 'jp-core', label: 'Japanese core' },
  { id: 'decks', label: 'Decks (sync demo)' },
  { id: 'credits', label: 'Credits' },
];

export function App() {
  const { session, loading } = useAuth();
  const [tab, setTab] = useState<Tab>('jp-core');

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-slate-950 text-slate-400">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  return (
    <SystemProvider>
      <div className="flex min-h-full flex-col bg-slate-950">
        <nav className="flex gap-1 border-b border-slate-800 bg-slate-900 px-4 py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                tab === t.id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <main className="flex-1">
          {tab === 'jp-core' && <JpCoreTestPage />}
          {tab === 'decks' && <DeckListDemo />}
          {tab === 'credits' && <Attribution />}
        </main>
      </div>
    </SystemProvider>
  );
}
