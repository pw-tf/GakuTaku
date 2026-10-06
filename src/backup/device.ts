import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from '../app/platform';
import { db } from '../db';
import { MIGRATIONS } from '../db/schema';
import { allMediaFiles, pruneMedia, putMediaBlobs } from '../media/store';
import { allBookFiles, pruneBookFiles, putBlob, putCover, putText } from '../reader/bookCache';
import { backupFileName, createBackup, restoreBackup, type BackupManifest, type BackupSource, type Progress, type RestoreTarget } from './format';

/** This device's data, as backup source and restore target. */

const PREFS_KEY = 'gakutaku-prefs';
const LAST_BACKUP_KEY = 'gakutaku-last-backup';

const source: BackupSource = {
  database: () => db.exportFile(),
  prefs: () => {
    try {
      return localStorage.getItem(PREFS_KEY);
    } catch {
      return null;
    }
  },
  media: allMediaFiles,
  books: allBookFiles,
};

/** The library's tables: a collection-only restore leaves these as they are (their files aren't in it). */
const LIBRARY_TABLES = ['documents', 'reading_positions', 'feeds'] as const;

const target: RestoreTarget = {
  schemaVersion: MIGRATIONS.length,
  database: (bytes) => db.importFile(bytes),
  prefs: (json) => {
    try {
      if (json) localStorage.setItem(PREFS_KEY, json);
    } catch {
      /* storage unavailable */
    }
  },
  keepLibrary: async () => {
    const saved = await Promise.all(LIBRARY_TABLES.map(async (t) => [t, await db.getAll<Record<string, unknown>>(`SELECT * FROM ${t}`)] as const));
    return async () => {
      await db.writeTransaction(async (tx) => {
        for (const [table, rows] of saved) {
          // Only columns the restored (and migrated) database has.
          const cols = new Set((await tx.getAll<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name));
          await tx.execute(`DELETE FROM ${table}`);
          if (!rows.length) continue;
          const names = Object.keys(rows[0]).filter((c) => cols.has(c));
          await tx.executeMany(
            `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
            rows.map((r) => names.map((n) => r[n])),
          );
        }
      });
    };
  },
  putMedia: putMediaBlobs,
  pruneMedia,
  putBook: async (b) => {
    if (b.file) await putBlob(b.id, b.file);
    if (b.text) await putText(b.id, b.text);
    if (b.cover) await putCover(b.id, b.cover);
  },
  pruneBooks: pruneBookFiles,
};

export function lastBackupAt(): Date | null {
  try {
    const v = localStorage.getItem(LAST_BACKUP_KEY);
    return v ? new Date(v) : null;
  } catch {
    return null;
  }
}

/** Base64 of a blob slice (its size must be a multiple of 3 so slices concatenate cleanly). */
async function base64Of(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 3 MiB: a multiple of 3, so each slice's base64 stands alone. */
const WRITE_CHUNK = 3 * 1024 * 1024;

/**
 * Hand a finished backup to the user. In the Android app it is written to the app's cache in
 * chunks (the bridge carries base64) and offered through the share sheet — save it to Drive, Files
 * or Downloads, or send it to another device. In a browser it downloads.
 */
async function deliver(blob: Blob, name: string, onProgress?: Progress): Promise<void> {
  return deliverFile(blob, name, { title: 'GakuTaku backup', dialogTitle: 'Save your GakuTaku backup', replace: /^GakuTaku-backup-.*\.zip$/ }, onProgress);
}

/**
 * Hand a file to the user: the share sheet in the Android app (save to Files, Drive, Downloads, or
 * send it), a download in a browser. Earlier files matching `replace` are cleared from the cache.
 */
export async function deliverFile(blob: Blob, name: string, opts: { title: string; dialogTitle: string; replace: RegExp }, onProgress?: Progress): Promise<void> {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  // Only the newest backup is kept in the cache.
  try {
    const { files } = await Filesystem.readdir({ path: '', directory: Directory.Cache });
    for (const f of files) if (opts.replace.test(f.name) || f.name === name) await Filesystem.deleteFile({ path: f.name, directory: Directory.Cache });
  } catch {
    /* nothing to clean */
  }
  await Filesystem.writeFile({ path: name, data: '', directory: Directory.Cache });
  for (let off = 0; off < blob.size; off += WRITE_CHUNK) {
    await Filesystem.appendFile({ path: name, data: await base64Of(blob.slice(off, off + WRITE_CHUNK)), directory: Directory.Cache });
    onProgress?.('Writing the file…', Math.min(off + WRITE_CHUNK, blob.size), blob.size);
  }
  const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache });
  try {
    await Share.share({ title: opts.title, files: [uri], dialogTitle: opts.dialogTitle });
  } catch (e) {
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) throw new BackupCancelled();
    throw e;
  }
}

/** The share sheet was dismissed without saving the backup anywhere. */
export class BackupCancelled extends Error {
  constructor() {
    super('The backup wasn’t saved anywhere.');
  }
}

/** Back up everything on this device and hand the file to the user. */
export async function backUpNow(onProgress?: Progress): Promise<{ bytes: number }> {
  const blob = await createBackup(source, onProgress);
  await deliver(blob, backupFileName(), onProgress);
  try {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  } catch {
    /* ignore */
  }
  return { bytes: blob.size };
}

/** Replace everything on this device with a backup file. The app must reload afterwards. */
export function restoreFrom(file: Blob, onProgress?: Progress): Promise<BackupManifest> {
  return restoreBackup(file, target, onProgress);
}
