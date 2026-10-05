/**
 * Plain-text books: TXT files and the text layer of PDFs are converted once, when the book is added,
 * into chapters of paragraphs. The reader shows them the same way as an ePUB's chapters.
 *
 * TXT handling covers what Japanese text files usually are:
 *   - UTF-8, UTF-16 (with BOM), Shift_JIS or EUC-JP encodings;
 *   - Aozora Bunko markup: ruby `｜漢字《かんじ》`, `［＃…］` notes, the notation preamble and the
 *     `底本：` colophon;
 *   - headings such as `第一章` or Aozora's `［＃「…」は中見出し］`.
 */

export interface TextChapter {
  title: string;
  paragraphs: string[];
}

export interface TextBookData {
  title: string;
  creator: string;
  chapters: TextChapter[];
}

/** A paragraph before chapter splitting; `heading` marks a chapter title line. */
export interface Para {
  text: string;
  heading?: boolean;
}

/** Chapters longer than this (characters) are split into parts at paragraph boundaries. */
const MAX_CHAPTER_CHARS = 16_000;
/** Without usable headings, text is cut into sections of about this many characters. */
const SECTION_CHARS = 9_000;

// ---- Decoding -------------------------------------------------------------------------------

/** Decode a text file, detecting UTF-16/UTF-8 BOMs, then strict UTF-8, then Shift_JIS / EUC-JP. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* not UTF-8 */
  }
  // Pick whichever legacy encoding yields fewer replacement characters (Shift_JIS wins ties).
  const sjis = new TextDecoder('shift_jis').decode(bytes);
  const euc = new TextDecoder('euc-jp').decode(bytes);
  const bad = (s: string) => (s.match(/�/g) ?? []).length;
  return bad(euc) < bad(sjis) ? euc : sjis;
}

// ---- Headings and chapters ------------------------------------------------------------------

const KANJI_NUM = '一二三四五六七八九十百千〇零壱弐参';
const HEADING_RE = new RegExp(
  `^(?:第[${KANJI_NUM}0-9０-９]+[章話部節回幕編巻]|序章|終章|序幕|終幕|序|プロローグ|エピローグ|あとがき|まえがき|はじめに|おわりに|Prologue|Epilogue|Chapter\\s*\\d+)`,
  'i',
);

/** Whether a line looks like a chapter heading (short, and a recognisable chapter marker). */
export function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= 40 && HEADING_RE.test(t);
}

/** Group paragraphs into chapters at headings, splitting very long chapters into parts. */
export function chapterize(paras: Para[], fallbackTitle = 'Text'): TextChapter[] {
  const headingCount = paras.filter((p) => p.heading).length;
  const raw: TextChapter[] = [];
  if (headingCount >= 2) {
    let cur: TextChapter = { title: '', paragraphs: [] };
    for (const p of paras) {
      if (p.heading) {
        if (cur.paragraphs.length || cur.title) raw.push(cur);
        cur = { title: p.text.trim(), paragraphs: [p.text] };
      } else cur.paragraphs.push(p.text);
    }
    if (cur.paragraphs.length) raw.push(cur);
    // Text before the first heading (a title page) gets its own short chapter.
    if (raw[0] && !raw[0].title) raw[0].title = fallbackTitle;
  } else {
    raw.push({ title: '', paragraphs: paras.map((p) => p.text) });
  }

  const out: TextChapter[] = [];
  const limit = headingCount >= 2 ? MAX_CHAPTER_CHARS : SECTION_CHARS;
  for (const ch of raw) {
    const parts = splitBySize(ch.paragraphs, limit);
    parts.forEach((ps, i) => {
      const base = ch.title || `Part ${out.length + 1}`;
      out.push({ title: parts.length > 1 && ch.title ? `${base} (${i + 1})` : base, paragraphs: ps });
    });
  }
  return out.length ? out : [{ title: fallbackTitle, paragraphs: [] }];
}

function splitBySize(paragraphs: string[], limit: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const p of paragraphs) {
    if (size > 0 && size + p.length > limit) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---- TXT ------------------------------------------------------------------------------------

const AOZORA_RULE = /^-{20,}\s*$/;

/** Strip Aozora Bunko inline markup from one line; reports whether it was marked as a heading. */
export function cleanAozoraLine(line: string): { text: string; heading: boolean } {
  const heading = /［＃[^］]*見出し[^］]*］/.test(line);
  const text = line
    .replace(/［＃[^］]*］/g, '') // editorial notes (indents, headings, page breaks, …)
    .replace(/｜([^《｜]+)《[^》]*》/g, '$1') // explicit ruby base
    .replace(/《[^》]*》/g, '') // implicit ruby
    .replace(/｜/g, '')
    .replace(/〔([^〕]*)〕/g, '$1');
  return { text, heading };
}

/** Parse a TXT book. The first non-empty lines of an Aozora file are its title and author. */
export function parseTxt(text: string, fallbackTitle: string): TextBookData {
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  const aozora = /《[^》]+》|［＃/.test(text);

  let title = fallbackTitle;
  let creator = '';
  if (aozora) {
    // Preamble: title, author, then a dashed box explaining the notation. Drop the box.
    const first = lines.findIndex((l) => AOZORA_RULE.test(l));
    if (first >= 0 && first < 40) {
      const second = lines.findIndex((l, i) => i > first && AOZORA_RULE.test(l));
      const head = lines.slice(0, first).map((l) => l.trim()).filter(Boolean);
      if (head[0]) title = head[0];
      if (head[1]) creator = head[1];
      // The title and author are the book's metadata, not its first chapter.
      if (second > first) lines = lines.slice(second + 1);
    }
    // Colophon: everything from the line starting with 底本： is bibliographic detail.
    const colophon = lines.findIndex((l) => /^底本[：:]/.test(l.trim()));
    if (colophon > 0) lines = lines.slice(0, colophon);
  }

  const paras: Para[] = [];
  for (const raw of lines) {
    const { text: t, heading } = aozora ? cleanAozoraLine(raw) : { text: raw, heading: false };
    const trimmed = t.replace(/^[ \t]+|\s+$/g, '');
    if (!trimmed.replace(/[\s　]/g, '')) continue;
    paras.push({ text: trimmed, heading: heading || looksLikeHeading(trimmed) });
  }
  return { title, creator, chapters: chapterize(paras, title) };
}

// ---- PDF text layer -------------------------------------------------------------------------

export interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  fontName?: string;
}

/**
 * Vertical presentation forms (U+FE10–FE19, U+FE30–FE48) → the ordinary characters. Text extracted
 * from vertically-set PDFs comes out in these forms (︒ for 。, ﹁ for 「), which would break
 * sentence detection and end up on mined cards.
 */
const VERTICAL_FORMS: Record<string, string> = {
  '\uFE10': '，', '\uFE11': '、', '\uFE12': '。', '\uFE13': '：', '\uFE14': '；', '\uFE15': '！', '\uFE16': '？',
  '\uFE17': '〖', '\uFE18': '〗', '\uFE19': '…', '\uFE30': '‥', '\uFE31': '—', '\uFE32': '–', '\uFE33': '_', '\uFE34': '_',
  '\uFE35': '（', '\uFE36': '）', '\uFE37': '｛', '\uFE38': '｝', '\uFE39': '〔', '\uFE3A': '〕', '\uFE3B': '【', '\uFE3C': '】',
  '\uFE3D': '《', '\uFE3E': '》', '\uFE3F': '〈', '\uFE40': '〉', '\uFE41': '「', '\uFE42': '」', '\uFE43': '『', '\uFE44': '』',
  '\uFE47': '［', '\uFE48': '］',
};
export const normalizeVerticalForms = (s: string) => s.replace(/[\uFE10-\uFE19\uFE30-\uFE48]/g, (c) => VERTICAL_FORMS[c] ?? c);

/**
 * Lines of one page from pdf.js text items. A line ends at an end-of-line mark, or where the next
 * item jumps across the line direction: down a line in horizontal text, left a column in vertical
 * text (`verticalFonts` are the fonts pdf.js reports as vertical).
 *
 * pdf.js drops the full-width space that indents a Japanese paragraph, so it is restored from the
 * geometry: a line starting about one character in from the page's text margin gets it back.
 */
export function pdfItemsToLines(items: PdfTextItem[], verticalFonts: Set<string> = new Set()): string[] {
  interface Line {
    text: string;
    start: number[] | null;
    size: number;
    vertical: boolean;
  }
  const lines: Line[] = [];
  let cur: Line = { text: '', start: null, size: 0, vertical: false };
  let last: number[] | null = null;
  const push = () => {
    if (cur.text) lines.push(cur);
    cur = { text: '', start: null, size: 0, vertical: false };
  };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const t = it.transform;
    const vertical = !!it.fontName && verticalFonts.has(it.fontName);
    if (cur.text && last && t) {
      const size = Math.max(Math.abs(t[0]), Math.abs(t[3]), 1);
      const across = vertical ? Math.abs(t[4] - last[4]) : Math.abs(t[5] - last[5]);
      if (across > size * 0.5) push();
    }
    if (!cur.text && t && it.str.trim()) {
      cur.start = t;
      cur.size = Math.max(Math.abs(t[0]), Math.abs(t[3]), 1);
      cur.vertical = vertical;
    }
    if (cur.text || it.str.trim()) cur.text += normalizeVerticalForms(it.str);
    if (t) last = t;
    if (it.hasEOL) push();
  }
  push();

  // Text margin: the leftmost line start (horizontal) or the topmost (vertical).
  const starts = (v: boolean) => lines.filter((l) => l.start && l.vertical === v).map((l) => (v ? -l.start![5] : l.start![4]));
  const margin = { h: Math.min(...starts(false)), v: Math.min(...starts(true)) };
  return lines.map((l) => {
    if (!l.start) return l.text;
    const offset = l.vertical ? -l.start[5] - margin.v : l.start[4] - margin.h;
    const indented = offset > l.size * 0.6 && offset < l.size * 1.6;
    return indented && !l.text.startsWith('　') ? '　' + l.text : l.text;
  });
}

const SENTENCE_END = /[。．！？!?」』）)】〉》…‥]$/;
const PARA_START = /^[　「『（(【〈《]/;

/**
 * Rebuild paragraphs from a PDF's lines (one string per visual line, pages in order). PDFs break
 * every visual line, so lines are joined back together; a new paragraph starts at a full-width
 * indent or an opening quote, or after a short line that ends a sentence.
 *
 * Running headers/footers (the same short line on many pages) and bare page numbers are removed.
 */
export function pdfLinesToParas(pages: string[][]): Para[] {
  const freq = new Map<string, number>();
  for (const page of pages) {
    for (const l of new Set(page.map((x) => x.trim()))) if (l) freq.set(l, (freq.get(l) ?? 0) + 1);
  }
  const repeated = (l: string) => pages.length >= 4 && l.length <= 40 && (freq.get(l) ?? 0) >= Math.max(3, pages.length * 0.3);
  const pageNumber = (l: string) => /^[\s\-–—]*[0-9０-９ivxlcIVXLC]{1,5}[\s\-–—]*$/.test(l) || /^-?\s*\d+\s*\/\s*\d+\s*-?$/.test(l);

  const lines: string[] = [];
  for (const page of pages) {
    for (const raw of page) {
      const t = raw.replace(/\s+$/, '');
      const key = t.trim();
      if (!key || pageNumber(key) || repeated(key)) continue;
      lines.push(t);
    }
  }
  const typical = percentile(lines.map((l) => l.trim().length), 0.75);

  const out: Para[] = [];
  let cur = '';
  let prev = '';
  const flush = () => {
    const t = cur.trim();
    if (t) out.push({ text: t, heading: looksLikeHeading(t) });
    cur = '';
  };
  for (const line of lines) {
    const t = line.trim();
    const startsNew =
      !cur ||
      PARA_START.test(line) ||
      looksLikeHeading(t) ||
      looksLikeHeading(prev) ||
      (SENTENCE_END.test(prev) && prev.length < typical * 0.85);
    if (startsNew) flush();
    // Latin text keeps a space at line joins; Japanese doesn't use one.
    cur += cur && /[A-Za-z0-9,.;:]$/.test(cur) && /^[A-Za-z0-9]/.test(t) ? ' ' + t : t;
    prev = t;
  }
  flush();
  return out;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
