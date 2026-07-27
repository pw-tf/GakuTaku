import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { db } from '../sync/system';
import type { ReviewLogRecord } from '../sync/AppSchema';
import {
  State,
  cardFromRow,
  deriveCard,
  parseJsonObject,
  previews,
  scheduler,
  toCardRow,
  type Card,
  type Grade,
  type GradePreview,
} from './fsrs';
import { NOTE_TYPE_NAME, parseNoteFields, type NoteFields } from './mining';
import { usePrefs } from '../app/prefs';
import {
  DEFAULT_LEARN_AHEAD_MINUTES,
  deckBudget,
  introducedTodayQuery,
  reviewedTodayQuery,
  studyDayEnd,
  studyDayStart,
  type DeckBudget,
  type DeckRaw,
  type DeckToday,
} from './queue';
import { ACTIVE_SQL } from './queue';
import { gatherSession, mulberry32, type GatherRow } from './gather';
import {
  defaultPresetConfig,
  parsePresetConfig,
  resolveDeckConfig,
  DEFAULT_PRESET_NAME,
  type ResolvedDeckConfig,
} from './presets';
import { leechPlan, siblingBuryPlan, type SiblingRow } from './cardPlans';
import { sweepExpiredBuried } from './cardOps';

/** An imported (non-vocab) card: raw fields + the chosen template's front/back, for generic render. */
export interface GenericCard {
  fields: Record<string, string>;
  front: string;
  back: string;
  /** The note type's stylesheet (Anki model CSS), applied in a sandboxed scope at render time. */
  css: string;
  /** The card's template/cloze ordinal (Anki `ord`) — the active cloze is ord + 1. */
  ord: number;
  /** Context for Anki's special fields: {{Tags}}, {{Deck}}, {{Subdeck}}, {{Card}}, {{Type}}. */
  tags: string;
  deckName: string;
  noteTypeName: string;
  templateName: string;
}

function parseStrMap(text: string | null | undefined): Record<string, string> {
  const obj = parseJsonObject(text);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? v : String(v ?? '');
  return out;
}

function parseTemplates(text: string | null | undefined): { name: string; front: string; back: string }[] {
  if (!text) return [];
  try {
    let v: unknown = JSON.parse(text);
    if (typeof v === 'string') v = JSON.parse(v);
    if (!Array.isArray(v)) return [];
    return v.map((t) => ({
      name: String((t as { name?: unknown })?.name ?? ''),
      front: String((t as { front?: unknown })?.front ?? ''),
      back: String((t as { back?: unknown })?.back ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * Review session controller (build plan M4 + Anki v3 alignment). Assembles a session from a
 * {@link ReviewSource}: active candidates are capped by the v3 daily-limit budgets (queue.ts),
 * ordered by the selected deck's gather/sort/mix options (gather.ts), and served through a
 * two-stream model:
 *   - `seq` cards (new, review, interday learning) appear in the gathered display order;
 *   - `timed` cards ((re)learning steps within today) appear at their exact due times, taking
 *     priority when due and honouring Anki's learn-ahead limit when the session is otherwise empty.
 * Each rating appends a review_log + refreshes the card cache in one transaction (§3.3), applies
 * the preset's leech action, and buries siblings per the preset's bury options. Sibling burying
 * happens at *answer* time — a deliberate deviation from v3's gather-time burying, because the
 * reactive SQL deck counts cannot run a gather; this preserves the counts-never-disagree invariant
 * while still never showing two siblings on the same day (v2/AnkiDroid-legacy semantics).
 */

export type ReviewSource =
  | { kind: 'due' }
  /** A deck and (optionally) its subdecks — `deckIds` = the deck plus all descendant deck ids. */
  | { kind: 'deck'; deckIds: string[]; deckName: string }
  | { kind: 'cards'; cardIds: string[]; label: string };

interface SessionCard {
  cardId: string;
  noteId: string;
  /** The note's tags (space-separated, Anki style) — needed for leech tagging. */
  tags: string;
  flag: number;
  fields: NoteFields;
  /** Present for imported note types; null for the built-in vocab card. */
  generic: GenericCard | null;
  fsrsCard: Card;
  cfg: ResolvedDeckConfig;
  /** Display order among seq cards (gather/sort/mix result). */
  seq: number;
  /** Timed cards ((re)learning steps today) are served by `dueAt`, not `seq`. */
  timed: boolean;
  /** When this card should next appear, in ms. Past = ready now. Only meaningful for timed cards. */
  dueAt: number;
}

interface CandidateRow {
  id: string;
  note_id: string;
  tmpl: number;
  state: number;
  flag: number | null;
  // Cached FSRS columns — let us rebuild the ts-fsrs Card without replaying logs (see loader).
  due: string | null;
  stability: number | null;
  difficulty: number | null;
  reps: number | null;
  lapses: number | null;
  last_review: string | null;
  fields: string;
  tags: string | null;
  created: string;
  deck_id: string | null;
  deck_name: string | null;
  fsrs_params: string | null;
  preset_id: string | null;
  nt_name: string | null;
  nt_templates: string | null;
  nt_css: string | null;
}

const SELECT_CARD = `SELECT c.id, c.template_index AS tmpl, c.state AS state, COALESCE(c.flag, 0) AS flag,
    c.due AS due, c.stability AS stability, c.difficulty AS difficulty, c.reps AS reps, c.lapses AS lapses, c.last_review AS last_review,
    n.id AS note_id, n.fields AS fields, n.tags AS tags, n.created_at AS created, n.deck_id,
    d.name AS deck_name, d.fsrs_params, d.preset_id, nt.name AS nt_name, nt.card_templates AS nt_templates, nt.css AS nt_css
  FROM cards c JOIN notes n ON n.id = c.note_id
  LEFT JOIN decks d ON d.id = n.deck_id
  LEFT JOIN note_types nt ON nt.id = n.note_type_id`;

/** Just enough to run the budgets + gather without marshalling every card's heavy note/CSS columns. */
interface LightRow {
  id: string;
  note_id: string;
  state: number;
  reps: number;
  due: string | null;
  position: number | null;
  created: string;
  deck_id: string | null;
  stability: number | null;
  difficulty: number | null;
  last_review: string | null;
  tmpl: number;
}

const SELECT_LIGHT = `SELECT c.id, c.note_id, c.state, c.reps, c.due, c.position, n.created_at AS created, n.deck_id,
    c.stability, c.difficulty, c.last_review, c.template_index AS tmpl
  FROM cards c JOIN notes n ON n.id = c.note_id`;

interface BuildResult {
  /** Hydrated candidates: seq cards first (in display order), then timed cards. */
  rows: CandidateRow[];
  timedIds: Set<string>;
  cfgByDeck: Map<string, ResolvedDeckConfig>;
}

const fallbackCfg = (): ResolvedDeckConfig => resolveDeckConfig({ preset_id: null, fsrs_params: null }, null);

/**
 * Build the session's candidate list. Budgets/gathering run on *lightweight* rows so we never fetch
 * the heavy note fields / template / CSS for the whole due backlog — only the chosen cards are then
 * hydrated. This is the difference between a review starting instantly and scanning thousands of
 * fat rows on a big imported deck.
 */
async function buildCandidates(source: ReviewSource): Promise<BuildResult> {
  const now = new Date();
  const cutoffHour = usePrefs.getState().dayCutoffHour;
  const dayStartD = studyDayStart(now, cutoffHour);
  const dayStart = dayStartD.toISOString();
  const dayEnd = studyDayEnd(now, cutoffHour).toISOString();

  // Converge yesterday's expired burials back to active (counts don't depend on it — ACTIVE_SQL
  // already treats them as active — but the rows should not stay marked buried forever).
  await sweepExpiredBuried(now);

  // Deck configs once (not joined per candidate row): decks + their presets, resolved.
  const deckRows = await db.getAll<{ id: string; name: string; fsrs_params: string | null; preset_id: string | null }>(
    'SELECT id, name, fsrs_params, preset_id FROM decks',
  );
  const presetRows = await db.getAll<{ id: string; name: string; config: string | null }>(
    'SELECT id, name, config FROM deck_presets',
  );
  const presetCfg = new Map(presetRows.map((p) => [p.id, parsePresetConfig(p.config)]));
  const cfgByDeck = new Map(
    deckRows.map((d) => [d.id, resolveDeckConfig(d, d.preset_id ? (presetCfg.get(d.preset_id) ?? null) : null)]),
  );
  const cfgFor = (deck: string) => cfgByDeck.get(deck) ?? fallbackCfg();

  if (source.kind === 'cards') {
    if (source.cardIds.length === 0) return { rows: [], timedIds: new Set(), cfgByDeck };
    const ph = source.cardIds.map(() => '?').join(',');
    const rows = await db.getAll<CandidateRow>(`${SELECT_CARD} WHERE c.id IN (${ph})`, source.cardIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = source.cardIds.map((id) => byId.get(id)).filter((r): r is CandidateRow => !!r);
    const timedIds = new Set(ordered.filter((r) => r.state === State.Learning || r.state === State.Relearning).map((r) => r.id));
    return { rows: ordered, timedIds, cfgByDeck };
  }

  if (source.kind === 'deck' && source.deckIds.length === 0) return { rows: [], timedIds: new Set(), cfgByDeck };
  const deckArg = source.kind === 'deck' ? source.deckIds : [];
  const deckFilter = deckArg.length ? ` AND n.deck_id IN (${deckArg.map(() => '?').join(',')})` : '';

  // v3: display order comes from the deck you clicked study on; 'due' (all decks) uses the Default
  // preset. Subdeck presets contribute limits only.
  let selectedCfg: ResolvedDeckConfig;
  if (source.kind === 'deck') {
    selectedCfg = cfgFor(source.deckIds[0]);
  } else {
    const def = presetRows.find((p) => p.name === DEFAULT_PRESET_NAME);
    selectedCfg = { ...(def ? parsePresetConfig(def.config) : defaultPresetConfig()), presetId: def?.id ?? null };
  }

  // Deck tree order for the 'deck' gather priority (name sort ≈ the deck screen's tree order,
  // since `Parent::Child` sorts directly after its parent).
  const deckOrder = [...deckRows].sort((a, b) => a.name.localeCompare(b.name)).map((d) => d.id);

  const dueLight = await db.getAll<LightRow>(
    `${SELECT_LIGHT} WHERE c.reps > 0 AND c.due <= ? AND ${ACTIVE_SQL}${deckFilter} ORDER BY c.due ASC`,
    [dayEnd, dayStart, ...deckArg],
  );
  const newLight = await db.getAll<LightRow>(
    `${SELECT_LIGHT} WHERE c.reps = 0 AND ${ACTIVE_SQL}${deckFilter}`,
    [dayStart, ...deckArg],
  );

  // Today's activity per deck, against the configurable study-day boundary (shared with the deck list).
  const intro = introducedTodayQuery(dayStart);
  const rev = reviewedTodayQuery(dayStart);
  const introduced = await db.getAll<{ deck: string | null; cnt: number }>(intro.sql, intro.params);
  const reviewsToday = await db.getAll<{ deck: string | null; cnt: number }>(rev.sql, rev.params);
  const introducedByDeck = new Map(introduced.map((r) => [r.deck ?? '', r.cnt]));
  const reviewedByDeck = new Map(reviewsToday.map((r) => [r.deck ?? '', r.cnt]));
  const todayFor = (deck: string): DeckToday => ({
    introduced: introducedByDeck.get(deck) ?? 0,
    reviewed: reviewedByDeck.get(deck) ?? 0,
  });

  // Raw per-deck counts from the same light rows the gather consumes (same predicates as the
  // counts SQL in queue.ts, so the deck list and the session cannot disagree).
  const dayStartMs = dayStartD.getTime();
  const rawByDeck = new Map<string, DeckRaw>();
  const rawFor = (deck: string): DeckRaw => {
    let r = rawByDeck.get(deck);
    if (!r) {
      r = { newCount: 0, learnIntraday: 0, learnInterday: 0, reviewCount: 0 };
      rawByDeck.set(deck, r);
    }
    return r;
  };
  const lastReviewMs = (r: LightRow) => (r.last_review ? new Date(r.last_review).getTime() : null);
  for (const r of newLight) rawFor(r.deck_id ?? '').newCount++;
  for (const r of dueLight) {
    const raw = rawFor(r.deck_id ?? '');
    if (r.state === State.Learning || r.state === State.Relearning) {
      const lr = lastReviewMs(r);
      if (lr != null && lr >= dayStartMs) raw.learnIntraday++;
      else raw.learnInterday++;
    } else {
      raw.reviewCount++;
    }
  }

  const budgets = new Map<string, DeckBudget>();
  for (const [deck, raw] of rawByDeck) budgets.set(deck, deckBudget(cfgFor(deck), raw, todayFor(deck)));

  // v3 tree cap: the selected deck's own limits also cap the whole subtree.
  let treeBudget: DeckBudget | null = null;
  if (source.kind === 'deck') {
    const treeRaw: DeckRaw = { newCount: 0, learnIntraday: 0, learnInterday: 0, reviewCount: 0 };
    const treeToday: DeckToday = { introduced: 0, reviewed: 0 };
    for (const id of source.deckIds) {
      const raw = rawByDeck.get(id);
      if (raw) {
        treeRaw.newCount += raw.newCount;
        treeRaw.learnIntraday += raw.learnIntraday;
        treeRaw.learnInterday += raw.learnInterday;
        treeRaw.reviewCount += raw.reviewCount;
      }
      const t = todayFor(id);
      treeToday.introduced += t.introduced;
      treeToday.reviewed += t.reviewed;
    }
    treeBudget = deckBudget(selectedCfg, treeRaw, treeToday);
  }

  const toGatherRow = (r: LightRow): GatherRow => ({
    id: r.id,
    noteId: r.note_id,
    deckId: r.deck_id ?? '',
    state: r.state,
    reps: r.reps,
    dueMs: r.due ? new Date(r.due).getTime() : 0,
    position: r.position,
    createdMs: new Date(r.created).getTime(),
    templateIndex: r.tmpl,
    stability: r.stability,
    lastReviewMs: lastReviewMs(r),
    difficulty: r.difficulty,
  });

  const gathered = gatherSession({
    newRows: newLight.map(toGatherRow),
    dueRows: dueLight.map(toGatherRow),
    budgets,
    treeBudget,
    cfg: selectedCfg,
    deckOrder,
    dayStartMs,
    rng: mulberry32((Math.random() * 0xffffffff) >>> 0),
  });

  const chosen = [...gathered.seq, ...gathered.timed];
  if (chosen.length === 0) return { rows: [], timedIds: new Set(), cfgByDeck };

  // Hydrate only the chosen cards with their heavy columns, preserving order.
  const ph = chosen.map(() => '?').join(',');
  const full = await db.getAll<CandidateRow>(`${SELECT_CARD} WHERE c.id IN (${ph})`, chosen);
  const byId = new Map(full.map((r) => [r.id, r]));
  return {
    rows: chosen.map((id) => byId.get(id)).filter((r): r is CandidateRow => !!r),
    timedIds: new Set(gathered.timed),
    cfgByDeck,
  };
}

const bucketOf = (c: SessionCard): keyof ReviewCounts =>
  c.fsrsCard.reps === 0 || c.fsrsCard.state === State.New
    ? 'new'
    : c.fsrsCard.state === State.Learning || c.fsrsCard.state === State.Relearning
      ? 'learning'
      : 'review';

export interface ReviewCounts {
  new: number;
  learning: number;
  review: number;
}

export interface ReviewState {
  loading: boolean;
  isEmpty: boolean;
  done: boolean;
  reviewedCount: number;
  counts: ReviewCounts;
  /** Which count the current card belongs to — Anki underlines that number in the top bar. */
  currentBucket: keyof ReviewCounts | null;
  /** When the session is paused on learning cards due later today, the earliest such due time (ms). */
  nextLearningDueAt: number | null;
  shown: boolean;
  current: { cardId: string; noteId: string; flag: number; fields: NoteFields; generic: GenericCard | null } | null;
  gradePreviews: GradePreview[];
  canUndo: boolean;
  reveal: () => void;
  rate: (grade: Grade) => void;
  /** Undo the last answer (Anki `Z`): removes its review_log, restores the card, and re-shows it. */
  undo: () => void;
  /** Drop cards from the in-memory session (after an external bury/suspend); advances if current. */
  excludeCards: (ids: string[]) => void;
  /** Reflect an external flag change on the current card in the session state. */
  setCurrentFlag: (flag: number) => void;
}

/** One buried sibling, kept so undo can restore both its row and its place in the session. */
interface BuriedSibling {
  id: string;
  prevQueue: number;
  prevBuriedUntil: string | null;
  sessionCard: SessionCard | null;
}

/** One answered card, kept so the review can be undone (Anki-style undo). */
interface UndoEntry {
  card: SessionCard;
  logId: string;
  /** Tags after the answer (leech tagging may have changed them). */
  newTags: string;
  /** The answer suspended the card via the leech action. */
  suspended: boolean;
  buriedSiblings: BuriedSibling[];
}

/** Pick what to show: a pinned (just-undone) card, then due timed cards, then seq order, then learn-ahead. */
function pickCurrent(queue: SessionCard[], pinnedId: string | null, nowMs: number, learnAheadMs: number): SessionCard | null {
  if (pinnedId) {
    const pinned = queue.find((c) => c.cardId === pinnedId);
    if (pinned) return pinned;
  }
  let dueTimed: SessionCard | null = null;
  let nextSeq: SessionCard | null = null;
  let ahead: SessionCard | null = null;
  for (const c of queue) {
    if (c.timed) {
      if (c.dueAt <= nowMs && (!dueTimed || c.dueAt < dueTimed.dueAt)) dueTimed = c;
      else if (c.dueAt <= nowMs + learnAheadMs && (!ahead || c.dueAt < ahead.dueAt)) ahead = c;
    } else if (!nextSeq || c.seq < nextSeq.seq) {
      nextSeq = c;
    }
  }
  return dueTimed ?? nextSeq ?? ahead;
}

export function useReview(source: ReviewSource): ReviewState {
  const { session } = useAuth();
  const userId = session?.user.id ?? '';
  const [queue, setQueue] = useState<SessionCard[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialTotal, setInitialTotal] = useState(0);
  const [shown, setShown] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [history, setHistory] = useState<UndoEntry[]>([]);
  const [, setClock] = useState(0);
  const shownAt = useRef<number>(Date.now());
  const queueRef = useRef<SessionCard[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const sourceKey = JSON.stringify(source);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { rows, timedIds, cfgByDeck } = await buildCandidates(source);
      if (cancelled) return;
      // Only (re)learning cards need a log replay — their intra-step counter isn't cached. New and
      // Review cards are rebuilt straight from the cached FSRS columns (no per-card replay), which is
      // the bulk of the queue and the main load-time win.
      const replayIds = rows
        .filter((r) => r.state === State.Learning || r.state === State.Relearning)
        .map((r) => r.id);
      let logsByCard = new Map<string, ReviewLogRecord[]>();
      if (replayIds.length) {
        const ph = replayIds.map(() => '?').join(',');
        const logs = await db.getAll<ReviewLogRecord>(
          `SELECT id, card_id, rating, review_time, elapsed_ms, scheduled_days FROM review_logs WHERE card_id IN (${ph})`,
          replayIds,
        );
        logsByCard = logs.reduce((m, log) => {
          const arr = m.get(log.card_id!) ?? [];
          arr.push(log);
          m.set(log.card_id!, arr);
          return m;
        }, new Map<string, ReviewLogRecord[]>());
      }
      if (cancelled) return;
      const now = Date.now();
      const items: SessionCard[] = rows.map((r, i) => {
        const cfg = (r.deck_id ? cfgByDeck.get(r.deck_id) : undefined) ?? fallbackCfg();
        const needsReplay = r.state === State.Learning || r.state === State.Relearning;
        const fsrsCard = needsReplay ? deriveCard(logsByCard.get(r.id) ?? [], r.created, cfg, r.id) : cardFromRow(r, r.created, r.id);
        // Imported (non-vocab) note types render via the generic Anki template renderer.
        let generic: GenericCard | null = null;
        if (r.nt_name && r.nt_name !== NOTE_TYPE_NAME) {
          const tmpls = parseTemplates(r.nt_templates);
          const t = tmpls[r.tmpl] ?? tmpls[0];
          if (t) {
            generic = {
              fields: parseStrMap(r.fields),
              front: t.front,
              back: t.back,
              css: r.nt_css ?? '',
              ord: r.tmpl,
              tags: r.tags ?? '',
              deckName: r.deck_name ?? '',
              noteTypeName: r.nt_name,
              templateName: t.name,
            };
          }
        }
        const timed = timedIds.has(r.id);
        return {
          cardId: r.id,
          noteId: r.note_id,
          tags: r.tags ?? '',
          flag: r.flag ?? 0,
          fields: parseNoteFields(r.fields),
          generic,
          fsrsCard,
          cfg,
          seq: i,
          timed,
          dueAt: timed ? fsrsCard.due.getTime() : now,
        };
      });
      setQueue(items);
      setPinnedId(null);
      setInitialTotal(items.length);
      setReviewedCount(0);
      setHistory([]);
      setShown(false);
      shownAt.current = Date.now();
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // Anki's learn-ahead limit (Preferences → Scheduling, default 20 min): a timed learning card is
  // served early only when nothing else is ready; further-out cards pause the session.
  const learnAheadMs = (usePrefs.getState().learnAheadMinutes ?? DEFAULT_LEARN_AHEAD_MINUTES) * 60_000;
  const current = pickCurrent(queue, pinnedId, Date.now(), learnAheadMs);
  const isEmpty = !loading && initialTotal === 0;
  const done = !loading && initialTotal > 0 && !current && queue.length === 0;
  const paused = !loading && !current && queue.length > 0;
  const nextLearningDueAt = paused ? queue.reduce<number | null>((m, c) => (m == null || c.dueAt < m ? c.dueAt : m), null) : null;

  // While paused on a future learning card, tick so it surfaces when its step elapses.
  useEffect(() => {
    if (!paused) return;
    const t = setInterval(() => setClock((c) => c + 1), 10_000);
    return () => clearInterval(t);
  }, [paused]);

  const counts = useMemo<ReviewCounts>(() => {
    let n = 0;
    let l = 0;
    let r = 0;
    for (const c of queue) {
      if (bucketOf(c) === 'new') n++;
      else if (bucketOf(c) === 'learning') l++;
      else r++;
    }
    return { new: n, learning: l, review: r };
  }, [queue]);

  const currentBucket = current ? bucketOf(current) : null;

  const gradePreviews = useMemo(
    () => (current && shown ? previews(current.fsrsCard, new Date(), current.cfg) : []),
    [current, shown],
  );

  const reveal = useCallback(() => setShown(true), []);

  const rate = useCallback(
    (grade: Grade) => {
      if (!current || !userId) return;
      const now = new Date();
      const cutoffHour = usePrefs.getState().dayCutoffHour;
      const elapsedMs = Math.max(0, Date.now() - shownAt.current);
      const next = scheduler(current.cfg).next(current.fsrsCard, now, grade);
      const row = toCardRow(next.card);
      const logId = crypto.randomUUID();
      // Leech handling per the preset (Anki's default action is Suspend; legacy decks keep tag-only).
      const lp = leechPlan(current.fsrsCard.lapses, next.card.lapses, current.cfg, current.tags);
      const newTags = lp.tag ? (current.tags ? `${current.tags} leech` : 'leech') : current.tags;

      const dueMs = next.card.due.getTime();
      const dayEndD = studyDayEnd(now, cutoffHour);
      const dayEndMs = dayEndD.getTime();
      // Re-queue if still in a (re)learning step due before the day rollover (unless the leech
      // action just suspended it); otherwise it leaves the session.
      const stillLearning =
        (next.card.state === State.Learning || next.card.state === State.Relearning) && dueMs < dayEndMs && !lp.suspend;

      setQueue((q) => {
        const rest = q.filter((c) => c.cardId !== current.cardId);
        if (stillLearning) rest.push({ ...current, tags: newTags, fsrsCard: next.card, timed: true, dueAt: dueMs });
        return rest;
      });
      setPinnedId(null);
      setReviewedCount((n) => n + 1);
      setShown(false);
      shownAt.current = Date.now();

      const cfg = current.cfg;
      const wantsSiblingBury = cfg.buryNewSiblings || cfg.buryReviewSiblings || cfg.buryInterdayLearningSiblings;
      void (async () => {
        // Sibling burying (answer-time; see the module JSDoc for the v3 deviation rationale).
        let buriedSiblings: BuriedSibling[] = [];
        if (wantsSiblingBury) {
          const sibs = await db.getAll<{
            id: string;
            state: number;
            reps: number;
            due: string | null;
            queue: number | null;
            buried_until: string | null;
            last_review: string | null;
          }>(
            `SELECT id, state, reps, due, queue, buried_until, last_review FROM cards WHERE note_id = ? AND id != ?`,
            [current.noteId, current.cardId],
          );
          const dayStartMs = studyDayStart(now, cutoffHour).getTime();
          const planRows: SiblingRow[] = sibs.map((s) => ({
            id: s.id,
            state: s.state,
            reps: s.reps,
            dueMs: s.due ? new Date(s.due).getTime() : null,
            queue: s.queue ?? 0,
            lastReviewMs: s.last_review ? new Date(s.last_review).getTime() : null,
          }));
          const buryIds = new Set(siblingBuryPlan(planRows, cfg, dayStartMs, dayEndMs));
          buriedSiblings = sibs
            .filter((s) => buryIds.has(s.id))
            .map((s) => ({
              id: s.id,
              prevQueue: s.queue ?? 0,
              prevBuriedUntil: s.buried_until,
              sessionCard: queueRef.current.find((c) => c.cardId === s.id) ?? null,
            }));
        }

        await db.writeTransaction(async (tx) => {
          await tx.execute(
            `INSERT INTO review_logs (id, user_id, card_id, rating, review_time, elapsed_ms, scheduled_days)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [logId, userId, current.cardId, grade, now.toISOString(), elapsedMs, next.card.scheduled_days],
          );
          await tx.execute(
            `UPDATE cards SET due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ?${lp.suspend ? ', queue = -1, buried_until = NULL' : ''} WHERE id = ?`,
            [row.due, row.stability, row.difficulty, row.reps, row.lapses, row.state, row.last_review, current.cardId],
          );
          if (lp.tag) await tx.execute(`UPDATE notes SET tags = ? WHERE id = ?`, [newTags, current.noteId]);
          if (buriedSiblings.length) {
            const ids = buriedSiblings.map((s) => s.id);
            await tx.execute(
              `UPDATE cards SET queue = -2, buried_until = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
              [dayEndD.toISOString(), ...ids],
            );
          }
        });

        if (buriedSiblings.length) {
          const ids = new Set(buriedSiblings.map((s) => s.id));
          setQueue((q) => q.filter((c) => !ids.has(c.cardId)));
        }
        setHistory((h) => [...h, { card: current, logId, newTags, suspended: lp.suspend, buriedSiblings }]);
      })();
    },
    [current, userId],
  );

  // Anki-style undo: remove the answer's log, restore the card (cache, queue column, tags) and any
  // buried siblings, and re-show the card.
  const undo = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return;
    const row = toCardRow(last.card.fsrsCard);
    void db.writeTransaction(async (tx) => {
      await tx.execute(`DELETE FROM review_logs WHERE id = ?`, [last.logId]);
      await tx.execute(
        `UPDATE cards SET due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ?, queue = 0, buried_until = NULL WHERE id = ?`,
        [row.due, row.stability, row.difficulty, row.reps, row.lapses, row.state, row.last_review, last.card.cardId],
      );
      if (last.newTags !== last.card.tags) {
        await tx.execute(`UPDATE notes SET tags = ? WHERE id = ?`, [last.card.tags, last.card.noteId]);
      }
      for (const s of last.buriedSiblings) {
        await tx.execute(`UPDATE cards SET queue = ?, buried_until = ? WHERE id = ?`, [s.prevQueue, s.prevBuriedUntil, s.id]);
      }
    });
    // The card may have been re-queued mid-learning — drop that copy, restore buried siblings'
    // session entries, and re-show the original card now.
    setQueue((q) => {
      const restored = last.buriedSiblings
        .map((s) => s.sessionCard)
        .filter((c): c is SessionCard => !!c && !q.some((x) => x.cardId === c.cardId));
      return [last.card, ...restored, ...q.filter((c) => c.cardId !== last.card.cardId)];
    });
    setPinnedId(last.card.cardId);
    setHistory((h) => h.slice(0, -1));
    setReviewedCount((n) => Math.max(0, n - 1));
    setShown(false);
    shownAt.current = Date.now();
  }, [history]);

  const excludeCards = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    setQueue((q) => q.filter((c) => !drop.has(c.cardId)));
    setPinnedId((p) => (p && drop.has(p) ? null : p));
    setShown(false);
    shownAt.current = Date.now();
  }, []);

  const setCurrentFlag = useCallback(
    (flag: number) => {
      if (!current) return;
      setQueue((q) => q.map((c) => (c.cardId === current.cardId ? { ...c, flag } : c)));
    },
    [current],
  );

  return {
    loading,
    isEmpty,
    done,
    reviewedCount,
    counts,
    currentBucket,
    nextLearningDueAt,
    shown,
    current: current
      ? { cardId: current.cardId, noteId: current.noteId, flag: current.flag, fields: current.fields, generic: current.generic }
      : null,
    gradePreviews,
    canUndo: history.length > 0,
    reveal,
    rate,
    undo,
    excludeCards,
    setCurrentFlag,
  };
}
