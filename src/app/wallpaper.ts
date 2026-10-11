import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useEffectiveTheme, usePrefs } from './prefs';

/** Home screen wallpaper: none, a built-in pattern, or the user's photo. */
export type Wallpaper = 'none' | 'seigaiha' | 'shippo' | 'washi' | 'photo';

export const PATTERNS: [Exclude<Wallpaper, 'none' | 'photo'>, string][] = [
  ['seigaiha', 'Seigaiha · waves'],
  ['shippo', 'Shippō · circles'],
  ['washi', 'Washi · paper'],
];

/**
 * The photo lives in its own persisted store, so the (large) image is written only when it
 * changes, not with every preference.
 */
// ponytail: a data URL in localStorage (~0.3 MB after downscaling); move to IndexedDB if it's ever bigger.
export const useWallpaperPhoto = create<{ photo: string | null; setPhoto: (p: string | null) => void }>()(
  persist((set) => ({ photo: null, setPhoto: (photo) => set({ photo }) }), { name: 'gakutaku-wallpaper' }),
);

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/** Built-in patterns, drawn in the accent colour over the theme's paper colour. */
function pattern(kind: Exclude<Wallpaper, 'none' | 'photo'>, accent: string, paper: string): string {
  if (kind === 'seigaiha') {
    // Rows of concentric fans, each overlapping the row above it.
    const fan = (x: number, y: number) =>
      `<circle cx="${x}" cy="${y}" r="40" fill="${paper}"/>` +
      [40, 31, 22, 13].map((r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${accent}" stroke-opacity=".32" stroke-width="2"/>`).join('');
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">${fan(0, 0)}${fan(80, 0)}${fan(40, 20)}${fan(0, 40)}${fan(80, 40)}</svg>`);
  }
  if (kind === 'shippo') {
    const c = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="24" fill="none" stroke="${accent}" stroke-opacity=".3" stroke-width="1.6"/>`;
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="${paper}"/>${c(0, 0)}${c(48, 0)}${c(0, 48)}${c(48, 48)}${c(24, 24)}</svg>`);
  }
  // Washi: long fibres of noise in the accent colour (the colour matrix paints them; a fill can't).
  const [r, g, b] = [1, 3, 5].map((i) => (parseInt(accent.slice(i, i + 2), 16) / 255).toFixed(3));
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><filter id="f"><feTurbulence type="fractalNoise" baseFrequency=".006 .1" numOctaves="4" seed="7" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 -2.4 1.25"/></filter>` +
      `<rect width="360" height="360" fill="${paper}"/><rect width="360" height="360" opacity=".22" filter="url(#f)"/></svg>`,
  );
}

/** The CSS `background` for a wallpaper, or null for none. `paper` is the theme's paper colour. */
export function wallpaperBackground(kind: Wallpaper, accent: string, paper: string, photo: string | null): string | null {
  if (kind === 'none') return null;
  if (kind === 'photo') return photo ? `center / cover no-repeat url("${photo}")` : null;
  return `${pattern(kind, accent, paper)} repeat`;
}

/** Shrink a picked image to at most 1600px on its long side and encode it as a JPEG data URL. */
export async function photoFromFile(file: File): Promise<string> {
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error('That file isn’t an image this phone can open.');
  });
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}

// ponytail: mirrors --paper in gakutaku.css (an SVG image can't read CSS variables).
export const PAPER = { light: 'oklch(0.972 0.009 83)', dark: 'oklch(0.205 0.010 60)', black: '#000' };

/** The Home wallpaper's CSS `background` for the current theme and accent, or null for none. */
export function useWallpaper(): string | null {
  const kind = usePrefs((s) => s.wallpaper);
  const accent = usePrefs((s) => s.accent);
  const theme = useEffectiveTheme();
  const photo = useWallpaperPhoto((s) => s.photo);
  return useMemo(() => wallpaperBackground(kind, accent, PAPER[theme], photo), [kind, accent, theme, photo]);
}
