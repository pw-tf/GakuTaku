import { useCallback, useEffect, useState } from 'react';
import { Btn, Chip, Spinner } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { loadFeedArticles, markFeedSeen, relTimeJa } from './articles';
import { htmlToText, type FeedArticle } from './parse';
import type { FeedView } from './useFeeds';

interface Props {
  feed: FeedView;
  onBack: () => void;
  onOpenArticle: (article: FeedArticle) => void;
}

/** Article list for one feed (drill-down from the Library's Feeds section). */
export function FeedArticles({ feed, onBack, onOpenArticle }: Props) {
  const [articles, setArticles] = useState<FeedArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      if (force) setRefreshing(true);
      setError(null);
      try {
        const arts = await loadFeedArticles(feed, force);
        setArticles(arts);
        markFeedSeen(feed.key, arts);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRefreshing(false);
      }
    },
    [feed],
  );

  useEffect(() => {
    setArticles(null);
    load(false);
  }, [load]);

  return (
    <>
      <div className="sec-bar" style={{ marginTop: 40 }}>
        <button className="icon-btn" title="All feeds" onClick={onBack}><Icon.chevL s={18} /></button>
        <h2 lang="ja">{feed.title}</h2>
        {feed.level && <Chip>{feed.level}</Chip>}
        <span className="count">{articles ? `${articles.length} articles` : ''}</span>
        <span className="more">
          <Btn size="sm" disabled={refreshing} onClick={() => load(true)}>
            {refreshing ? <Spinner size={14} /> : 'Refresh'}
          </Btn>
        </span>
      </div>

      {error ? (
        <p style={{ color: 'var(--ink-faint)' }}>
          Couldn't load this feed: {error}{' '}
          <a style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => load(true)}>Retry</a>
        </p>
      ) : articles === null ? (
        <p style={{ color: 'var(--ink-faint)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner size={16} /> Loading articles…
        </p>
      ) : articles.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>This feed has no articles right now.</p>
      ) : (
        <div className="feed-list">
          {articles.map((a) => (
            <div className="feed-row" key={a.id} onClick={() => onOpenArticle(a)}>
              <div className="fmeta">
                <div className="ft" lang="ja">{a.title}</div>
                {a.summary && <div className="fl" lang="ja">{htmlToText(a.summary)}</div>}
              </div>
              <div className="ftime" lang="ja">{relTimeJa(a.published)}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
