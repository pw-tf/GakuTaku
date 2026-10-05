import { mediaUrl } from '../media/store';
import type { AvTag } from '../anki/template';

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
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

function playOne(tag: AvTag, gen: number): Promise<void> {
  return new Promise((resolve) => {
    if (gen !== generation) return resolve();
    if (tag.kind === 'tts') {
      if (typeof speechSynthesis === 'undefined') return resolve();
      const u = new SpeechSynthesisUtterance(tag.value);
      if (tag.lang) u.lang = tag.lang.replace('_', '-');
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
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
