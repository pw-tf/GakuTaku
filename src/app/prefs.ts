import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FuriganaDensity = 'all' | 'n3' | 'off';

export const ACCENTS = ['#b8492f', '#3f5bb0', '#2f6b4f', '#7d4a86'];

interface PrefsState {
  accent: string;
  dark: boolean;
  furigana: FuriganaDensity;
  setAccent: (a: string) => void;
  setDark: (d: boolean) => void;
  setFurigana: (f: FuriganaDensity) => void;
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
      setAccent: (accent) => set({ accent }),
      setDark: (dark) => set({ dark }),
      setFurigana: (furigana) => set({ furigana }),
    }),
    { name: 'gakutaku-prefs' },
  ),
);
