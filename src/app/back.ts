import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * Android back button. Anything that can be "backed out of" (a reader, a modal, a menu) registers a
 * handler while it is open; the most recently opened one handles the press. With nothing open,
 * back sends the app to the background, as Android apps do on their home screen.
 */

const stack: { current: () => void }[] = [];

/** While `active`, a back press calls `onBack` (if nothing opened later is also listening). */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    stack.push(ref);
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** Run the innermost back handler; false when there was none. */
export function handleBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.current();
  return true;
}

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('backButton', () => {
    if (!handleBack()) void CapApp.minimizeApp();
  });
}
