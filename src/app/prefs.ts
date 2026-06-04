import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FuriganaDensity = 'all' | 'n3' | 'off';

export const ACCENTS = ['#b8492f', '#3f5bb0', '#2f6b4f', '#7d4a86'];

interface PrefsState {
  accent: string;
  dark: boolean;
  furigana: FuriganaDensity;
  /** Last deck a word was mined into — used for one-tap "Add to deck". */
  lastDeckId: string | null;
  setAccent: (a: string) => void;
  setDark: (d: boolean) => void;
  setFurigana: (f: FuriganaDensity) => void;
  setLastDeckId: (id: string | null) => void;
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
      setAccent: (accent) => set({ accent }),
      setDark: (dark) => set({ dark }),
      setFurigana: (furigana) => set({ furigana }),
      setLastDeckId: (lastDeckId) => set({ lastDeckId }),
    }),
    { name: 'gakutaku-prefs' },
  ),
);
