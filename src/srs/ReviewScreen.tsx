import { useEffect, useState } from 'react';
import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { useAuth } from '../auth/AuthProvider';
import { CardTemplate } from './CardTemplate';
import { EditCardModal } from './EditCardModal';
import { useReview, type ReviewSource } from './useReview';

interface Props {
  source: ReviewSource;
  onExit: () => void;
}

const RATINGS = [
  ['again', 'Again', 'var(--rate-again)'],
  ['hard', 'Hard', 'var(--rate-hard)'],
  ['good', 'Good', 'var(--rate-good)'],
  ['easy', 'Easy', 'var(--rate-easy)'],
] as const;

function sourceLabel(source: ReviewSource): string {
  if (source.kind === 'deck') return source.deckName;
  if (source.kind === 'cards') return source.label;
  return 'All due';
}

/** Review flow backed by real FSRS scheduling with Anki-style intra-session relearning. Each rating
 *  appends a review_log; the card's state is derived from its logs (§3.3). Cards in a (re)learning
 *  step reappear within the session until they graduate. Interval previews come straight from ts-fsrs. */
export function ReviewScreen({ source, onExit }: Props) {
  const { session } = useAuth();
  const review = useReview(source);
  const { current, shown, gradePreviews, counts } = review;
  const [editing, setEditing] = useState<string | null>(null);

  // Keyboard, matching Anki desktop: space/enter reveals — or answers Good once revealed;
  // 1–4 rate; Z (or Ctrl+Z / U) undoes the last answer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // composedPath so inputs inside the card's Shadow DOM (e.g. {{type:…}} boxes) are seen.
      const target = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        // Enter in Anki's type-answer box reveals the answer.
        if (e.key === 'Enter' && current && !shown && target.classList.contains('typeans')) {
          e.preventDefault();
          review.reveal();
        }
        return;
      }
      if (e.key === 'z' || e.key === 'Z' || e.key === 'u' || e.key === 'U') {
        if (review.canUndo) {
          e.preventDefault();
          review.undo();
        }
        return;
      }
      if (!current) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!shown) review.reveal();
        else {
          const good = gradePreviews[2];
          if (good) review.rate(good.grade);
        }
      } else if (shown && e.key >= '1' && e.key <= '4') {
        const p = gradePreviews[Number(e.key) - 1];
        if (p) review.rate(p.grade);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, shown, gradePreviews, review]);

  const label = sourceLabel(source);

  if (review.loading) {
    return (
      <div className="review-wrap">
        <div className="rv-top"><span className="back" onClick={onExit}><Icon.chevL s={18} /> Back</span></div>
        <div className="rv-stage"><p style={{ color: 'var(--ink-faint)' }}>Loading cards…</p></div>
      </div>
    );
  }

  if (review.isEmpty) {
    return (
      <div className="review-wrap">
        <div className="rv-top"><span className="back" onClick={onExit}><Icon.chevL s={18} /> Back</span></div>
        <div className="rv-stage">
          <div className="rv-done">
            <div className="jpbig" lang="ja">空っぽ</div>
            <div className="big">Nothing due</div>
            <p style={{ color: 'var(--ink-soft)', fontSize: 15, lineHeight: 1.6 }}>
              No cards are due right now. Mine some words while reading — tap a word, then ＋ Add to deck.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24 }}>
              <Btn variant="primary" onClick={onExit}>Back to library</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (review.done || !current) {
    const waitMin = review.nextLearningDueAt ? Math.max(1, Math.ceil((review.nextLearningDueAt - Date.now()) / 60000)) : null;
    return (
      <div className="review-wrap">
        <div className="rv-top"><span className="back" onClick={onExit}><Icon.chevL s={18} /> Done</span></div>
        <div className="rv-stage">
          <div className="rv-done">
            <div className="jpbig" lang="ja">お疲れさま</div>
            <div className="big">{waitMin != null ? 'Done for now' : 'Congratulations!'}</div>
            <p style={{ color: 'var(--ink-soft)', fontSize: 15, lineHeight: 1.6 }}>
              {waitMin != null
                ? `The next learning card will be ready in ${waitMin === 1 ? 'a minute' : `${waitMin} minutes`} — it will appear here automatically.`
                : `You have finished this deck for now. You made ${review.reviewedCount} ${review.reviewedCount === 1 ? 'review' : 'reviews'}; scheduling is saved and synced.`}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24 }}>
              {review.canUndo && <Btn onClick={review.undo}>Undo last answer</Btn>}
              <Btn variant="primary" onClick={onExit}>Back to library</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const f = current.fields;
  const userId = session?.user.id ?? '';

  return (
    <div className="review-wrap">
      <div className="rv-top">
        <span className="back" onClick={onExit}><Icon.close s={18} /></span>
        <span className="rv-counts" title="New · Learning · Due">
          <span className={'c new' + (review.currentBucket === 'new' ? ' cur' : '')}>{counts.new}</span>
          <span className={'c learn' + (review.currentBucket === 'learning' ? ' cur' : '')}>{counts.learning}</span>
          <span className={'c review' + (review.currentBucket === 'review' ? ' cur' : '')}>{counts.review}</span>
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {review.canUndo && (
          <button className="rv-edit" title="Undo last answer (Z)" onClick={review.undo}><Icon.undo s={16} /></button>
        )}
        <button className="rv-edit" title="Edit card" onClick={() => setEditing(current.cardId)}><Icon.study s={16} /></button>
        <Chip>{label}</Chip>
      </div>

      <div
        className="rv-stage"
        onClick={(e) => {
          // Don't reveal when interacting with elements inside the card (type box, hints, audio).
          const t = (e.nativeEvent.composedPath?.()[0] ?? e.target) as HTMLElement;
          if (t.tagName === 'INPUT' || t.tagName === 'A' || !!t.closest?.('.anki-audio')) return;
          if (!shown) review.reveal();
        }}
      >
        {current.generic ? (
          <div className="card-face">
            <CardTemplate
              front={current.generic.front}
              back={current.generic.back}
              fields={current.generic.fields}
              css={current.generic.css}
              ord={current.generic.ord}
              shown={shown}
              userId={userId}
              meta={{
                tags: current.generic.tags,
                deckName: current.generic.deckName,
                noteTypeName: current.generic.noteTypeName,
                templateName: current.generic.templateName,
              }}
            />
            {!shown && <div className="show-hint">Tap to reveal · space</div>}
          </div>
        ) : (
          <div className="card-face">
            <Kicker accent style={{ display: 'block' }}>recall the reading &amp; meaning</Kicker>
            <div className="cf-term" style={{ marginTop: 24 }} lang="ja">{f.Term}</div>
            {shown ? (
              <>
                <div className="cf-reading" lang="ja">{f.Reading}</div>
                <div className="cf-sep" />
                {f.Pos && <div className="cf-pos">{f.Pos}</div>}
                <div className="cf-gloss">{f.Meaning}</div>
              </>
            ) : (
              <div className="show-hint">Tap to reveal · space</div>
            )}
          </div>
        )}
      </div>

      <div className="rv-foot">
        {!shown ? (
          <Btn variant="primary" className="reveal-btn" onClick={review.reveal}>Show answer</Btn>
        ) : (
          <div className="rate-grid">
            {RATINGS.map(([k, lab, color], ki) => (
              <div className="rate-btn" key={k} onClick={() => gradePreviews[ki] && review.rate(gradePreviews[ki].grade)}>
                <div className="rivl">{gradePreviews[ki]?.interval ?? ''}</div>
                <div className="rlab" style={{ color }}>{lab}</div>
                <div className="rate-key">{ki + 1}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && <EditCardModal cardId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
