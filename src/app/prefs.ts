import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FuriganaDensity = 'all' | 'n3' | 'off';

/** Reader layout preferences (persisted, so a chosen layout survives across sessions). */
export type ReaderOrientation = 'horizontal' | 'vertical';
export type ReaderFlow = 'paged' | 'scroll';
export type ReaderFontScale = 's' | 'm' | 'l';
export type ReaderWidth = 'normal' | 'wide';

export const ACCENTS = ['#b8492f', '#3f5bb0', '#2f6b4f', '#7d4a86'];

interface PrefsState {
  accent: string;
  dark: boolean;
  furigana: FuriganaDensity;
  /** Last deck a word was mined into — used for one-tap "Add to deck". */
  lastDeckId: number | null;
  /** null = not yet chosen, so a book's own direction can seed the first default. */
  readerOrientation: ReaderOrientation | null;
  readerFlow: ReaderFlow;
  readerFontScale: ReaderFontScale;
  readerWidth: ReaderWidth;
  /** Mining: fetch a native-speaker recording of the word (JapanesePod101, Android app only). */
  mineWordAudio: boolean;
  /** Mining: record the sentence with the device's Japanese voice (Android app only). */
  mineSentenceAudio: boolean;
  setAccent: (a: string) => void;
  setDark: (d: boolean) => void;
  setFurigana: (f: FuriganaDensity) => void;
  setLastDeckId: (id: number | null) => void;
  setReaderOrientation: (o: ReaderOrientation) => void;
  setReaderFlow: (f: ReaderFlow) => void;
  setReaderFontScale: (s: ReaderFontScale) => void;
  setReaderWidth: (w: ReaderWidth) => void;
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
      dark: false,
      furigana: 'all',
      lastDeckId: null,
      readerOrientation: null,
      readerFlow: 'paged',
      readerFontScale: 'm',
      readerWidth: 'normal',
      mineWordAudio: true,
      mineSentenceAudio: true,
      setAccent: (accent) => set({ accent }),
      setDark: (dark) => set({ dark }),
      setFurigana: (furigana) => set({ furigana }),
      setLastDeckId: (lastDeckId) => set({ lastDeckId }),
      setReaderOrientation: (readerOrientation) => set({ readerOrientation }),
      setReaderFlow: (readerFlow) => set({ readerFlow }),
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
    },
  ),
);
