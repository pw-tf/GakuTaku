import { db } from '../sync/system';
import { usePrefs } from '../app/prefs';
import {
  MANUAL_RATING,
  applyManualEvent,
  cardFromRow,
  toCardRow,
  type CardCacheRow,
} from './fsrs';
import { QUEUE_SCHED_BURIED, QUEUE_SUSPENDED, QUEUE_USER_BURIED, type DueDateSpec } from './cardPlans';
import { studyDayEnd } from './queue';

/**
 * Card operations (Anki parity): suspend/bury/flag are plain synced `cards` columns — user state
 * with no revlog entry, exactly as in Anki. Forget and Set-due-date DO change scheduling state,
 * which is derived from review_logs (§3.3), so they write a rating-0 manual log AND update the
 * cache via the same {@link applyManualEvent} the replay fold uses — cache and replay agree by
 * construction. Pure decision logic lives in `cardPlans.ts`.
 */

const chunk = <T,>(arr: T[], n = 200): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const ph = (ids: string[]) => ids.map(() => '?').join(',');

/** Anki `@`: suspended cards leave every queue and count until unsuspended. */
export async function suspendCards(ids: string[]): Promise<void> {
  for (const part of chunk(ids)) {
    await db.execute(`UPDATE cards SET queue = ${QUEUE_SUSPENDED}, buried_until = NULL WHERE id IN (${ph(part)})`, part);
  }
}

export async function unsuspendCards(ids: string[]): Promise<void> {
  for (const part of chunk(ids)) {
    await db.execute(
      `UPDATE cards SET queue = 0, buried_until = NULL WHERE id IN (${ph(part)}) AND COALESCE(queue, 0) = ${QUEUE_SUSPENDED}`,
      part,
    );
  }
}

/** Bury until the next day rollover. `manual` distinguishes Anki's user bury (-3) from sibling bury (-2). */
export async function buryCards(ids: string[], opts: { manual: boolean }, now: Date = new Date()): Promise<void> {
  const queue = opts.manual ? QUEUE_USER_BURIED : QUEUE_SCHED_BURIED;
  const until = studyDayEnd(now, usePrefs.getState().dayCutoffHour).toISOString();
  for (const part of chunk(ids)) {
    await db.execute(`UPDATE cards SET queue = ${queue}, buried_until = ? WHERE id IN (${ph(part)})`, [until, ...part]);
  }
}

export async function unburyCards(ids: string[]): Promise<void> {
  for (const part of chunk(ids)) {
    await db.execute(
      `UPDATE cards SET queue = 0, buried_until = NULL WHERE id IN (${ph(part)}) AND COALESCE(queue, 0) <= ${QUEUE_SCHED_BURIED}`,
      part,
    );
  }
}

/** Anki's deck-screen "Unbury": lift all burials in the given decks. */
export async function unburyDecks(deckIds: string[]): Promise<void> {
  if (!deckIds.length) return;
  await db.execute(
    `UPDATE cards SET queue = 0, buried_until = NULL
     WHERE COALESCE(queue, 0) <= ${QUEUE_SCHED_BURIED}
       AND note_id IN (SELECT id FROM notes WHERE deck_id IN (${ph(deckIds)}))`,
    deckIds,
  );
}

/**
 * Converge expired burials back to queue 0 — Anki's day-rollover unbury. Counts don't depend on
 * this (ACTIVE_SQL treats an expired burial as active), so it can run opportunistically: app
 * mount, visibility change, session build.
 */
export async function sweepExpiredBuried(now: Date = new Date()): Promise<void> {
  await db.execute(
    `UPDATE cards SET queue = 0, buried_until = NULL
     WHERE COALESCE(queue, 0) <= ${QUEUE_SCHED_BURIED} AND (buried_until IS NULL OR buried_until <= ?)`,
    [now.toISOString()],
  );
}

/** Set (or clear, with 0) a card flag. */
export async function setFlag(ids: string[], flag: number): Promise<void> {
  const f = Math.max(0, Math.min(7, Math.floor(flag)));
  for (const part of chunk(ids)) {
    await db.execute(`UPDATE cards SET flag = ? WHERE id IN (${ph(part)})`, [f, ...part]);
  }
}

interface ManualTargetRow extends CardCacheRow {
  id: string;
  created: string;
}

const SELECT_MANUAL_TARGETS = `SELECT c.id, c.due, c.stability, c.difficulty, c.reps, c.lapses, c.state, c.last_review,
    n.created_at AS created
  FROM cards c JOIN notes n ON n.id = c.note_id`;

/**
 * Write one manual (rating-0) log per card and update the cache through the same fold logic the
 * replay uses. `scheduledDays: null` = Forget (reset to New); `n ≥ 0` = Set due date.
 */
async function applyManualToCards(userId: string, ids: string[], scheduledDays: (cardId: string) => number | null): Promise<void> {
  if (!ids.length) return;
  const rows = await db.getAll<ManualTargetRow>(`${SELECT_MANUAL_TARGETS} WHERE c.id IN (${ph(ids)})`, ids);
  const now = new Date();
  const nowISO = now.toISOString();
  await db.writeTransaction(async (tx) => {
    for (const row of rows) {
      const days = scheduledDays(row.id);
      // Forget is encoded as scheduled_days = -1 (< 0); set-due-N as N ≥ 0. See MANUAL_RATING in fsrs.ts.
      const stored = days == null ? -1 : days;
      const next = applyManualEvent(cardFromRow(row, row.created, row.id), { review_time: nowISO, scheduled_days: stored });
      const cache = toCardRow(next);
      await tx.execute(
        `INSERT INTO review_logs (id, user_id, card_id, rating, review_time, elapsed_ms, scheduled_days)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        [crypto.randomUUID(), userId, row.id, MANUAL_RATING, nowISO, stored],
      );
      await tx.execute(
        `UPDATE cards SET due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?`,
        [cache.due, cache.stability, cache.difficulty, cache.reps, cache.lapses, cache.state, cache.last_review, row.id],
      );
    }
  });
}

/**
 * Anki "Forget": back to New. `position` is untouched — that is Anki's "restore original position"
 * default. Documented divergence: reps/lapses reset too (our counts are log-derived; Anki's
 * optional "reset repetition counts" off-state isn't representable without extra schema).
 */
export async function forgetCards(userId: string, ids: string[]): Promise<void> {
  await applyManualToCards(userId, ids, () => null);
}

/** Anki "Set due date": days or a range, random per card within it. FSRS memory state is untouched. */
export async function setDueDate(userId: string, ids: string[], spec: DueDateSpec): Promise<void> {
  await applyManualToCards(userId, ids, () => spec.min + Math.floor(Math.random() * (spec.max - spec.min + 1)));
}

/** Minimal Anki "Reposition": renumber the given new cards from `start`, stepping by `step`. */
export async function repositionNew(ids: string[], start: number, step = 1): Promise<void> {
  await db.writeTransaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.execute(`UPDATE cards SET position = ? WHERE id = ?`, [start + i * step, ids[i]]);
    }
  });
}

/** Next new-card position for a deck's insertion order (max+1 for sequential, random for random). */
export async function nextNewPosition(insertionOrder: 'sequential' | 'random'): Promise<number> {
  if (insertionOrder === 'random') {
    // Anki's random insertion order assigns a random position at note-add time.
    return Math.floor(Math.random() * 1_000_000);
  }
  const row = await db.getOptional<{ maxpos: number | null }>(`SELECT MAX(position) AS maxpos FROM cards`);
  return (row?.maxpos ?? 0) + 1;
}
