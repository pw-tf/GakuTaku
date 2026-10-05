/** Answer-button labels ("10m", "3d", "1.2mo") — a port of rslib/src/scheduler/timespan.rs. */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const MONTH = YEAR / 12;

type Unit = 's' | 'm' | 'h' | 'd' | 'mo' | 'y';

function naturalUnit(secs: number): Unit {
  const s = Math.abs(secs);
  if (s < MINUTE) return 's';
  if (s < HOUR) return 'm';
  if (s < DAY) return 'h';
  if (s < MONTH) return 'd';
  if (s < YEAR) return 'mo';
  return 'y';
}

const DIVISOR: Record<Unit, number> = { s: 1, m: MINUTE, h: HOUR, d: DAY, mo: MONTH, y: YEAR };

/** Anki `answer_button_time`. */
export function answerButtonTime(seconds: number): string {
  const unit = naturalUnit(seconds);
  const v = seconds / DIVISOR[unit];
  const amount = unit === 's' || unit === 'm' || unit === 'd' ? Math.round(v) : Math.round(v * 10) / 10;
  return `${amount}${unit}`;
}

/** Anki `answer_button_time_collapsible`: "End" for 0, "<10m" inside the learn-ahead window. */
export function answerButtonTimeCollapsible(seconds: number, collapseSecs: number): string {
  if (seconds === 0) return 'End';
  const s = answerButtonTime(seconds);
  return seconds < collapseSecs ? `<${s}` : s;
}

/** Anki `time_span` (rounded): "1.5 minutes", "12 months". */
export function timeSpan(seconds: number): string {
  const unit = naturalUnit(seconds);
  const v = seconds / DIVISOR[unit];
  const amount = unit === 's' || unit === 'd' ? Math.round(v) : Math.round(v * 10) / 10;
  const names: Record<Unit, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day', mo: 'month', y: 'year' };
  return `${amount} ${names[unit]}${amount === 1 ? '' : 's'}`;
}
