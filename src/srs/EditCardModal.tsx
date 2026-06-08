import { useEffect, useState } from 'react';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { deleteCard, loadCardForEdit, updateNoteFields, type EditableCard } from './mining';

/**
 * Edit (or delete) a single card's note fields. Reused by the deck browser and the review screen.
 * Field list/order comes from the note type, so it works for the built-in vocab type and any
 * imported Anki note type. Saving writes `notes.fields`; the card's FSRS state is untouched.
 */
export function EditCardModal({ cardId, onClose, onDeleted }: { cardId: string; onClose: () => void; onDeleted?: () => void }) {
  const [card, setCard] = useState<EditableCard | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ok = true;
    void loadCardForEdit(cardId).then((c) => {
      if (ok && c) { setCard(c); setValues(c.values); }
    });
    return () => { ok = false; };
  }, [cardId]);

  async function save() {
    if (!card || busy) return;
    setBusy(true);
    try {
      await updateNoteFields(card.noteId, values);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || !window.confirm('Delete this card? This cannot be undone.')) return;
    setBusy(true);
    try {
      await deleteCard(cardId);
      onDeleted?.();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Edit card</h3>
          <button className="icon-btn" onClick={onClose}><Icon.close s={18} /></button>
        </div>
        <div className="modal-body">
          {!card ? (
            <p style={{ color: 'var(--ink-faint)' }}>Loading…</p>
          ) : (
            card.fieldNames.map((name) => (
              <label className="opt-field col" key={name}>
                <span>{name}</span>
                <textarea
                  className="opt-textarea"
                  rows={2}
                  lang="ja"
                  value={values[name] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                />
              </label>
            ))
          )}
        </div>
        <div className="modal-foot">
          <button className="dc-opt-btn danger-text" style={{ marginRight: 'auto' }} disabled={!card || busy} onClick={() => void remove()}>
            Delete card
          </button>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!card || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Btn>
        </div>
      </div>
    </div>
  );
}
