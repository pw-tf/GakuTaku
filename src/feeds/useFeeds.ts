import { useMemo } from 'react';
import { useQuery } from '@powersync/react';
import { db } from '../sync/system';
import type { FeedRecord } from '../sync/AppSchema';
import { DEFAULT_FEEDS, type FeedKind } from './defaults';

/**
 * A feed as shown in the UI: built-in defaults merged with the user's `feeds` rows.
 * A default feed has a DB row only once the user has toggled it (the row stores its
 * enabled state, keyed by builtin_id); custom feeds are ordinary rows.
 */
export interface FeedView {
  /** Stable UI key: builtin id for defaults, row id for custom feeds. */
  key: string;
  /** Backing `feeds` row, if one exists (null for an untouched default). */
  rowId: string | null;
  builtinId: string | null;
  title: string;
  url: string;
  kind: FeedKind;
  level?: string;
  enabled: boolean;
  custom: boolean;
}

/** All feeds (defaults first, then custom in added order), including disabled ones. */
export function useFeeds(): { feeds: FeedView[]; loading: boolean } {
  const { data: rows, isLoading } = useQuery<FeedRecord>('SELECT * FROM feeds ORDER BY added_at ASC');

  const feeds = useMemo(() => {
    const overrides = new Map<string, FeedRecord>();
    const custom: FeedRecord[] = [];
    for (const r of rows) {
      if (r.builtin_id) overrides.set(r.builtin_id, r);
      else custom.push(r);
    }
    const out: FeedView[] = DEFAULT_FEEDS.map((d) => {
      const o = overrides.get(d.id);
      return {
        key: d.id,
        rowId: o?.id ?? null,
        builtinId: d.id,
        title: d.title,
        url: d.url,
        kind: d.kind,
        level: d.level,
        enabled: o ? o.enabled !== 0 : true,
        custom: false,
      };
    });
    for (const r of custom) {
      out.push({
        key: r.id,
        rowId: r.id,
        builtinId: null,
        title: r.title || r.url || 'Feed',
        url: r.url ?? '',
        kind: r.kind === 'nhk-easy' ? 'nhk-easy' : 'rss',
        enabled: r.enabled !== 0,
        custom: true,
      });
    }
    return out;
  }, [rows]);

  return { feeds, loading: isLoading };
}

/** Subscribe to a custom RSS feed (validated by the caller via a test fetch). */
export async function addCustomFeed(userId: string, url: string, title: string): Promise<void> {
  await db.execute(
    'INSERT INTO feeds (id, user_id, url, title, kind, enabled, builtin_id, added_at) VALUES (uuid(), ?, ?, ?, ?, 1, NULL, ?)',
    [userId, url, title, 'rss', new Date().toISOString()],
  );
}

/** Toggle any feed. For an untouched default this materializes its override row. */
export async function setFeedEnabled(feed: FeedView, userId: string, enabled: boolean): Promise<void> {
  if (feed.rowId) {
    await db.execute('UPDATE feeds SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, feed.rowId]);
  } else {
    await db.execute(
      'INSERT INTO feeds (id, user_id, url, title, kind, enabled, builtin_id, added_at) VALUES (uuid(), ?, ?, ?, ?, ?, ?, ?)',
      [userId, feed.url, feed.title, feed.kind, enabled ? 1 : 0, feed.builtinId, new Date().toISOString()],
    );
  }
}

/** Remove a custom feed's subscription (defaults can only be disabled, not removed). */
export async function removeFeed(feed: FeedView): Promise<void> {
  if (feed.rowId) await db.execute('DELETE FROM feeds WHERE id = ?', [feed.rowId]);
}
