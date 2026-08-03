/**
 * Built-in default feeds — real Japanese news sources that work out of the box.
 * These are code-defined (not seeded into the DB): a `feeds` row with a matching
 * `builtin_id` is created only when the user toggles one off/on, and stores just
 * that state. See useFeeds.ts for the merge.
 *
 * NHK reorganised its web properties for the NHK ONE launch (1 Oct 2025): `www3.nhk.or.jp`
 * no longer serves the news tree, and requests to the old paths come back 401 from the
 * account gate. News Web Easy became 「NHKやさしいことばニュース」. Everything now lives under
 * `news.web.nhk`, so that is the primary host here — with the old addresses kept as
 * fallbacks (`altUrls`) so anything still answering there keeps working.
 */

export type FeedKind = 'rss' | 'nhk-easy';

export interface DefaultFeed {
  id: string;
  title: string;
  url: string;
  kind: FeedKind;
  /** Rough JLPT difficulty label shown as a chip (informational only). */
  level: string;
  /** Tried in order if `url` fails — endpoint moves shouldn't need a redeploy to survive. */
  altUrls?: string[];
}

/** NHK's news RSS categories, all on the same host/path shape. */
function nhkRss(id: string, title: string, cat: number, level: string): DefaultFeed {
  return {
    id,
    title,
    url: `https://news.web.nhk/n-data/conf/na/rss/cat${cat}.xml`,
    altUrls: [`https://www3.nhk.or.jp/rss/news/cat${cat}.xml`],
    kind: 'rss',
    level,
  };
}

export const DEFAULT_FEEDS: DefaultFeed[] = [
  {
    id: 'nhk-easy',
    title: 'NHK やさしいことばニュース',
    // NHK Easy has no RSS; this JSON news list is what the site itself loads.
    url: 'https://news.web.nhk/news/easy/news-list.json',
    altUrls: [
      'https://news.web.nhk/news/easy/top-list.json',
      'https://www3.nhk.or.jp/news/easy/news-list.json',
    ],
    kind: 'nhk-easy',
    level: 'N5–N3',
  },
  nhkRss('nhk-top', 'NHK 主要ニュース', 0, 'N2–N1'),
  nhkRss('nhk-social', 'NHK 社会', 1, 'N2–N1'),
  nhkRss('nhk-science', 'NHK 科学・文化', 3, 'N2–N1'),
  nhkRss('nhk-business', 'NHK 経済', 5, 'N1'),
];
