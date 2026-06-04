import { Icon } from '../ui/icons';
import { useDecks } from '../sync/hooks';
import { SAMPLE_CARDS, SAMPLE_DECKS, type SampleDeck } from '../data/sample';

interface Props {
  onReviewDeck: (deck: SampleDeck) => void;
}

/** Deck grid from real PowerSync decks (fallback to sample); cards table is sample until M4. */
export function DecksScreen({ onReviewDeck }: Props) {
  const { data: realDecks } = useDecks();

  const decks: SampleDeck[] =
    realDecks.length > 0
      ? realDecks.map((d) => ({ id: d.id, name: d.name ?? 'Untitled', due: 0, new: 0, count: 0, color: 'var(--rust)' }))
      : SAMPLE_DECKS;

  return (
    <div className="page">
      <div className="deck-grid">
        {decks.map((d) => (
          <div className="deck-card" key={d.id} onClick={() => onReviewDeck(d)}>
            <div className="dc-top">
              <span className="dc-bar" style={{ background: d.color }} />
              <span className="dc-name">{d.name}</span>
            </div>
            <div className="dc-stats">
              <div className="ds due"><div className="v">{d.due}</div><div className="l">Due</div></div>
              <div className="ds"><div className="v">{d.new}</div><div className="l">New</div></div>
              <div className="ds"><div className="v">{d.count}</div><div className="l">Total</div></div>
            </div>
          </div>
        ))}
      </div>

      <div className="sec-bar">
        <h2>All cards</h2>
        <span className="count">{SAMPLE_CARDS.length} shown</span>
        <span className="more">
          <div className="searchbox" style={{ width: 200 }}><Icon.search s={15} /><input placeholder="Search cards…" /></div>
        </span>
      </div>
      <table className="card-table">
        <thead>
          <tr>
            <th>Term</th>
            <th className="hide-sm">Meaning</th>
            <th>Deck</th>
            <th>State</th>
            <th className="hide-sm">Due</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE_CARDS.map((c, i) => (
            <tr key={i}>
              <td>
                <span className="ct-term" lang="ja">{c.term}</span>{' '}
                <span className="ct-reading" lang="ja">{c.reading}</span>
              </td>
              <td className="hide-sm" style={{ color: 'var(--ink-soft)' }}>{c.gloss}</td>
              <td style={{ color: 'var(--ink-faint)', fontSize: 13 }}>{c.deck}</td>
              <td><span className={'state-pill state-' + c.state}>{c.state}</span></td>
              <td className="hide-sm" style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-faint)' }}>{c.due}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
