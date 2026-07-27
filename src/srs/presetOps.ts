import { db } from '../sync/system';
import type { DeckPresetRecord } from '../sync/AppSchema';
import {
  DEFAULT_PRESET_NAME,
  defaultPresetConfig,
  legacyParamsCustomized,
  parseDeckOverrides,
  parsePresetConfig,
  resolveDeckConfig,
  serializeDeckOverrides,
  serializePresetConfig,
  type DeckOverrides,
  type DeckPresetConfig,
  type ResolvedDeckConfig,
} from './presets';
import { deckConfig } from './fsrs';

/**
 * DB operations for deck option presets (the pure model lives in `presets.ts`). Includes the
 * one-shot client-side migration from the legacy per-deck `fsrs_params` config to presets.
 */

export interface PresetRow {
  id: string;
  name: string;
  config: string | null;
}

/** All of the user's presets, name-sorted (Default first). */
export async function loadPresets(): Promise<PresetRow[]> {
  const rows = await db.getAll<PresetRow>('SELECT id, name, config FROM deck_presets ORDER BY name ASC');
  rows.sort((a, b) => (a.name === DEFAULT_PRESET_NAME ? -1 : b.name === DEFAULT_PRESET_NAME ? 1 : a.name.localeCompare(b.name)));
  return rows;
}

/** Build a presetId → parsed config map (the shape `resolveDeckConfig` consumes). */
export function presetConfigMap(rows: Pick<PresetRow, 'id' | 'config'>[]): Map<string, DeckPresetConfig> {
  return new Map(rows.map((r) => [r.id, parsePresetConfig(r.config)]));
}

/** Find-or-create the user's 'Default' preset (Anki-default config); returns its id. */
export async function ensureDefaultPreset(userId: string): Promise<string> {
  const rows = await db.getAll<{ id: string }>('SELECT id FROM deck_presets WHERE user_id = ? AND name = ? LIMIT 1', [
    userId,
    DEFAULT_PRESET_NAME,
  ]);
  if (rows.length) return rows[0].id;
  const id = crypto.randomUUID();
  await db.execute('INSERT INTO deck_presets (id, user_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    userId,
    DEFAULT_PRESET_NAME,
    serializePresetConfig(defaultPresetConfig()),
    new Date().toISOString(),
  ]);
  return id;
}

export async function createPreset(userId: string, name: string, config: DeckPresetConfig): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute('INSERT INTO deck_presets (id, user_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    userId,
    name.trim() || 'Preset',
    serializePresetConfig(config),
    new Date().toISOString(),
  ]);
  return id;
}

export async function savePresetConfig(presetId: string, config: DeckPresetConfig): Promise<void> {
  await db.execute('UPDATE deck_presets SET config = ? WHERE id = ?', [serializePresetConfig(config), presetId]);
}

export async function renamePreset(presetId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await db.execute('UPDATE deck_presets SET name = ? WHERE id = ?', [trimmed, presetId]);
}

/** Delete a preset, reassigning its member decks to the Default preset (Anki reassigns similarly). */
export async function deletePreset(userId: string, presetId: string): Promise<void> {
  const defaultId = await ensureDefaultPreset(userId);
  if (presetId === defaultId) return; // the Default preset is not deletable
  await db.writeTransaction(async (tx) => {
    await tx.execute('UPDATE decks SET preset_id = ? WHERE preset_id = ?', [defaultId, presetId]);
    await tx.execute('DELETE FROM deck_presets WHERE id = ?', [presetId]);
  });
}

export async function assignPreset(deckId: string, presetId: string): Promise<void> {
  await db.execute('UPDATE decks SET preset_id = ? WHERE id = ?', [presetId, deckId]);
}

/** Persist a deck's per-deck data (description + limit overrides), preserving the other keys. */
export async function saveDeckOverrides(deckId: string, patch: Partial<DeckOverrides>): Promise<void> {
  const row = await db.getOptional<{ fsrs_params: string | null }>('SELECT fsrs_params FROM decks WHERE id = ?', [deckId]);
  const current = parseDeckOverrides(row?.fsrs_params);
  await db.execute('UPDATE decks SET fsrs_params = ? WHERE id = ?', [serializeDeckOverrides({ ...current, ...patch }), deckId]);
}

/** A deck's effective config, loaded by id (for one-off imperative callers like mining). */
export async function resolveDeckConfigById(deckId: string): Promise<ResolvedDeckConfig> {
  const deck = await db.getOptional<{ preset_id: string | null; fsrs_params: string | null }>(
    'SELECT preset_id, fsrs_params FROM decks WHERE id = ?',
    [deckId],
  );
  if (!deck) return resolveDeckConfig({ preset_id: null, fsrs_params: null }, null);
  let preset: DeckPresetConfig | null = null;
  if (deck.preset_id) {
    const row = await db.getOptional<Pick<DeckPresetRecord, 'config'>>('SELECT config FROM deck_presets WHERE id = ?', [
      deck.preset_id,
    ]);
    if (row) preset = parsePresetConfig(row.config);
  }
  return resolveDeckConfig(deck, preset);
}

/**
 * One-shot migration of legacy per-deck `fsrs_params` config into presets, run after sign-in once
 * the first sync has landed. Idempotent: a user with any presets is left alone. Decks whose legacy
 * params match the defaults join the 'Default' preset; decks with customized scheduling get their
 * own preset named after the deck (Anki-faithful defaults fill the new knobs — including
 * leechAction 'suspend'; legacy tag-only behavior is preserved only for not-yet-migrated decks via
 * resolveDeckConfig's fallback). A concurrent migration on another device is benign: the losing
 * device's extra presets are user-deletable duplicates.
 */
export async function ensurePresetsMigrated(userId: string): Promise<void> {
  const existing = await db.getAll<{ n: number }>('SELECT COUNT(*) AS n FROM deck_presets WHERE user_id = ?', [userId]);
  if ((existing[0]?.n ?? 0) > 0) return;

  const decks = await db.getAll<{ id: string; name: string; fsrs_params: string | null; preset_id: string | null }>(
    'SELECT id, name, fsrs_params, preset_id FROM decks WHERE user_id = ?',
    [userId],
  );
  const defaultId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.writeTransaction(async (tx) => {
    await tx.execute('INSERT INTO deck_presets (id, user_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)', [
      defaultId,
      userId,
      DEFAULT_PRESET_NAME,
      serializePresetConfig(defaultPresetConfig()),
      now,
    ]);
    for (const deck of decks) {
      if (deck.preset_id) continue; // already migrated elsewhere
      let presetId = defaultId;
      if (legacyParamsCustomized(deck.fsrs_params)) {
        const legacy = deckConfig({ fsrs_params: deck.fsrs_params });
        presetId = crypto.randomUUID();
        await tx.execute('INSERT INTO deck_presets (id, user_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)', [
          presetId,
          userId,
          deck.name,
          serializePresetConfig({
            ...defaultPresetConfig(),
            newPerDay: legacy.newPerDay,
            reviewsPerDay: legacy.reviewsPerDay,
            desiredRetention: legacy.desiredRetention,
            maximumInterval: legacy.maximumInterval,
            learningSteps: legacy.learningSteps,
            relearningSteps: legacy.relearningSteps,
            w: legacy.w,
          }),
          now,
        ]);
      }
      const overrides = serializeDeckOverrides({ description: deckConfig({ fsrs_params: deck.fsrs_params }).description });
      await tx.execute('UPDATE decks SET preset_id = ?, fsrs_params = ? WHERE id = ?', [presetId, overrides, deck.id]);
    }
  });
}
