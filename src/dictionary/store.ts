import { dictDb } from './db';
import {
  bucketOf,
  bucketPath,
  KANJI_JLPT_PATH,
  type DictBucket,
  type DictEntry,
  type DictManifest,
  type KanjiJlptIndex,
} from './types';

/**
 * On-demand access to the hosted dictionary.
 *
 * The dictionary is sharded by a hash of each headword ({@link bucketOf}), so a lookup only ever
 * needs the one or two buckets its candidate forms hash into — a few tens of KB — instead of the
 * ~900k-record up-front download this replaced. Every bucket that is fetched is cached in
 * IndexedDB, so a word looked up once keeps working offline, and the optional
 * {@link downloadAllBuckets} simply warms every bucket at once for full offline coverage.
 */

const BUCKET = 'dictionary';
/** Parsed buckets held for the session; they are small and re-parsing on every lookup is waste. */
const memory = new Map<number, DictBucket>();
/** In-flight fetches, so N candidate forms in one bucket cause one request, not N. */
const inFlight = new Map<number, Promise<DictBucket>>();

function publicUrl(path: string, version?: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL;
  const url = `${base}/storage/v1/object/public/${BUCKET}/${path}`;
  // Bucket paths are version-independent, so the version has to bust the HTTP cache explicitly.
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

async function fetchGzipJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to fetch ${what} (${res.status}).`);
  const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text) as T;
}

// ---- Manifest ---------------------------------------------------------------

let manifestPromise: Promise<DictManifest> | null = null;

async function fetchManifest(): Promise<DictManifest> {
  const res = await fetch(publicUrl('manifest.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Dictionary manifest not found (${res.status}). Has it been uploaded?`);
  const manifest = (await res.json()) as DictManifest;
  if (manifest.format !== 'buckets-1') {
    throw new Error(`Unsupported dictionary format "${manifest.format}" — update the app, or re-run build:dict.`);
  }
  return manifest;
}

/** Adopt a freshly fetched manifest, dropping every cached bucket if the build changed. */
async function storeManifest(manifest: DictManifest, previous: DictManifest | null): Promise<void> {
  if (previous && previous.version !== manifest.version) await dictDb.buckets.clear();
  await dictDb.meta.put({ key: 'manifest', value: JSON.stringify(manifest) });
}

async function cachedManifest(): Promise<DictManifest | null> {
  const row = await dictDb.meta.get('manifest');
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as DictManifest;
    return parsed.format === 'buckets-1' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The manifest, preferring the cached copy so the first lookup of a session costs one round trip
 * rather than two. A newer build is picked up by a background revalidation; because bucket cache
 * keys include the version, a version change during a session can only cost a re-fetch, never a
 * wrong answer.
 */
export function getManifest(): Promise<DictManifest> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const cached = await cachedManifest();
    if (cached) {
      void revalidateManifest(cached);
      return cached;
    }
    const fresh = await fetchManifest();
    await storeManifest(fresh, null);
    return fresh;
  })();
  // A failed manifest (offline on first run) must not poison the session's every later lookup.
  manifestPromise.catch(() => {
    manifestPromise = null;
  });
  return manifestPromise;
}

async function revalidateManifest(previous: DictManifest): Promise<void> {
  try {
    const fresh = await fetchManifest();
    if (fresh.version === previous.version) return;
    await storeManifest(fresh, previous);
    memory.clear();
    inFlight.clear();
    manifestPromise = Promise.resolve(fresh);
  } catch {
    /* offline or unreachable — the cached manifest stays authoritative */
  }
}

/** True when a lookup can be served: a manifest is cached, or one can be fetched. */
export async function isDictionaryReady(): Promise<boolean> {
  try {
    await getManifest();
    return true;
  } catch {
    return false;
  }
}

// ---- Buckets ----------------------------------------------------------------

async function loadBucket(bucket: number, manifest: DictManifest): Promise<DictBucket> {
  const key = `${manifest.version}/${bucket}`;
  const row = await dictDb.buckets.get(key);
  if (row) {
    try {
      return JSON.parse(row.json) as DictBucket;
    } catch {
      await dictDb.buckets.delete(key); // corrupt cache entry — refetch below
    }
  }
  const res = await fetch(publicUrl(bucketPath(bucket), manifest.version));
  if (!res.ok || !res.body) throw new Error(`Failed to fetch dictionary data (${res.status}).`);
  const json = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  // Cache failures (private mode, quota) must not fail the lookup itself.
  await dictDb.buckets.put({ key, json }).catch(() => undefined);
  return JSON.parse(json) as DictBucket;
}

function getBucket(bucket: number, manifest: DictManifest): Promise<DictBucket> {
  const held = memory.get(bucket);
  if (held) return Promise.resolve(held);
  const pending = inFlight.get(bucket);
  if (pending) return pending;
  const p = loadBucket(bucket, manifest)
    .then((data) => {
      memory.set(bucket, data);
      return data;
    })
    .finally(() => inFlight.delete(bucket));
  inFlight.set(bucket, p);
  return p;
}

/**
 * Every entry filed under any of `forms`, de-duplicated by id. Each distinct bucket is fetched
 * once and in parallel, so a term plus its deinflections and kanji costs a couple of requests at
 * most — and none at all once they are cached.
 */
export async function entriesForForms(forms: string[]): Promise<DictEntry[]> {
  const wanted = [...new Set(forms.filter(Boolean))];
  if (wanted.length === 0) return [];
  const manifest = await getManifest();

  const byBucket = new Map<number, string[]>();
  for (const form of wanted) {
    const b = bucketOf(form, manifest.bucketCount);
    const list = byBucket.get(b);
    if (list) list.push(form);
    else byBucket.set(b, [form]);
  }

  const out: DictEntry[] = [];
  const seen = new Set<string>();
  const loaded = await Promise.all(
    [...byBucket].map(async ([bucket, bucketForms]) => [await getBucket(bucket, manifest), bucketForms] as const),
  );
  for (const [data, bucketForms] of loaded) {
    for (const form of bucketForms) {
      for (const entry of data[form] ?? []) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
      }
    }
  }
  return out;
}

/**
 * Fetch and cache one bucket *without* keeping it in memory — the optional offline download warms
 * every bucket, and holding them all parsed would cost far more than the cache it is filling.
 * Already-cached buckets are skipped, which is what makes an interrupted download resumable.
 */
export async function cacheBucket(bucket: number, manifest: DictManifest): Promise<boolean> {
  const key = `${manifest.version}/${bucket}`;
  if (await dictDb.buckets.get(key)) return false;
  const res = await fetch(publicUrl(bucketPath(bucket), manifest.version));
  if (!res.ok || !res.body) throw new Error(`Failed to fetch dictionary data (${res.status}).`);
  const json = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  await dictDb.buckets.put({ key, json });
  return true;
}

/** How many of this build's buckets are already cached locally. */
export async function cachedBucketCount(manifest: DictManifest): Promise<number> {
  const prefix = `${manifest.version}/`;
  const rows = await dictDb.buckets.where('key').startsWith(prefix).count();
  const kanji = await dictDb.buckets.get(`${prefix}kanji-jlpt`);
  return Math.max(0, Math.min(manifest.bucketCount, rows - (kanji ? 1 : 0)));
}

// ---- Kanji JLPT index -------------------------------------------------------

let kanjiJlptPromise: Promise<KanjiJlptIndex> | null = null;

/**
 * `literal → old-JLPT level` for every kanji in KANJIDIC. A few KB, fetched once and cached,
 * because the reader's "N3+" furigana density needs a level for every kanji on screen — pulling a
 * bucket per character would be far more traffic than the whole index.
 */
export function getKanjiJlpt(): Promise<KanjiJlptIndex> {
  if (kanjiJlptPromise) return kanjiJlptPromise;
  kanjiJlptPromise = (async () => {
    const manifest = await getManifest();
    const key = `${manifest.version}/kanji-jlpt`;
    const row = await dictDb.buckets.get(key);
    if (row) {
      try {
        return JSON.parse(row.json) as KanjiJlptIndex;
      } catch {
        await dictDb.buckets.delete(key);
      }
    }
    const index = await fetchGzipJson<KanjiJlptIndex>(
      publicUrl(KANJI_JLPT_PATH, manifest.version),
      'the kanji index',
    );
    await dictDb.buckets.put({ key, json: JSON.stringify(index) }).catch(() => undefined);
    return index;
  })();
  kanjiJlptPromise.catch(() => {
    kanjiJlptPromise = null;
  });
  return kanjiJlptPromise;
}
