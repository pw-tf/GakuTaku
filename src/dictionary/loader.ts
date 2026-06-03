import { dictDb } from './db';
import type { DictManifest, DictRecord } from './types';

const BUCKET = 'dictionary';

function publicUrl(path: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL;
  return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
}

export interface LoadProgress {
  phase: 'manifest' | 'download' | 'done';
  loaded: number;
  total: number;
}

export async function isDictionaryLoaded(): Promise<boolean> {
  const v = await dictDb.meta.get('version');
  return !!v;
}

/**
 * First-run download of the dictionary shards from Supabase Storage into IndexedDB.
 * Idempotent: skips if the manifest version is already loaded. Streams each gzip shard through
 * the native DecompressionStream, parses NDJSON, and bulk-inserts. Reports progress for the UI.
 */
export async function ensureDictionary(onProgress?: (p: LoadProgress) => void): Promise<void> {
  onProgress?.({ phase: 'manifest', loaded: 0, total: 0 });

  const manifestRes = await fetch(publicUrl('manifest.json'), { cache: 'no-cache' });
  if (!manifestRes.ok) {
    throw new Error(`Dictionary manifest not found (${manifestRes.status}). Has it been uploaded?`);
  }
  const manifest: DictManifest = await manifestRes.json();

  const existing = await dictDb.meta.get('version');
  if (existing?.value === manifest.version) {
    onProgress?.({ phase: 'done', loaded: manifest.totalRecords, total: manifest.totalRecords });
    return;
  }

  // Version changed (or first run): rebuild the store.
  await dictDb.entries.clear();

  let loaded = 0;
  for (const shard of manifest.shards) {
    const res = await fetch(publicUrl(shard.path));
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch dictionary shard ${shard.path} (${res.status}).`);
    }
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    const records: DictRecord[] = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as DictRecord);
    await dictDb.entries.bulkPut(records);
    loaded += shard.count;
    onProgress?.({ phase: 'download', loaded, total: manifest.totalRecords });
  }

  await dictDb.meta.put({ key: 'version', value: manifest.version });
  onProgress?.({ phase: 'done', loaded: manifest.totalRecords, total: manifest.totalRecords });
}
