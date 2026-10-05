import { mediaUrl } from '../media/store';
import type { AvTag } from '../anki/template';
import { speak, stopSpeaking } from '../native/tts';

/**
 * Plays a card's audio tags one after another (Anki's `av_player`): `[sound:…]` files from the media
 * folder, and `{{tts …}}` text through the system's speech engine. Starting a new sequence stops
 * the previous one.
 */

let generation = 0;
let current: HTMLAudioElement | null = null;

export function stopAudio(): void {
  generation++;
  if (current) {
    current.pause();
    current = null;
  }
  stopSpeaking();
}

function playOne(tag: AvTag, gen: number): Promise<void> {
  return new Promise((resolve) => {
    if (gen !== generation) return resolve();
    if (tag.kind === 'tts') {
      void speak(tag.value, tag.lang?.replace('_', '-')).then(resolve);
      return;
    }
    void mediaUrl(tag.value).then((url) => {
      if (!url || gen !== generation) return resolve();
      const a = new Audio(url);
      current = a;
      a.onended = () => resolve();
      a.onerror = () => resolve();
      a.play().catch(() => resolve());
    });
  });
}

export async function playAudio(tags: AvTag[]): Promise<void> {
  stopAudio();
  const gen = generation;
  for (const t of tags) {
    if (gen !== generation) return;
    await playOne(t, gen);
  }
}
