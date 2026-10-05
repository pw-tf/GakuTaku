import Dexie, { type Table } from 'dexie';
import { db } from '../db';
import { createBackup } from './format';

/**
 * Automatic backups, as Anki makes them: once a day the collection (cards, notes, review history,
 * settings — not media or books) is saved inside the app, and the last few are kept. They guard
 * against mistakes and damage; the "Back up now" file is what protects against losing the phone.
 */

export const AUTO_BACKUPS_KEPT = 5;
const MIN_GAP_MS = 20 * 3_600_000;
const ENABLED_KEY = 'gakutaku-auto-backup';

interface AutoBackupRow {
  id?: number;
  /** ISO time it was made. */
  at: string;
  blob: Blob;
}

class AutoBackupDB extends Dexie {
  backups!: Table<AutoBackupRow, number>;
  constructor() {
    super('gakutaku-auto-backups');
    this.version(1).stores({ backups: '++id, at' });
  }
}

const store = new AutoBackupDB();

export function autoBackupEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setAutoBackupEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off');
  } catch {
    /* not remembered */
  }
}

export async function listAutoBackups(): Promise<{ id: number; at: Date; bytes: number }[]> {
  const rows = await store.backups.orderBy('at').reverse().toArray();
  return rows.map((r) => ({ id: r.id!, at: new Date(r.at), bytes: r.blob.size }));
}

export async function autoBackupBlob(id: number): Promise<Blob | null> {
  return (await store.backups.get(id))?.blob ?? null;
}

/** Make an automatic backup now and drop the oldest beyond the kept number. */
export async function makeAutoBackup(): Promise<void> {
  const blob = await createBackup(
    {
      database: () => db.exportFile(),
      prefs: () => {
        try {
          return localStorage.getItem('gakutaku-prefs');
        } catch {
          return null;
        }
      },
      media: async function* () {},
      books: async function* () {},
    },
    undefined,
    { files: false },
  );
  await store.backups.add({ at: new Date().toISOString(), blob });
  const all = await store.backups.orderBy('at').toArray();
  const extra = all.slice(0, Math.max(0, all.length - AUTO_BACKUPS_KEPT));
  if (extra.length) await store.backups.bulkDelete(extra.map((r) => r.id!));
}

let running = false;

/** Make a backup if it's on and the last one is old enough. Safe to call often. */
export async function maybeAutoBackup(): Promise<void> {
  if (running || !autoBackupEnabled()) return;
  running = true;
  try {
    const last = await store.backups.orderBy('at').last();
    if (last && Date.now() - new Date(last.at).getTime() < MIN_GAP_MS) return;
    await makeAutoBackup();
  } catch (e) {
    console.warn('Automatic backup failed', e);
  } finally {
    running = false;
  }
}
