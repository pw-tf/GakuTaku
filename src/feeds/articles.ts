import { proxyFetch } from './proxy';
import { parseFeedXml, parseNhkEasyList, type FeedArticle } from './parse';
import type { FeedView } from './useFeeds';

/**
 * Per-feed article lists with a short in-memory cache, so navigating around the
 * Library doesn't refetch every feed, and "unread" chips based on the newest
 * article the user has seen (localStorage — cosmetic, not synced).
 */

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; articles: FeedArticle[] }>();

export async function loadFeedArticles(feed: FeedView, force = false): Promise<FeedArticle[]> {
  const hit = cache.get(feed.key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.articles;
  const res = await proxyFetch(feed.url);
  const articles =
    feed.kind === 'nhk-easy' ? parseNhkEasyList(res.body) : parseFeedXml(res.body, res.url || feed.url).articles;
  cache.set(feed.key, { at: Date.now(), articles });
  return articles;
}

const seenKey = (feedKey: string) => `gt-feed-seen:${feedKey}`;

/** Articles newer than the last one seen when this feed was opened (all, if never opened). */
export function unreadCount(feedKey: string, articles: FeedArticle[]): number {
  const seen = localStorage.getItem(seenKey(feedKey));
  if (!seen) return articles.length;
  return articles.filter((a) => (a.published ?? '') > seen).length;
}

export function markFeedSeen(feedKey: string, articles: FeedArticle[]): void {
  const newest = articles.reduce((max, a) => ((a.published ?? '') > max ? (a.published as string) : max), '');
  if (newest) localStorage.setItem(seenKey(feedKey), newest);
}

/** Compact Japanese relative time for list rows ('2時間前', '昨日', '7月12日'). */
export function relTimeJa(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'たった今';
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨日';
  if (days < 7) return `${days}日前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
