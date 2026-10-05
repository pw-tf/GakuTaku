import { isNative } from '../app/platform';
import { fetchBytes } from '../feeds/proxy';
import { synthesize } from '../native/tts';
import { putMediaFile } from '../media/store';

/**
 * Audio for mined cards:
 *   - word audio: a native speaker's recording from JapanesePod101's dictionary (the source Yomitan
 *     uses by default);
 *   - sentence audio: the sentence recorded with the device's Japanese voice.
 * Both need the Android app; in a desktop browser the cards fall back to speaking at review time.
 */

/** SHA-256 of JapanesePod101's "the audio for this clip is currently not available" clip. */
const JPOD_MISSING = 'ae6398b5a27bc8c0a771df6c907ade794be15518174773c58c7c7ddd17098906';

const isKana = (s: string) => /^[぀-ヿー]+$/.test(s);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The JapanesePod101 clip URL for a word (kana-only words are looked up by reading). */
export function jpodUrl(term: string, reading: string): string {
  const params = new URLSearchParams();
  if (!(reading === term && isKana(term)) && term) params.set('kanji', term);
  if (reading) params.set('kana', reading);
  return `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?${params.toString()}`;
}

/** A short, stable, filesystem-safe name for a media file. */
async function mediaName(prefix: string, key: string, ext: string): Promise<string> {
  const hash = (await sha256Hex(new TextEncoder().encode(key))).slice(0, 16);
  return `gakutaku_${prefix}_${hash}.${ext}`;
}

/** Fetch and store the word's recording; returns the media filename, or null if there is none. */
export async function fetchWordAudio(term: string, reading: string): Promise<string | null> {
  if (!isNative) return null; // the site doesn't allow cross-origin reads from a browser
  try {
    const { bytes, contentType } = await fetchBytes(jpodUrl(term, reading));
    if (bytes.length < 1024 || (contentType && !/audio|octet-stream/i.test(contentType))) return null;
    if ((await sha256Hex(bytes)) === JPOD_MISSING) return null;
    const name = await mediaName('jpod', `${term}|${reading}`, 'mp3');
    await putMediaFile(name, new Blob([bytes as BlobPart], { type: 'audio/mpeg' }));
    return name;
  } catch {
    return null;
  }
}

/** Record and store the sentence; returns the media filename, or null. */
export async function recordSentenceAudio(sentence: string): Promise<string | null> {
  const blob = await synthesize(sentence);
  if (!blob) return null;
  const name = await mediaName('tts', sentence, 'wav');
  await putMediaFile(name, blob);
  return name;
}
