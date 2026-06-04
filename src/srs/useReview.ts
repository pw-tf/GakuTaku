import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { db } from '../sync/system';
import type { ReviewLogRecord } from '../sync/AppSchema';
import {
  State,
  deckConfig,
  deriveCard,
  previews,
  scheduler,
  toCardRow,
  type Card,
  type DeckConfig,
  type Grade,
  type GradePreview,
} from './fsrs';
import { parseNoteFields, type NoteFields } from './mining';

/**
 * Review session controller (build plan M4 + Anki-style relearning). Assembles a queue from a
 * {@link ReviewSource}, derives each card's FSRS state from its append-only logs (§3.3), and on each
 * rating appends a review_log + refreshes the card cache. Cards that land in a (re)learning step are
 * re-queued by their next due time so they reappear within the session, exactly like Anki — the
 * scheduling itself comes from ts-fsrs short-term steps, not a bespoke heuristic.
 */

export type ReviewSource =
  | { kind: 'due' }
  | { kind: 'deck'; deckId: string; deckName: string }
  | { kind: 'cards'; cardIds: string[]; label: string };

const DAY_MS = 86_400_000;

interface SessionCard {
  cardId: string;
  fields: NoteFields;
  fsrsCard: Card;
  cfg: DeckConfig;
  /** When this card should next appear, in ms. Past = ready now. */
  dueAt: number;
}

interface CandidateRow {
  id: string;
  fields: string;
  created: string;
  deck_id: string | null;
  fsrs_params: string | null;
}

function startOfTodayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const SELECT_CARD = `SELECT c.id, n.fields AS fields, n.created_at AS created, n.deck_id, d.fsrs_params
  FROM cards c JOIN notes n ON n.id = c.note_id LEFT JOIN decks d ON d.id = n.deck_id`;

/** Build the ordered list of candidate cards, honouring per-deck new-card limits. */
async function buildCandidates(source: ReviewSource): Promise<CandidateRow[]> {
  const now = new Date().toISOString();

  if (source.kind === 'cards') {
    if (source.cardIds.length === 0) return [];
    const ph = source.cardIds.map(() => '?').join(',');
    const rows = await db.getAll<CandidateRow>(`${SELECT_CARD} WHERE c.id IN (${ph})`, source.cardIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return source.cardIds.map((id) => byId.get(id)).filter((r): r is CandidateRow => !!r);
  }

  const deckFilter = source.kind === 'deck' ? ' AND n.deck_id = ?' : '';
  const deckArg = source.kind === 'deck' ? [source.deckId] : [];

  const due = await db.getAll<CandidateRow>(
    `${SELECT_CARD} WHERE c.reps > 0 AND c.due <= ?${deckFilter} ORDER BY c.due ASC`,
    [now, ...deckArg],
  );

  const newRows = await db.getAll<CandidateRow>(
    `${SELECT_CARD} WHERE c.reps = 0${deckFilter} ORDER BY n.created_at ASC`,
    deckArg,
  );
  const introduced = await db.getAll<{ deck: string | null; cnt: number }>(
    `SELECT n.deck_id AS deck, COUNT(*) AS cnt
     FROM (SELECT card_id, MIN(review_time) AS first FROM review_logs GROUP BY card_id) f
     JOIN cards c ON c.id = f.card_id
     JOIN notes n ON n.id = c.note_id
     WHERE f.first >= ?
     GROUP BY n.deck_id`,
    [startOfTodayISO()],
  );
  const introducedByDeck = new Map(introduced.map((r) => [r.deck ?? '', r.cnt]));
  const remaining = new Map<string, number>();
  const allowedNew: CandidateRow[] = [];
  for (const row of newRows) {
    const deck = row.deck_id ?? '';
    if (!remaining.has(deck)) {
      const perDay = deckConfig({ fsrs_params: row.fsrs_params }).newPerDay;
      remaining.set(deck, Math.max(0, perDay - (introducedByDeck.get(deck) ?? 0)));
    }
    const left = remaining.get(deck)!;
    if (left > 0) {
      allowedNew.push(row);
      remaining.set(deck, left - 1);
    }
  }
  return [...due, ...allowedNew];
}

const bySoonest = (a: SessionCard, b: SessionCard) => a.dueAt - b.dueAt;

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
  shown: boolean;
  current: { cardId: string; fields: NoteFields } | null;
  gradePreviews: GradePreview[];
  reveal: () => void;
  rate: (grade: Grade) => void;
}

export function useReview(source: ReviewSource): ReviewState {
  const { session } = useAuth();
  const userId = session?.user.id ?? '';
  const [queue, setQueue] = useState<SessionCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialTotal, setInitialTotal] = useState(0);
  const [shown, setShown] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const shownAt = useRef<number>(Date.now());

  const sourceKey = JSON.stringify(source);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const rows = await buildCandidates(source);
      if (cancelled) return;
      let logsByCard = new Map<string, ReviewLogRecord[]>();
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        const ph = ids.map(() => '?').join(',');
        const logs = await db.getAll<ReviewLogRecord>(`SELECT * FROM review_logs WHERE card_id IN (${ph})`, ids);
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
        const fsrsCard = deriveCard(logsByCard.get(r.id) ?? [], r.created, cfg);
        // Reviews keep their (past) due so the most overdue come first; new cards queue at "now".
        const dueAt = fsrsCard.reps === 0 ? now : fsrsCard.due.getTime();
        return { cardId: r.id, fields: parseNoteFields(r.fields), fsrsCard, cfg, dueAt };
      });
      items.sort(bySoonest);
      setQueue(items);
      setInitialTotal(items.length);
      setReviewedCount(0);
      setShown(false);
      shownAt.current = Date.now();
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  const current = queue[0] ?? null;
  const isEmpty = !loading && initialTotal === 0;
  const done = !loading && initialTotal > 0 && queue.length === 0;

  const counts = useMemo<ReviewCounts>(() => {
    let n = 0;
    let l = 0;
    let r = 0;
    for (const c of queue) {
      if (c.fsrsCard.reps === 0 || c.fsrsCard.state === State.New) n++;
      else if (c.fsrsCard.state === State.Learning || c.fsrsCard.state === State.Relearning) l++;
      else r++;
    }
    return { new: n, learning: l, review: r };
  }, [queue]);

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
      void db.writeTransaction(async (tx) => {
        await tx.execute(
          `INSERT INTO review_logs (id, user_id, card_id, rating, review_time, elapsed_ms, scheduled_days)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), userId, current.cardId, grade, now.toISOString(), elapsedMs, next.card.scheduled_days],
        );
        await tx.execute(
          `UPDATE cards SET due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?`,
          [row.due, row.stability, row.difficulty, row.reps, row.lapses, row.state, row.last_review, current.cardId],
        );
      });

      // Re-queue if still in a (re)learning step that lands within the day; otherwise it graduates.
      const dueMs = next.card.due.getTime();
      const stillLearning =
        (next.card.state === State.Learning || next.card.state === State.Relearning) &&
        dueMs - now.getTime() < DAY_MS;
      setQueue((q) => {
        const rest = q.slice(1);
        if (stillLearning) {
          rest.push({ ...current, fsrsCard: next.card, dueAt: dueMs });
          rest.sort(bySoonest);
        }
        return rest;
      });
      setReviewedCount((n) => n + 1);
      setShown(false);
      shownAt.current = Date.now();
    },
    [current, userId],
  );

  return {
    loading,
    isEmpty,
    done,
    reviewedCount,
    counts,
    shown,
    current: current ? { cardId: current.cardId, fields: current.fields } : null,
    gradePreviews,
    reveal,
    rate,
  };
}
