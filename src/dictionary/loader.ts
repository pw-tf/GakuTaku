import { dictDb } from './db';
import type { DictManifest, DictRecord } from './types';

const BUCKET = 'dictionary';
/** Shards fetched+decompressed ahead of the (serial) IndexedDB insert, so network and DB overlap. */
const PREFETCH = 4;

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

async function fetchShard(path: string): Promise<DictRecord[]> {
  const res = await fetch(publicUrl(path));
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch dictionary shard ${path} (${res.status}).`);
  }
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DictRecord);
}

/**
 * First-run download of the dictionary shards from Supabase Storage into IndexedDB.
 * Idempotent: skips if the manifest version is already loaded. Downloads are pipelined — a few
 * shards fetch and decompress while the previous one bulk-inserts — and resumable: every inserted
 * shard is marked in meta under the pending version, so an interrupted download (tab closed,
 * network drop) picks up where it left off instead of starting over.
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

  // Resume only a matching in-progress download; anything else starts clean.
  const pending = await dictDb.meta.get('pending');
  if (pending?.value !== manifest.version) {
    await dictDb.entries.clear();
    await dictDb.meta.where('key').startsWith('shard:').delete();
    await dictDb.meta.put({ key: 'pending', value: manifest.version });
  }
  const done = new Set(
    (await dictDb.meta.where('key').startsWith('shard:').toArray()).map((r) => r.key.slice('shard:'.length)),
  );

  let loaded = 0;
  for (const s of manifest.shards) if (done.has(s.path)) loaded += s.count;
  onProgress?.({ phase: 'download', loaded, total: manifest.totalRecords });

  const todo = manifest.shards.filter((s) => !done.has(s.path));
  const inFlight = new Map<number, Promise<DictRecord[]>>();
  for (let i = 0; i < todo.length; i++) {
    for (let j = i; j < Math.min(i + PREFETCH, todo.length); j++) {
      if (!inFlight.has(j)) {
        const p = fetchShard(todo[j].path);
        p.catch(() => {}); // surfaced when awaited in order; this just prevents an unhandled rejection
        inFlight.set(j, p);
      }
    }
    const records = await inFlight.get(i)!;
    inFlight.delete(i);
    await dictDb.entries.bulkPut(records);
    await dictDb.meta.put({ key: `shard:${todo[i].path}`, value: manifest.version });
    loaded += todo[i].count;
    onProgress?.({ phase: 'download', loaded, total: manifest.totalRecords });
  }

  await dictDb.meta.where('key').startsWith('shard:').delete();
  await dictDb.meta.delete('pending');
  await dictDb.meta.put({ key: 'version', value: manifest.version });
  onProgress?.({ phase: 'done', loaded: manifest.totalRecords, total: manifest.totalRecords });
}
