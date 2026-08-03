// rss-proxy — Supabase Edge Function (Deno).
//
// The browser can't fetch third-party feeds/articles directly (CORS), so the app
// POSTs { url } here and gets back { body, contentType, url } as JSON. The function
// also decodes legacy Japanese charsets (Shift_JIS / EUC-JP / ISO-2022-JP) to UTF-8,
// which fetch().text() in the browser could not do.
//
// Deploy:  supabase functions deploy rss-proxy
// JWT verification is ON by default, so only signed-in app users can call this —
// it is not an open proxy. Parsing (RSS/Atom/article extraction) happens client-side.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BYTES = 3 * 1024 * 1024; // plenty for any feed or article page
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Validate a target URL. Rejects non-http(s) schemes and obvious private/internal hosts (SSRF guard). */
function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || // raw IPv4 literal
    host.includes(':') // IPv6 literal
  ) {
    throw new Error('This host is not allowed');
  }
  return url;
}

/**
 * Request headers. Several Japanese news sites (NHK among them) sit behind a CDN that rejects
 * requests which don't look like a browser fetching the page's own assets, so we send an
 * ordinary Accept/Accept-Language set and a same-origin Referer alongside the identifying UA.
 */
function requestHeaders(url: URL): HeadersInit {
  return {
    'User-Agent':
      'Mozilla/5.0 (compatible; GakuTaku/1.0; +https://github.com/pw-tf/gakutaku) personal RSS reader',
    Accept:
      'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, application/json, */*',
    'Accept-Language': 'ja,en;q=0.8',
    Referer: url.origin + '/',
  };
}

/** Follow redirects manually so every hop goes through checkUrl. */
async function fetchWithGuards(start: URL): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: requestHeaders(url),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc) throw new Error(`Redirect without Location (${res.status})`);
      url = checkUrl(new URL(loc, url).toString());
      continue;
    }
    return { res, url };
  }
  throw new Error('Too many redirects');
}

/** Read a body with a hard size cap (feeds should never be this big). */
async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Charset from the Content-Type header, else sniffed from the XML declaration / meta tag. */
function detectCharset(contentType: string, bytes: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType);
  if (fromHeader) return fromHeader[1];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromXml = /encoding=["']([\w-]+)["']/i.exec(head);
  if (fromXml) return fromXml[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (fromMeta) return fromMeta[1];
  return 'utf-8';
}

/** Turn an upstream status into something a reader can act on. */
function upstreamMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `The site refused this request (${status}) — the feed may now require a login, or have moved.`;
  }
  if (status === 404 || status === 410) return `This feed no longer exists at that address (${status}).`;
  if (status === 429) return 'The site is rate-limiting requests (429). Try again in a few minutes.';
  if (status >= 500) return `The site is having trouble right now (${status}).`;
  return `Upstream responded ${status}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  try {
    const body = await req.json().catch(() => ({}));
    const raw = (body as { url?: unknown }).url;
    if (typeof raw !== 'string' || !raw) return json(400, { error: 'Missing "url" in request body' });

    const { res, url } = await fetchWithGuards(checkUrl(raw));
    if (!res.ok) {
      await res.body?.cancel();
      return json(502, { error: upstreamMessage(res.status), status: res.status, url: url.toString() });
    }
    const bytes = await readCapped(res);
    const contentType = res.headers.get('content-type') ?? '';
    let text: string;
    try {
      text = new TextDecoder(detectCharset(contentType, bytes)).decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes); // unknown label → best effort
    }
    return json(200, { body: text, contentType, url: url.toString() });
  } catch (e) {
    return json(400, { error: e instanceof Error ? e.message : String(e) });
  }
});
