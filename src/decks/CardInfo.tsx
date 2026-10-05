import { col } from '../anki/appCollection';
import type { CardInfo as Info } from '../anki/collection';
import { answerButtonTime, timeSpan } from '../anki/timespan';
import { useLive } from '../db/useLive';
import { Spinner } from '../ui/atoms';
import { Modal } from '../ui/Modal';

/** Anki's Card Info: the card's schedule, memory state and review history. */

const KIND = ['Learn', 'Review', 'Relearn', 'Filtered', 'Manual', 'Rescheduled'];
const RATING = ['—', 'Again', 'Hard', 'Good', 'Easy'];
const RATING_COLOR = ['var(--ink-faint)', 'var(--rate-again)', 'var(--rate-hard)', 'var(--rate-good)', 'var(--rate-easy)'];

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dateTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : timeSpan(ms / 1000));

function dueText(info: Info): string {
  const { card, timing } = info;
  if (card.queue === -1) return 'Suspended';
  if (card.queue === -2 || card.queue === -3) return 'Buried';
  if (card.type === 0) return `New #${card.due}`;
  if (card.queue === 1 || card.queue === 4) return dateTime(card.due * 1000);
  const days = (card.odid ? card.odue : card.due) - timing.today;
  return date((timing.nextDayAt + (days - 1) * 86_400) * 1000 + 1);
}

export function CardInfoModal({ cardId, onClose }: { cardId: number; onClose: () => void }) {
  const { data: info, loading } = useLive(() => col.cardInfo(cardId), [cardId], ['cards', 'revlog', 'notes', 'decks']);

  return (
    <Modal title="Card info" onClose={onClose} wide>
      <div className="modal-body card-info">
        {loading && !info ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 30 }}><Spinner size={22} /></div>
        ) : !info ? (
          <p className="muted">This card no longer exists.</p>
        ) : (
          <CardInfoBody info={info} />
        )}
      </div>
    </Modal>
  );
}

function CardInfoBody({ info }: { info: Info }) {
  const { card, revlog } = info;
  const graded = revlog.filter((r) => r.ease > 0);
  const first = graded.length ? graded[graded.length - 1].id : null;
  const latest = graded.length ? graded[0].id : null;
  const totalMs = graded.reduce((s, r) => s + r.time, 0);
  // With FSRS, the history's "factor" holds difficulty, stored as (d - 1) / 9 + 0.1 (Anki's layout).
  const fsrs = card.difficulty != null;
  const rows: [string, string][] = [
    ['Added', date(card.id)],
    ...(first ? ([['First review', date(first)], ['Latest review', date(latest!)]] as [string, string][]) : []),
    ['Due', dueText(info)],
    ...(card.type !== 0 && card.ivl > 0 ? ([['Interval', timeSpan(card.ivl * 86_400)]] as [string, string][]) : []),
    ...(card.factor > 0 && card.difficulty == null ? ([['Ease', pct(card.factor / 1000)]] as [string, string][]) : []),
    ...(card.difficulty != null ? ([['Difficulty', pct((card.difficulty - 1) / 9)]] as [string, string][]) : []),
    ...(card.stability != null ? ([['Stability', timeSpan(card.stability * 86_400)]] as [string, string][]) : []),
    ...(info.retrievability != null ? ([['Retrievability', pct(info.retrievability)]] as [string, string][]) : []),
    ['Reviews', String(card.reps)],
    ['Lapses', String(card.lapses)],
    ...(graded.length ? ([['Average time', secs(totalMs / graded.length)], ['Total time', secs(totalMs)]] as [string, string][]) : []),
    ...(card.type === 0 ? [] : card.original_position != null ? ([['Position', `#${card.original_position}`]] as [string, string][]) : []),
    ['Card type', info.templateName],
    ['Note type', info.notetype.name],
    ['Deck', info.originalDeckName ? `${info.originalDeckName} (in ${info.deckName})` : info.deckName],
    ['Preset', info.presetName],
    ['Card ID', String(card.id)],
    ['Note ID', String(card.nid)],
  ];

  return (
    <>
      <dl className="ci-grid">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {revlog.length > 0 && (
        <>
          <h4 className="ci-h">Review history</h4>
          <div className="ci-table-wrap">
            <table className="ci-table">
              <thead>
                <tr><th>Date</th><th>Type</th><th>Rating</th><th>Interval</th><th>{fsrs ? 'Difficulty' : 'Ease'}</th><th>Time</th></tr>
              </thead>
              <tbody>
                {revlog.map((r) => (
                  <tr key={r.id}>
                    <td>{dateTime(r.id)}</td>
                    <td>{KIND[r.type] ?? '?'}</td>
                    <td style={{ color: RATING_COLOR[r.ease] ?? undefined }}>{RATING[r.ease] ?? r.ease}</td>
                    <td>{r.ivl === 0 ? '—' : answerButtonTime(r.ivl < 0 ? -r.ivl : r.ivl * 86_400)}</td>
                    <td>{r.factor <= 0 ? '—' : fsrs ? pct(Math.max(0, r.factor / 1000 - 0.1)) : pct(r.factor / 1000)}</td>
                    <td>{r.time ? secs(r.time) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
