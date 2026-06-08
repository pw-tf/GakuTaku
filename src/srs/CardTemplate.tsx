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
    if (!shown) return frontHtml;
    // On the answer side, wrap the repeated question (`{{FrontSide}}`) so it can be highlighted as
    // the word under review, distinct from the answer body below it.
    return renderSide(back, fields, `<div class="ct-q">${frontHtml}</div>`);
  }, [front, back, fields, shown]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;

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
  }, [html, userId]);

  return (
    <div
      className={'card-html' + (shown ? '' : ' is-front')}
      ref={ref}
      lang="ja"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
