import { fieldMap, type Notetype } from './notetype';

/**
 * Anki's card template engine — a port of rslib/src/template.rs (tokenizer, parser, conditionals,
 * empty-front detection), rslib/src/template_filters.rs (text, furigana/kana/kanji, hint, type,
 * cloze, cloze-only, tts) and rslib/src/cloze.rs (nested clozes, hints, ordinals), plus the AV-tag
 * extraction Anki's Python layer does after rendering (pylib/anki/template.py `render`).
 *
 * The output is the same HTML Anki puts in its reviewer, so a deck's own CSS applies to it
 * unchanged.
 */

// ---- Lexing / parsing (template.rs) ------------------------------------------------------

type Node =
  | { t: 'text'; text: string }
  | { t: 'comment'; text: string }
  | { t: 'rep'; key: string; filters: string[] }
  | { t: 'cond'; key: string; children: Node[] }
  | { t: 'neg'; key: string; children: Node[] };

type Token = { t: 'text' | 'comment' | 'rep' | 'open' | 'openNeg' | 'close'; v: string };

const ALT_DIRECTIVE = '{{=<% %>=}}';

function classify(inner: string): Token {
  const start = inner.replace(/^\{+/, '').trim();
  if (start.length < 2) return { t: 'rep', v: start };
  if (start.startsWith('#')) return { t: 'open', v: start.slice(1).trimStart() };
  if (start.startsWith('/')) return { t: 'close', v: start.slice(1).trimStart() };
  if (start.startsWith('^')) return { t: 'openNeg', v: start.slice(1).trimStart() };
  return { t: 'rep', v: start };
}

function* tokens(template: string): Generator<Token> {
  let open = '{{';
  let close = '}}';
  if (template.trimStart().startsWith(ALT_DIRECTIVE)) {
    template = template.trimStart().slice(ALT_DIRECTIVE.length);
    open = '<%';
    close = '%>';
  }
  let rest = template;
  while (rest.length) {
    let found = -1;
    let tok: Token | null = null;
    let consumed = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest.startsWith(open, i)) {
        const end = rest.indexOf(close, i + open.length);
        if (end >= 0) {
          found = i;
          tok = classify(rest.slice(i + open.length, end));
          consumed = end + close.length;
          break;
        }
      }
      if (rest.startsWith('<!--', i)) {
        const end = rest.indexOf('-->', i + 4);
        if (end >= 0) {
          found = i;
          tok = { t: 'comment', v: rest.slice(i + 4, end) };
          consumed = end + 3;
          break;
        }
      }
    }
    if (found < 0) {
      yield { t: 'text', v: rest };
      return;
    }
    if (found > 0) yield { t: 'text', v: rest.slice(0, found) };
    yield tok!;
    rest = rest.slice(consumed);
  }
}

export class TemplateError extends Error {}

function parse(template: string): Node[] {
  const it = tokens(template);
  const inner = (openTag: string | null): Node[] => {
    const nodes: Node[] = [];
    for (let n = it.next(); !n.done; n = it.next()) {
      const tok = n.value;
      switch (tok.t) {
        case 'text':
          nodes.push({ t: 'text', text: tok.v });
          break;
        case 'comment':
          nodes.push({ t: 'comment', text: tok.v });
          break;
        case 'rep': {
          const parts = tok.v.split(':').reverse();
          nodes.push({ t: 'rep', key: parts[0], filters: parts.slice(1) });
          break;
        }
        case 'open':
          nodes.push({ t: 'cond', key: tok.v, children: inner(tok.v) });
          break;
        case 'openNeg':
          nodes.push({ t: 'neg', key: tok.v, children: inner(tok.v) });
          break;
        case 'close':
          if (openTag === tok.v) return nodes;
          throw new TemplateError(openTag ? `Found {{/${tok.v}}}, but expected {{/${openTag}}}` : `Found {{/${tok.v}}}, but missing {{#${tok.v}}} or {{^${tok.v}}}`);
      }
    }
    if (openTag) throw new TemplateError(`Missing {{/${openTag}}}`);
    return nodes;
  };
  return inner(null);
}

/** Anki `field_is_empty`: only whitespace and empty br/div tags. */
export function fieldIsEmpty(text: string): boolean {
  return /^(?:\s|<\/?(?:br|div) ?\/?>)*$/i.test(text);
}

function templateIsEmpty(nonEmpty: Set<string>, nodes: Node[]): boolean {
  for (const n of nodes) {
    switch (n.t) {
      case 'rep':
        if (nonEmpty.has(n.key)) return false;
        break;
      case 'cond':
        if (nonEmpty.has(n.key) && !templateIsEmpty(nonEmpty, n.children)) return false;
        break;
      case 'neg':
        if (!nonEmpty.has(n.key) && !templateIsEmpty(nonEmpty, n.children)) return false;
        break;
    }
  }
  return true;
}

/** True if `qfmt` renders something with these fields (Anki `renders_with_fields`). */
export function rendersWithFields(qfmt: string, fields: Record<string, string>): boolean {
  try {
    const nonEmpty = new Set(Object.entries(fields).filter(([, v]) => !fieldIsEmpty(v)).map(([k]) => k));
    return !templateIsEmpty(nonEmpty, parse(qfmt));
  } catch {
    return false;
  }
}

// ---- HTML helpers (text.rs) -------------------------------------------------------------

const HTML_RE = /<!--[\s\S]*?-->|<[\s\S]*?>/g;

export function stripHtmlPreservingEntities(html: string): string {
  return html.replace(HTML_RE, '');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(html: string): string {
  if (!html.includes('&')) return html;
  return html
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/ /g, ' ');
}

export const stripHtml = (html: string) => decodeEntities(stripHtmlPreservingEntities(html));

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- Cloze (cloze.rs) ---------------------------------------------------------------------

type ClozeTok = { t: 'open'; ords: number[] } | { t: 'text'; v: string } | { t: 'close' };
type TextOrCloze = { t: 'text'; v: string } | { t: 'cloze'; ords: number[]; nodes: TextOrCloze[]; hint: string | null };

const OPEN_CLOZE = /^\{\{c([\d,]+)::/;

function clozeTokens(text: string): ClozeTok[] {
  const out: ClozeTok[] = [];
  let mathClose: string | null = null;
  let mathId = 0;
  let nextId = 0;
  const regions: (number | null)[] = [];
  const region = () => (mathClose ? mathId : null);
  const canClose = () => region() == null || regions[regions.length - 1] === region();
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) out.push({ t: 'text', v: text.slice(textStart, end) });
  };
  while (i < text.length) {
    const rest = text.slice(i);
    const m = OPEN_CLOZE.exec(rest);
    const ords = m ? [...new Set(m[1].split(',').map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b) : [];
    if (m && ords.length) {
      flush(i);
      out.push({ t: 'open', ords });
      regions.push(region());
      i += m[0].length;
      textStart = i;
      continue;
    }
    if (rest.startsWith('}}') && canClose()) {
      flush(i);
      out.push({ t: 'close' });
      regions.pop();
      i += 2;
      textStart = i;
      continue;
    }
    // MathJax delimiters
    if (!mathClose) {
      let entered = false;
      for (const [o, c] of [['\\(', '\\)'], ['\\[', '\\]']] as const) {
        if (rest.startsWith(o) && rest.slice(o.length).includes(c)) {
          mathClose = c;
          mathId = nextId++;
          i += o.length;
          entered = true;
          break;
        }
      }
      if (entered) continue;
    } else if (rest.startsWith(mathClose)) {
      i += mathClose.length;
      mathClose = null;
      continue;
    }
    i += 1;
  }
  flush(text.length);
  return out;
}

function parseClozes(text: string): TextOrCloze[] {
  const open: { ords: number[]; nodes: TextOrCloze[]; hint: string | null }[] = [];
  const output: TextOrCloze[] = [];
  for (const tok of clozeTokens(text)) {
    if (tok.t === 'open') {
      if (open.length < 10) open.push({ ords: tok.ords, nodes: [], hint: null });
    } else if (tok.t === 'text') {
      const cur = open[open.length - 1];
      if (cur) {
        let v = tok.v;
        if (!v.startsWith('image-occlusion:')) {
          const idx = v.indexOf('::');
          if (idx >= 0) {
            cur.hint = v.slice(idx + 2);
            v = v.slice(0, idx);
          }
        }
        cur.nodes.push({ t: 'text', v });
      } else output.push({ t: 'text', v: tok.v });
    } else {
      const c = open.pop();
      if (c) {
        const target = open.length ? open[open.length - 1].nodes : output;
        target.push({ t: 'cloze', ...c });
      } else output.push({ t: 'text', v: '}}' });
    }
  }
  return output;
}

function clozedText(nodes: TextOrCloze[]): string {
  return nodes.map((n) => (n.t === 'text' ? n.v : clozedText(n.nodes))).join('');
}

function revealCloze(c: Extract<TextOrCloze, { t: 'cloze' }>, ord: number, question: boolean, found: { v: boolean }): string {
  const active = c.ords.includes(ord);
  found.v ||= active;
  const ordStr = c.ords.join(',');
  const inner = (q: boolean) => c.nodes.map((n) => (n.t === 'text' ? n.v : revealCloze(n, ord, q, found))).join('');
  const first = c.nodes[0];
  if (first?.t === 'text' && first.v.startsWith('image-occlusion:')) return ''; // image occlusion isn't supported
  if (question && active) {
    const content = inner(question);
    return `<span class="cloze" data-cloze="${escapeAttr(content)}" data-ordinal="${ordStr}">[${c.hint ?? '...'}]</span>`;
  }
  if (!question && active) return `<span class="cloze" data-ordinal="${ordStr}">${inner(question)}</span>`;
  return `<span class="cloze-inactive" data-ordinal="${ordStr}">${inner(question)}</span>`;
}

export function revealClozeText(text: string, ord: number, question: boolean): string {
  const found = { v: false };
  let buf = '';
  for (const n of parseClozes(text)) buf += n.t === 'text' ? n.v : revealCloze(n, ord, question, found);
  return found.v ? buf : '';
}

function revealClozeTextOnly(text: string, ord: number, question: boolean): string {
  const out: string[] = [];
  const walk = (n: TextOrCloze) => {
    if (n.t !== 'cloze') return;
    if (n.ords.includes(ord)) out.push(question ? n.hint ?? '...' : clozedText(n.nodes));
    n.nodes.forEach(walk);
  };
  parseClozes(text).forEach(walk);
  return out.join(', ');
}

/** The answer text for `{{type:cloze:Field}}` (Anki `extract_cloze_for_typing`). */
export function extractClozeForTyping(text: string, ord: number): string {
  const out: string[] = [];
  const walk = (n: TextOrCloze) => {
    if (n.t !== 'cloze') return;
    if (n.ords.includes(ord)) out.push(clozedText(n.nodes));
    n.nodes.forEach(walk);
  };
  parseClozes(text).forEach(walk);
  if (!out.length) return '';
  return out.every((x) => x === out[0]) ? out[0] : out.join(', ');
}

/** Cloze numbers (> 0) used in a field (Anki `cloze_numbers_in_string`). */
export function clozeNumbersInString(text: string): Set<number> {
  const set = new Set<number>();
  const walk = (nodes: TextOrCloze[]) => {
    for (const n of nodes) {
      if (n.t === 'cloze') {
        n.ords.forEach((o) => o !== 0 && set.add(o));
        walk(n.nodes);
      }
    }
  };
  walk(parseClozes(text));
  return set;
}

const MATHJAX_RE = /(\\[([])([\s\S]*?)(\\[)\]])/gi;
const stripHtmlInsideMathjax = (text: string) => text.replace(MATHJAX_RE, (_m, o: string, inner: string, c: string) => o + stripHtmlPreservingEntities(inner) + c);

// ---- Filters (template_filters.rs) ------------------------------------------------------------

const FURIGANA_RE = / ?([^ >]+?)\[(.+?)\]/g;
const rubyFilter = (text: string, f: (base: string, reading: string) => string) =>
  text.replace(/&nbsp;/g, ' ').replace(FURIGANA_RE, (m, base: string, reading: string) => (reading.startsWith('sound:') ? m : f(base, reading)));

export const furiganaFilter = (t: string) => rubyFilter(t, (b, r) => `<ruby><rb>${b}</rb><rt>${r}</rt></ruby>`);
export const kanaFilter = (t: string) => rubyFilter(t, (_b, r) => r);
export const kanjiFilter = (t: string) => rubyFilter(t, (b) => b);

let hintCounter = 0;
function hintFilter(text: string, fieldName: string): string {
  if (!text.trim()) return text;
  const id = `${(hintCounter++).toString(16)}${Math.abs(hashString(text + fieldName)).toString(16)}`;
  return `
<a class=hint href="#"
onclick="this.style.display='none';
document.getElementById('hint${id}').style.display='block';
return false;" draggable=false>
${fieldName}</a>
<div id="hint${id}" class=hint style="display: none">${text}</div>
`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

interface Ctx {
  fields: Record<string, string>;
  nonEmpty: Set<string>;
  cardOrd: number;
  /** Set when rendering the answer side. */
  frontside: string | null;
}

function applyFilters(text: string, filters: string[], fieldName: string, ctx: Ctx): string {
  // `filters` is innermost-first already (parse reversed them).
  let fs = filters;
  if (fs.length === 2 && fs[0] === 'cloze' && fs[1] === 'type') fs = ['type-cloze'];
  else if (fs.length === 2 && fs[0] === 'nc' && fs[1] === 'type') fs = ['type-nc'];
  else if (fs.length && fs[fs.length - 1] === 'type') fs = ['type'];
  for (const f of fs) {
    switch (f) {
      case 'text': text = stripHtml(text); break;
      case 'furigana': text = furiganaFilter(text); break;
      case 'kanji': text = kanjiFilter(text); break;
      case 'kana': text = kanaFilter(text); break;
      case 'type': text = `[[type:${fieldName}]]`; break;
      case 'type-cloze': text = `[[type:cloze:${fieldName}]]`; break;
      case 'type-nc': text = `[[type:nc:${fieldName}]]`; break;
      case 'hint': text = hintFilter(text, fieldName); break;
      case 'cloze': text = stripHtmlInsideMathjax(revealClozeText(text, ctx.cardOrd + 1, ctx.frontside == null)); break;
      case 'cloze-only': text = revealClozeTextOnly(text, ctx.cardOrd + 1, ctx.frontside == null); break;
      case '': break;
      default:
        if (f.startsWith('tts ')) text = `[anki:tts lang=${f.slice(4)}]${text}[/anki:tts]`;
      // unknown filters are ignored (Anki: add-on filters)
    }
  }
  return text;
}

function renderNodes(nodes: Node[], ctx: Ctx): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += n.text;
        break;
      case 'comment':
        out += `<!--${n.text}-->`;
        break;
      case 'rep':
        if (n.key === 'FrontSide') out += ctx.frontside ?? '';
        else if (!n.key && n.filters.length) {
          /* empty field with a filter: nothing for built-in filters */
        } else if (n.key in ctx.fields) out += applyFilters(ctx.fields[n.key], n.filters, n.key, ctx);
        else throw new TemplateError(`Found '{{${[...n.filters].reverse().concat(n.key).join(':')}}}', but there is no field called '${n.key}'`);
        break;
      case 'cond':
      case 'neg': {
        const known = n.key in ctx.fields || /^c\d+$/.test(n.key);
        if (!ctx.nonEmpty.has(n.key) && !known) throw new TemplateError(`There is no field called '${n.key}'`);
        const truthy = ctx.nonEmpty.has(n.key) !== (n.t === 'neg');
        const inner = renderNodes(n.children, ctx);
        if (truthy) out += inner;
      }
    }
  }
  return out;
}

// ---- AV tags (card_rendering) ---------------------------------------------------------------

export interface AvTag {
  kind: 'sound' | 'tts';
  /** Filename for sounds; text for TTS. */
  value: string;
  lang?: string;
}

/** Replace `[sound:…]` / `[anki:tts …]` with `[anki:play:side:N]` refs, collecting the tags. */
function extractAvTags(text: string, side: 'q' | 'a', into: AvTag[]): string {
  return text.replace(/\[sound:(.+?)\]|\[anki:tts lang=([^\]]+?)\]([\s\S]*?)\[\/anki:tts\]/g, (_m, sound?: string, lang?: string, tts?: string) => {
    const idx = into.length;
    if (sound != null) into.push({ kind: 'sound', value: decodeEntities(sound) });
    else into.push({ kind: 'tts', value: stripHtml(tts ?? ''), lang: lang?.split(/\s+/)[0] });
    return `[anki:play:${side}:${idx}]`;
  });
}

const PLAY_SVG =
  '<svg class="playImage" viewBox="0 0 64 64" version="1.1"><circle cx="32" cy="32" r="29" /><path d="M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z" /></svg>';

/** Anki `av_refs_to_play_icons`. */
export function avRefsToPlayIcons(text: string): string {
  return text.replace(/\[anki:play:(q|a):(\d+)\]/g, (_m, side: string, idx: string) => `<a class="replay-button soundLink" href="#" data-play="${side}:${idx}" draggable="false">${PLAY_SVG}</a>`);
}

// ---- Public API -----------------------------------------------------------------------------

export interface RenderedCard {
  /** HTML with play buttons in place of audio tags; may still contain `[[type:…]]` markers. */
  question: string;
  answer: string;
  questionAv: AvTag[];
  answerAv: AvTag[];
  css: string;
  /** True when the front is empty (the card would be blank in Anki). */
  isEmpty: boolean;
  error: string | null;
}

export interface RenderInput {
  notetype: Notetype;
  flds: string;
  ord: number;
  tags: string;
  deckName: string;
  flags: number;
  cardId: number;
}

const FLAG_NAMES = ['', 'flag1', 'flag2', 'flag3', 'flag4', 'flag5', 'flag6', 'flag7'];

/** Render a card's question and answer the way Anki does. */
export function renderCard(input: RenderInput): RenderedCard {
  const { notetype: nt, ord } = input;
  const tmpl = nt.kind === 1 ? nt.templates[0] : nt.templates.find((t) => t.ord === ord) ?? nt.templates[0];
  const fields = fieldMap(nt, input.flds);
  const special: Record<string, string> = {
    Tags: input.tags.trim(),
    Type: nt.name,
    Deck: input.deckName,
    Subdeck: input.deckName.split('::').pop() ?? input.deckName,
    CardFlag: FLAG_NAMES[input.flags & 7] ?? '',
    Card: tmpl?.name ?? '',
    CardID: String(input.cardId),
  };
  for (const [k, v] of Object.entries(special)) if (!(k in fields)) fields[k] = v;
  const cardNum = `c${ord + 1}`;
  if (!(cardNum in fields)) fields[cardNum] = '1';
  const nonEmpty = new Set(Object.entries(fields).filter(([, v]) => !fieldIsEmpty(v)).map(([k]) => k));

  const empty = (msg: string): RenderedCard => ({ question: msg, answer: msg, questionAv: [], answerAv: [], css: nt.css, isEmpty: true, error: null });
  if (!tmpl) return empty('<div>This note type has no card templates.</div>');

  try {
    const ctx: Ctx = { fields, nonEmpty, cardOrd: ord, frontside: null };
    const qNodes = parse(tmpl.qfmt);
    let qtext = renderNodes(qNodes, ctx);
    if (nt.kind === 1) {
      const nums = new Set<number>();
      for (const f of nt.fields) for (const n of clozeNumbersInString(fields[f.name] ?? '')) nums.add(n);
      if (!nums.has(ord + 1)) return empty(`<div>This card has no cloze ${ord + 1} — it’s empty.</div>`);
    } else if (templateIsEmpty(nonEmpty, qNodes)) {
      return empty('<div>The front of this card is blank.</div>');
    }
    const questionAv: AvTag[] = [];
    qtext = extractAvTags(qtext, 'q', questionAv);
    const atextRaw = renderNodes(parse(tmpl.afmt), { ...ctx, frontside: qtext });
    const answerAv: AvTag[] = [];
    const atext = extractAvTags(atextRaw, 'a', answerAv);
    return { question: avRefsToPlayIcons(qtext), answer: avRefsToPlayIcons(atext), questionAv, answerAv, css: nt.css, isEmpty: false, error: null };
  } catch (e) {
    const msg = `<div class="template-error">${e instanceof Error ? e.message : String(e)}</div>`;
    return { question: msg, answer: msg, questionAv: [], answerAv: [], css: nt.css, isEmpty: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Which card ordinals a note generates (Anki: non-empty fronts; cloze numbers for cloze types). */
export function generatedOrdinals(nt: Notetype, flds: string): number[] {
  const fields = fieldMap(nt, flds);
  if (nt.kind === 1) {
    const nums = new Set<number>();
    for (const f of nt.fields) for (const n of clozeNumbersInString(fields[f.name] ?? '')) nums.add(n - 1);
    return nums.size ? [...nums].sort((a, b) => a - b) : [0];
  }
  return nt.templates.filter((t) => rendersWithFields(t.qfmt, fields)).map((t) => t.ord).sort((a, b) => a - b);
}

// ---- Type-in-the-answer (reviewer.py + rslib compare_answer) -------------------------------------

/** The field text a `[[type:…]]` marker expects. */
export function typeAnswerExpected(marker: string, nt: Notetype, flds: string, ord: number): string {
  const fields = fieldMap(nt, flds);
  const m = /^\[\[type:(?:(cloze|nc):)?(.+?)\]\]$/.exec(marker);
  if (!m) return '';
  const raw = fields[m[2]] ?? '';
  const text = m[1] === 'cloze' ? extractClozeForTyping(raw, ord + 1) : raw;
  return stripHtml(text).trim();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Anki-style character diff of the typed answer against the expected one. */
export function compareAnswer(expected: string, provided: string): string {
  if (!provided) return `<code id=typeans>${esc(expected)}</code>`;
  const a = [...provided];
  const b = [...expected];
  // LCS table
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let typed = '';
  let correct = '';
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      typed += `<span class=typeGood>${esc(a[i])}</span>`;
      correct += `<span class=typeGood>${esc(b[j])}</span>`;
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      correct += `<span class=typeMissed>${esc(b[j])}</span>`;
      typed += `<span class=typeMissed>-</span>`;
      j++;
    } else {
      typed += `<span class=typeBad>${esc(a[i])}</span>`;
      i++;
    }
  }
  if (provided === expected) return `<code id=typeans>${typed}</code>`;
  return `<code id=typeans>${typed}<br><span id=typearrow>&darr;</span><br>${correct}</code>`;
}
