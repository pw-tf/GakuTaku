import { Capacitor } from '@capacitor/core';

/** True inside the Android app (Capacitor), false in a browser. */
export const isNative = Capacitor.isNativePlatform();

/**
 * The `accept` attribute for a file input. Android's picker turns `accept` into MIME filters and
 * has no MIME type for `.apkg` (or reliably for `.epub`), so it would grey those files out — inside
 * the app we accept anything and check the extension after picking.
 */
export function fileAccept(webAccept: string): string | undefined {
  return isNative ? undefined : webAccept;
}
