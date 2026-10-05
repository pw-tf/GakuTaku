import { registerPlugin } from '@capacitor/core';
import { isNative } from '../app/platform';

/**
 * The Android app draws edge to edge (behind the status and navigation bars). The native side
 * reports the bars' sizes; they become CSS variables (--sat/--sab/--sal/--sar) that the layout pads
 * by. Elsewhere the variables fall back to the browser's own safe-area insets.
 */

interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface SystemBarsApi {
  get(): Promise<Insets>;
  setStyle(opts: { dark: boolean }): Promise<void>;
  addListener(event: 'change', cb: (insets: Insets) => void): Promise<{ remove: () => Promise<void> }>;
}

const SystemBars = registerPlugin<SystemBarsApi>('SystemBars');

function apply(i: Insets) {
  const s = document.documentElement.style;
  s.setProperty('--sat', `${i.top}px`);
  s.setProperty('--sab', `${i.bottom}px`);
  s.setProperty('--sal', `${i.left}px`);
  s.setProperty('--sar', `${i.right}px`);
}

/** Start following the system bars (call once at startup). */
export function initSystemBars(): void {
  if (!isNative) return;
  void SystemBars.addListener('change', apply).catch(() => {});
  void SystemBars.get().then(apply).catch(() => {});
}

/** Light or dark status/navigation bar icons to suit the app's theme. */
export function setSystemBarStyle(dark: boolean): void {
  if (!isNative) return;
  void SystemBars.setStyle({ dark }).catch(() => {});
}
