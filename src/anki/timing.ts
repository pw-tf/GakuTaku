/**
 * Study-day arithmetic, ported from rslib/src/scheduler/timing.rs (`sched_timing_today_v2_new`).
 *
 * Anki numbers days from the collection's creation date. GakuTaku numbers them from 1970-01-01
 * instead (the same calculation with a fixed creation date), so a day number means the same thing
 * on every device and needs no stored creation time. Review/day-learning `due` values and the
 * per-deck "studied today" counters are all in these day numbers. Imports shift Anki's
 * collection-relative numbers onto this scale.
 */

export interface Timing {
  /** Unix seconds "now". */
  now: number;
  /** Today's day number. */
  today: number;
  /** Unix seconds of the next rollover. */
  nextDayAt: number;
}

const DAY_MS = 86_400_000;

/** Days since 0001-01-01 style counter for a local calendar date (only differences matter). */
function localDayIndex(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** The local time `hour`:00 on the same calendar day as `d`. */
function atHour(d: Date, hour: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour % 24, 0, 0, 0);
}

export function timingAt(nowMs: number, rolloverHour: number): Timing {
  const now = new Date(nowMs);
  const rolloverToday = atHour(now, rolloverHour);
  const passed = rolloverToday.getTime() <= nowMs;
  const next = passed
    ? atHour(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12), rolloverHour)
    : rolloverToday;
  const today = Math.max(0, localDayIndex(now) - (passed ? 0 : 1));
  return { now: Math.floor(nowMs / 1000), today, nextDayAt: Math.floor(next.getTime() / 1000) };
}

/**
 * Anki's day count for an *Anki* collection, used only when importing: how many rollovers have
 * passed since the collection's creation (`crt`, unix secs). `creationOffset` / `currentOffset`
 * are minutes west of UTC (Anki's `creationOffset` config); when the creation offset is unknown
 * Anki falls back to the "legacy v2" cutoff, reproduced here.
 */
export function ankiDaysElapsed(
  crtSecs: number,
  nowSecs: number,
  rolloverHour: number,
  creationOffsetMinsWest: number | null,
  currentOffsetMinsWest: number,
): number {
  const shift = (secs: number, minsWest: number) => new Date((secs - minsWest * 60) * 1000);
  // Dates as seen in a fixed offset: reuse UTC getters on a shifted timestamp.
  const ymd = (d: Date) => Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS);
  if (creationOffsetMinsWest == null) {
    // sched_timing_today_v2_legacy
    const crtLocal = shift(crtSecs, currentOffsetMinsWest);
    const crtRollover =
      Date.UTC(crtLocal.getUTCFullYear(), crtLocal.getUTCMonth(), crtLocal.getUTCDate(), rolloverHour) / 1000 +
      currentOffsetMinsWest * 60;
    return Math.max(0, Math.floor((nowSecs - crtRollover) / 86_400));
  }
  const created = shift(crtSecs, creationOffsetMinsWest);
  const now = shift(nowSecs, currentOffsetMinsWest);
  const rolloverToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), rolloverHour);
  const passed = rolloverToday <= now.getTime();
  const days = ymd(now) - ymd(created) - (passed ? 0 : 1);
  return Math.max(0, days);
}
