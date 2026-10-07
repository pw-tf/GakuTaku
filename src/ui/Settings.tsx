import { useEffect, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { isNative } from '../app/platform';
import { ACCENTS, usePrefs, type ThemeMode } from '../app/prefs';
import { BackupSection } from '../backup/BackupSection';
import { ACTION_NAMES, GESTURE_NAMES, type Gesture, type ReviewAction } from '../study/gestures';
import { remindersAvailable, requestReminderPermission } from '../native/reminders';
import { Btn } from './atoms';
import { Modal } from './Modal';

const THEMES: [ThemeMode, string][] = [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark'], ['black', 'Black']];
const ACCENT_NAMES = ['Vermilion', 'Indigo', 'Pine', 'Plum', 'Teal', 'Rose'];

/** The Settings screen: appearance, reading, review, mining, backup and about. */
export function SettingsScreen({ onOpenCredits }: { onOpenCredits: () => void }) {
  const p = usePrefs();
  return (
    <div className="page settings-page">
      <section className="set-card">
        <h3>Appearance</h3>
        <div className="set-row col">
          <span className="set-label">Theme</span>
          <div className="density-seg">
            {THEMES.map(([v, label]) => (
              <div key={v} className={'d' + (p.theme === v ? ' on' : '')} onClick={() => p.setTheme(v)}>{label}</div>
            ))}
          </div>
          <span className="set-help">Auto follows your phone’s dark mode. Black uses true black, which saves battery on OLED screens.</span>
        </div>
        <div className="set-row col">
          <span className="set-label">Accent colour</span>
          <div className="accent-swatches">
            {ACCENTS.map((c, i) => (
              <button key={c} type="button" className={'sw' + (p.accent === c ? ' on' : '')} style={{ background: c }} aria-label={ACCENT_NAMES[i] ?? c} title={ACCENT_NAMES[i]} onClick={() => p.setAccent(c)} />
            ))}
          </div>
        </div>
      </section>

      <section className="set-card">
        <h3>Reading</h3>
        <div className="set-row col">
          <span className="set-label">Furigana</span>
          <div className="density-seg">
            {(['all', 'n3', 'off'] as const).map((v) => (
              <div key={v} className={'d' + (p.furigana === v ? ' on' : '')} onClick={() => p.setFurigana(v)}>
                {v === 'all' ? 'All' : v === 'n3' ? 'N3+' : 'Off'}
              </div>
            ))}
          </div>
          <span className="set-help">N3+ shows readings only over harder kanji (JLPT N3 and above).</span>
        </div>
        <div className="set-row col">
          <span className="set-label">Text size</span>
          <div className="density-seg">
            {(['s', 'm', 'l'] as const).map((v) => (
              <div key={v} className={'d' + (p.readerFontScale === v ? ' on' : '')} onClick={() => p.setReaderFontScale(v)}>
                {v === 's' ? 'Small' : v === 'm' ? 'Medium' : 'Large'}
              </div>
            ))}
          </div>
        </div>
        <div className="set-row col">
          <span className="set-label">Line width</span>
          <div className="density-seg">
            {(['normal', 'wide'] as const).map((v) => (
              <div key={v} className={'d' + (p.readerWidth === v ? ' on' : '')} onClick={() => p.setReaderWidth(v)}>
                {v === 'normal' ? 'Normal' : 'Wide'}
              </div>
            ))}
          </div>
        </div>
        <div className="toggle-row">
          <span>Underline words without a card</span>
          <input type="checkbox" checked={p.markUnknown} onChange={(e) => p.setMarkUnknown(e.target.checked)} />
        </div>
      </section>

      <ReviewSettings />

      <section className="set-card">
        <h3>Mining</h3>
        <div className="toggle-row">
          <span>Word audio (native speaker)</span>
          <input type="checkbox" checked={p.mineWordAudio} onChange={(e) => p.setMineWordAudio(e.target.checked)} />
        </div>
        <div className="toggle-row">
          <span>Sentence audio (device voice)</span>
          <input type="checkbox" checked={p.mineSentenceAudio} onChange={(e) => p.setMineSentenceAudio(e.target.checked)} />
        </div>
        <span className="set-help">Added to mined cards in the Android app. Elsewhere, cards read the word and sentence aloud at review time.</span>
      </section>

      <section className="set-card">
        <BackupSection />
      </section>

      <section className="set-card">
        <h3>About</h3>
        <AppVersion />
        <span className="set-help">Study settings (new cards per day, learning steps, FSRS, day rollover) are in each deck’s Options, as in Anki.</span>
        <a className="set-link" onClick={onOpenCredits}>Credits &amp; licenses →</a>
      </section>
    </div>
  );
}

/** The installed version (Android app only), so it's clear when an update has landed. */
function AppVersion() {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    if (isNative) void CapApp.getInfo().then((i) => setV(`${i.version} (build ${i.build})`)).catch(() => {});
  }, []);
  return v ? <span className="set-help">GakuTaku {v}</span> : null;
}

/** Reviewer preferences: timer, card text size and gestures. */
function ReviewSettings() {
  const { showTimer, cardZoom, setShowTimer, setCardZoom, reminder, reminderTime, setReminder, setReminderTime } = usePrefs();
  const [gesturesOpen, setGesturesOpen] = useState(false);
  const [reminderNote, setReminderNote] = useState<string | null>(null);
  return (
    <section className="set-card">
      <h3>Review</h3>
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
    </section>
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
