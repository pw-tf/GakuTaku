import { useEffect, useRef } from 'react';
import { mediaDataUrl } from '../media/store';

/**
 * Shows one side of a card exactly as Anki's reviewer would: Anki's base reviewer styles, the note
 * type's own CSS, `<body class="card cardN">` (plus `nightMode` in dark mode), and the deck's own
 * scripts, inside a sandboxed frame, so a deck's JavaScript runs but can't reach the app or its
 * data. Local media (images, and fonts/images referenced from the deck's CSS) are inlined. Taps,
 * swipes, key presses, audio buttons and typed answers are reported to the app through
 * `postMessage`.
 *
 * Like Anki's reviewer, the frame's document is loaded once and each card side is swapped into
 * `#qa` in place. Reloading the whole document for every reveal and every card made reviewing feel
 * sluggish on phones.
 */

export type CardEvent =
  | { type: 'tap'; x: number; y: number; w: number; h: number }
  | { type: 'swipe'; dir: 'left' | 'right' | 'up' | 'down' }
  | { type: 'key'; key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }
  | { type: 'play'; ref: string }
  | { type: 'typed'; value: string; enter: boolean }
  | { type: 'pycmd'; cmd: string };

/** Frame-internal: the shell document has loaded and can take card content. */
type ReadyEvent = { type: 'ready' };

interface Props {
  html: string;
  css: string;
  ord: number;
  dark: boolean;
  onEvent: (e: CardEvent) => void;
  /** Bumps when the same side should re-render (e.g. after editing the note). */
  version?: number;
  /** Which side `html` is (the answer scrolls to `#answer`, as in Anki). */
  side?: 'q' | 'a';
  /** Card text size (1 = 100%). */
  zoom?: number;
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
.replay-button svg { width: 34px; height: 34px; }
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
  // A card side arrives from the app: swap it in, then run its scripts as Anki's reviewer does.
  window.addEventListener('message', function(e){
    var d = e.data;
    if (e.source !== parent || !d || d.__gakutakuRender !== 1) return;
    document.documentElement.className = d.htmlClass;
    document.documentElement.style.zoom = d.zoom && d.zoom !== 1 ? String(d.zoom) : '';
    document.body.className = d.bodyClass;
    var css = document.getElementById('note-css');
    if (css.textContent !== d.css) css.textContent = d.css;
    var qa = document.getElementById('qa');
    qa.innerHTML = d.html;
    Array.prototype.forEach.call(qa.querySelectorAll('script'), function(old){
      var s = document.createElement('script');
      for (var i = 0; i < old.attributes.length; i++) s.setAttribute(old.attributes[i].name, old.attributes[i].value);
      s.text = old.text;
      old.parentNode.replaceChild(s, old);
    });
    var answer = d.side === 'a' && document.getElementById('answer');
    if (answer) answer.scrollIntoView(); else window.scrollTo(0, 0);
    var ta = document.getElementById('typeans'); if (ta && ta.tagName === 'INPUT') ta.focus();
  });
  post({type:'ready'});
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

/**
 * Data URLs of recently shown media. The answer side repeats the question's images, and cards come
 * round again, so encoding each file once saves a database read and a base64 pass per render.
 */
const dataUrlCache = new Map<string, string | null>();
let dataUrlCacheChars = 0;
const DATA_URL_CACHE_CHARS = 40_000_000;

async function cachedDataUrl(name: string): Promise<string | null> {
  if (dataUrlCache.has(name)) {
    const hit = dataUrlCache.get(name)!;
    dataUrlCache.delete(name);
    dataUrlCache.set(name, hit); // most recently used last
    return hit;
  }
  const url = await mediaDataUrl(name);
  dataUrlCache.set(name, url);
  dataUrlCacheChars += url?.length ?? 0;
  for (const [k, v] of dataUrlCache) {
    if (dataUrlCacheChars <= DATA_URL_CACHE_CHARS) break;
    dataUrlCache.delete(k);
    dataUrlCacheChars -= v?.length ?? 0;
  }
  return url;
}

/** Replace references to local media files with data: URLs. */
async function inlineMedia(text: string, re: RegExp, pick: (m: RegExpExecArray) => string, rebuild: (m: RegExpExecArray, url: string) => string): Promise<string> {
  const matches = [...text.matchAll(re)] as RegExpExecArray[];
  if (!matches.length) return text;
  const urls = new Map<string, string | null>();
  await Promise.all(
    [...new Set(matches.map(pick).filter(isLocalRef))].map(async (ref) => urls.set(ref, await cachedDataUrl(decodeName(ref)))),
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

/** The frame's document, loaded once; card sides are posted into it. */
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style><style id="note-css"></style></head>
<body class="card"><div id="qa"></div><script>${BRIDGE}</script></body></html>`;

interface Content {
  html: string;
  css: string;
  bodyClass: string;
  htmlClass: string;
  side: 'q' | 'a';
  zoom: number;
}

async function buildContent(html: string, css: string, ord: number, dark: boolean, side: 'q' | 'a', zoom: number): Promise<Content> {
  const [body, noteCss] = await Promise.all([
    inlineMedia(html, LOCAL_SRC, (m) => m[3], (m, url) => `${m[1]}${m[2]}${url}${m[2]}`),
    inlineMedia(css, CSS_URL, (m) => m[2], (_m, url) => `url("${url}")`),
  ]);
  return {
    html: body,
    css: noteCss,
    bodyClass: `card card${ord + 1}${dark ? ' nightMode night_mode' : ''} mobile android`,
    htmlClass: dark ? 'night-mode' : '',
    side,
    zoom,
  };
}

export function CardView({ html, css, ord, dark, onEvent, version = 0, side = 'q', zoom = 1 }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const pending = useRef<Content | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const send = (c: Content) => {
    const win = ref.current?.contentWindow;
    if (!ready.current || !win) {
      pending.current = c;
      return;
    }
    win.postMessage({ __gakutakuRender: 1, ...c }, '*');
  };

  useEffect(() => {
    let alive = true;
    void buildContent(html, css, ord, dark, side, zoom).then((c) => alive && send(c));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, css, ord, dark, version, side, zoom]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== ref.current?.contentWindow) return;
      const data = e.data as ((CardEvent | ReadyEvent) & { __gakutaku?: number }) | null;
      if (!data || data.__gakutaku !== 1) return;
      if (data.type === 'ready') {
        ready.current = true;
        if (pending.current) send(pending.current);
        pending.current = null;
        return;
      }
      onEventRef.current(data);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <iframe ref={ref} className="card-frame" title="Card" sandbox="allow-scripts" srcDoc={SHELL} />;
}
