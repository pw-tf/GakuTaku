import { useMemo } from 'react';
import { useQuery } from '../sync/hooks';
import { usePrefs } from '../app/prefs';
import { parseJsonObject } from './fsrs';
import { NOTE_TYPE_NAME, parseNoteFields } from './mining';
import {
  capDeckQueue,
  introducedTodayQuery,
  rawDeckCountsQuery,
  reviewedTodayQuery,
  studyDayEnd,
  studyDayStart,
  type DeckToday,
} from './queue';
import { parseDeckOverrides, parsePresetConfig, resolveDeckConfig, type DeckOverrides, type ResolvedDeckConfig } from './presets';

/**
 * Reactive SRS queries over the synced `cards` cache (thin wrappers around PowerSync's `useQuery`,
 * like `src/sync/hooks.ts`). The FSRS columns on `cards` are a replay cache (§3.3); these read them
 * for fast counts/listing without re-deriving from logs. All daily-limit/study-day logic comes from
 * `queue.ts`, shared with the review-session builder so the deck list and the session never disagree.
 */

/** Start of the current study day (honours the configurable cutoff hour); re-subscribes only on cutoff change. */
function useStudyDayStart(): string {
  const cutoff = usePrefs((s) => s.dayCutoffHour);
  return useMemo(() => studyDayStart(new Date(), cutoff).toISOString(), [cutoff]);
}

/** End of the current study day — the due threshold for Anki-style day-granular counts. */
function useStudyDayEnd(): string {
  const cutoff = usePrefs((s) => s.dayCutoffHour);
  return useMemo(() => studyDayEnd(new Date(), cutoff).toISOString(), [cutoff]);
}

interface RawDeckCount {
  deck: string;
  name: string | null;
  fsrs_params: string | null;
  preset_id: string | null;
  total: number;
  newc: number;
  learn_intraday: number;
  learn_interday: number;
  reviewc: number;
  suspendedc: number;
  buriedc: number;
}

export interface DeckStat {
  id: string;
  name: string;
  /** The deck's effective config (preset + per-deck overrides). */
  cfg: ResolvedDeckConfig;
  presetId: string | null;
  presetName: string | null;
  /** Per-deck limit overrides + description (Anki "this deck" values). */
  overrides: DeckOverrides;
  /** Today's activity — needed so the deck tree can apply a parent's limits to the subtree sum. */
  today: DeckToday;
  /** Daily-capped counts (what's actually studiable today) — match the review session and the badge. */
  new: number;
  learning: number;
  due: number;
  total: number;
  /** Affordances: buried (still within their bury window) and suspended cards in this deck. */
  buried: number;
  suspended: number;
}

export interface DeckStatsResult {
  decks: DeckStat[];
  /** True until the first result lands (so the UI can show a spinner instead of an empty/zero state). */
  loading: boolean;
}

/** Per-deck Anki-style counts (New / Learning / Due, daily-capped) plus each deck's resolved config. */
export function useDeckStats(): DeckStatsResult {
  const dayEnd = useStudyDayEnd();
  const dayStart = useStudyDayStart();
  const rawQ = useMemo(() => rawDeckCountsQuery(dayStart, dayEnd), [dayStart, dayEnd]);
  const introQ = useMemo(() => introducedTodayQuery(dayStart), [dayStart]);
  const revQ = useMemo(() => reviewedTodayQuery(dayStart), [dayStart]);
  const presetParams = useMemo(() => [], []);
  const { data: raw, isLoading: lRaw } = useQuery<RawDeckCount>(rawQ.sql, rawQ.params);
  const { data: intro, isLoading: lIntro } = useQuery<{ deck: string | null; cnt: number }>(introQ.sql, introQ.params);
  const { data: rev, isLoading: lRev } = useQuery<{ deck: string | null; cnt: number }>(revQ.sql, revQ.params);
  const { data: presets, isLoading: lPresets } = useQuery<{ id: string; name: string; config: string | null }>(
    'SELECT id, name, config FROM deck_presets',
    presetParams,
  );
  const decks = useMemo(() => {
    const introByDeck = new Map(intro.map((r) => [r.deck ?? '', r.cnt]));
    const revByDeck = new Map(rev.map((r) => [r.deck ?? '', r.cnt]));
    const presetById = new Map(presets.map((p) => [p.id, p]));
    return raw.map((r) => {
      const preset = r.preset_id ? presetById.get(r.preset_id) : undefined;
      const cfg = resolveDeckConfig(
        { preset_id: r.preset_id, fsrs_params: r.fsrs_params },
        preset ? parsePresetConfig(preset.config) : null,
      );
      const today: DeckToday = { introduced: introByDeck.get(r.deck) ?? 0, reviewed: revByDeck.get(r.deck) ?? 0 };
      const q = capDeckQueue(
        cfg,
        { newCount: r.newc, learnIntraday: r.learn_intraday, learnInterday: r.learn_interday, reviewCount: r.reviewc },
        today,
      );
      return {
        id: r.deck,
        name: r.name ?? 'Untitled',
        cfg,
        presetId: preset?.id ?? null,
        presetName: preset?.name ?? null,
        overrides: preset ? parseDeckOverrides(r.fsrs_params) : {},
        today,
        new: q.new,
        learning: q.learning,
        due: q.due,
        total: r.total,
        buried: r.buriedc,
        suspended: r.suspendedc,
      };
    });
  }, [raw, intro, rev, presets]);
  return { decks, loading: lRaw || lIntro || lRev || lPresets };
}

export interface StudyCountResult {
  count: number;
  loading: boolean;
}

/** Cards actually studiable right now across all decks — the Review badge / "Today" number. */
export function useStudyCount(): StudyCountResult {
  const { decks, loading } = useDeckStats();
  const count = useMemo(() => decks.reduce((s, d) => s + d.new + d.learning + d.due, 0), [decks]);
  return { count, loading };
}

export interface CardRow {
  id: string;
  deck: string;
  /** Primary/sort field — Term for vocab, the note type's first field for imported decks. */
  front: string;
  /** Reading (vocab only; empty for imported note types). */
  reading: string;
  /** Secondary text — Meaning for vocab, the remaining fields joined for imported decks. */
  back: string;
  due: string | null;
  reps: number;
  state: number;
  last_review: string | null;
  /** Anki queue value: 0 active, -1 suspended, -2/-3 buried. */
  queue: number;
  buried_until: string | null;
  flag: number;
  position: number | null;
}

interface RawCardRow {
  id: string;
  deck: string | null;
  fields: string;
  nt_name: string | null;
  nt_fields: string | null;
  due: string | null;
  reps: number;
  state: number;
  last_review: string | null;
  queue: number | null;
  buried_until: string | null;
  flag: number | null;
  position: number | null;
}

const CARD_SELECT = `SELECT c.id, d.name AS deck, n.fields AS fields, nt.name AS nt_name, nt.fields AS nt_fields,
    c.due, c.reps, c.state, c.last_review, COALESCE(c.queue, 0) AS queue, c.buried_until, COALESCE(c.flag, 0) AS flag, c.position
  FROM cards c
  JOIN notes n ON n.id = c.note_id
  LEFT JOIN decks d ON d.id = n.deck_id
  LEFT JOIN note_types nt ON nt.id = n.note_type_id`;

/** Strip HTML tags, media tokens and entities so a note field reads as plain text in the browser table. */
function plainText(s: string): string {
  return s
    .replace(/\[sound:[^\]]*\]/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map a raw row to display fields, handling both the built-in vocab type and imported note types. */
function toCardRow(r: RawCardRow): CardRow {
  const base = {
    id: r.id,
    deck: r.deck ?? '—',
    due: r.due,
    reps: r.reps,
    state: r.state,
    last_review: r.last_review,
    queue: r.queue ?? 0,
    buried_until: r.buried_until,
    flag: r.flag ?? 0,
    position: r.position,
  };
  if (!r.nt_name || r.nt_name === NOTE_TYPE_NAME) {
    const f = parseNoteFields(r.fields);
    return { ...base, front: f.Term, reading: f.Reading, back: f.Meaning };
  }
  // Imported note type: show the first field as the term and the rest as the meaning.
  const values = parseJsonObject(r.fields);
  const order = (() => {
    try {
      const v = parseJsonObject(r.nt_fields) as unknown;
      return Array.isArray(v) ? (v as string[]) : Object.keys(values);
    } catch {
      return Object.keys(values);
    }
  })();
  const names = order.length ? order : Object.keys(values);
  const str = (k: string) => plainText(typeof values[k] === 'string' ? (values[k] as string) : '');
  const front = str(names[0] ?? '');
  const back = names.slice(1).map(str).filter(Boolean).join(' · ');
  return { ...base, front, reading: '', back };
}

/** Optional filters for the deck card table (Anki browser-style flag/status filtering). */
export interface DeckCardsFilter {
  /** 1..7 = only that flag. */
  flag?: number;
  status?: 'all' | 'suspended' | 'buried';
}

/** Cards in a single deck (newest first), for the deck detail browser. */
export function useDeckCards(deckId: string, filter?: DeckCardsFilter): CardRow[] {
  const flag = filter?.flag ?? 0;
  const status = filter?.status ?? 'all';
  const params = useMemo(() => (flag ? [deckId, flag] : [deckId]), [deckId, flag]);
  const statusSql =
    status === 'suspended'
      ? ' AND COALESCE(c.queue, 0) = -1'
      : status === 'buried'
        ? ' AND COALESCE(c.queue, 0) <= -2'
        : '';
  const flagSql = flag ? ' AND COALESCE(c.flag, 0) = ?' : '';
  const { data } = useQuery<RawCardRow>(
    `${CARD_SELECT} WHERE n.deck_id = ?${flagSql}${statusSql} ORDER BY n.created_at DESC LIMIT 500`,
    params,
  );
  return data.map(toCardRow);
}
