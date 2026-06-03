import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { usePowerSync, useStatus, useDecks } from '../sync/hooks';

/**
 * M1 sync-proof surface (throwaway; M4 replaces this with the real deck browser).
 * Writes go to the local SQLite DB and are queued for upload — works fully offline.
 */
export function DeckListDemo() {
  const { session, signOut } = useAuth();
  const db = usePowerSync();
  const status = useStatus();
  const { data: decks, isLoading } = useDecks();
  const [name, setName] = useState('');

  async function addDeck() {
    const deckName = name.trim() || `Deck ${new Date().toLocaleString()}`;
    await db.execute(
      `INSERT INTO decks (id, user_id, name, fsrs_params, created_at)
       VALUES (uuid(), ?, ?, ?, ?)`,
      [session!.user.id, deckName, '{}', new Date().toISOString()],
    );
    setName('');
  }

  async function deleteDeck(id: string) {
    await db.execute('DELETE FROM decks WHERE id = ?', [id]);
  }

  const connected = status.connected;
  const lastSynced = status.lastSyncedAt;

  return (
    <div className="mx-auto max-w-xl p-6 text-slate-100">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">GakuTaku</h1>
          <p className="text-sm text-slate-400">{session?.user.email}</p>
        </div>
        <button
          onClick={() => signOut()}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Sign out
        </button>
      </header>

      <div className="mb-4 flex items-center gap-2 text-xs">
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`}
        />
        <span className="text-slate-400">
          {connected ? 'Synced' : 'Offline'}
          {lastSynced ? ` · last sync ${lastSynced.toLocaleTimeString()}` : ''}
        </span>
      </div>

      <div className="mb-6 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addDeck()}
          placeholder="New deck name"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-indigo-500"
        />
        <button
          onClick={addDeck}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500"
        >
          Add deck
        </button>
      </div>

      {isLoading ? (
        <p className="text-slate-400">Loading…</p>
      ) : decks.length === 0 ? (
        <p className="text-slate-400">No decks yet. Add one — it syncs across your devices.</p>
      ) : (
        <ul className="space-y-2">
          {decks.map((deck) => (
            <li
              key={deck.id}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-4 py-3"
            >
              <span>{deck.name}</span>
              <button
                onClick={() => deleteDeck(deck.id)}
                className="text-sm text-slate-500 hover:text-red-400"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
