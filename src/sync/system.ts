import { PowerSyncDatabase } from '@powersync/web';
import { AppSchema } from './AppSchema';
import { SupabaseConnector } from './SupabaseConnector';

/** Local SQLite (wa-sqlite WASM) database, synced with Supabase via the connector. */
export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'japanese-reader.db' },
});

export const connector = new SupabaseConnector();

/**
 * Connect the local DB to the sync stream. Call after the user is authenticated
 * (fetchCredentials returns null until then). Safe to call repeatedly.
 */
export async function connectSync(): Promise<void> {
  await db.connect(connector);
}

export async function disconnectSync(): Promise<void> {
  await db.disconnectAndClear();
}
