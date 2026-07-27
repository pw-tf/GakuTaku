import { useEffect, useState } from 'react';
import { jpCore } from '../jp-core/client';
import type { FuriToken } from '../jp-core/worker';
import { Reader } from '../reader/Reader';
import type { RestoreTarget } from '../reader/useBook';
import type { MinedItem } from '../ui/LookupPopup';
import { Icon } from '../ui/icons';
import { proxyFetch } from './proxy';
import { extractArticle, htmlToParagraphs, htmlToText, jpLength, type FeedArticle } from './parse';
import type { FeedView } from './useFeeds';

interface Props {
  article: FeedArticle;
  feed: FeedView;
  mined: MinedItem[];
  onMine: (item: MinedItem) => void;
  onReviewMined: () => void;
  onClose: () => void;
}

// Stable across renders so the Reader's restore effect doesn't re-fire and jump to top.
const RESTORE_TOP: RestoreTarget = { kind: 'top' };
const noop = () => {};

interface ArticleState {
  status: 'loading' | 'ready' | 'error';
  paragraphs: FuriToken[][];
  error?: string;
}

/**
 * RSS article view: resolves the article's text (feed-embedded content, else the
 * page body via the proxy + extraction), tokenizes it, and renders the same Reader
 * used for books — so furigana density, dictionary lookup and mining all just work.
 */
export function ArticleReader({ article, feed, mined, onMine, onReviewMined, onClose }: Props) {
  const [state, setState] = useState<ArticleState>({ status: 'loading', paragraphs: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ status: 'loading', paragraphs: [] });
      try {
        let paras = article.content ? htmlToParagraphs(article.content) : [];
        // Feed content that's missing or just a stub → fetch the article page itself.
        if (jpLength(paras.join('')) < 100 && article.link) {
          const res = await proxyFetch(article.link);
          const extracted = extractArticle(res.body);
          if (extracted.paragraphs.length) paras = extracted.paragraphs;
        }
        if (paras.length === 0 && article.summary) paras = [htmlToText(article.summary)];
        if (paras.length === 0) throw new Error('No readable text found in this article.');
        const tokens = await jpCore.furiganaForMany(paras);
        if (!cancelled) setState({ status: 'ready', paragraphs: tokens });
      } catch (e) {
        if (!cancelled) {
          setState({ status: 'error', paragraphs: [], error: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [article.id, article.link, article.content, article.summary]);

  if (state.status !== 'ready') {
    return (
      <div className="reader">
        <div className="rd-top">
          <span className="back" onClick={onClose}><Icon.chevL s={18} /> <span className="back-lbl">Articles</span></span>
          <span className="rtitle" lang="ja">{article.title}</span>
        </div>
        <div className="rd-stage"><div className="rd-scroll"><div className="rd-col">
          {state.status === 'loading' ? (
            <p style={{ color: 'var(--ink-faint)' }}>Fetching article…</p>
          ) : (
            <p style={{ color: 'var(--rate-again)' }}>Couldn't open this article: {state.error}</p>
          )}
        </div></div></div>
      </div>
    );
  }

  return (
    <Reader
      title={article.title}
      backLabel={feed.title}
      direction="ltr"
      chapterIndex={0}
      chapterCount={1}
      paragraphs={state.paragraphs}
      loadingChapter={false}
      restore={RESTORE_TOP}
      mined={mined}
      onMine={onMine}
      onReviewMined={onReviewMined}
      onPrevChapter={noop}
      onNextChapter={noop}
      onPrevChapterEnd={noop}
      onProgress={noop}
      onClose={onClose}
    />
  );
}
