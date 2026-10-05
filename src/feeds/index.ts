// RSS feeds. Fetching (native HTTP on Android, charset decoding) lives in ./proxy.ts;
// everything else (parsing, extraction, UI) is client-side in this folder.
export { FeedsSection } from './FeedsSection';
export { FeedArticles } from './FeedArticles';
export { useFeeds, addCustomFeed, setFeedEnabled, removeFeed, type FeedView } from './useFeeds';
export { DEFAULT_FEEDS, type FeedKind } from './defaults';
export type { FeedArticle } from './parse';
