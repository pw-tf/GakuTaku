import { useCallback, useEffect, useState } from 'react';
import { col } from '../anki/appCollection';
import type { Rating } from '../anki/types';
import { usePrefs } from '../app/prefs';
import { useBackHandler } from '../app/back';
import { Btn, Chip } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { ConfirmModal, PromptModal } from '../ui/Modal';
import { CardView, type CardEvent } from './CardView';
import { EditNoteModal } from './EditNoteModal';
import { useStudy } from './useStudy';

/** Anki's flag names and colours. */
export const FLAG_NAMES = ['No flag', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'] as const;
export const FLAG_COLORS = ['', '#e5535a', '#eb8a30', '#4fa965', '#4a90d9', '#e07ba8', '#3ec2c2', '#9d78d2'] as const;

const BUTTONS: { rating: Rating; label: string; color: string }[] = [
  { rating: 1, label: 'Again', color: 'var(--rate-again)' },
  { rating: 2, label: 'Hard', color: 'var(--rate-hard)' },
  { rating: 3, label: 'Good', color: 'var(--rate-good)' },
  { rating: 4, label: 'Easy', color: 'var(--rate-easy)' },
];

interface Props {
  /** Deck to study (with subdecks), or 0 for everything due. */
  deckId: number;
  title: string;
  onExit: () => void;
}

type Dialog = null | 'edit' | 'due' | 'forget' | 'deleteNote';

/** The reviewer: Anki's study flow with AnkiDroid-style controls. */
export function ReviewScreen({ deckId, title, onExit }: Props) {
  const study = useStudy(deckId);
  const { state } = study;
  const dark = usePrefs((s) => s.dark);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const card = state.card?.prepared.card ?? null;

  useBackHandler(menuOpen, () => setMenuOpen(false));

  const noteCardIds = useCallback((nid: number) => col.cardIdsOfNote(nid), []);

  const toggleFlag = useCallback(
    async (n: number) => {
      if (!card) return;
      await col.setFlag([card.id], (card.flags & 7) === n ? 0 : n);
      await study.refreshCurrent();
    },
    [card, study],
  );

  const bury = useCallback(
    async (wholeNote: boolean) => {
      if (!card) return;
      const ids = wholeNote ? await noteCardIds(card.nid) : [card.id];
      await col.buryOrSuspend(ids, 'buryUser');
      await study.removeFromSession(ids);
    },
    [card, study, noteCardIds],
  );

  const suspend = useCallback(
    async (wholeNote: boolean) => {
      if (!card) return;
      const ids = wholeNote ? await noteCardIds(card.nid) : [card.id];
      await col.buryOrSuspend(ids, 'suspend');
      await study.removeFromSession(ids);
    },
    [card, study, noteCardIds],
  );

  // Keyboard: Anki desktop's bindings.
  useEffect(() => {
    function onKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'> & { preventDefault?: () => void }) {
      if (dialog) return;
      const pd = () => e.preventDefault?.();
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '7') {
        pd();
        void toggleFlag(Number(e.key));
        return;
      }
      if (e.key === 'z' || e.key === 'Z' || e.key === 'u' || e.key === 'U') {
        pd();
        void study.undo();
        return;
      }
      if (!card) return;
      if (e.key === 'r' || e.key === 'R' || e.key === 'F5') {
        pd();
        study.replay();
      } else if (e.key === '-') {
        pd();
        void bury(false);
      } else if (e.key === '=') {
        pd();
        void bury(true);
      } else if (e.key === '@') {
        pd();
        void suspend(false);
      } else if (e.key === '!') {
        pd();
        void suspend(true);
      } else if (e.key === 'e' || e.key === 'E') {
        pd();
        setDialog('edit');
      } else if (e.key === ' ' || e.key === 'Enter') {
        pd();
        if (!state.shown) study.reveal();
        else void study.answer(3);
      } else if (state.shown && e.key >= '1' && e.key <= '4') {
        pd();
        void study.answer(Number(e.key) as Rating);
      }
    }
    const listener = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onKey(e);
    };
    window.addEventListener('keydown', listener);
    (window as unknown as { __cardKey?: typeof onKey }).__cardKey = onKey;
    return () => window.removeEventListener('keydown', listener);
  }, [card, state.shown, study, toggleFlag, bury, suspend, dialog]);

  const onCardEvent = useCallback(
    (e: CardEvent) => {
      switch (e.type) {
        case 'tap':
          if (!state.shown) study.reveal();
          break;
        case 'swipe':
          // AnkiDroid defaults: swipe up = show answer, left/right navigate nothing destructive.
          if (e.dir === 'up' && !state.shown) study.reveal();
          break;
        case 'key':
          (window as unknown as { __cardKey?: (k: typeof e) => void }).__cardKey?.(e);
          break;
        case 'play':
          study.playRef(e.ref);
          break;
        case 'typed':
          study.setTyped(e.value);
          if (e.enter && !state.shown) study.reveal();
          break;
        case 'pycmd':
          if (e.cmd === 'ans' && !state.shown) study.reveal();
          else if (e.cmd.startsWith('ease') && state.shown) void study.answer(Number(e.cmd.slice(4)) as Rating);
          break;
      }
    },
    [state.shown, study],
  );

  const top = (
    <div className="rv-top">
      <span className="back" onClick={onExit} aria-label="Close"><Icon.close s={18} /></span>
      {card && (
        <span className="rv-counts" title="New · Learning · To review">
          <span className={'c new' + (state.kind === 'new' ? ' cur' : '')}>{state.counts.new}</span>
          <span className={'c learn' + (state.kind === 'learning' ? ' cur' : '')}>{state.counts.learning}</span>
          <span className={'c review' + (state.kind === 'review' ? ' cur' : '')}>{state.counts.review}</span>
        </span>
      )}
      {card && (card.flags & 7) > 0 && (
        <span title={`Flag: ${FLAG_NAMES[card.flags & 7]}`} style={{ width: 10, height: 10, borderRadius: 3, background: FLAG_COLORS[card.flags & 7], display: 'inline-block' }} />
      )}
      <span className="spacer" style={{ flex: 1 }} />
      {state.canUndo && (
        <button className="rv-edit" title="Undo (Z)" aria-label="Undo" onClick={() => void study.undo()}><Icon.undo s={16} /></button>
      )}
      {card && (
        <>
          <button className="rv-edit" title="Edit note (E)" aria-label="Edit note" onClick={() => setDialog('edit')}><Icon.study s={16} /></button>
          <span className="deck-add" style={{ position: 'relative' }}>
            <button className="rv-edit" title="More" aria-label="More actions" onClick={() => setMenuOpen((o) => !o)}><Icon.gear s={16} /></button>
            {menuOpen && (
              <>
                <div className="popmenu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="popmenu" style={{ right: 0 }}>
                  <div style={{ display: 'flex', gap: 6, padding: '8px 12px', alignItems: 'center' }}>
                    {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                      <button
                        key={n}
                        title={`${FLAG_NAMES[n]} flag (Ctrl+${n})`}
                        aria-label={`${FLAG_NAMES[n]} flag`}
                        onClick={() => { setMenuOpen(false); void toggleFlag(n); }}
                        style={{ width: 22, height: 22, borderRadius: 6, border: (card.flags & 7) === n ? '2px solid var(--ink)' : '1px solid transparent', background: FLAG_COLORS[n], cursor: 'pointer', padding: 0 }}
                      />
                    ))}
                  </div>
                  <button onClick={() => { setMenuOpen(false); study.replay(); }}><Icon.sound s={15} /> Replay audio <span className="rate-key">R</span></button>
                  <button onClick={() => { setMenuOpen(false); void bury(false); }}><Icon.moon s={15} /> Bury card <span className="rate-key">-</span></button>
                  <button onClick={() => { setMenuOpen(false); void bury(true); }}><Icon.moon s={15} /> Bury note <span className="rate-key">=</span></button>
                  <button onClick={() => { setMenuOpen(false); void suspend(false); }}><Icon.pause s={15} /> Suspend card <span className="rate-key">@</span></button>
                  <button onClick={() => { setMenuOpen(false); void suspend(true); }}><Icon.pause s={15} /> Suspend note <span className="rate-key">!</span></button>
                  <button onClick={() => { setMenuOpen(false); setDialog('due'); }}><Icon.clock s={15} /> Set due date…</button>
                  <button onClick={() => { setMenuOpen(false); setDialog('forget'); }}><Icon.undo s={15} /> Reset card (Forget)…</button>
                  <button className="danger" onClick={() => { setMenuOpen(false); setDialog('deleteNote'); }}><Icon.trash s={15} /> Delete note…</button>
                </div>
              </>
            )}
          </span>
        </>
      )}
      <Chip>{title}</Chip>
    </div>
  );

  const dialogs = card && (
    <>
      {dialog === 'edit' && (
        <EditNoteModal
          noteId={card.nid}
          onClose={() => setDialog(null)}
          onSaved={() => void study.refreshCurrent()}
          onDeleted={() => void study.removeFromSession([card.id])}
        />
      )}
      {dialog === 'due' && (
        <PromptModal
          title="Set due date"
          label="Days from today"
          initial="0"
          help="“0” = today, “1” = tomorrow, “3-7” = a random day in that range. Add “!” (e.g. “7!”) to also set the interval."
          confirmLabel="Set"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await col.setDueDate([card.id], v);
            await study.removeFromSession([card.id]);
          }}
        />
      )}
      {dialog === 'forget' && (
        <ConfirmModal
          title="Reset card?"
          message="The card goes back to the end of the new queue, as if you had never studied it (its review history is kept)."
          confirmLabel="Reset"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await col.forget([card.id], { resetCounts: false, restorePosition: true });
            await study.removeFromSession([card.id]);
          }}
        />
      )}
      {dialog === 'deleteNote' && (
        <ConfirmModal
          title="Delete note?"
          message="This deletes the note and all of its cards."
          confirmLabel="Delete"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const ids = await noteCardIds(card.nid);
            await col.removeNotes([card.nid]);
            await study.removeFromSession(ids);
          }}
        />
      )}
    </>
  );

  if (state.loading) {
    return (
      <div className="review-wrap">
        {top}
        <div className="rv-stage"><p style={{ color: 'var(--ink-faint)' }}>Loading cards…</p></div>
      </div>
    );
  }

  if (!card) {
    const waitSecs = state.nextLearningAt ? Math.max(0, state.nextLearningAt - Math.floor(Date.now() / 1000)) : null;
    return (
      <div className="review-wrap">
        {top}
        <div className="rv-stage">
          <div className="rv-done">
            <div className="jpbig" lang="ja">{state.reviewedCount ? 'お疲れさま' : '空っぽ'}</div>
            <div className="big">{waitSecs != null ? 'Done for now' : 'Congratulations!'}</div>
            <p style={{ color: 'var(--ink-soft)', fontSize: 15, lineHeight: 1.6 }}>
              {state.error
                ? state.error
                : waitSecs != null
                  ? `More learning cards will be due in ${waitSecs < 90 ? 'a minute' : `${Math.ceil(waitSecs / 60)} minutes`}. They’ll appear here automatically.`
                  : state.reviewedCount
                    ? `You have finished this deck for now. ${state.reviewedCount} ${state.reviewedCount === 1 ? 'card' : 'cards'} studied.`
                    : 'Nothing is due right now.'}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24 }}>
              {state.canUndo && <Btn onClick={() => void study.undo()}>Undo last answer</Btn>}
              <Btn variant="primary" onClick={onExit}>Back</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="review-wrap">
      {top}
      <div className="rv-card">
        <CardView html={state.html} css={state.rendered?.css ?? ''} ord={card.ord} dark={dark} onEvent={onCardEvent} version={state.version} side={state.shown ? 'a' : 'q'} />
      </div>
      <div className="rv-foot">
        {!state.shown ? (
          <Btn variant="primary" className="reveal-btn" onClick={study.reveal}>Show answer</Btn>
        ) : (
          <div className="rate-grid">
            {BUTTONS.map((b, i) => (
              <button className="rate-btn" key={b.rating} onClick={() => void study.answer(b.rating)}>
                <div className="rivl">{state.buttonLabels[i] ?? ''}</div>
                <div className="rlab" style={{ color: b.color }}>{b.label}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {dialogs}
    </div>
  );
}
