import type { Sql } from '../anki/collection';
import { timingAt } from '../anki/timing';
import { HEATMAP_DAYS } from './analytics';

/** Analytics › Reading: what was read (finished chapters and articles), from `reading_log`. */

export interface ReadingDay {
  chapters: number;
  articles: number;
  chars: number;
  ms: number;
}

export interface ReadingData {
  total: ReadingDay;
  last30: ReadingDay;
  /** HEATMAP_DAYS days, oldest first (study days, like the review heatmap). */
  days: ReadingDay[];
  /** Intensity 0–4 per day, by characters read. */
  heatmap: number[];
  minedTotal: number;
  mined30: number;
  books: { id: string; title: string; percent: number; chapters: number }[];
}

const zero = (): ReadingDay => ({ chapters: 0, articles: 0, chars: 0, ms: 0 });
const add = (d: ReadingDay, r: { kind: string; chars: number; ms: number }) => {
  if (r.kind === 'article') d.articles++;
  else d.chapters++;
  d.chars += r.chars;
  d.ms += r.ms;
};

export async function loadReading(sql: Sql, nowMs: number, rollover: number): Promise<ReadingData> {
  const t = timingAt(nowMs, rollover);
  const dayStartMs = (t.nextDayAt - 86_400) * 1000;
  const since30 = dayStartMs - 29 * 86_400_000;
  const log = await sql.all<{ kind: string; chars: number; ms: number; at: number }>('SELECT kind, chars, ms, at FROM reading_log');

  const total = zero();
  const last30 = zero();
  const byDay = new Map<number, ReadingDay>();
  for (const r of log) {
    add(total, r);
    if (r.at >= since30) add(last30, r);
    const d = timingAt(r.at, rollover).today;
    add(byDay.get(d) ?? byDay.set(d, zero()).get(d)!, r);
  }
  const days = Array.from({ length: HEATMAP_DAYS }, (_, i) => byDay.get(t.today - (HEATMAP_DAYS - 1 - i)) ?? zero());
  const max = Math.max(1, ...days.map((d) => d.chars));
  const heatmap = days.map(({ chars, chapters, articles }) => (chapters + articles === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((chars / max) * 4)))));

  const [mined] = await sql.all<{ total: number; recent: number }>(
    'SELECT COUNT(*) AS total, SUM(looked_up_at >= ?) AS recent FROM mined_words',
    [new Date(since30).toISOString()],
  );
  const books = await sql.all<{ id: string; title: string; percent: number | null; chapters: number }>(
    `SELECT d.id, d.title, (SELECT MAX(percent) FROM reading_positions p WHERE p.document_id = d.id) AS percent,
       (SELECT COUNT(*) FROM reading_log l WHERE l.doc_key = d.id) AS chapters
     FROM documents d ORDER BY d.added_at DESC`,
  );

  return {
    total,
    last30,
    days,
    heatmap,
    minedTotal: mined?.total ?? 0,
    mined30: mined?.recent ?? 0,
    books: books.map((b) => ({ id: b.id, title: b.title ?? '', percent: Math.round(b.percent ?? 0), chapters: b.chapters })),
  };
}
