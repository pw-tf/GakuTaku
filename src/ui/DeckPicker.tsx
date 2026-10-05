import { useState } from 'react';
import { col } from '../anki/appCollection';
import { useBackHandler } from '../app/back';
import { useLive } from '../db/useLive';
import { DEFAULT_MINING_DECK } from '../study/mining';
import { Btn } from './atoms';
import { Icon } from './icons';

interface Props {
  currentDeckId: number | null;
  onPick: (deckId: number) => void;
  onClose: () => void;
}

/** Choose (or create) the deck a mined word goes into. */
export function DeckPicker({ currentDeckId, onPick, onClose }: Props) {
  const { data: decks = [] } = useLive(() => col.decks(), [], ['decks']);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  useBackHandler(true, onClose);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      onPick(await col.getOrCreateDeck(newName.trim() || DEFAULT_MINING_DECK));
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
          {decks.length === 0 && <p style={{ color: 'var(--ink-faint)', fontSize: 13, padding: '4px 2px' }}>No decks yet — create one below.</p>}
          {decks.map((d) => (
            <button key={d.id} className={'dp-row' + (d.id === currentDeckId ? ' on' : '')} onClick={() => onPick(d.id)}>
              <span className="dp-name">{d.name}</span>
              {d.id === currentDeckId && <Icon.check s={16} />}
            </button>
          ))}
        </div>
        <div className="dp-new">
          <input placeholder="New deck name…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
          <Btn size="sm" variant="primary" onClick={() => void create()} disabled={creating}><Icon.plus s={14} /> Create</Btn>
        </div>
      </div>
    </div>
  );
}
