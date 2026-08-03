import { useEffect, useMemo, useRef } from 'react';
import { usePrefs } from '../app/prefs';
import { resolveMedia } from '../import/media';

/**
 * Render an imported Anki card faithfully (SRS redesign). Anki templates are HTML with `{{Field}}`
 * substitution, `{{FrontSide}}`, `{{#Field}}…{{/Field}}` / `{{^Field}}…{{/Field}}` conditionals,
 * `{{cloze:Field}}` deletions, field filters (`text:`, `hint:`, `type:` and the Japanese-support
 * `furigana:`/`kana:`/`kanji:` ruby syntax), and the special fields `{{Tags}}`/`{{Deck}}`/
 * `{{Subdeck}}`/`{{Card}}`/`{{Type}}`. We render the result **inside a Shadow DOM** together with the
 * note type's own CSS, so each deck looks as its author intended — including which word is emphasised —
 * without a heuristic and without the styles leaking into (or being overridden by) the app. Media
 * refs were rewritten at import to `data-media`/`data-audio` tokens, resolved after mount.
 */

/** Show/hide `{{#F}}…{{/F}}` (if non-empty) and `{{^F}}…{{/F}}` (if empty) blocks until stable. */
function applyConditionals(tmpl: string, fields: Record<string, string>): string {
  let prev: string;
  let out = tmpl;
  do {
    prev = out;
    out = out
      .replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, f: string, inner: string) => (fields[f.trim()]?.trim() ? inner : ''))
      .replace(/\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, f: string, inner: string) => (fields[f.trim()]?.trim() ? '' : inner));
  } while (out !== prev);
  return out;
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '');

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Anki Japanese-support furigana syntax: `漢字[かんじ]` — the reading binds back to the preceding
 * space (which is consumed) or tag boundary. `[sound:…]` brackets are left alone.
 */
const FURIGANA_RE = /(?:&nbsp;|\s)?([^\s>]+?)\[(.+?)\]/g;

const furigana = (s: string) =>
  s.replace(FURIGANA_RE, (m, base: string, reading: string) =>
    reading.startsWith('sound:') ? m : `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`,
  );
const kanaOnly = (s: string) =>
  s.replace(FURIGANA_RE, (m, _base: string, reading: string) => (reading.startsWith('sound:') ? m : reading));
const kanjiOnly = (s: string) =>
  s.replace(FURIGANA_RE, (m, base: string, reading: string) => (reading.startsWith('sound:') ? m : base));

/** Apply a `{{filter1:filter2:Field}}` chain, innermost (rightmost) filter first, like Anki. */
function applyFilters(value: string, mods: string[], fieldName: string): string {
  for (let i = mods.length - 1; i >= 0; i--) {
    switch (mods[i].trim().toLowerCase()) {
      case 'text':
        value = stripHtml(value);
        break;
      case 'furigana':
        value = furigana(value);
        break;
      case 'kana':
        value = kanaOnly(value);
        break;
      case 'kanji':
        value = kanjiOnly(value);
        break;
      case 'hint':
        if (value.trim()) {
          value = `<a class="hint" href="#" data-hint>${escapeHtml(fieldName)}</a><div class="hint-content" style="display:none">${value}</div>`;
        }
        break;
      default:
        break; // unknown filters (e.g. add-on filters) pass the value through, like Anki
    }
  }
  return value;
}

/**
 * Replace `{{[filters:]Field}}` with the (filtered) field value. `{{type:Field}}` becomes Anki's
 * type-in-the-answer box on the question and a typed-vs-expected comparison on the answer; the
 * actual diff is filled in after mount (the typed text lives outside this pure render).
 */
function substFields(tmpl: string, fields: Record<string, string>, opts: RenderOpts): string {
  return tmpl.replace(/\{\{([^}#^/][^}]*)\}\}/g, (_m, raw: string) => {
    const parts = raw.trim().split(':');
    const name = parts[parts.length - 1].trim();
    const mods = parts.slice(0, -1);
    if (mods[0]?.trim().toLowerCase() === 'type') {
      let expected = stripHtml(fields[name] ?? '').trim();
      if (mods[1]?.trim().toLowerCase() === 'cloze') {
        expected = clozeAnswers(fields[name] ?? '', opts.clozeN).map((t) => stripHtml(t).trim()).join(', ');
      }
      return opts.showAnswer
        ? `<span data-type-compare data-expected="${encodeURIComponent(expected)}"></span>`
        : `<input type="text" class="typeans" data-typeans autocomplete="off" autocapitalize="off" spellcheck="false">`;
    }
    return applyFilters(fields[name] ?? '', mods, name);
  });
}

/** The answer texts of the active cloze ordinal (for `{{type:cloze:…}}`). */
function clozeAnswers(value: string, activeN: number): string[] {
  const out: string[] = [];
  value.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (m, n: string, text: string) => {
    if (Number(n) === activeN) out.push(text);
    return m;
  });
  return out;
}

/**
 * Process Anki cloze markers `{{cN::answer::hint}}` for the active cloze ordinal. On the question
 * side the active cloze is hidden as `[hint]`/`[...]`; other clozes show their answer. On the answer
 * side the active cloze is revealed and highlighted.
 */
function processCloze(value: string, activeN: number, showAnswer: boolean): string {
  return value.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_m, n: string, text: string, hint?: string) => {
    if (Number(n) !== activeN) return text; // other clozes are revealed as plain text
    if (showAnswer) return `<span class="cloze">${text}</span>`;
    return `<span class="cloze">[${hint && hint.trim() ? hint : '...'}]</span>`;
  });
}

/** Anki-style typed-answer comparison: shared prefix/suffix good, differing middle bad/missed. */
function typeDiffHtml(typed: string, expected: string): string {
  if (!typed) return `<code class="typeans"><span class="typeMissed">${escapeHtml(expected)}</span></code>`;
  if (typed === expected) return `<code class="typeans"><span class="typeGood">${escapeHtml(typed)}</span></code>`;
  let p = 0;
  while (p < typed.length && p < expected.length && typed[p] === expected[p]) p++;
  let s = 0;
  while (s < typed.length - p && s < expected.length - p && typed[typed.length - 1 - s] === expected[expected.length - 1 - s]) s++;
  const span = (cls: string, t: string) => (t ? `<span class="${cls}">${escapeHtml(t)}</span>` : '');
  const typedRow = span('typeGood', typed.slice(0, p)) + span('typeBad', typed.slice(p, typed.length - s) || '-') + span('typeGood', s ? typed.slice(typed.length - s) : '');
  const expectedRow =
    span('typeGood', expected.slice(0, p)) + span('typeMissed', expected.slice(p, expected.length - s)) + span('typeGood', s ? expected.slice(expected.length - s) : '');
  return `<code class="typeans">${typedRow}<br><span class="typearrow">⇩</span><br>${expectedRow}</code>`;
}

interface RenderOpts {
  frontSide?: string;
  clozeN: number;
  showAnswer: boolean;
}

function renderSide(tmpl: string, fields: Record<string, string>, opts: RenderOpts): string {
  let html = applyConditionals(tmpl, fields);
  // The FrontSide copy is marked (display:contents, so it can't disturb the deck's own layout) so
  // answer-side autoplay can skip audio the user already heard on the question — as Anki does.
  if (opts.frontSide != null) {
    html = html.replace(/\{\{FrontSide\}\}/g, `<span data-frontside style="display:contents">${opts.frontSide}</span>`);
  }
  // Cloze fields are processed before generic substitution so their {{cN::…}} markers aren't mangled.
  html = html.replace(/\{\{cloze:([^}]+)\}\}/g, (_m, f: string) => {
    const name = f.split(':').pop()!.trim();
    return processCloze(fields[name] ?? '', opts.clozeN, opts.showAnswer);
  });
  return substFields(html, fields, opts);
}

/** Minimal defaults so a card still reads even with no model CSS; the model CSS follows and wins. */
const BASE_CSS = `
  :host { display: block; }
  .card { font-family: var(--jp-mincho), serif; font-size: 21px; line-height: 1.7; color: var(--ink); text-align: center; }
  .nightMode .card, .night_mode .card { color: var(--ink); }
  img { max-width: 100%; height: auto; }
  a { color: var(--accent); }
  hr { border: none; border-top: 1px solid var(--rule); margin: 16px 0; }
  .cloze { color: var(--accent); font-weight: 600; }
  rt { font-size: 0.5em; }
  a.hint { font-size: 0.8em; }
  input.typeans { font: inherit; text-align: center; width: 100%; max-width: 360px; padding: 6px 10px;
    border: 1px solid var(--rule-strong); border-radius: 8px; background: var(--paper-raised); color: var(--ink); }
  code.typeans { font-family: var(--mono); font-size: 0.8em; }
  .typeGood { background: #afa; color: #000; }
  .typeBad { background: #faa; color: #000; }
  .typeMissed { background: #ccc; color: #000; }
  .nightMode .typeGood, .night_mode .typeGood { background: #570; color: #fff; }
  .nightMode .typeBad, .night_mode .typeBad { background: #730; color: #fff; }
  .nightMode .typeMissed, .night_mode .typeMissed { background: #555; color: #fff; }
  .anki-audio { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px;
    border-radius: 999px; background: color-mix(in oklch, var(--accent) 14%, transparent); color: var(--accent);
    cursor: pointer; font-size: 15px; margin: 6px; user-select: none; }
  .anki-audio.playing { background: color-mix(in oklch, var(--accent) 32%, transparent); }
  .anki-audio.missing { background: color-mix(in oklch, var(--ink-faint) 14%, transparent); color: var(--ink-faint);
    cursor: default; }
`;

/**
 * Playback for a card's `[sound:…]` refs. Anki plays the question's audio when the question is
 * shown and the answer's own audio on reveal, in document order, one after another; a click on any
 * speaker replays just that clip. Only one clip is ever audible at a time.
 */
class AudioPlayer {
  private el: HTMLAudioElement | null = null;
  /** Bumped on every new play/stop so a slow `resolveMedia` can't start a clip that was superseded. */
  private gen = 0;

  stop(): void {
    this.gen++;
    this.el?.pause();
    this.el = null;
  }

  /** Play tokens in order, stopping early if anything else takes over playback. */
  async playSequence(tokens: string[], userId: string): Promise<void> {
    this.stop();
    const gen = this.gen;
    for (const token of tokens) {
      const url = await resolveMedia(token, userId);
      if (gen !== this.gen) return;
      if (!url) continue;
      const el = new Audio(url);
      this.el = el;
      try {
        await el.play();
      } catch {
        return; // autoplay blocked, or the clip is undecodable — don't stall the rest of the card
      }
      const ended = await new Promise<boolean>((resolve) => {
        el.onended = () => resolve(true);
        el.onerror = () => resolve(false);
        el.onpause = () => resolve(false);
      });
      if (gen !== this.gen || !ended) return;
    }
  }
}

/** Context for Anki's special fields. */
export interface CardMeta {
  tags?: string;
  deckName?: string;
  noteTypeName?: string;
  templateName?: string;
}

interface Props {
  front: string;
  back: string;
  fields: Record<string, string>;
  css: string;
  /** Card template/cloze ordinal (Anki `ord`); the active cloze is `ord + 1`. */
  ord: number;
  shown: boolean;
  userId: string;
  meta?: CardMeta;
}

/**
 * Replay the audio the current card just auto-played (Anki's "R"). Registered by the mounted
 * CardTemplate; a no-op when the card has no audio or none is mounted.
 */
export let replayCardAudio: () => void = () => {};

export function CardTemplate({ front, back, fields, css, ord, shown, userId, meta }: Props) {
  const dark = usePrefs((s) => s.dark);
  const autoplayAudio = usePrefs((s) => s.autoplayAudio);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  /** What the user typed into a {{type:…}} box on the question side, kept across the reveal. */
  const typedRef = useRef('');
  const playerRef = useRef<AudioPlayer | null>(null);
  const replayRef = useRef<() => void>(() => {});
  // Read through a ref: toggling autoplay in Settings shouldn't re-render the card and replay it.
  const autoplayRef = useRef(autoplayAudio);
  autoplayRef.current = autoplayAudio;
  useEffect(() => {
    replayCardAudio = () => replayRef.current();
    return () => {
      replayCardAudio = () => {};
    };
  }, []);

  const html = useMemo(() => {
    const deck = meta?.deckName ?? '';
    const allFields: Record<string, string> = {
      ...fields,
      Tags: meta?.tags ?? '',
      Type: meta?.noteTypeName ?? '',
      Deck: deck,
      Subdeck: deck.includes('::') ? deck.slice(deck.lastIndexOf('::') + 2) : deck,
      Card: meta?.templateName ?? '',
      CardFlag: '',
    };
    const clozeN = ord + 1;
    const frontHtml = renderSide(front, allFields, { clozeN, showAnswer: false });
    return shown ? renderSide(back, allFields, { frontSide: frontHtml, clozeN, showAnswer: true }) : frontHtml;
  }, [front, back, fields, ord, shown, meta]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!shadowRef.current) shadowRef.current = host.attachShadow({ mode: 'open' });
    const root = shadowRef.current;
    const nm = dark ? ' nightMode night_mode' : '';
    root.innerHTML = `<style>${BASE_CSS}${css || ''}</style><div class="${nm.trim()}"><div class="card">${html}</div></div>`;

    let alive = true;
    const player = (playerRef.current ??= new AudioPlayer());
    player.stop(); // a card change (or a reveal) supersedes whatever was playing
    root.querySelectorAll<HTMLElement>('[data-media]').forEach((node) => {
      const token = node.getAttribute('data-media');
      if (!token) return;
      void resolveMedia(token, userId).then((url) => {
        if (url && alive && node.tagName === 'IMG') (node as HTMLImageElement).src = url;
      });
    });
    const audioNodes = Array.from(root.querySelectorAll<HTMLElement>('[data-audio]')).filter((n) =>
      n.getAttribute('data-audio'),
    );
    for (const node of audioNodes) {
      const token = node.getAttribute('data-audio')!;
      node.classList.add('anki-audio');
      node.textContent = '►';
      node.title = 'Play audio';
      // Mark refs whose blob isn't available (never imported, or offline before first download) so a
      // dead speaker button reads as dead instead of silently doing nothing when clicked.
      void resolveMedia(token, userId).then((url) => {
        if (!url && alive) {
          node.classList.add('missing');
          node.title = 'Audio unavailable — reimport this deck, or go online once to fetch it';
        }
      });
      node.onclick = (e) => {
        e.stopPropagation(); // don't let a replay also reveal the answer
        void player.playSequence([token], userId);
      };
    }
    // Anki's autoplay: the question's clips on the question, the answer's own clips on reveal
    // (anything inside the {{FrontSide}} copy was already heard).
    const autoNodes = shown ? audioNodes.filter((n) => !n.closest('[data-frontside]')) : audioNodes;
    const autoTokens = autoNodes.map((n) => n.getAttribute('data-audio')!);
    replayRef.current = () => void player.playSequence(autoTokens, userId);
    if (autoplayRef.current && autoTokens.length) replayRef.current();
    // {{hint:…}}: clicking the field-name link reveals the hidden content (like Anki).
    root.querySelectorAll<HTMLAnchorElement>('a[data-hint]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        a.style.display = 'none';
        const content = a.nextElementSibling as HTMLElement | null;
        if (content) content.style.display = 'block';
      };
    });
    // {{type:…}}: capture typing on the question; render the comparison on the answer.
    const typeInput = root.querySelector<HTMLInputElement>('input[data-typeans]');
    if (typeInput) {
      typedRef.current = '';
      typeInput.oninput = () => {
        typedRef.current = typeInput.value;
      };
      typeInput.focus();
    }
    const compare = root.querySelector<HTMLElement>('[data-type-compare]');
    if (compare) {
      compare.innerHTML = typeDiffHtml(typedRef.current.trim(), decodeURIComponent(compare.getAttribute('data-expected') ?? ''));
    }
    return () => {
      alive = false;
      player.stop();
    };
  }, [html, css, dark, userId, shown]);

  return <div className="card-shadow-host" ref={hostRef} lang="ja" />;
}
