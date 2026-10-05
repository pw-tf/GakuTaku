import { registerPlugin } from '@capacitor/core';
import { isNative } from '../app/platform';

interface JapaneseTtsPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  speak(opts: { text: string; rate?: number }): Promise<void>;
  stop(): Promise<void>;
  synthesize(opts: { text: string; rate?: number }): Promise<{ data: string; mimeType: string }>;
}

/** android/app/src/main/java/app/gakutaku/JapaneseTtsPlugin.java */
const NativeTts = registerPlugin<JapaneseTtsPlugin>('JapaneseTts');

/**
 * Japanese text-to-speech. Android's WebView has no Web Speech API, so the app uses the device's
 * TTS engine through a small native plugin; a desktop browser uses `speechSynthesis`.
 */
export async function speak(text: string, lang = 'ja-JP'): Promise<void> {
  if (!text.trim()) return;
  if (isNative) {
    await NativeTts.speak({ text }).catch(() => undefined);
    return;
  }
  if (typeof speechSynthesis === 'undefined') return;
  await new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking(): void {
  if (isNative) void NativeTts.stop().catch(() => undefined);
  else if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** Record text with the device's Japanese voice (Android only; null elsewhere or on failure). */
export async function synthesize(text: string): Promise<Blob | null> {
  if (!isNative || !text.trim()) return null;
  try {
    const { data, mimeType } = await NativeTts.synthesize({ text });
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // A WAV header alone (no samples) means the engine produced nothing.
    return bytes.length > 64 ? new Blob([bytes as BlobPart], { type: mimeType }) : null;
  } catch {
    return null;
  }
}
