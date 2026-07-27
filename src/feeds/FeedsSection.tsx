import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Btn, Chip } from '../ui/atoms';
import { Icon } from '../ui/icons';
import { loadFeedArticles, relTimeJa, unreadCount } from './articles';
import { parseFeedXml } from './parse';
import { proxyFetch } from './proxy';
import { addCustomFeed, removeFeed, setFeedEnabled, useFeeds, type FeedView } from './useFeeds';

interface Preview {
  latest: string;
  time: string;
  unread: number;
  error?: boolean;
}

/** Lazily fetch each enabled feed's newest article for the list rows (cached in articles.ts). */
function useFeedPreviews(feeds: FeedView[]): Record<string, Preview> {
  const [map, setMap] = useState<Record<string, Preview>>({});
  useEffect(() => {
    let alive = true;
    for (const f of feeds) {
      if (map[f.key]) continue;
      loadFeedArticles(f)
        .then((arts) => {
          if (!alive) return;
          const latest = arts[0];
          setMap((m) => ({
            ...m,
            [f.key]: {
              latest: latest?.title ?? 'No articles',
              time: relTimeJa(latest?.published ?? null),
              unread: unreadCount(f.key, arts),
            },
          }));
        })
        .catch(() => alive && setMap((m) => ({ ...m, [f.key]: { latest: '', time: '', unread: 0, error: true } })));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feeds.map((f) => f.key).join(',')]);
  return map;
}

interface Props {
  onOpenFeed: (feed: FeedView) => void;
}

/** Library "Feeds" section: enabled feeds with latest-article previews, plus manage/add. */
export function FeedsSection({ onOpenFeed }: Props) {
  const { session } = useAuth();
  const { feeds } = useFeeds();
  const [manage, setManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const enabled = feeds.filter((f) => f.enabled);
  const previews = useFeedPreviews(enabled);

  return (
    <>
      <div className="sec-bar" style={{ marginTop: 40 }}>
        <h2>Feeds</h2>
        <span className="count">{enabled.length} {enabled.length === 1 ? 'feed' : 'feeds'}</span>
        <span className="more" style={{ display: 'flex', gap: 8 }}>
          <Btn size="sm" onClick={() => setManage((m) => !m)}>{manage ? 'Done' : 'Manage'}</Btn>
          <Btn size="sm" onClick={() => setAdding(true)}><Icon.plus s={15} /> Add feed</Btn>
        </span>
      </div>

      {manage ? (
        <div className="feed-list">
          {feeds.map((f) => (
            <div className="mng-row" key={f.key}>
              <div className="fic"><Icon.rss s={16} /></div>
              <div className="fmeta">
                <div className="ft" lang="ja">
                  {f.title} {f.level && <Chip>{f.level}</Chip>} <Chip>{f.custom ? 'custom' : 'default'}</Chip>
                </div>
                <div className="fl">{f.kind === 'nhk-easy' ? 'NHK News Web Easy' : f.url}</div>
              </div>
              {f.custom && (
                <button className="icon-btn" title="Remove feed" onClick={() => removeFeed(f)}>
                  <Icon.trash s={16} />
                </button>
              )}
              <div
                className={'switch' + (f.enabled ? ' on' : '')}
                role="switch"
                aria-checked={f.enabled}
                title={f.enabled ? 'Turn off' : 'Turn on'}
                onClick={() => session && setFeedEnabled(f, session.user.id, !f.enabled)}
              />
            </div>
          ))}
        </div>
      ) : enabled.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)' }}>
          All feeds are turned off. Use Manage to re-enable the defaults, or add your own RSS feed.
        </p>
      ) : (
        <div className="feed-list">
          {enabled.map((f) => {
            const p = previews[f.key];
            return (
              <div className="feed-row" key={f.key} onClick={() => onOpenFeed(f)}>
                <div className="fic"><Icon.rss s={18} /></div>
                <div className="fmeta">
                  <div className="ft" lang="ja">
                    {f.title} {f.level && <Chip>{f.level}</Chip>}
                    {p && !p.error && p.unread > 0 && <Chip accent>{p.unread} new</Chip>}
                  </div>
                  <div className="fl" lang="ja">
                    {!p ? 'Loading…' : p.error ? <span className="feed-err">Couldn't load — tap to retry</span> : p.latest}
                  </div>
                </div>
                <div className="ftime" lang="ja">{p && !p.error ? p.time : ''}</div>
              </div>
            );
          })}
        </div>
      )}

      {adding && session && <AddFeedModal userId={session.user.id} onClose={() => setAdding(false)} />}
    </>
  );
}

function AddFeedModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const raw = url.trim();
    if (!/^https?:\/\//i.test(raw)) {
      setErr('Enter a full URL starting with http:// or https://');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Validate by fetching + parsing once; also yields the feed's own title.
      const res = await proxyFetch(raw);
      const parsed = parseFeedXml(res.body, res.url || raw);
      await addCustomFeed(userId, raw, parsed.title || new URL(raw).hostname);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Add RSS feed</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close s={18} /></button>
        </div>
        <div className="modal-body">
          <div className="opt-field col">
            <span>Feed URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && submit()}
              placeholder="https://example.com/rss.xml"
              autoFocus
            />
          </div>
          {err && <div style={{ color: 'var(--rate-again)', fontSize: 13 }}>{err}</div>}
          <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
            RSS 2.0, RSS 1.0 and Atom feeds are supported — the title is detected automatically. Articles open in the
            reader with furigana and tap-to-lookup, like any book.
          </div>
        </div>
        <div className="modal-foot">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={busy || !url.trim()} onClick={submit}>
            {busy ? 'Checking…' : 'Add feed'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
