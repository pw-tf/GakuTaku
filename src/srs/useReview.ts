import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { db } from '../sync/system';
import type { ReviewLogRecord } from '../sync/AppSchema';
import {
  State,
  cardFromRow,
  deckConfig,
  deriveCard,
  parseJsonObject,
  previews,
  scheduler,
  toCardRow,
  type Card,
  type DeckConfig,
  type Grade,
  type GradePreview,
} from './fsrs';
import { NOTE_TYPE_NAME, parseNoteFields, type NoteFields } from './mining';
import { usePrefs } from '../app/prefs';
import { INTRODUCED_TODAY_SQL, LEARN_AHEAD_MS, REVIEWED_TODAY_SQL, deckAllowances, studyDayEnd, studyDayStart } from './queue';

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
 * Review session controller (build plan M4 + Anki-style relearning). Assembles a queue from a
 * {@link ReviewSource}, derives each card's FSRS state from its append-only logs (§3.3), and on each
 * rating appends a review_log + refreshes the card cache. Cards that land in a (re)learning step are
 * re-queued by their next due time so they reappear within the session, exactly like Anki — the
 * scheduling itself comes from ts-fsrs short-term steps, not a bespoke heuristic.
 */

export type ReviewSource =
  | { kind: 'due' }
  /** A deck and (optionally) its subdecks — `deckIds` = the deck plus all descendant deck ids. */
  | { kind: 'deck'; deckIds: string[]; deckName: string }
  | { kind: 'cards'; cardIds: string[]; label: string };

interface SessionCard {
  cardId: string;
  fields: NoteFields;
  /** Present for imported note types; null for the built-in vocab card. */
  generic: GenericCard | null;
  fsrsCard: Card;
  cfg: DeckConfig;
  /** When this card should next appear, in ms. Past = ready now. */
  dueAt: number;
}

interface CandidateRow {
  id: string;
  tmpl: number;
  state: number;
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
  nt_name: string | null;
  nt_templates: string | null;
  nt_css: string | null;
}

const SELECT_CARD = `SELECT c.id, c.template_index AS tmpl, c.state AS state,
    c.due AS due, c.stability AS stability, c.difficulty AS difficulty, c.reps AS reps, c.lapses AS lapses, c.last_review AS last_review,
    n.fields AS fields, n.tags AS tags, n.created_at AS created, n.deck_id,
    d.name AS deck_name, d.fsrs_params, nt.name AS nt_name, nt.card_templates AS nt_templates, nt.css AS nt_css
  FROM cards c JOIN notes n ON n.id = c.note_id
  LEFT JOIN decks d ON d.id = n.deck_id
  LEFT JOIN note_types nt ON nt.id = n.note_type_id`;

/** Just enough to apply the daily caps without marshalling every card's heavy note/CSS columns. */
interface LightRow {
  id: string;
  state: number;
  deck_id: string | null;
}

/**
 * Build the ordered list of candidate cards. Daily caps are applied to *lightweight* rows (id +
 * state + deck) so we never fetch the heavy note fields / template / CSS for the whole due backlog —
 * only the chosen cards are then hydrated. This is the difference between a review starting instantly
 * and scanning thousands of fat rows on a big imported deck.
 */
async function buildCandidates(source: ReviewSource): Promise<CandidateRow[]> {
  // Anki-style day granularity: anything due before the next day rollover is studiable now.
  const cutoffHour = usePrefs.getState().dayCutoffHour;
  const dayEnd = studyDayEnd(new Date(), cutoffHour).toISOString();

  if (source.kind === 'cards') {
    if (source.cardIds.length === 0) return [];
    const ph = source.cardIds.map(() => '?').join(',');
    const rows = await db.getAll<CandidateRow>(`${SELECT_CARD} WHERE c.id IN (${ph})`, source.cardIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return source.cardIds.map((id) => byId.get(id)).filter((r): r is CandidateRow => !!r);
  }

  if (source.kind === 'deck' && source.deckIds.length === 0) return [];
  const deckArg = source.kind === 'deck' ? source.deckIds : [];
  const deckFilter = deckArg.length ? ` AND n.deck_id IN (${deckArg.map(() => '?').join(',')})` : '';

  // Deck configs once (not joined per candidate row).
  const deckRows = await db.getAll<{ id: string; fsrs_params: string | null }>('SELECT id, fsrs_params FROM decks');
  const cfgByDeck = new Map(deckRows.map((d) => [d.id, deckConfig({ fsrs_params: d.fsrs_params })]));
  const cfgFor = (deck: string) => cfgByDeck.get(deck) ?? deckConfig({ fsrs_params: null });

  const dueLight = await db.getAll<LightRow>(
    `SELECT c.id, c.state, n.deck_id FROM cards c JOIN notes n ON n.id = c.note_id
     WHERE c.reps > 0 AND c.due <= ?${deckFilter} ORDER BY c.due ASC`,
    [dayEnd, ...deckArg],
  );
  const newLight = await db.getAll<LightRow>(
    `SELECT c.id, c.state, n.deck_id FROM cards c JOIN notes n ON n.id = c.note_id
     WHERE c.reps = 0${deckFilter} ORDER BY n.created_at ASC`,
    deckArg,
  );

  // Today's activity per deck, against the configurable study-day boundary (shared with the deck list).
  const dayStart = studyDayStart(new Date(), cutoffHour).toISOString();
  const introduced = await db.getAll<{ deck: string | null; cnt: number }>(INTRODUCED_TODAY_SQL, [dayStart, dayStart]);
  const reviewsToday = await db.getAll<{ deck: string | null; cnt: number }>(REVIEWED_TODAY_SQL, [dayStart]);
  const introducedByDeck = new Map(introduced.map((r) => [r.deck ?? '', r.cnt]));
  const reviewedByDeck = new Map(reviewsToday.map((r) => [r.deck ?? '', r.cnt]));
  const allowanceFor = (deck: string) =>
    deckAllowances(cfgFor(deck), { introduced: introducedByDeck.get(deck) ?? 0, reviewed: reviewedByDeck.get(deck) ?? 0 });

  // Cap to each deck's remaining allowance (learning/relearning bypass the review cap so a lapsed
  // card always returns), collecting the chosen ids in display order.
  const reviewRemaining = new Map<string, number>();
  const newRemaining = new Map<string, number>();
  const chosen: string[] = [];
  for (const row of dueLight) {
    if (row.state !== State.Review) { chosen.push(row.id); continue; }
    const deck = row.deck_id ?? '';
    if (!reviewRemaining.has(deck)) reviewRemaining.set(deck, allowanceFor(deck).reviewLeft);
    const left = reviewRemaining.get(deck)!;
    if (left > 0) { chosen.push(row.id); reviewRemaining.set(deck, left - 1); }
  }
  for (const row of newLight) {
    const deck = row.deck_id ?? '';
    if (!newRemaining.has(deck)) newRemaining.set(deck, allowanceFor(deck).newLeft);
    const left = newRemaining.get(deck)!;
    if (left > 0) { chosen.push(row.id); newRemaining.set(deck, left - 1); }
  }
  if (chosen.length === 0) return [];

  // Hydrate only the chosen cards with their heavy columns, preserving order.
  const ph = chosen.map(() => '?').join(',');
  const full = await db.getAll<CandidateRow>(`${SELECT_CARD} WHERE c.id IN (${ph})`, chosen);
  const byId = new Map(full.map((r) => [r.id, r]));
  return chosen.map((id) => byId.get(id)).filter((r): r is CandidateRow => !!r);
}

const bySoonest = (a: SessionCard, b: SessionCard) => a.dueAt - b.dueAt;

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
  current: { cardId: string; fields: NoteFields; generic: GenericCard | null } | null;
  gradePreviews: GradePreview[];
  canUndo: boolean;
  reveal: () => void;
  rate: (grade: Grade) => void;
  /** Undo the last answer (Anki `Z`): removes its review_log, restores the card, and re-shows it. */
  undo: () => void;
}

/** One answered card, kept so the review can be undone (Anki-style undo). */
interface UndoEntry {
  card: SessionCard;
  logId: string;
}

export function useReview(source: ReviewSource): ReviewState {
  const { session } = useAuth();
  const userId = session?.user.id ?? '';
  const [queue, setQueue] = useState<SessionCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialTotal, setInitialTotal] = useState(0);
  const [shown, setShown] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [history, setHistory] = useState<UndoEntry[]>([]);
  const [, setClock] = useState(0);
  const shownAt = useRef<number>(Date.now());

  const sourceKey = JSON.stringify(source);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const rows = await buildCandidates(source);
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
      const items: SessionCard[] = rows.map((r) => {
        const cfg = deckConfig({ fsrs_params: r.fsrs_params });
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
        // Reviews due later today are available immediately (day granularity, like Anki);
        // (re)learning cards keep their intraday timestamps so steps are honoured within the session.
        const dueAt =
          fsrsCard.reps === 0 ? now
          : fsrsCard.state === State.Review ? Math.min(fsrsCard.due.getTime(), now)
          : fsrsCard.due.getTime();
        return { cardId: r.id, fields: parseNoteFields(r.fields), generic, fsrsCard, cfg, dueAt };
      });
      items.sort(bySoonest);
      setQueue(items);
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

  // Anki's learn-ahead: the head card is served up to 20 minutes early when nothing else is ready.
  // Learning cards due later than that pause the session ("next learning card in N minutes").
  const head = queue[0] ?? null;
  const current = head && head.dueAt <= Date.now() + LEARN_AHEAD_MS ? head : null;
  const isEmpty = !loading && initialTotal === 0;
  const done = !loading && initialTotal > 0 && !current;
  const nextLearningDueAt = done && head ? head.dueAt : null;

  // While paused on a future learning card, tick so it surfaces when its step elapses.
  useEffect(() => {
    if (!head || current) return;
    const t = setInterval(() => setClock((c) => c + 1), 10_000);
    return () => clearInterval(t);
  }, [head, current]);

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
      const elapsedMs = Math.max(0, Date.now() - shownAt.current);
      const next = scheduler(current.cfg).next(current.fsrsCard, now, grade);
      const row = toCardRow(next.card);
      const logId = crypto.randomUUID();
      void db.writeTransaction(async (tx) => {
        await tx.execute(
          `INSERT INTO review_logs (id, user_id, card_id, rating, review_time, elapsed_ms, scheduled_days)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [logId, userId, current.cardId, grade, now.toISOString(), elapsedMs, next.card.scheduled_days],
        );
        await tx.execute(
          `UPDATE cards SET due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?`,
          [row.due, row.stability, row.difficulty, row.reps, row.lapses, row.state, row.last_review, current.cardId],
        );
      });

      // Re-queue if still in a (re)learning step due before the day rollover; otherwise it leaves the
      // session (interday learning steps and graduated cards come back on a later study day).
      const dueMs = next.card.due.getTime();
      const dayEndMs = studyDayEnd(now, usePrefs.getState().dayCutoffHour).getTime();
      const stillLearning =
        (next.card.state === State.Learning || next.card.state === State.Relearning) && dueMs < dayEndMs;
      setQueue((q) => {
        const rest = q.slice(1);
        if (stillLearning) {
          rest.push({ ...current, fsrsCard: next.card, dueAt: dueMs });
          rest.sort(bySoonest);
        }
        return rest;
      });
      setHistory((h) => [...h, { card: current, logId }]);
      setReviewedCount((n) => n + 1);
      setShown(false);
      shownAt.current = Date.now();
    },
    [current, userId],
  );

  // Anki-style undo: remove the answer's log, restore the card's cached state, and put it back on top.
  const undo = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return;
    const row = toCardRow(last.card.fsrsCard);
    void db.writeTransaction(async (tx) => {
      await tx.execute(`DELETE FROM review_logs WHERE id = ?`, [last.logId]);
      await tx.execute(
        `UPDATE cards SET due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?`,
        [row.due, row.stability, row.difficulty, row.reps, row.lapses, row.state, row.last_review, last.card.cardId],
      );
    });
    // The card may have been re-queued mid-learning — drop that copy and re-show the original now.
    setQueue((q) => [{ ...last.card, dueAt: Date.now() }, ...q.filter((c) => c.cardId !== last.card.cardId)]);
    setHistory((h) => h.slice(0, -1));
    setReviewedCount((n) => Math.max(0, n - 1));
    setShown(false);
    shownAt.current = Date.now();
  }, [history]);

  return {
    loading,
    isEmpty,
    done,
    reviewedCount,
    counts,
    currentBucket,
    nextLearningDueAt,
    shown,
    current: current ? { cardId: current.cardId, fields: current.fields, generic: current.generic } : null,
    gradePreviews,
    canUndo: history.length > 0,
    reveal,
    rate,
    undo,
  };
}
