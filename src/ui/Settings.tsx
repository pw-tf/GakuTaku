import { useEffect, useRef, useState } from 'react';
import { ACCENTS, usePrefs } from '../app/prefs';
import { BackupSection } from '../backup/BackupSection';
import { ACTION_NAMES, GESTURE_NAMES, type Gesture, type ReviewAction } from '../study/gestures';
import { remindersAvailable, requestReminderPermission } from '../native/reminders';
import { Btn } from './atoms';
import { Modal } from './Modal';

interface ContentProps {
  onOpenCredits: () => void;
}

/** The settings controls (accent / dark / furigana / credits), reused by the desktop popover and the mobile menu. */
export function SettingsContent({ onOpenCredits }: ContentProps) {
  const {
    accent, dark, furigana, mineWordAudio, mineSentenceAudio,
    setAccent, setDark, setFurigana, setMineWordAudio, setMineSentenceAudio,
  } = usePrefs();
  return (
    <>
      <div className="set-sec">
        <div className="set-h">Accent</div>
        <div className="accent-swatches">
          {ACCENTS.map((c) => (
            <div
              key={c}
              className={'sw' + (accent === c ? ' on' : '')}
              style={{ background: c }}
              onClick={() => setAccent(c)}
            />
          ))}
        </div>
      </div>

      <div className="set-sec">
        <div className="toggle-row">
          <span>Dark mode</span>
          <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />
        </div>
      </div>

      <div className="set-sec">
        <div className="set-h">Furigana</div>
        <div className="density-seg">
          {(['all', 'n3', 'off'] as const).map((v) => (
            <div key={v} className={'d' + (furigana === v ? ' on' : '')} onClick={() => setFurigana(v)}>
              {v === 'all' ? 'All' : v === 'n3' ? 'N3+' : 'Off'}
            </div>
          ))}
        </div>
      </div>

      <ReviewSettings />

      <div className="set-sec">
        <div className="set-h">Mining</div>
        <div className="toggle-row">
          <span>Word audio (native speaker)</span>
          <input type="checkbox" checked={mineWordAudio} onChange={(e) => setMineWordAudio(e.target.checked)} />
        </div>
        <div className="toggle-row" style={{ marginTop: 8 }}>
          <span>Sentence audio (device voice)</span>
          <input type="checkbox" checked={mineSentenceAudio} onChange={(e) => setMineSentenceAudio(e.target.checked)} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6, lineHeight: 1.5 }}>
          Added to mined cards in the Android app. Elsewhere, cards read the word and sentence aloud at review time.
        </div>
      </div>

      <div className="set-sec">
        <BackupSection />
      </div>

      <div className="set-sec">
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', lineHeight: 1.5 }}>
          Study settings (day rollover, FSRS, audio autoplay, limits) are under a deck's Options, as in Anki.
        </div>
      </div>

      <div className="set-sec">
        <a
          style={{ color: 'var(--accent)', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}
          onClick={onOpenCredits}
        >
          Credits &amp; licenses →
        </a>
      </div>
    </>
  );
}

interface Props {
  onClose: () => void;
  onOpenCredits: () => void;
}

/** Desktop settings popover (anchored above the sidebar user row). */
export function Settings({ onClose, onOpenCredits }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement;
      // Ignore clicks on the user row (it toggles the popover itself) and in dialogs opened from here.
      if (ref.current && !ref.current.contains(t) && !t.closest('.user-row') && !t.closest('.modal-backdrop')) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div className="settings-pop" ref={ref}>
      <SettingsContent
        onOpenCredits={() => {
          onOpenCredits();
          onClose();
        }}
      />
    </div>
  );
}

/** Reviewer preferences: timer, card text size and gestures. */
function ReviewSettings() {
  const { showTimer, cardZoom, setShowTimer, setCardZoom, reminder, reminderTime, setReminder, setReminderTime } = usePrefs();
  const [gesturesOpen, setGesturesOpen] = useState(false);
  const [reminderNote, setReminderNote] = useState<string | null>(null);
  return (
    <div className="set-sec">
      <div className="set-h">Review</div>
      <div className="toggle-row">
        <span>Show answer timer</span>
        <input type="checkbox" checked={showTimer} onChange={(e) => setShowTimer(e.target.checked)} />
      </div>
      <div className="toggle-row" style={{ marginTop: 8 }}>
        <span>Card text size</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="range" min={0.6} max={2} step={0.1} value={cardZoom} onChange={(e) => setCardZoom(Number(e.target.value))} aria-label="Card text size" />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, width: 38, textAlign: 'right' }}>{Math.round(cardZoom * 100)}%</span>
        </span>
      </div>
      {remindersAvailable && (
        <>
          <div className="toggle-row" style={{ marginTop: 8 }}>
            <span>Daily reminder</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {reminder && <input type="time" value={reminderTime} aria-label="Reminder time" onChange={(e) => e.target.value && setReminderTime(e.target.value)} />}
              <input
                type="checkbox"
                checked={reminder}
                onChange={async (e) => {
                  const on = e.target.checked;
                  setReminderNote(null);
                  if (on && !(await requestReminderPermission())) {
                    setReminderNote('Notifications are off for GakuTaku. Allow them in Android settings to get reminders.');
                    return;
                  }
                  setReminder(on);
                }}
              />
            </span>
          </div>
          {(reminderNote || reminder) && (
            <div style={{ fontSize: 11, color: reminderNote ? 'var(--rate-again)' : 'var(--ink-faint)', marginTop: 4, lineHeight: 1.5 }}>
              {reminderNote ?? 'Only on days with cards due; shows how many.'}
            </div>
          )}
        </>
      )}
      <a style={{ display: 'inline-block', color: 'var(--accent)', fontSize: 13, cursor: 'pointer', fontWeight: 600, marginTop: 10 }} onClick={() => setGesturesOpen(true)}>
        Gestures and tap zones →
      </a>
      {gesturesOpen && <GesturesModal onClose={() => setGesturesOpen(false)} />}
    </div>
  );
}

const GESTURE_ORDER: Gesture[] = ['tap', 'tapTop', 'tapBottom', 'tapLeft', 'tapRight', 'swipeLeft', 'swipeRight', 'swipeUp', 'swipeDown'];

function GesturesModal({ onClose }: { onClose: () => void }) {
  const { gestures, setGesture, resetGestures } = usePrefs();
  return (
    <Modal title="Review gestures" onClose={onClose}>
      <div className="modal-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13, lineHeight: 1.5 }}>
          What a tap or swipe on the card does. The tap zones are the card’s top and bottom quarters and its left and right edges. On the question side, an answer gesture shows the answer first.
        </p>
        {GESTURE_ORDER.map((g) => (
          <label key={g} className="opt-field" style={{ padding: '5px 0' }}>
            <span>{GESTURE_NAMES[g]}</span>
            <select value={gestures[g]} onChange={(e) => setGesture(g, e.target.value as ReviewAction)}>
              {(Object.keys(ACTION_NAMES) as ReviewAction[]).map((a) => <option key={a} value={a}>{ACTION_NAMES[a]}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="modal-foot">
        <Btn onClick={resetGestures}>Reset</Btn>
        <Btn variant="primary" onClick={onClose}>Done</Btn>
      </div>
    </Modal>
  );
}
