// M7 — RSS feeds. The CORS/charset proxy lives in supabase/functions/rss-proxy;
// everything else (parsing, extraction, UI) is client-side in this folder.
export { FeedsSection } from './FeedsSection';
export { FeedArticles } from './FeedArticles';
export { useFeeds, addCustomFeed, setFeedEnabled, removeFeed, type FeedView } from './useFeeds';
export { DEFAULT_FEEDS, type FeedKind } from './defaults';
export type { FeedArticle } from './parse';
