import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useDecks } from '../sync/hooks';
import { createDeck, DEFAULT_DECK_NAME } from '../srs/mining';
import { Btn } from './atoms';
import { Icon } from './icons';

interface Props {
  currentDeckId: string | null;
  onPick: (deckId: string) => void;
  onClose: () => void;
}

/** Modal for choosing (or creating) the deck a mined word goes into. */
export function DeckPicker({ currentDeckId, onPick, onClose }: Props) {
  const { session } = useAuth();
  const { data: decks } = useDecks();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!session || creating) return;
    setCreating(true);
    try {
      const id = await createDeck(session.user.id, newName.trim() || DEFAULT_DECK_NAME);
      onPick(id);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="deck-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dp-head">
          <span className="dp-t">Add to deck</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close s={18} /></button>
        </div>

        <div className="dp-list">
          {decks.length === 0 && (
            <p style={{ color: 'var(--ink-faint)', fontSize: 13, padding: '4px 2px' }}>
              No decks yet — create one below.
            </p>
          )}
          {decks.map((d) => (
            <button
              key={d.id}
              className={'dp-row' + (d.id === currentDeckId ? ' on' : '')}
              onClick={() => onPick(d.id)}
            >
              <span className="dp-name">{d.name ?? 'Untitled'}</span>
              {d.id === currentDeckId && <Icon.check s={16} />}
            </button>
          ))}
        </div>

        <div className="dp-new">
          <input
            placeholder="New deck name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <Btn size="sm" variant="primary" onClick={create} disabled={creating}>
            <Icon.plus s={14} /> Create
          </Btn>
        </div>
      </div>
    </div>
  );
}
