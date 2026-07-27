import { supabase } from '../sync/supabase';

/** Result of a proxied fetch: decoded UTF-8 text plus the final (post-redirect) URL. */
export interface ProxyResult {
  body: string;
  contentType: string;
  url: string;
}

/**
 * Fetch a feed or article URL through the rss-proxy Edge Function (browser CORS +
 * legacy-charset decoding live server-side; see supabase/functions/rss-proxy).
 */
export async function proxyFetch(target: string): Promise<ProxyResult> {
  const { data, error } = await supabase.functions.invoke('rss-proxy', { body: { url: target } });
  if (error) {
    // Non-2xx responses carry our own { error } JSON; surface it instead of the generic message.
    let detail = '';
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        detail = ((await ctx.json()) as { error?: string }).error ?? '';
      } catch {
        /* not JSON */
      }
    }
    if (!detail && /Failed to send|Failed to fetch/i.test(error.message ?? '')) {
      detail = 'Could not reach the feed proxy — is the rss-proxy Edge Function deployed?';
    }
    throw new Error(detail || error.message || 'Feed proxy request failed');
  }
  const res = data as Partial<ProxyResult> & { error?: string };
  if (res?.error) throw new Error(res.error);
  if (typeof res?.body !== 'string') throw new Error('Feed proxy returned an unexpected response');
  return { body: res.body, contentType: res.contentType ?? '', url: res.url ?? target };
}
