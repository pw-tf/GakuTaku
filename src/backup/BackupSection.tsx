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

  async function restore(file: Blob) {
    const t = useTasks.getState();
    t.start(TASK, 'Restoring backup');
    try {
      // Keep what's here now as an automatic backup first, so a wrong restore can be undone.
      t.update(TASK, { message: 'Saving the current state first…' });
      const { makeAutoBackup } = await import('./auto');
      await makeAutoBackup();
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
      <h3>Backup</h3>
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
      <AutoBackups busy={busy} onRestore={(blob) => void restore(blob)} />
      {pending && (
        <ConfirmModal
          title="Restore this backup?"
          message={
            <>
              Everything on this device will be replaced with the backup from{' '}
              <b>{new Date(pending.manifest.createdAt).toLocaleString()}</b> ({plural(pending.manifest.counts.media, 'media file')},{' '}
              {plural(pending.manifest.counts.books, 'book')}). What’s here now is saved as an automatic backup first, so you can go back.
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

/** Settings → Backup → automatic backups: on/off, and restoring one of the kept ones. */
function AutoBackups({ busy, onRestore }: { busy: boolean; onRestore: (blob: Blob) => void }) {
  const [enabled, setEnabled] = useState(true);
  const [list, setList] = useState<{ id: number; at: Date; bytes: number }[]>([]);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ id: number; at: Date } | null>(null);

  useEffect(() => {
    void import('./auto').then(async (m) => {
      setEnabled(m.autoBackupEnabled());
      setList(await m.listAutoBackups());
    });
  }, [open]);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="toggle-row">
        <span>Automatic daily backups</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const on = e.target.checked;
            setEnabled(on);
            void import('./auto').then((m) => m.setAutoBackupEnabled(on));
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 4, lineHeight: 1.5 }}>
        Cards, history and settings, kept on this device (the last {5}). Media and books aren’t included.{' '}
        {list.length > 0 && <a style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : `Restore one (${list.length})`}</a>}
      </div>
      {open && (
        <div className="auto-backups">
          {list.map((b) => (
            <div key={b.id} className="ab-row">
              <span>{b.at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <span className="muted">{size(b.bytes)}</span>
              <Btn size="sm" disabled={busy} onClick={() => setConfirm(b)}>Restore</Btn>
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <ConfirmModal
          title="Restore this automatic backup?"
          message={<>Your cards, review history and settings go back to how they were on <b>{confirm.at.toLocaleString()}</b>. Your books, feeds, reading positions and media stay as they are. What’s here now is saved as another automatic backup first.</>}
          confirmLabel="Restore"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const m = await import('./auto');
            const blob = await m.autoBackupBlob(confirm.id);
            setConfirm(null);
            if (blob) onRestore(blob);
          }}
        />
      )}
    </div>
  );
}
