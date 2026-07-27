/**
 * Built-in default feeds — real Japanese news sources that work out of the box.
 * These are code-defined (not seeded into the DB): a `feeds` row with a matching
 * `builtin_id` is created only when the user toggles one off/on, and stores just
 * that state. See useFeeds.ts for the merge.
 */

export type FeedKind = 'rss' | 'nhk-easy';

export interface DefaultFeed {
  id: string;
  title: string;
  url: string;
  kind: FeedKind;
  /** Rough JLPT difficulty label shown as a chip (informational only). */
  level: string;
}

export const DEFAULT_FEEDS: DefaultFeed[] = [
  {
    id: 'nhk-easy',
    title: 'NHK やさしいニュース',
    // NHK News Web Easy has no RSS; this JSON news list is what the site itself loads.
    url: 'https://www3.nhk.or.jp/news/easy/news-list.json',
    kind: 'nhk-easy',
    level: 'N5–N3',
  },
  {
    id: 'nhk-top',
    title: 'NHK 主要ニュース',
    url: 'https://www3.nhk.or.jp/rss/news/cat0.xml',
    kind: 'rss',
    level: 'N2–N1',
  },
  {
    id: 'nhk-social',
    title: 'NHK 社会',
    url: 'https://www3.nhk.or.jp/rss/news/cat1.xml',
    kind: 'rss',
    level: 'N2–N1',
  },
  {
    id: 'nhk-science',
    title: 'NHK 科学・文化',
    url: 'https://www3.nhk.or.jp/rss/news/cat3.xml',
    kind: 'rss',
    level: 'N2–N1',
  },
  {
    id: 'nhk-business',
    title: 'NHK 経済',
    url: 'https://www3.nhk.or.jp/rss/news/cat5.xml',
    kind: 'rss',
    level: 'N1',
  },
];
