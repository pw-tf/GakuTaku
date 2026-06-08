import { useEffect, useState } from 'react';
import { db } from '../sync/system';
import { useAuth } from '../auth/AuthProvider';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { useAllCards, useDeckStats, type DeckStat } from './srsHooks';
import { cardStateLabel, deckConfig, formatInterval, serializeDeckConfig, type DeckConfig } from './fsrs';
import { createDeck, deleteDeck, renameDeck } from './mining';
import { optimizeDeck } from '../analytics/optimizer';

interface Props {
  onReviewDeck: (deck: DeckStat) => void;
}

const DECK_TONES = ['var(--rust)', 'var(--azure)', 'var(--sage)', 'var(--amber)'];

/** Merge a config patch into a deck's fsrs_params, preserving anything not touched (e.g. weights). */
async function updateDeckConfig(deckId: string, patch: Partial<DeckConfig>): Promise<void> {
  const rows = await db.getAll<{ fsrs_params: string | null }>(
    'SELECT fsrs_params FROM decks WHERE id = ?',
    [deckId],
  );
  const cfg = deckConfig({ fsrs_params: rows[0]?.fsrs_params ?? null });
  await db.execute('UPDATE decks SET fsrs_params = ? WHERE id = ?', [
    serializeDeckConfig({ ...cfg, ...patch }),
    deckId,
  ]);
}

/** "1m 10m" / "1m, 10m" → ['1m','10m']; empty → undefined (use FSRS defaults). */
function parseSteps(text: string): string[] | undefined {
  const steps = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return steps.length ? steps : undefined;
}

/** Inline per-deck config: name + new cards/day + (re)learning steps + delete. Stops click bubbling
 *  so editing doesn't launch a review. */
function DeckConfigControl({ deck }: { deck: DeckStat }) {
  const [name, setName] = useState(deck.name);
  const [perDay, setPerDay] = useState(deck.newPerDay);
  const [learn, setLearn] = useState((deck.learningSteps ?? []).join(' '));
  const [relearn, setRelearn] = useState((deck.relearningSteps ?? []).join(' '));
  useEffect(() => setPerDay(deck.newPerDay), [deck.newPerDay]);
  useEffect(() => setName(deck.name), [deck.name]);

  function confirmDelete() {
    if (window.confirm(`Delete “${deck.name}” and its ${deck.total} card${deck.total === 1 ? '' : 's'}? This cannot be undone.`)) {
      void deleteDeck(deck.id);
    }
  }

  return (
    <div className="dc-config" onClick={(e) => e.stopPropagation()}>
      <label className="dc-field">
        <span className="l">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== deck.name && void renameDeck(deck.id, name)}
        />
      </label>
      <label className="dc-field">
        <span className="l">New/day</span>
        <input
          type="number"
          min={0}
          value={perDay}
          onChange={(e) => {
            const n = Math.max(0, parseInt(e.target.value || '0', 10) || 0);
            setPerDay(n);
            void updateDeckConfig(deck.id, { newPerDay: n });
          }}
        />
      </label>
      <label className="dc-field">
        <span className="l">Learning steps</span>
        <input
          value={learn}
          placeholder="1m 10m"
          onChange={(e) => setLearn(e.target.value)}
          onBlur={() => void updateDeckConfig(deck.id, { learningSteps: parseSteps(learn) })}
        />
      </label>
      <label className="dc-field">
        <span className="l">Relearning</span>
        <input
          value={relearn}
          placeholder="10m"
          onChange={(e) => setRelearn(e.target.value)}
          onBlur={() => void updateDeckConfig(deck.id, { relearningSteps: parseSteps(relearn) })}
        />
      </label>
      <OptimizeControl deck={deck} />
      <button className="dc-delete" onClick={confirmDelete}>
        <Icon.trash s={14} /> Delete deck
      </button>
    </div>
  );
}

/** Trains personalized FSRS weights from this deck's review history and writes them to fsrs_params. */
function OptimizeControl({ deck }: { deck: DeckStat }) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setRunning(true);
    setMsg(null);
    try {
      const r = await optimizeDeck(deck.id);
      setMsg(
        r.ok
          ? { ok: true, text: `Optimized from ${r.reviewCount} reviews — weights saved.` }
          : { ok: false, text: r.reason ?? 'Could not optimize.' },
      );
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message ?? 'Optimization failed.' });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="dc-optimize">
      <button className="dc-opt-btn" disabled={running} onClick={() => void run()}>
        {running ? 'Optimizing…' : 'Optimize FSRS weights'}
      </button>
      {msg && <span className={'dc-opt-msg' + (msg.ok ? ' ok' : ' err')}>{msg.text}</span>}
    </div>
  );
}

/** Decks grid + all-cards browser, driven entirely by the synced cards/notes/decks tables (M4). */
export function DecksScreen({ onReviewDeck }: Props) {
  const { session } = useAuth();
  const decks = useDeckStats();
  const cards = useAllCards();
  const now = Date.now();
  const [creating, setCreating] = useState(false);

  function dueText(due: string | null, reps: number): string {
    if (reps === 0) return 'new';
    if (!due) return '—';
    const t = new Date(due).getTime();
    return t <= now ? 'due' : formatInterval(new Date(now), new Date(t));
  }

  async function addDeck() {
    const userId = session?.user.id;
    if (!userId || creating) return;
    const name = window.prompt('New deck name', 'New deck');
    if (name === null) return;
    setCreating(true);
    try {
      await createDeck(userId, name.trim() || 'New deck');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page">
      <div className="sec-bar">
        <h2>Decks</h2>
        <span className="count">{decks.length} {decks.length === 1 ? 'deck' : 'decks'}</span>
        <span className="more">
          <Btn size="sm" disabled={creating} onClick={() => void addDeck()}>
            <Icon.plus s={15} /> New deck
          </Btn>
        </span>
      </div>
      {decks.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)', marginBottom: 36 }}>
          No decks yet. Open a book, tap a word, and ＋ Add to deck to start mining cards.
        </p>
      ) : (
        <div className="deck-grid">
          {decks.map((d, i) => (
            <div className="deck-card" key={d.id} onClick={() => onReviewDeck(d)}>
              <div className="dc-top">
                <span className="dc-bar" style={{ background: DECK_TONES[i % DECK_TONES.length] }} />
                <span className="dc-name">{d.name}</span>
              </div>
              <div className="dc-stats">
                <div className="ds due"><div className="v">{d.due}</div><div className="l">Due</div></div>
                <div className="ds"><div className="v">{d.new}</div><div className="l">New</div></div>
                <div className="ds"><div className="v">{d.total}</div><div className="l">Total</div></div>
              </div>
              <DeckConfigControl deck={d} />
            </div>
          ))}
        </div>
      )}

      <div className="sec-bar">
        <h2>All cards</h2>
        <span className="count">{cards.length} {cards.length === 1 ? 'card' : 'cards'}</span>
      </div>

      {cards.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>No cards yet.</p>
      ) : (
        <table className="card-table">
          <thead>
            <tr>
              <th>Term</th>
              <th className="hide-sm">Meaning</th>
              <th>Deck</th>
              <th>State</th>
              <th className="hide-sm">Due</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => {
              const state = cardStateLabel({
                state: c.state,
                reps: c.reps,
                due: new Date(c.due ?? now),
                last_review: c.last_review ? new Date(c.last_review) : null,
              });
              return (
                <tr key={c.id}>
                  <td>
                    <span className="ct-term" lang="ja">{c.fields.Term}</span>{' '}
                    <span className="ct-reading" lang="ja">{c.fields.Reading}</span>
                  </td>
                  <td className="hide-sm" style={{ color: 'var(--ink-soft)' }}>{c.fields.Meaning}</td>
                  <td style={{ color: 'var(--ink-faint)', fontSize: 13 }}>{c.deck}</td>
                  <td><span className={'state-pill state-' + state}>{state}</span></td>
                  <td className="hide-sm" style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-faint)' }}>
                    {dueText(c.due, c.reps)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
