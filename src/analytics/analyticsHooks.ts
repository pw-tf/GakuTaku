import { appSql, col } from '../anki/appCollection';
import { useLive } from '../db/useLive';
import { loadAnalytics, loadStreak, type AnalyticsData } from './analytics';

/** Live analytics (recomputed when reviews or cards change). */
export function useAnalytics(): AnalyticsData | undefined {
  return useLive(async () => loadAnalytics(appSql, Date.now(), (await col.config()).rollover), [], ['revlog', 'cards']).data;
}

/** The day streak for the library header. */
export function useStreak(): number {
  return useLive(async () => loadStreak(appSql, Date.now(), (await col.config()).rollover), [], ['revlog']).data ?? 0;
}
