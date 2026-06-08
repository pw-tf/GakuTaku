import { useEffect, useMemo, useRef } from 'react';
import { usePrefs } from '../app/prefs';
import { resolveMedia } from '../import/media';

/**
 * Render an imported Anki card faithfully (SRS redesign). Anki templates are HTML with `{{Field}}`
 * substitution, `{{FrontSide}}`, `{{#Field}}…{{/Field}}` / `{{^Field}}…{{/Field}}` conditionals, and
 * `{{cloze:Field}}` deletions. We render the result **inside a Shadow DOM** together with the note
 * type's own CSS, so each deck looks as its author intended — including which word is emphasised —
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

/** Replace `{{Field}}` (stripping modifiers like `text:`/`furigana:`) with field values. */
function substFields(tmpl: string, fields: Record<string, string>): string {
  return tmpl.replace(/\{\{([^}#^/][^}]*)\}\}/g, (_m, raw: string) => {
    let name = raw.trim();
    const colon = name.lastIndexOf(':');
    if (colon >= 0) name = name.slice(colon + 1).trim();
    return fields[name] ?? '';
  });
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

interface RenderOpts {
  frontSide?: string;
  clozeN: number;
  showAnswer: boolean;
}

function renderSide(tmpl: string, fields: Record<string, string>, opts: RenderOpts): string {
  let html = applyConditionals(tmpl, fields);
  if (opts.frontSide != null) html = html.replace(/\{\{FrontSide\}\}/g, opts.frontSide);
  // Cloze fields are processed before generic substitution so their {{cN::…}} markers aren't mangled.
  html = html.replace(/\{\{cloze:([^}]+)\}\}/g, (_m, f: string) =>
    processCloze(fields[f.trim()] ?? '', opts.clozeN, opts.showAnswer),
  );
  return substFields(html, fields);
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
  .anki-audio { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px;
    border-radius: 999px; background: color-mix(in oklch, var(--accent) 14%, transparent); color: var(--accent);
    cursor: pointer; font-size: 15px; margin: 6px; user-select: none; }
`;

interface Props {
  front: string;
  back: string;
  fields: Record<string, string>;
  css: string;
  /** Card template/cloze ordinal (Anki `ord`); the active cloze is `ord + 1`. */
  ord: number;
  shown: boolean;
  userId: string;
}

export function CardTemplate({ front, back, fields, css, ord, shown, userId }: Props) {
  const dark = usePrefs((s) => s.dark);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  const html = useMemo(() => {
    const clozeN = ord + 1;
    const frontHtml = renderSide(front, fields, { clozeN, showAnswer: false });
    return shown ? renderSide(back, fields, { frontSide: frontHtml, clozeN, showAnswer: true }) : frontHtml;
  }, [front, back, fields, ord, shown]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!shadowRef.current) shadowRef.current = host.attachShadow({ mode: 'open' });
    const root = shadowRef.current;
    const nm = dark ? ' nightMode night_mode' : '';
    root.innerHTML = `<style>${BASE_CSS}${css || ''}</style><div class="${nm.trim()}"><div class="card">${html}</div></div>`;

    let alive = true;
    root.querySelectorAll<HTMLElement>('[data-media]').forEach((node) => {
      const token = node.getAttribute('data-media');
      if (!token) return;
      void resolveMedia(token, userId).then((url) => {
        if (url && alive && node.tagName === 'IMG') (node as HTMLImageElement).src = url;
      });
    });
    root.querySelectorAll<HTMLElement>('[data-audio]').forEach((node) => {
      const token = node.getAttribute('data-audio');
      if (!token) return;
      node.classList.add('anki-audio');
      node.textContent = '►';
      node.onclick = async () => {
        const url = await resolveMedia(token, userId);
        if (url) void new Audio(url).play().catch(() => {});
      };
    });
    return () => { alive = false; };
  }, [html, css, dark, userId]);

  return <div className="card-shadow-host" ref={hostRef} lang="ja" />;
}
