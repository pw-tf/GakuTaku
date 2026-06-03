import { useAuth } from '../auth/AuthProvider';
import { LoginScreen } from '../auth/LoginScreen';
import { SystemProvider } from '../sync/SystemProvider';
import { DeckListDemo } from '../ui/DeckListDemo';

export function App() {
  const { session, loading } = useAuth();

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
      <div className="min-h-full bg-slate-950">
        <DeckListDemo />
      </div>
    </SystemProvider>
  );
}
