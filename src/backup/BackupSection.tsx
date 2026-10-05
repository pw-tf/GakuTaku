import { useEffect, useRef, useState } from 'react';
import { fileAccept } from '../app/platform';
import { useTasks } from '../app/tasks';
import { Btn } from '../ui/atoms';
import { ConfirmModal } from '../ui/Modal';
import type { BackupManifest } from './format';

const TASK = 'backup';

function ago(d: Date | null): string {
  if (!d) return 'Never backed up.';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `Last backup: ${when}.`;
}

const size = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Settings → Backup: save everything to one file, or replace everything from one. */
export function BackupSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = useTasks((s) => s.tasks.some((t) => t.id === TASK && t.status === 'running'));
  const [last, setLast] = useState<Date | null>(null);
  const [pending, setPending] = useState<{ file: File; manifest: BackupManifest } | null>(null);

  useEffect(() => {
    void import('./device').then((m) => setLast(m.lastBackupAt()));
  }, []);

  async function backUp() {
    const t = useTasks.getState();
    t.start(TASK, 'Backing up');
    try {
      const { backUpNow } = await import('./device');
      const { bytes } = await backUpNow((message, done, total) => t.update(TASK, { message, done: done ?? 0, total: total ?? 0 }));
      setLast(new Date());
      t.finish(TASK, 'success', `Backup saved (${size(bytes)}).`);
    } catch (e) {
      t.finish(TASK, 'error', e instanceof Error ? e.message : 'Backup failed.');
    }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { readBackup } = await import('./format');
      const { manifest, close } = await readBackup(file);
      await close();
      setPending({ file, manifest });
    } catch (err) {
      const t = useTasks.getState();
      t.start(TASK, 'Restore');
      t.finish(TASK, 'error', err instanceof Error ? err.message : 'That file can’t be restored.');
    }
  }

  async function restore(file: File) {
    const t = useTasks.getState();
    t.start(TASK, 'Restoring backup');
    try {
      const { restoreFrom } = await import('./device');
      await restoreFrom(file, (message, done, total) => t.update(TASK, { message, done: done ?? 0, total: total ?? 0 }));
      t.finish(TASK, 'success', 'Restored. Reloading…');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      t.finish(TASK, 'error', err instanceof Error ? err.message : 'Restore failed.');
    }
  }

  return (
    <>
      <div className="set-h">Backup</div>
      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8, lineHeight: 1.5 }}>
        Everything lives on this device. A backup is one file with your cards, review history, media, books and settings.
        <br />
        {ago(last)}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn size="sm" variant="primary" disabled={busy} onClick={() => void backUp()}>Back up now</Btn>
        <Btn size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>Restore…</Btn>
      </div>
      <input ref={fileRef} type="file" hidden accept={fileAccept('.zip,application/zip')} onChange={(e) => void pick(e)} />
      {pending && (
        <ConfirmModal
          title="Restore this backup?"
          message={
            <>
              Everything on this device will be replaced with the backup from{' '}
              <b>{new Date(pending.manifest.createdAt).toLocaleString()}</b> ({plural(pending.manifest.counts.media, 'media file')},{' '}
              {plural(pending.manifest.counts.books, 'book')}). Anything added since then will be lost.
            </>
          }
          confirmLabel="Restore"
          danger
          onClose={() => setPending(null)}
          onConfirm={() => {
            const f = pending.file;
            setPending(null);
            void restore(f);
          }}
        />
      )}
    </>
  );
}
