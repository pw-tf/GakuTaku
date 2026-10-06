import { useEffect, useRef, useState } from 'react';
import { col } from '../anki/appCollection';
import { splitFields, type Notetype } from '../anki/notetype';
import { CardPreview, NoteFields, TagInput } from '../decks/NoteEditor';
import { Btn } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { ConfirmModal, Modal } from '../ui/Modal';

/** Edit a note's fields (HTML, as in Anki's HTML editor, with a formatting toolbar) and tags, or delete it. */
export function EditNoteModal({ noteId, onClose, onSaved, onDeleted }: { noteId: number; onClose: () => void; onSaved?: () => void; onDeleted?: () => void }) {
  const [nt, setNt] = useState<Notetype | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState(false);
  /** The note as loaded, to ask before discarding edits. */
  const [loaded, setLoaded] = useState<string | null>(null);
  // Parents pass a fresh onClose each render; keep it out of the load effect so a re-render
  // doesn't reload the note over the edits being made.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    void (async () => {
      const note = await col.note(noteId);
      if (!note) return closeRef.current();
      const type = await col.notetype(note.mid);
      setNt(type);
      const fs = splitFields(note.flds);
      const vals = type ? type.fields.map((_, i) => fs[i] ?? '') : fs;
      setValues(vals);
      setTags(note.tags.trim());
      setLoaded(JSON.stringify([vals, note.tags.trim()]));
    })();
  }, [noteId]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await col.updateNote(noteId, values, tags.split(/\s+/).filter(Boolean));
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  if (confirmDelete) {
    return (
      <ConfirmModal
        title="Delete note?"
        message="This deletes the note and all of its cards. Their review history is kept for statistics."
        confirmLabel="Delete"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await col.removeNotes([noteId]);
          onDeleted?.();
          onClose();
        }}
      />
    );
  }

  if (preview && nt) return <CardPreview notetype={nt} values={values} tags={tags} deckName="" onClose={() => setPreview(false)} />;

  return (
    <Modal title={nt ? `Edit · ${nt.name}` : 'Edit note'} onClose={onClose} wide dirty={loaded != null && loaded !== JSON.stringify([values, tags.trim()])}>
      <div className="modal-body">
        {nt && <NoteFields notetype={nt} values={values} onChange={setValues} excludeNid={noteId} />}
        <TagInput value={tags} onChange={setTags} />
        {err && <p style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={() => setConfirmDelete(true)} style={{ marginRight: 'auto', color: 'var(--rate-again)' }}>Delete</Btn>
        <Btn onClick={() => setPreview(true)} disabled={!nt}><Icon.review s={15} /> Preview</Btn>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={saving || !nt} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Btn>
      </div>
    </Modal>
  );
}
