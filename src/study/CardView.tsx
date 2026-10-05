import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaDataUrl } from '../media/store';

/**
 * Shows one side of a card exactly as Anki's reviewer would: a full HTML document with Anki's base
 * reviewer styles, the note type's own CSS, `<body class="card cardN">` (plus `nightMode` in dark
 * mode), and the deck's own scripts — inside a sandboxed frame, so a deck's JavaScript runs but
 * can't reach the app or its data. Local media (images, and fonts/images referenced from the
 * deck's CSS) are inlined. Taps, swipes, key presses, audio buttons and typed answers are reported
 * to the app through `postMessage`.
 */

export type CardEvent =
  | { type: 'tap'; x: number; y: number; w: number; h: number }
  | { type: 'swipe'; dir: 'left' | 'right' | 'up' | 'down' }
  | { type: 'key'; key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }
  | { type: 'play'; ref: string }
  | { type: 'typed'; value: string; enter: boolean }
  | { type: 'pycmd'; cmd: string };

interface Props {
  html: string;
  css: string;
  ord: number;
  dark: boolean;
  onEvent: (e: CardEvent) => void;
  /** Bumps when the same side should re-render (e.g. after editing the note). */
  version?: number;
}

/** Anki's ts/reviewer/reviewer.scss essentials + its palette variables, so deck CSS behaves the same. */
const BASE_CSS = `
:root { --canvas: #ffffff; --fg: #020202; --canvas-elevated: #ffffff; --border: #c4c4c4; }
.nightMode { --canvas: #2c2c2c; --fg: #fcfcfc; --canvas-elevated: #363636; --border: #555; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 20px; overflow-wrap: break-word; background-color: var(--canvas); color: var(--fg);
  font-family: "Zen Kaku Gothic New", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
body.nightMode { background-color: var(--canvas); color: var(--fg); }
hr { background-color: #d0d0d0; margin: 1em 0; border: none; height: 1px; }
.nightMode hr { background-color: #555; }
img { max-width: 100%; max-height: 95vh; }
li { text-align: start; }
pre { text-align: left; }
#typeans { width: 100%; box-sizing: border-box; line-height: 1.75; font: inherit; padding: 4px 8px; }
code#typeans { white-space: pre-wrap; font-variant-ligatures: none; display: block; }
.typeGood { background: #afa; color: black; }
.typeBad { color: black; background: #faa; }
.typeMissed { color: black; background: #ccc; }
.replay-button { text-decoration: none; display: inline-flex; vertical-align: middle; margin: 3px; }
.replay-button svg { width: 40px; height: 40px; }
.replay-button svg circle { fill: #fff; stroke: #414141; }
.replay-button svg path { fill: #414141; }
.nightMode .replay-button svg circle { fill: #3a3a3a; stroke: #aaa; }
.nightMode .replay-button svg path { fill: #ddd; }
.cloze { font-weight: bold; color: blue; }
.nightMode .cloze { color: lightblue; }
.hint { color: inherit; }
.template-error { color: #c33; font-size: 15px; text-align: left; }
`;

/** Runs inside the card frame. Kept small and dependency-free. */
const BRIDGE = `
(function(){
  var post = function(m){ parent.postMessage(Object.assign({__gakutaku: 1}, m), '*'); };
  window.pycmd = function(cmd){ post({type:'pycmd', cmd: String(cmd)}); return false; };
  window.bridgeCommand = window.pycmd;
  document.addEventListener('click', function(e){
    var t = e.target;
    var play = t.closest && t.closest('[data-play]');
    if (play) { e.preventDefault(); post({type:'play', ref: play.getAttribute('data-play')}); return; }
    if (t.closest && t.closest('a,button,input,textarea,select,label,summary,[onclick]')) return;
    var sel = window.getSelection && String(window.getSelection());
    if (sel) return;
    post({type:'tap', x: e.clientX, y: e.clientY, w: innerWidth, h: innerHeight});
  }, true);
  var sx = 0, sy = 0, st = 0;
  document.addEventListener('touchstart', function(e){ var p = e.touches[0]; sx = p.clientX; sy = p.clientY; st = Date.now(); }, {passive: true});
  document.addEventListener('touchend', function(e){
    var p = e.changedTouches[0]; var dx = p.clientX - sx, dy = p.clientY - sy;
    if (Date.now() - st > 600) return;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) post({type:'swipe', dir: dx > 0 ? 'right' : 'left'});
    else if (Math.abs(dy) > 90 && Math.abs(dy) > Math.abs(dx) * 1.5 && (document.scrollingElement.scrollHeight <= innerHeight + 2)) post({type:'swipe', dir: dy > 0 ? 'down' : 'up'});
  }, {passive: true});
  document.addEventListener('keydown', function(e){
    var t = e.target;
    if (t && t.id === 'typeans') {
      if (e.key === 'Enter') { e.preventDefault(); post({type:'typed', value: t.value, enter: true}); }
      return;
    }
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    post({type:'key', key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey});
    if (e.key === ' ') e.preventDefault();
  });
  document.addEventListener('input', function(e){ if (e.target && e.target.id === 'typeans') post({type:'typed', value: e.target.value, enter: false}); });
  var ta = document.getElementById('typeans'); if (ta && ta.tagName === 'INPUT') setTimeout(function(){ ta.focus(); }, 50);
})();
`;

const LOCAL_SRC = /(<(?:img|source|video|audio)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

function isLocalRef(ref: string): boolean {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.trim());
}

function decodeName(ref: string): string {
  try {
    return decodeURIComponent(ref.trim());
  } catch {
    return ref.trim();
  }
}

/** Replace references to local media files with data: URLs. */
async function inlineMedia(text: string, re: RegExp, pick: (m: RegExpExecArray) => string, rebuild: (m: RegExpExecArray, url: string) => string): Promise<string> {
  const matches = [...text.matchAll(re)] as RegExpExecArray[];
  if (!matches.length) return text;
  const urls = new Map<string, string | null>();
  await Promise.all(
    [...new Set(matches.map(pick).filter(isLocalRef))].map(async (ref) => urls.set(ref, await mediaDataUrl(decodeName(ref)))),
  );
  let out = '';
  let last = 0;
  for (const m of matches) {
    const url = urls.get(pick(m));
    out += text.slice(last, m.index) + (url ? rebuild(m, url) : m[0]);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

async function buildDocument(html: string, css: string, ord: number, dark: boolean): Promise<string> {
  const body = await inlineMedia(html, LOCAL_SRC, (m) => m[3], (m, url) => `${m[1]}${m[2]}${url}${m[2]}`);
  const noteCss = await inlineMedia(css, CSS_URL, (m) => m[2], (_m, url) => `url("${url}")`);
  const bodyClass = `card card${ord + 1}${dark ? ' nightMode night_mode' : ''} mobile android`;
  return `<!doctype html><html class="${dark ? 'night-mode' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style><style>${noteCss}</style></head>
<body class="${bodyClass}"><div id="qa">${body}</div><script>${BRIDGE}</script></body></html>`;
}

export function CardView({ html, css, ord, dark, onEvent, version = 0 }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const key = useMemo(() => `${ord}|${dark}|${version}|${css.length}|${html}`, [html, css, ord, dark, version]);
  useEffect(() => {
    let alive = true;
    void buildDocument(html, css, ord, dark).then((d) => alive && setDoc(d));
    return () => {
      alive = false;
    };
    // `key` covers html/css/ord/dark/version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== ref.current?.contentWindow) return;
      const data = e.data as (CardEvent & { __gakutaku?: number }) | null;
      if (!data || data.__gakutaku !== 1) return;
      onEventRef.current(data);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={ref}
      className="card-frame"
      title="Card"
      sandbox="allow-scripts"
      srcDoc={doc ?? ''}
      style={{ visibility: doc ? 'visible' : 'hidden' }}
    />
  );
}
