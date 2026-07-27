import { useMemo, useState } from 'react';
import { useQuery } from '../sync/hooks';
import { computeAnalytics, computeStreak, type AnalyticsCard, type AnalyticsData, type AnalyticsLog } from './analytics';

/**
 * Reactive analytics over the synced `review_logs` + `cards` caches (build plan M5). Thin wrapper
 * around PowerSync's `useQuery`, like `src/srs/srsHooks.ts`: the queries re-run when the underlying
 * tables change, and the pure {@link computeAnalytics} fold runs in a `useMemo`.
 */

/** A now-threshold captured once per mount so the `useMemo` key is stable across renders. */
function useStableNow(): number {
  const [now] = useState(() => Date.now());
  return now;
}

export function useAnalytics(): AnalyticsData {
  const now = useStableNow();

  const { data: cardRows } = useQuery<{
    id: string;
    created_at: string | null;
    fsrs_params: string | null;
    preset_id: string | null;
    preset_config: string | null;
    due: string | null;
    reps: number;
    state: number;
    last_review: string | null;
    queue: number | null;
  }>(
    `SELECT c.id, n.created_at, d.fsrs_params, d.preset_id, dp.config AS preset_config,
       c.due, c.reps, c.state, c.last_review, COALESCE(c.queue, 0) AS queue
     FROM cards c
     JOIN notes n ON n.id = c.note_id
     LEFT JOIN decks d ON d.id = n.deck_id
     LEFT JOIN deck_presets dp ON dp.id = d.preset_id`,
  );

  const { data: logRows } = useQuery<AnalyticsLog>(
    `SELECT card_id, rating, review_time, elapsed_ms FROM review_logs`,
  );

  return useMemo(() => {
    const cards: AnalyticsCard[] = cardRows.map((r) => ({
      id: r.id,
      createdAt: r.created_at ?? new Date(0).toISOString(),
      fsrsParams: r.fsrs_params,
      presetId: r.preset_id,
      presetConfig: r.preset_config,
      due: r.due,
      reps: r.reps,
      state: r.state,
      lastReview: r.last_review,
      suspended: (r.queue ?? 0) === -1,
    }));
    return computeAnalytics(cards, logRows, new Date(now));
  }, [cardRows, logRows, now]);
}

/**
 * Cheap day-streak for the library header — only reads review timestamps, skipping the full
 * dashboard fold (which replays every card for retention). Reactive to new reviews.
 */
export function useStreak(): number {
  const now = useStableNow();
  // rating >= 1: manual events (forget / set due date) don't count toward the streak.
  const { data } = useQuery<{ review_time: string | null }>(`SELECT review_time FROM review_logs WHERE rating >= 1`);
  return useMemo(() => computeStreak(data.map((r) => r.review_time), new Date(now)), [data, now]);
}
