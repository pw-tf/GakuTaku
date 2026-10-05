/**
 * Sentence capture for mining: the sentence around a tapped word, as plain text and in Anki's
 * furigana syntax (` 漢字[かんじ]`, rendered by the `{{furigana:…}}` filter), with the word in bold.
 */

export interface SentenceToken {
  surface: string;
  segments?: { text: string; reading?: string }[];
}

const END_CHARS = /[。！？!?．]/;
const CLOSERS = /^[」』）)】〉》〕”’"'…‥]+$/;
/** A sentence with no end punctuation is capped to this many tokens either side of the word. */
const MAX_SIDE = 40;

const isEnd = (t: SentenceToken) => END_CHARS.test(t.surface);

/** Token range [start, end) of the sentence containing token `i`. */
export function sentenceBounds(tokens: SentenceToken[], i: number): [number, number] {
  let start = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (isEnd(tokens[j])) {
      start = j + 1;
      break;
    }
  }
  // Closing quotes right after the previous sentence's end belong to that sentence.
  while (start < i && CLOSERS.test(tokens[start].surface)) start++;
  let end = tokens.length;
  for (let k = i; k < tokens.length; k++) {
    if (isEnd(tokens[k])) {
      end = k + 1;
      while (end < tokens.length && CLOSERS.test(tokens[end].surface)) end++;
      break;
    }
  }
  start = Math.max(start, i - MAX_SIDE);
  end = Math.min(end, i + MAX_SIDE + 1);
  // Leading whitespace (paragraph indents) isn't part of the sentence.
  while (start < i && !tokens[start].surface.trim()) start++;
  return [start, end];
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One token in Anki furigana syntax. A space marks where each ruby base starts. */
function furiganaOf(t: SentenceToken, out: string): string {
  if (!t.segments?.length) return escapeHtml(t.surface);
  let s = '';
  for (const seg of t.segments) {
    const text = escapeHtml(seg.text);
    if (seg.reading && seg.reading !== seg.text) {
      const prev = out + s;
      s += (prev && !prev.endsWith('>') && !prev.endsWith(' ') ? ' ' : '') + `${text}[${escapeHtml(seg.reading)}]`;
    } else s += text;
  }
  return s;
}

export interface CapturedSentence {
  /** Plain text, for speech. */
  plain: string;
  /** HTML with the word in <b>. */
  html: string;
  /** Anki furigana syntax with the word in <b>. */
  furigana: string;
}

/** The sentence around token `i` in a paragraph's tokens. */
export function captureSentence(tokens: SentenceToken[], i: number): CapturedSentence {
  const [start, end] = sentenceBounds(tokens, i);
  let plain = '';
  let html = '';
  let furigana = '';
  for (let k = start; k < end; k++) {
    const t = tokens[k];
    plain += t.surface;
    const f = furiganaOf(t, furigana + (k === i ? '<b>' : ''));
    if (k === i) {
      html += `<b>${escapeHtml(t.surface)}</b>`;
      furigana += `<b>${f}</b>`;
    } else {
      html += escapeHtml(t.surface);
      furigana += f;
    }
  }
  return { plain: plain.trim(), html: html.trim(), furigana: furigana.trim() };
}
