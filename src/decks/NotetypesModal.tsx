import { useEffect, useMemo, useState } from 'react';
import { appSql, col } from '../anki/appCollection';
import { splitFields, type Notetype } from '../anki/notetype';
import { stockNotetypes } from '../anki/stock';
import { useLive } from '../db/useLive';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { ConfirmModal, Modal, PromptModal } from '../ui/Modal';
import { CardPreview } from './NoteEditor';

/** Anki's Manage Note Types: add, clone, rename, delete, and edit fields and card types. */

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'rename'; nt: Notetype }
  | { kind: 'delete'; nt: Notetype; notes: number }
  | { kind: 'fields'; nt: Notetype }
  | { kind: 'cards'; nt: Notetype };

export function NotetypesModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const { data } = useLive(async () => ({ types: await col.notetypes(), counts: await col.notetypeUseCounts() }), [], ['notetypes', 'notes']);
  const back = () => setView({ kind: 'list' });

  if (view.kind === 'add') return <AddNotetype existing={data?.types ?? []} onClose={back} />;
  if (view.kind === 'rename') {
    return <PromptModal title="Rename note type" label="Name" initial={view.nt.name} confirmLabel="Rename" onClose={back} onSubmit={(v) => col.renameNotetype(view.nt.id, v)} />;
  }
  if (view.kind === 'delete') {
    return (
      <ConfirmModal
        title={`Delete “${view.nt.name}”?`}
        message={view.notes ? `This also deletes its ${view.notes.toLocaleString()} note${view.notes === 1 ? '' : 's'} and all their cards.` : 'No notes use it.'}
        confirmLabel="Delete"
        danger
        onClose={back}
        onConfirm={() => col.removeNotetype(view.nt.id)}
      />
    );
  }
  if (view.kind === 'fields') return <FieldsEditor nt={view.nt} onClose={back} />;
  if (view.kind === 'cards') return <CardsEditor nt={view.nt} onClose={back} />;

  return (
    <Modal title="Note types" onClose={onClose} wide>
      <div className="modal-body nt-list">
        {(data?.types ?? []).map((nt) => {
          const n = data?.counts.get(nt.id) ?? 0;
          return (
            <div key={nt.id} className="nt-row">
              <div className="nt-main">
                <div className="nt-name">{nt.name}</div>
                <div className="muted nt-meta">
                  {n.toLocaleString()} note{n === 1 ? '' : 's'} · {nt.fields.length} field{nt.fields.length === 1 ? '' : 's'} · {nt.kind === 1 ? 'cloze' : `${nt.templates.length} card type${nt.templates.length === 1 ? '' : 's'}`}
                </div>
              </div>
              <div className="nt-actions">
                <Btn size="sm" onClick={() => setView({ kind: 'fields', nt })}>Fields</Btn>
                <Btn size="sm" onClick={() => setView({ kind: 'cards', nt })}>Cards</Btn>
                <Btn size="sm" onClick={() => setView({ kind: 'rename', nt })} aria-label={`Rename ${nt.name}`}><Icon.study s={14} /></Btn>
                <Btn size="sm" onClick={() => setView({ kind: 'delete', nt, notes: n })} aria-label={`Delete ${nt.name}`} disabled={(data?.types.length ?? 0) <= 1}><Icon.trash s={14} /></Btn>
              </div>
            </div>
          );
        })}
      </div>
      <div className="modal-foot">
        <Btn onClick={() => setView({ kind: 'add' })} style={{ marginRight: 'auto' }}><Icon.plus s={15} /> Add note type</Btn>
        <Btn variant="primary" onClick={onClose}>Done</Btn>
      </div>
    </Modal>
  );
}

function AddNotetype({ existing, onClose }: { existing: Notetype[]; onClose: () => void }) {
  const stock = useMemo(() => stockNotetypes(), []);
  const options = [
    ...stock.map((nt, i) => ({ key: `s${i}`, label: `Add: ${nt.name}`, base: nt })),
    ...existing.map((nt) => ({ key: `c${nt.id}`, label: `Clone: ${nt.name}`, base: nt })),
  ];
  const [pick, setPick] = useState(options[0]?.key ?? '');
  const base = options.find((o) => o.key === pick)?.base;
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (base) setName(pick.startsWith('c') ? `${base.name} copy` : base.name);
  }, [pick, base]);
  return (
    <Modal title="Add note type" onClose={onClose}>
      <div className="modal-body">
        <label className="opt-field col">
          <span>Start from</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <label className="opt-field col">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          variant="primary"
          onClick={async () => {
            if (!base || !name.trim()) return setErr('Enter a name.');
            const { id: _id, ...rest } = base as Notetype;
            void _id;
            await col.addNotetype({ ...rest, name: name.trim() });
            onClose();
          }}
        >
          Add
        </Btn>
      </div>
    </Modal>
  );
}

interface FieldDraft {
  name: string;
  from: number | null;
}

function FieldsEditor({ nt, onClose }: { nt: Notetype; onClose: () => void }) {
  const original = useMemo(() => [...nt.fields].sort((a, b) => a.ord - b.ord), [nt]);
  const [fields, setFields] = useState<FieldDraft[]>(original.map((f, i) => ({ name: f.name, from: i })));
  const [sortIdx, setSortIdx] = useState(nt.sortIdx);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
    if (sortIdx === i) setSortIdx(j);
    else if (sortIdx === j) setSortIdx(i);
  };
  const remove = (i: number) => {
    setFields(fields.filter((_, k) => k !== i));
    if (sortIdx === i) setSortIdx(0);
    else if (sortIdx > i) setSortIdx(sortIdx - 1);
  };

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await col.changeNotetypeFields(nt.id, fields, sortIdx);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const removed = original.filter((_, i) => !fields.some((f) => f.from === i)).map((f) => f.name);
  if (confirm) {
    return (
      <ConfirmModal
        title="Delete fields?"
        message={`${confirm} The text in ${removed.length === 1 ? 'this field' : 'these fields'} is deleted from every note of this type.`}
        confirmLabel="Save"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await save();
        }}
      />
    );
  }

  return (
    <Modal title={`Fields · ${nt.name}`} onClose={onClose} wide>
      <div className="modal-body">
        {fields.map((f, i) => (
          <div key={i} className="fe-row">
            <input value={f.name} aria-label={`Field ${i + 1} name`} onChange={(e) => setFields(fields.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
            <label className="fe-sort" title="Sort the browser by this field">
              <input type="radio" name="sortfield" checked={sortIdx === i} onChange={() => setSortIdx(i)} /> sort
            </label>
            <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="icon-btn" aria-label="Move down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="icon-btn" aria-label={`Delete ${f.name}`} disabled={fields.length <= 1} onClick={() => remove(i)}><Icon.trash s={15} /></button>
          </div>
        ))}
        <Btn size="sm" onClick={() => setFields([...fields, { name: `Field ${fields.length + 1}`, from: null }])} style={{ alignSelf: 'flex-start' }}>
          <Icon.plus s={14} /> Add field
        </Btn>
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Renaming a field updates the card templates that use it.</p>
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={saving} onClick={() => (removed.length ? setConfirm(`Deleting: ${removed.join(', ')}.`) : void save())}>{saving ? 'Saving…' : 'Save'}</Btn>
      </div>
    </Modal>
  );
}

interface TemplateDraft {
  name: string;
  qfmt: string;
  afmt: string;
  from: number | null;
}

function CardsEditor({ nt, onClose }: { nt: Notetype; onClose: () => void }) {
  const [templates, setTemplates] = useState<TemplateDraft[]>(() => [...nt.templates].sort((a, b) => a.ord - b.ord).map((t, i) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt, from: i })));
  const [css, setCss] = useState(nt.css);
  const [idx, setIdx] = useState(0);
  const [side, setSide] = useState<'front' | 'back' | 'css'>('front');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const { data: sample } = useLive(
    async () => {
      const [row] = await appSql.all<{ flds: string }>('SELECT flds FROM notes WHERE mid = ? LIMIT 1', [nt.id]);
      const fields = [...nt.fields].sort((a, b) => a.ord - b.ord);
      return row ? splitFields(row.flds) : fields.map((f) => `(${f.name})`);
    },
    [nt.id],
    ['notes'],
  );
  const { data: cardCounts } = useLive(
    async () => {
      const rows = await appSql.all<{ ord: number; n: number }>('SELECT ord, COUNT(*) AS n FROM cards WHERE nid IN (SELECT id FROM notes WHERE mid = ?) GROUP BY ord', [nt.id]);
      return new Map(rows.map((r) => [r.ord, r.n]));
    },
    [nt.id],
    ['cards'],
  );

  const cur = templates[Math.min(idx, templates.length - 1)];
  const set = (patch: Partial<TemplateDraft>) => setTemplates(templates.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  const draft: Notetype = { ...nt, css, templates: templates.map((t, ord) => ({ name: t.name, ord, qfmt: t.qfmt, afmt: t.afmt })) };

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await col.changeNotetypeTemplates(nt.id, templates, css);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const removedCards = nt.templates.filter((_, i) => !templates.some((t) => t.from === i)).reduce((s, t) => s + (cardCounts?.get(t.ord) ?? 0), 0);

  if (preview && sample) {
    return <CardPreview notetype={{ ...draft, templates: draft.templates }} values={sample} tags="" deckName="" onClose={() => setPreview(false)} />;
  }
  if (confirm) {
    return (
      <ConfirmModal title="Delete card types?" message={confirm} confirmLabel="Save" danger onClose={() => setConfirm(null)}
        onConfirm={async () => { setConfirm(null); await save(); }} />
    );
  }

  return (
    <Modal title={`Cards · ${nt.name}`} onClose={onClose} wide>
      <div className="modal-body">
        <div className="chip-row">
          {templates.map((t, i) => (
            <button key={i} className={'fchip' + (i === idx ? ' on' : '')} onClick={() => setIdx(i)}>{t.name || `Card ${i + 1}`}</button>
          ))}
          {nt.kind === 0 && (
            <button className="fchip" onClick={() => { setTemplates([...templates, { name: `Card ${templates.length + 1}`, qfmt: cur.qfmt, afmt: cur.afmt, from: null }]); setIdx(templates.length); }}>
              + Add card type
            </button>
          )}
        </div>
        {cur && (
          <>
            <div className="ce-head">
              <label className="opt-field" style={{ flex: 1 }}>
                <span>Name</span>
                <input value={cur.name} onChange={(e) => set({ name: e.target.value })} style={{ flex: 1, width: 'auto' }} />
              </label>
              {nt.kind === 0 && templates.length > 1 && (
                <>
                  <button className="icon-btn" aria-label="Move earlier" disabled={idx === 0} onClick={() => { const n = [...templates]; [n[idx - 1], n[idx]] = [n[idx], n[idx - 1]]; setTemplates(n); setIdx(idx - 1); }}>←</button>
                  <button className="icon-btn" aria-label="Move later" disabled={idx === templates.length - 1} onClick={() => { const n = [...templates]; [n[idx + 1], n[idx]] = [n[idx], n[idx + 1]]; setTemplates(n); setIdx(idx + 1); }}>→</button>
                  <button className="icon-btn" aria-label="Delete this card type" onClick={() => { setTemplates(templates.filter((_, i) => i !== idx)); setIdx(Math.max(0, idx - 1)); }}><Icon.trash s={15} /></button>
                </>
              )}
            </div>
            <div className="density-seg ce-tabs">
              {(['front', 'back', 'css'] as const).map((s) => (
                <div key={s} className={'d' + (side === s ? ' on' : '')} onClick={() => setSide(s)}>{s === 'front' ? 'Front template' : s === 'back' ? 'Back template' : 'Styling'}</div>
              ))}
            </div>
            <textarea
              className="ce-code"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={side === 'front' ? cur.qfmt : side === 'back' ? cur.afmt : css}
              onChange={(e) => (side === 'front' ? set({ qfmt: e.target.value }) : side === 'back' ? set({ afmt: e.target.value }) : setCss(e.target.value))}
            />
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, margin: 0 }}>
              Fields: {[...nt.fields].sort((a, b) => a.ord - b.ord).map((f) => `{{${f.name}}}`).join(' ')} · the back usually starts with {'{{FrontSide}}<hr id=answer>'}.
            </p>
          </>
        )}
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={() => setPreview(true)} disabled={!sample} style={{ marginRight: 'auto' }}><Icon.review s={15} /> Preview</Btn>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          variant="primary"
          disabled={saving}
          onClick={() => (removedCards > 0 ? setConfirm(`This deletes ${removedCards.toLocaleString()} card${removedCards === 1 ? '' : 's'} of the removed card types (and any notes left with no cards).`) : void save())}
        >
          {saving ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </Modal>
  );
}
