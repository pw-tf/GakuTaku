/**
 * Client-side feed & article parsing (the proxy only fetches + decodes bytes).
 *  - RSS 2.0, RSS 1.0 (RDF) and Atom feeds via DOMParser XML mode.
 *  - The NHK News Web Easy JSON news list (it has no RSS).
 *  - Readability-lite article-body extraction from fetched HTML pages, so an
 *    article opens as clean paragraphs the tokenizer/furigana pipeline can eat.
 */

export interface FeedArticle {
  id: string;
  title: string;
  link: string;
  /** Plain-ish summary/description from the feed (may contain HTML). */
  summary: string;
  /** ISO timestamp, or null when the feed doesn't say. */
  published: string | null;
  /** Full article HTML when the feed carries it (content:encoded / Atom content). */
  content: string | null;
}

const JP_CHAR = /[ぁ-ヿ㐀-䶿一-鿿]/g;

/** Number of Japanese characters in a string (kana + kanji) — a cheap "is this real content" score. */
export function jpLength(s: string): number {
  return (s.match(JP_CHAR) ?? []).length;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** First descendant with the given local name, ignoring namespaces (content:encoded, dc:date, …). */
function firstNS(parent: Element, local: string): Element | null {
  const list = parent.getElementsByTagNameNS('*', local);
  return list.length ? list[0] : null;
}

/** Direct child with a local name — avoids grabbing an <item>'s title when reading the channel's. */
function childNS(parent: Element, local: string): Element | null {
  for (const c of Array.from(parent.children)) if (c.localName === local) return c;
  return null;
}

function toIso(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Parse an RSS 2.0 / RSS 1.0 (RDF) / Atom document into a uniform article list. */
export function parseFeedXml(xml: string, baseUrl: string): { title: string; articles: FeedArticle[] } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('This URL is not a valid RSS/Atom feed');
  const root = doc.documentElement;

  if (root.localName === 'feed') return parseAtom(root, baseUrl);
  if (root.localName === 'rss' || root.localName === 'RDF') return parseRss(root, baseUrl);
  throw new Error(`Unsupported feed format <${root.localName}>`);
}

function parseRss(root: Element, baseUrl: string): { title: string; articles: FeedArticle[] } {
  const channel = firstNS(root, 'channel');
  const title = channel ? textOf(childNS(channel, 'title')) : '';
  const articles: FeedArticle[] = [];
  // In RSS 2.0 items live under <channel>; in RDF they're siblings of it. NS-blind scan covers both.
  for (const item of Array.from(root.getElementsByTagNameNS('*', 'item'))) {
    const link = textOf(childNS(item, 'link')) || firstNS(item, 'link')?.getAttribute('rdf:resource') || '';
    const itemTitle = textOf(childNS(item, 'title'));
    if (!itemTitle && !link) continue;
    const encoded = firstNS(item, 'encoded'); // content:encoded (full-content feeds)
    articles.push({
      id: textOf(childNS(item, 'guid')) || link || itemTitle,
      title: itemTitle || link,
      link: link ? resolveUrl(link, baseUrl) : '',
      summary: textOf(childNS(item, 'description')),
      published: toIso(textOf(childNS(item, 'pubDate')) || textOf(firstNS(item, 'date'))),
      content: encoded?.textContent?.trim() || null,
    });
  }
  return { title, articles };
}

function parseAtom(root: Element, baseUrl: string): { title: string; articles: FeedArticle[] } {
  const title = textOf(childNS(root, 'title'));
  const articles: FeedArticle[] = [];
  for (const entry of Array.from(root.getElementsByTagNameNS('*', 'entry'))) {
    const links = Array.from(entry.children).filter((c) => c.localName === 'link');
    const alt = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate') ?? links[0];
    const link = alt?.getAttribute('href') ?? '';
    const entryTitle = textOf(childNS(entry, 'title'));
    if (!entryTitle && !link) continue;
    const content = childNS(entry, 'content');
    articles.push({
      id: textOf(childNS(entry, 'id')) || link || entryTitle,
      title: entryTitle || link,
      link: link ? resolveUrl(link, baseUrl) : '',
      summary: textOf(childNS(entry, 'summary')),
      published: toIso(textOf(childNS(entry, 'published')) || textOf(childNS(entry, 'updated'))),
      content: content?.textContent?.trim() || null,
    });
  }
  return { title, articles };
}

// ---- NHK News Web Easy ------------------------------------------------------

interface NhkEasyItem {
  news_id?: string;
  title?: string;
  news_prearranged_time?: string; // "YYYY-MM-DD HH:mm:ss" in JST
}

/** Parse NHK Easy's news-list.json: `[ { "YYYY-MM-DD": [ {news_id, title, …} ] } ]`. */
export function parseNhkEasyList(jsonText: string): FeedArticle[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('NHK Easy news list was not valid JSON');
  }
  const days = (Array.isArray(data) ? data[0] : data) as Record<string, NhkEasyItem[]> | null;
  const out: FeedArticle[] = [];
  for (const items of Object.values(days ?? {})) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it?.news_id || !it.title) continue;
      out.push({
        id: it.news_id,
        title: it.title,
        link: `https://www3.nhk.or.jp/news/easy/${it.news_id}/${it.news_id}.html`,
        summary: '',
        published: it.news_prearranged_time ? toIso(`${it.news_prearranged_time.replace(' ', 'T')}+09:00`) : null,
        content: null,
      });
    }
  }
  out.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  return out.slice(0, 30);
}

// ---- Article-body extraction --------------------------------------------------

/** Chrome to strip before extracting text. rt/rp go too — the app renders its own furigana. */
const STRIP_SELECTOR =
  'script,style,noscript,iframe,form,nav,header,footer,aside,figure,figcaption,button,select,input,rt,rp';

/** Known article-body containers first (NHK variants), then generic conventions. */
const BODY_SELECTORS = [
  '#js-article-body', // NHK News Web Easy
  '.content--detail-body', // NHK News Web
  '#news_textbody',
  '[itemprop="articleBody"]',
  '.article-body',
  '.entry-content',
  '.post-content',
  'article',
  'main',
];

function paragraphsIn(scope: Element): string[] {
  const out: string[] = [];
  for (const el of Array.from(scope.querySelectorAll('p, h2, h3, li, blockquote'))) {
    if (el.querySelector('p')) continue; // container, not a leaf block
    const t = textOf(el);
    if (t) out.push(t);
  }
  if (out.length === 0) {
    // No block markup at all — fall back to line-splitting the raw text.
    for (const line of (scope.textContent ?? '').split(/\n+/)) {
      const t = line.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Fallback scorer: the container whose <p> children hold the most Japanese text. */
function densestBlock(body: Element): Element {
  let best: Element = body;
  let bestScore = 0;
  for (const el of Array.from(body.querySelectorAll('div, section, article, main, td'))) {
    let score = 0;
    for (const p of Array.from(el.children)) if (p.localName === 'p') score += jpLength(p.textContent ?? '');
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/**
 * Extract readable paragraphs from a full article page. Tries known/common
 * article-body selectors, then falls back to a paragraph-density scan.
 */
export function extractArticle(html: string): { title: string; paragraphs: string[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  const title = textOf(doc.querySelector('h1')) || textOf(doc.querySelector('title'));

  for (const sel of BODY_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el && jpLength(el.textContent ?? '') >= 80) return { title, paragraphs: paragraphsIn(el) };
  }
  return { title, paragraphs: doc.body ? paragraphsIn(densestBlock(doc.body)) : [] };
}

/** Paragraphs from feed-embedded HTML (content:encoded), same stripping rules. */
export function htmlToParagraphs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  return doc.body ? paragraphsIn(doc.body) : [];
}

/** Plain text from an HTML snippet (entity-safe) — for summary lines in lists. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return textOf(doc.body);
}
