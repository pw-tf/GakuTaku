import { useEffect, useState } from 'react';
import { col } from '../anki/appCollection';
import type { Notetype } from '../anki/notetype';
import type { Deck } from '../anki/types';
import { Btn } from '../ui/atoms';
import { Modal } from '../ui/Modal';

const LAST_TYPE_KEY = 'gakutaku-last-notetype';

/** Anki's Add screen: pick a note type and deck, fill the fields, add. Stays open for the next note. */
export function AddNoteModal({ deckId, onClose }: { deckId: number; onClose: () => void }) {
  const [types, setTypes] = useState<Notetype[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [mid, setMid] = useState<number | null>(null);
  const [did, setDid] = useState(deckId);
  const [values, setValues] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const [ts, ds] = await Promise.all([col.notetypes(), col.decks()]);
      setTypes(ts);
      setDecks(ds);
      let last: number | null = null;
      try {
        last = Number(localStorage.getItem(LAST_TYPE_KEY)) || null;
      } catch {
        /* storage unavailable */
      }
      const pick = ts.find((t) => t.id === last) ?? ts.find((t) => t.name === 'Basic') ?? ts[0];
      if (pick) {
        setMid(pick.id);
        setValues(pick.fields.map(() => ''));
      }
    })();
  }, []);

  const nt = types.find((t) => t.id === mid) ?? null;

  async function add() {
    if (!nt) return;
    setSaving(true);
    setMsg(null);
    try {
      const { cardIds } = await col.addNote(nt.id, values, tags.split(/\s+/).filter(Boolean), did);
      try {
        localStorage.setItem(LAST_TYPE_KEY, String(nt.id));
      } catch {
        /* ignore */
      }
      setValues(nt.fields.map(() => ''));
      setMsg({ ok: true, text: `Added ${cardIds.length} card${cardIds.length === 1 ? '' : 's'}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add" onClose={onClose} wide>
      <div className="modal-body">
        <div className="add-pickers">
          <label className="opt-field col">
            <span>Type</span>
            <select value={mid ?? ''} onChange={(e) => { const t = types.find((x) => x.id === Number(e.target.value)); if (t) { setMid(t.id); setValues(t.fields.map(() => '')); } }}>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="opt-field col">
            <span>Deck</span>
            <select value={did} onChange={(e) => setDid(Number(e.target.value))}>
              {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        </div>
        {nt?.fields.map((f, i) => (
          <label className="opt-field col" key={`${nt.id}-${f.name}`}>
            <span>{f.name}</span>
            <textarea lang="ja" rows={i === 0 ? 2 : 1} autoFocus={i === 0} value={values[i] ?? ''} onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
        <label className="opt-field col">
          <span>Tags</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="space-separated" />
        </label>
        {nt?.kind === 1 && <p className="opt-note">Mark clozes as {'{{c1::text}}'}, {'{{c2::text::hint}}'} …</p>}
        {msg && <p style={{ color: msg.ok ? 'var(--rate-good)' : 'var(--rate-again)', fontSize: 13 }}>{msg.text}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Close</Btn>
        <Btn variant="primary" disabled={saving || !nt} onClick={() => void add()}>{saving ? 'Adding…' : 'Add'}</Btn>
      </div>
    </Modal>
  );
}
