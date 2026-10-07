import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_GESTURES, type Gesture, type ReviewAction } from '../study/gestures';

export type FuriganaDensity = 'all' | 'n3' | 'off';

/** Reader layout preferences (persisted, so a chosen layout survives across sessions). */
export type ReaderOrientation = 'horizontal' | 'vertical';
export type ReaderFlow = 'paged' | 'scroll';
export type ReaderFontScale = 's' | 'm' | 'l';
export type ReaderWidth = 'normal' | 'wide';

export const ACCENTS = ['#b8492f', '#3f5bb0', '#2f6b4f', '#7d4a86', '#1f7a80', '#a8476b'];

/** App theme: follow the phone, or always light, dark, or black (true black, for OLED screens). */
export type ThemeMode = 'system' | 'light' | 'dark' | 'black';

interface PrefsState {
  accent: string;
  theme: ThemeMode;
  furigana: FuriganaDensity;
  /** Last deck a word was mined into — used for one-tap "Add to deck". */
  lastDeckId: number | null;
  /** null = not yet chosen, so a book's own direction can seed the first default. */
  readerOrientation: ReaderOrientation | null;
  readerFlow: ReaderFlow;
  readerFontScale: ReaderFontScale;
  readerWidth: ReaderWidth;
  /** Reader: underline words that aren't in any of your notes yet. */
  markUnknown: boolean;
  /** Mining: fetch a native-speaker recording of the word (JapanesePod101, Android app only). */
  mineWordAudio: boolean;
  /** Mining: record the sentence with the device's Japanese voice (Android app only). */
  mineSentenceAudio: boolean;
  /** Reviewer: what each tap zone / swipe does. */
  gestures: Record<Gesture, ReviewAction>;
  /** Reviewer: show how long the current card has been on screen. */
  showTimer: boolean;
  /** Reviewer: card text size, as a fraction (1 = 100%). */
  cardZoom: number;
  /** Daily study reminder (Android notifications) at `reminderTime` (HH:MM, local). */
  reminder: boolean;
  reminderTime: string;
  setReminder: (on: boolean) => void;
  setReminderTime: (t: string) => void;
  setGesture: (g: Gesture, a: ReviewAction) => void;
  resetGestures: () => void;
  setShowTimer: (on: boolean) => void;
  setCardZoom: (z: number) => void;
  setAccent: (a: string) => void;
  setTheme: (t: ThemeMode) => void;
  setFurigana: (f: FuriganaDensity) => void;
  setLastDeckId: (id: number | null) => void;
  setReaderOrientation: (o: ReaderOrientation) => void;
  setReaderFlow: (f: ReaderFlow) => void;
  setReaderFontScale: (s: ReaderFontScale) => void;
  setReaderWidth: (w: ReaderWidth) => void;
  setMarkUnknown: (on: boolean) => void;
  setMineWordAudio: (on: boolean) => void;
  setMineSentenceAudio: (on: boolean) => void;
}

/**
 * User UI preferences (theme, accent, furigana density). Persisted to localStorage; the furigana
 * density is shared between the reader rail and the settings popover. (Production could later sync
 * these to the user_settings table.)
 */
export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      accent: ACCENTS[0],
      theme: 'system',
      furigana: 'all',
      lastDeckId: null,
      readerOrientation: null,
      readerFlow: 'paged',
      markUnknown: true,
      readerFontScale: 'm',
      readerWidth: 'normal',
      mineWordAudio: true,
      mineSentenceAudio: true,
      gestures: { ...DEFAULT_GESTURES },
      showTimer: false,
      cardZoom: 1,
      reminder: false,
      reminderTime: '19:00',
      setReminder: (reminder) => set({ reminder }),
      setReminderTime: (reminderTime) => set({ reminderTime }),
      setGesture: (g, a) => set((s) => ({ gestures: { ...s.gestures, [g]: a } })),
      resetGestures: () => set({ gestures: { ...DEFAULT_GESTURES } }),
      setShowTimer: (showTimer) => set({ showTimer }),
      setCardZoom: (cardZoom) => set({ cardZoom }),
      setAccent: (accent) => set({ accent }),
      setTheme: (theme) => set({ theme }),
      setFurigana: (furigana) => set({ furigana }),
      setLastDeckId: (lastDeckId) => set({ lastDeckId }),
      setReaderOrientation: (readerOrientation) => set({ readerOrientation }),
      setReaderFlow: (readerFlow) => set({ readerFlow }),
      setMarkUnknown: (markUnknown) => set({ markUnknown }),
      setReaderFontScale: (readerFontScale) => set({ readerFontScale }),
      setReaderWidth: (readerWidth) => set({ readerWidth }),
      setMineWordAudio: (mineWordAudio) => set({ mineWordAudio }),
      setMineSentenceAudio: (mineSentenceAudio) => set({ mineSentenceAudio }),
    }),
    {
      name: 'gakutaku-prefs',
      version: 1,
      // v0 stored deck ids as UUID strings (pre-Anki schema); they no longer exist.
      migrate: (persisted) => ({ ...(persisted as object), lastDeckId: null }) as PrefsState,
      // Gestures added later keep their defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PrefsState> & { dark?: boolean };
        // Older versions stored a dark-mode switch instead of a theme.
        const theme: ThemeMode = p.theme ?? (p.dark === true ? 'dark' : p.dark === false ? 'light' : current.theme);
        return { ...current, ...p, theme, gestures: { ...DEFAULT_GESTURES, ...(p.gestures ?? {}) } };
      },
    },
  ),
);

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

/** The theme in effect: 'system' resolved against the phone's light/dark setting (live). */
export function useEffectiveTheme(): 'light' | 'dark' | 'black' {
  const theme = usePrefs((s) => s.theme);
  const [systemDark, setSystemDark] = useState(() => darkQuery()?.matches ?? false);
  useEffect(() => {
    const q = darkQuery();
    if (!q) return;
    const on = () => setSystemDark(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

/** True when the app is dark (dark or black theme). */
export function useDark(): boolean {
  return useEffectiveTheme() !== 'light';
}
