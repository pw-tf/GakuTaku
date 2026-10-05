import { useEffect, useState } from 'react';
import { col } from '../anki/appCollection';
import type { Notetype } from '../anki/notetype';
import type { Deck } from '../anki/types';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { CardPreview, NoteFields, TagInput } from './NoteEditor';

const LAST_TYPE_KEY = 'gakutaku-last-notetype';
const stickyKey = (mid: number) => `gakutaku-sticky-${mid}`;

function loadSticky(mid: number): boolean[] {
  try {
    const v = JSON.parse(localStorage.getItem(stickyKey(mid)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.map(Boolean) : [];
  } catch {
    return [];
  }
}

/** Anki's Add screen: pick a note type and deck, fill the fields, add. Stays open for the next note. */
export function AddNoteModal({ deckId, onClose }: { deckId: number; onClose: () => void }) {
  const [types, setTypes] = useState<Notetype[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [mid, setMid] = useState<number | null>(null);
  const [did, setDid] = useState(deckId);
  const [values, setValues] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [sticky, setSticky] = useState<boolean[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);

  const choose = (t: Notetype) => {
    setMid(t.id);
    setValues(t.fields.map(() => ''));
    setSticky(loadSticky(t.id));
  };

  useEffect(() => {
    void (async () => {
      const [ts, ds] = await Promise.all([col.notetypes(), col.decks()]);
      setTypes(ts);
      setDecks(ds.sort((a, b) => a.name.localeCompare(b.name)));
      let last: number | null = null;
      try {
        last = Number(localStorage.getItem(LAST_TYPE_KEY)) || null;
      } catch {
        /* storage unavailable */
      }
      const pick = ts.find((t) => t.id === last) ?? ts.find((t) => t.name === 'Basic') ?? ts[0];
      if (pick) choose(pick);
    })();
  }, []);

  const nt = types.find((t) => t.id === mid) ?? null;
  const deckName = decks.find((d) => d.id === did)?.name ?? '';

  function toggleSticky(i: number) {
    if (!nt) return;
    const next = nt.fields.map((_, j) => (j === i ? !sticky[j] : !!sticky[j]));
    setSticky(next);
    try {
      localStorage.setItem(stickyKey(nt.id), JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  }

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
      setValues((v) => nt.fields.map((_, i) => (sticky[i] ? v[i] ?? '' : '')));
      setMsg({ ok: true, text: `Added ${cardIds.length} card${cardIds.length === 1 ? '' : 's'}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (preview && nt) return <CardPreview notetype={nt} values={values} tags={tags} deckName={deckName} onClose={() => setPreview(false)} />;

  return (
    <Modal title="Add" onClose={onClose} wide>
      <div className="modal-body">
        <div className="add-pickers">
          <label className="opt-field col">
            <span>Type</span>
            <select value={mid ?? ''} onChange={(e) => { const t = types.find((x) => x.id === Number(e.target.value)); if (t) choose(t); }}>
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
        {nt && <NoteFields notetype={nt} values={values} onChange={setValues} sticky={sticky} onToggleSticky={toggleSticky} autoFocus />}
        <TagInput value={tags} onChange={setTags} />
        {nt?.kind === 1 && <p className="opt-note">Select text and tap […] to make a cloze ({'{{c1::text}}'}; add a hint as {'{{c1::text::hint}}'}).</p>}
        {msg && <p style={{ color: msg.ok ? 'var(--rate-good)' : 'var(--rate-again)', fontSize: 13 }}>{msg.text}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={() => setPreview(true)} disabled={!nt} style={{ marginRight: 'auto' }}><Icon.review s={15} /> Preview</Btn>
        <Btn onClick={onClose}>Close</Btn>
        <Btn variant="primary" disabled={saving || !nt} onClick={() => void add()}>{saving ? 'Adding…' : 'Add'}</Btn>
      </div>
    </Modal>
  );
}
