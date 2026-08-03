import Dexie, { type Table } from 'dexie';

export interface MetaRow {
  key: string;
  value: string;
}

/** One cached bucket payload, keyed `${version}/${bucket}` so a new build never reads stale data. */
export interface BucketRow {
  key: string;
  /** Decompressed JSON text. Kept as a string: smaller than a structured-cloned object graph,
   *  and `JSON.parse` on a ~20 KB bucket is far cheaper than the IndexedDB round-trip anyway. */
  json: string;
}

/**
 * Local dictionary store (IndexedDB). This is large *static* data — deliberately NOT synced
 * through PowerSync/Postgres (build plan §3.1).
 *
 * v1 held every record in one `entries` table, filled by a ~900k-row up-front download. v2 caches
 * hashed buckets fetched on demand instead, so `entries` is dropped — which also reclaims the
 * substantial space the old full download took on existing installs.
 */
export class DictDB extends Dexie {
  buckets!: Table<BucketRow, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('gakutaku-dict');
    this.version(1).stores({
      entries: 'id, type, *forms',
      meta: 'key',
    });
    this.version(2).stores({
      entries: null, // drop the v1 whole-dictionary table
      buckets: 'key',
      meta: 'key',
    });
  }
}

export const dictDb = new DictDB();
