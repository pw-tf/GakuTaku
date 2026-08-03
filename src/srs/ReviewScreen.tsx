import { useCallback, useEffect, useState } from 'react';
import { Btn, Chip, Kicker } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { useAuth } from '../auth/AuthProvider';
import { db } from '../sync/system';
import { CardTemplate, replayCardAudio } from './CardTemplate';
import { EditCardModal } from './EditCardModal';
import { useReview, type ReviewSource } from './useReview';
import { buryCards, forgetCards, setDueDate, setFlag, suspendCards } from './cardOps';
import { FLAG_COLORS, FLAG_NAMES, parseDueDateSpec } from './cardPlans';

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
  const [menuOpen, setMenuOpen] = useState(false);
  const userId = session?.user.id ?? '';

  // --- Card actions (Anki parity). Bury/suspend/forget/set-due remove the card from the session;
  // they are deliberately not Z-undoable — only answers are, matching this session model.
  const noteCardIds = useCallback(async (noteId: string): Promise<string[]> => {
    const rows = await db.getAll<{ id: string }>('SELECT id FROM cards WHERE note_id = ?', [noteId]);
    return rows.map((r) => r.id);
  }, []);

  const toggleFlag = useCallback(
    (n: number) => {
      if (!current) return;
      // Anki toggles: setting the already-active flag clears it.
      const next = current.flag === n ? 0 : n;
      void setFlag([current.cardId], next);
      review.setCurrentFlag(next);
    },
    [current, review],
  );

  const buryCurrent = useCallback(
    (wholeNote: boolean) => {
      if (!current) return;
      void (async () => {
        const ids = wholeNote ? await noteCardIds(current.noteId) : [current.cardId];
        await buryCards(ids, { manual: true });
        review.excludeCards(ids);
      })();
    },
    [current, review, noteCardIds],
  );

  const suspendCurrent = useCallback(
    (wholeNote: boolean) => {
      if (!current) return;
      void (async () => {
        const ids = wholeNote ? await noteCardIds(current.noteId) : [current.cardId];
        await suspendCards(ids);
        review.excludeCards(ids);
      })();
    },
    [current, review, noteCardIds],
  );

  const forgetCurrent = useCallback(() => {
    if (!current || !userId) return;
    void (async () => {
      await forgetCards(userId, [current.cardId]);
      review.excludeCards([current.cardId]);
    })();
  }, [current, userId, review]);

  const setDueCurrent = useCallback(() => {
    if (!current || !userId) return;
    const raw = window.prompt('Set due date: days from now (e.g. “5”), or a range (e.g. “3-7”)', '1');
    if (raw == null) return;
    const spec = parseDueDateSpec(raw);
    if (!spec) return;
    void (async () => {
      await setDueDate(userId, [current.cardId], spec);
      review.excludeCards([current.cardId]);
    })();
  }, [current, userId, review]);

  // Keyboard, matching Anki desktop: space/enter reveals — or answers Good once revealed;
  // 1–4 rate; Z (or Ctrl+Z / U) undoes; R replays the card's audio; Ctrl+1..7 toggles flags;
  // `-`/`=` bury card/note; `@`/`!` suspend card/note.
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
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '7') {
        if (current) {
          e.preventDefault();
          toggleFlag(Number(e.key));
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
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        replayCardAudio();
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        buryCurrent(false);
      } else if (e.key === '=') {
        e.preventDefault();
        buryCurrent(true);
      } else if (e.key === '@') {
        e.preventDefault();
        suspendCurrent(false);
      } else if (e.key === '!') {
        e.preventDefault();
        suspendCurrent(true);
      } else if (e.key === ' ' || e.key === 'Enter') {
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
  }, [current, shown, gradePreviews, review, toggleFlag, buryCurrent, suspendCurrent]);

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

  return (
    <div className="review-wrap">
      <div className="rv-top">
        <span className="back" onClick={onExit}><Icon.close s={18} /></span>
        <span className="rv-counts" title="New · Learning · Due">
          <span className={'c new' + (review.currentBucket === 'new' ? ' cur' : '')}>{counts.new}</span>
          <span className={'c learn' + (review.currentBucket === 'learning' ? ' cur' : '')}>{counts.learning}</span>
          <span className={'c review' + (review.currentBucket === 'review' ? ' cur' : '')}>{counts.review}</span>
        </span>
        {current.flag > 0 && (
          <span
            title={`Flag: ${FLAG_NAMES[current.flag]}`}
            style={{ width: 10, height: 10, borderRadius: 3, background: FLAG_COLORS[current.flag], display: 'inline-block' }}
          />
        )}
        <span className="spacer" style={{ flex: 1 }} />
        {review.canUndo && (
          <button className="rv-edit" title="Undo last answer (Z)" onClick={review.undo}><Icon.undo s={16} /></button>
        )}
        <button className="rv-edit" title="Edit card" onClick={() => setEditing(current.cardId)}><Icon.study s={16} /></button>
        <span className="deck-add" style={{ position: 'relative' }}>
          <button className="rv-edit" title="Card actions" onClick={() => setMenuOpen((o) => !o)}><Icon.gear s={16} /></button>
          {menuOpen && (
            <>
              <div className="popmenu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="popmenu" style={{ right: 0 }}>
                <div style={{ display: 'flex', gap: 6, padding: '8px 12px', alignItems: 'center' }}>
                  {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                    <button
                      key={n}
                      title={`${FLAG_NAMES[n]} (Ctrl+${n})`}
                      onClick={() => { setMenuOpen(false); toggleFlag(n); }}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        border: current.flag === n ? '2px solid var(--ink)' : '1px solid transparent',
                        background: FLAG_COLORS[n],
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  ))}
                </div>
                <button onClick={() => { setMenuOpen(false); buryCurrent(false); }}><Icon.moon s={15} /> Bury card <span className="rate-key">-</span></button>
                <button onClick={() => { setMenuOpen(false); buryCurrent(true); }}><Icon.moon s={15} /> Bury note <span className="rate-key">=</span></button>
                <button onClick={() => { setMenuOpen(false); suspendCurrent(false); }}><Icon.pause s={15} /> Suspend card <span className="rate-key">@</span></button>
                <button onClick={() => { setMenuOpen(false); suspendCurrent(true); }}><Icon.pause s={15} /> Suspend note <span className="rate-key">!</span></button>
                <button onClick={() => { setMenuOpen(false); setDueCurrent(); }}><Icon.clock s={15} /> Set due date…</button>
                <button className="danger" onClick={() => { setMenuOpen(false); forgetCurrent(); }}><Icon.undo s={15} /> Forget card</button>
              </div>
            </>
          )}
        </span>
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
