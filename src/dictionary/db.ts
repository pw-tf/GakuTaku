import Dexie, { type Table } from 'dexie';
import type { DictRecord } from './types';

export interface MetaRow {
  key: string;
  value: string;
}

/**
 * Local dictionary store (IndexedDB). This is large *static* data — deliberately NOT synced
 * through PowerSync/Postgres (build plan §3.1). Downloaded once and queried offline thereafter.
 */
export class DictDB extends Dexie {
  entries!: Table<DictRecord, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('gakutaku-dict');
    this.version(1).stores({
      // `*forms` is a multiEntry index: a record matches a query if any of its forms matches.
      entries: 'id, type, *forms',
      meta: 'key',
    });
  }
}

export const dictDb = new DictDB();
