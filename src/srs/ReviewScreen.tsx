import { useState } from 'react';
import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { SAMPLE_INTERVALS } from '../data/sample';

export interface ReviewCard {
  term: string;
  reading: string;
  pos: string;
  gloss: string;
  jlpt?: string;
}

interface Props {
  queue: ReviewCard[];
  deckName: string;
  onExit: () => void;
}

const RATINGS = [
  ['again', 'Again', 'var(--rate-again)'],
  ['hard', 'Hard', 'var(--rate-hard)'],
  ['good', 'Good', 'var(--rate-good)'],
  ['easy', 'Easy', 'var(--rate-easy)'],
] as const;

/**
 * Review flow. UI + interaction only — real FSRS scheduling and append-only review_logs land in M4;
 * the next-interval previews are sample values.
 */
export function ReviewScreen({ queue, deckName, onExit }: Props) {
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(false);

  const total = queue.length;
  const card = queue[i];

  function rate() {
    if (i + 1 >= total) setDone(true);
    else {
      setI(i + 1);
      setShown(false);
    }
  }

  if (total === 0) {
    return (
      <div className="review-wrap">
        <div className="rv-top"><span className="back" onClick={onExit}><Icon.chevL s={18} /> Back</span></div>
        <div className="rv-stage"><div className="rv-done"><div className="big">Nothing due</div></div></div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="review-wrap">
        <div className="rv-top"><span className="back" onClick={onExit}><Icon.chevL s={18} /> Done</span></div>
        <div className="rv-stage">
          <div className="rv-done">
            <div className="jpbig" lang="ja">お疲れさま</div>
            <div className="big">Session complete</div>
            <p style={{ color: 'var(--ink-soft)', fontSize: 15, lineHeight: 1.6 }}>
              You reviewed {total} cards. (Real FSRS scheduling + synced review history arrive in M4.)
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24 }}>
              <Btn variant="primary" onClick={onExit}>Back to library</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const ivl = SAMPLE_INTERVALS[i % SAMPLE_INTERVALS.length];

  return (
    <div className="review-wrap">
      <div className="rv-top">
        <span className="back" onClick={onExit}><Icon.close s={18} /></span>
        <div className="prog-track"><i style={{ width: (i / total) * 100 + '%' }} /></div>
        <span className="qcount">{i + 1} / {total}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <Chip>{deckName}</Chip>
      </div>

      <div className="rv-stage" onClick={() => !shown && setShown(true)}>
        <div className="card-face">
          <Kicker accent style={{ display: 'block' }}>
            {card.jlpt ? card.jlpt + ' · ' : ''}recall the reading & meaning
          </Kicker>
          <div className="cf-term" style={{ marginTop: 24 }} lang="ja">{card.term}</div>
          {shown ? (
            <>
              <div className="cf-reading" lang="ja">{card.reading}</div>
              <div className="cf-sep" />
              {card.pos && <div className="cf-pos">{card.pos}</div>}
              <div className="cf-gloss">{card.gloss}</div>
            </>
          ) : (
            <div className="show-hint">Tap to reveal · space</div>
          )}
        </div>
      </div>

      <div className="rv-foot">
        {!shown ? (
          <Btn variant="primary" className="reveal-btn" onClick={() => setShown(true)}>Show answer</Btn>
        ) : (
          <div className="rate-grid">
            {RATINGS.map(([k, label, color], ki) => (
              <div className="rate-btn" key={k} onClick={rate}>
                <div className="rlab"><span className="rdot" style={{ background: color }} />{label}</div>
                <div className="rivl">{ivl[k]}</div>
                <div className="rate-key">{ki + 1}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
