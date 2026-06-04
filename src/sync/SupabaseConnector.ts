import {
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
  type PowerSyncCredentials,
  CrudEntry,
  UpdateType,
} from '@powersync/web';
import { supabase, powersyncUrl } from './supabase';

/**
 * Postgres error codes that are NOT recoverable by retrying the same write:
 *  - 22xxx: data exception (e.g. invalid text representation)
 *  - 23xxx: integrity constraint violation (unique / FK / not-null / check)
 *  - 42501: insufficient privilege (RLS rejected the write)
 *
 * For these we log + discard the transaction so it does not block the upload queue
 * forever. Everything else (network blips, 5xx, etc.) is rethrown to trigger
 * PowerSync's retry/backoff.
 */
const FATAL_RESPONSE_CODES = [/^22\d{3}$/, /^23\d{3}$/, /^42501$/];

/**
 * Columns that are Postgres `jsonb` but `column.text` in the client schema (AppSchema). The client
 * stores them as serialized JSON strings; if we upsert that string straight into a jsonb column it
 * lands as a double-encoded jsonb *string scalar*, and on replication back the client reads
 * `"{...}"` which JSON.parses to a string (not the object) — corrupting note fields / deck params.
 * Parse these back to objects before sending so Postgres stores real jsonb that round-trips cleanly.
 */
const JSON_COLUMNS: Record<string, string[]> = {
  decks: ['fsrs_params'],
  note_types: ['fields', 'card_templates'],
  notes: ['fields'],
};

function coerceJsonColumns(table: string, data: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  if (!cols) return data;
  const out = { ...data };
  for (const c of cols) {
    if (typeof out[c] === 'string') {
      try {
        out[c] = JSON.parse(out[c] as string);
      } catch {
        // Leave unparseable values as-is.
      }
    }
  }
  return out;
}

export class SupabaseConnector implements PowerSyncBackendConnector {
  /** Returns the endpoint + JWT PowerSync uses to authenticate the sync stream. */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();

    if (error) {
      throw new Error(`Could not fetch Supabase credentials: ${error.message}`);
    }
    if (!session) {
      // Not signed in — no sync until login.
      return null;
    }

    return {
      endpoint: powersyncUrl,
      token: session.access_token,
    };
  }

  /**
   * Flushes the local write queue to Supabase. One transaction at a time so that
   * PowerSync can checkpoint correctly. Maps each CRUD op back to a Supabase table
   * operation (§3.3 conflict strategy lives here at the transport layer).
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) {
      return;
    }

    let lastOp: CrudEntry | null = null;
    try {
      for (const op of transaction.crud) {
        lastOp = op;
        const table = supabase.from(op.table);

        switch (op.op) {
          case UpdateType.PUT: {
            const record = coerceJsonColumns(op.table, { ...op.opData, id: op.id });
            const { error } = await table.upsert(record);
            if (error) throw error;
            break;
          }
          case UpdateType.PATCH: {
            const { error } = await table.update(coerceJsonColumns(op.table, op.opData ?? {})).eq('id', op.id);
            if (error) throw error;
            break;
          }
          case UpdateType.DELETE: {
            const { error } = await table.delete().eq('id', op.id);
            if (error) throw error;
            break;
          }
        }
      }

      await transaction.complete();
    } catch (ex: unknown) {
      const code = (ex as { code?: string })?.code ?? '';
      if (typeof code === 'string' && FATAL_RESPONSE_CODES.some((re) => re.test(code))) {
        // Permanent failure — discard so the queue is not blocked.
        console.error('Discarding fatal upload op', { op: lastOp, error: ex });
        await transaction.complete();
      } else {
        // Likely transient — rethrow so PowerSync retries with backoff.
        console.error('Upload failed, will retry', ex);
        throw ex;
      }
    }
  }
}
