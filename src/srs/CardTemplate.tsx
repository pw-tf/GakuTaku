import { useEffect, useMemo, useRef } from 'react';
import { resolveMedia } from '../import/media';

/**
 * Render an imported Anki card (build plan M6). Anki templates are HTML with `{{Field}}`
 * substitution, `{{FrontSide}}` (the rendered question, reused on the answer), and
 * `{{#Field}}…{{/Field}}` / `{{^Field}}…{{/Field}}` conditionals. We support those; cloze and
 * template JS are out of scope. Media refs were rewritten at import time to `data-media`/`data-audio`
 * tokens, which we resolve to object URLs from the offline cache (or Storage) after the HTML mounts.
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

/** Replace `{{Field}}` (stripping modifiers like `text:`/`furigana:`/`cloze:`) with field values. */
function substFields(tmpl: string, fields: Record<string, string>): string {
  return tmpl.replace(/\{\{([^}#^/][^}]*)\}\}/g, (_m, raw: string) => {
    let name = raw.trim();
    const colon = name.lastIndexOf(':');
    if (colon >= 0) name = name.slice(colon + 1).trim();
    return fields[name] ?? '';
  });
}

function renderSide(tmpl: string, fields: Record<string, string>, frontSide?: string): string {
  let html = applyConditionals(tmpl, fields);
  if (frontSide != null) html = html.replace(/\{\{FrontSide\}\}/g, frontSide);
  return substFields(html, fields);
}

/** Plain text of a field value (drop tags, media tokens, furigana brackets) for word matching. */
function plain(s: string): string {
  return s
    .replace(/\[sound:[^\]]*\]/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]/g, '') // furigana readings like 人[ひと]
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TARGET_NAME = /(word|vocab|term|target|focus|kanji|expression|単語|言葉|表現)/i;
const CONTEXT_NAME = /(sentence|context|example|reading|meaning|definition|translat|note|例文|文)/i;

/**
 * Identify the single word under review on a sentence/context card: the short field whose value
 * appears *inside* a longer field (the example sentence). Used to highlight only that word in the
 * accent colour, rather than the whole card. Returns null when nothing matches (then nothing is
 * highlighted — better than colouring the entire sentence).
 */
function pickWord(fields: Record<string, string>): string | null {
  const entries = Object.entries(fields)
    .map(([name, v]) => ({ name, val: plain(v) }))
    .filter((e) => e.val.length > 0);
  let best: { val: string; score: number } | null = null;
  for (const e of entries) {
    if (e.val.length > 24) continue; // a word/phrase, not a sentence
    const insideLonger = entries.some((o) => o.val.length > e.val.length && o.val.includes(e.val));
    if (!insideLonger) continue;
    const score = (TARGET_NAME.test(e.name) ? 2 : 0) - (CONTEXT_NAME.test(e.name) ? 2 : 0) - e.val.length * 0.01;
    if (!best || score > best.score) best = { val: e.val, score };
  }
  return best?.val ?? null;
}

/** Wrap every occurrence of `word` in the element's text nodes with an accent span. DOM-safe (never
 *  touches tags/attributes), idempotent (skips text already inside a highlight). */
function highlightWord(root: HTMLElement, word: string): void {
  if (word.length < 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.parentElement?.closest('.ct-word')) continue;
    if (t.textContent && t.textContent.includes(word)) targets.push(t);
  }
  for (const t of targets) {
    const parts = (t.textContent ?? '').split(word);
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (i > 0) {
        const span = document.createElement('span');
        span.className = 'ct-word';
        span.textContent = word;
        frag.appendChild(span);
      }
      if (p) frag.appendChild(document.createTextNode(p));
    });
    t.replaceWith(frag);
  }
}

interface Props {
  front: string;
  back: string;
  fields: Record<string, string>;
  shown: boolean;
  userId: string;
}

export function CardTemplate({ front, back, fields, shown, userId }: Props) {
  const html = useMemo(() => {
    const frontHtml = renderSide(front, fields);
    return shown ? renderSide(back, fields, frontHtml) : frontHtml;
  }, [front, back, fields, shown]);

  const word = useMemo(() => pickWord(fields), [fields]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;

    if (word) highlightWord(el, word);

    el.querySelectorAll<HTMLElement>('[data-media]').forEach((node) => {
      const token = node.getAttribute('data-media');
      if (!token) return;
      void resolveMedia(token, userId).then((url) => {
        if (url && alive && node.tagName === 'IMG') (node as HTMLImageElement).src = url;
      });
    });

    el.querySelectorAll<HTMLElement>('[data-audio]').forEach((node) => {
      const token = node.getAttribute('data-audio');
      if (!token) return;
      node.classList.add('ready');
      node.textContent = '►';
      node.onclick = async () => {
        const url = await resolveMedia(token, userId);
        if (url) void new Audio(url).play().catch(() => {});
      };
    });

    return () => { alive = false; };
  }, [html, userId, word]);

  return (
    <div
      className={'card-html' + (shown ? '' : ' is-front')}
      ref={ref}
      lang="ja"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
