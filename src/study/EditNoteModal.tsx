import { useEffect, useState } from 'react';
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

  useEffect(() => {
    void (async () => {
      const note = await col.note(noteId);
      if (!note) return onClose();
      const type = await col.notetype(note.mid);
      setNt(type);
      const fs = splitFields(note.flds);
      setValues(type ? type.fields.map((_, i) => fs[i] ?? '') : fs);
      setTags(note.tags.trim());
    })();
  }, [noteId, onClose]);

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
    <Modal title={nt ? `Edit · ${nt.name}` : 'Edit note'} onClose={onClose} wide>
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
