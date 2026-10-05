import { useState } from 'react';
import { appSql, col } from '../anki/appCollection';
import { useTasks } from '../app/tasks';
import { Btn } from '../ui/atoms';
import { Modal } from '../ui/Modal';

const TASK = 'export';

/** Export a deck (with subdecks) or the whole collection as an Anki package for Anki / AnkiDroid. */
export function ExportModal({ deckId, deckName, onClose }: { deckId: number | null; deckName: string | null; onClose: () => void }) {
  const [scheduling, setScheduling] = useState(true);
  const [media, setMedia] = useState(true);

  async function run() {
    onClose();
    const t = useTasks.getState();
    t.start(TASK, 'Exporting');
    try {
      const [{ gatherExport, buildApkg, apkgFileName }, { getMediaFile }, { deliverFile, BackupCancelled }] = await Promise.all([
        import('../export/apkg'),
        import('../media/store'),
        import('../backup/device'),
      ]);
      t.update(TASK, { message: 'Collecting cards…' });
      const data = await gatherExport(col, appSql, deckId);
      t.update(TASK, { message: media ? 'Packing cards and media…' : 'Packing cards…' });
      const out = await buildApkg(data, { scheduling, media }, getMediaFile);
      try {
        await deliverFile(out.blob, apkgFileName(deckName), { title: 'Anki deck', dialogTitle: 'Save or share the deck', replace: /\.apkg$/ }, (message, done, total) => t.update(TASK, { message, done: done ?? 0, total: total ?? 0 }));
      } catch (e) {
        if (e instanceof BackupCancelled) return t.finish(TASK, 'error', 'The deck wasn’t saved anywhere.');
        throw e;
      }
      t.finish(TASK, 'success', `Exported ${out.notes.toLocaleString()} notes, ${out.cards.toLocaleString()} cards${media ? `, ${out.media.toLocaleString()} media files` : ''}.`);
    } catch (e) {
      t.finish(TASK, 'error', e instanceof Error ? e.message : 'Export failed.');
    }
  }

  return (
    <Modal title={deckName ? `Export “${deckName.split('::').pop()}”` : 'Export all decks'} onClose={onClose}>
      <div className="modal-body">
        <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.55 }}>
          An Anki package (.apkg){deckName ? ' of this deck and its subdecks' : ''}, for Anki or AnkiDroid.
        </p>
        <label className="opt-check"><input type="checkbox" checked={scheduling} onChange={(e) => setScheduling(e.target.checked)} /> Include scheduling information (due dates, review history)</label>
        <label className="opt-check"><input type="checkbox" checked={media} onChange={(e) => setMedia(e.target.checked)} /> Include media (pictures and audio)</label>
        {!scheduling && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Without scheduling, every card is exported as new — good for sharing a deck.</p>}
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => void run()}>Export</Btn>
      </div>
    </Modal>
  );
}
