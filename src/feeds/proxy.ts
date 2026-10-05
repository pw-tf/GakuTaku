import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { isNhkUrl, nhkGet } from '../native/nhk';

/** Result of a feed/article fetch: decoded text plus the final (post-redirect) URL. */
export interface ProxyResult {
  body: string;
  contentType: string;
  url: string;
}

/** A failed fetch, carrying the upstream HTTP status when there was one. */
export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** NHK refused because the reader hasn't agreed to its terms (in this app) yet. */
    readonly needsNhkAgreement = false,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

/** NHK ONE (Oct 2025) serves its web news only after the reader agrees to NHK's terms. */
function nhkRefusal(status: number): ProxyError {
  return new ProxyError('NHK asks you to agree to its terms before it shows this.', status, true);
}

/** NHK pages in the Android app go through the native NHK fetch, which carries NHK's cookies. */
async function nhkFetch(url: URL): Promise<{ bytes: Uint8Array; contentType: string; url: string }> {
  const res = await nhkGet(url.toString());
  if (res.status === 401 || res.status === 403) throw nhkRefusal(res.status);
  if (res.status < 200 || res.status >= 300) throw new ProxyError(upstreamMessage(res.status), res.status);
  return { bytes: res.bytes, contentType: res.contentType, url: res.url };
}

/**
 * Some Japanese news sites (NHK among them) sit behind a CDN that rejects requests which don't look
 * like an ordinary browser, so send a normal Accept / Accept-Language set and a same-origin Referer.
 */
function requestHeaders(url: URL): Record<string, string> {
  return {
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, application/json, */*',
    'Accept-Language': 'ja,en;q=0.8',
    Referer: url.origin + '/',
  };
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

/** Decode bytes in their declared charset (Shift_JIS / EUC-JP feeds still exist). */
function decode(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(detectCharset(contentType, bytes)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes); // unknown label → best effort
  }
}

/** Turn an upstream status into something a reader can act on. */
function upstreamMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `The site refused this request (${status}) — the feed may now require a login, or have moved.`;
  }
  if (status === 404 || status === 410) return `This feed no longer exists at that address (${status}).`;
  if (status === 429) return 'The site is rate-limiting requests (429). Try again in a few minutes.';
  if (status >= 500) return `The site is having trouble right now (${status}).`;
  return `The site responded ${status}.`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProxyError('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProxyError('Only http(s) URLs are supported.');
  return url;
}

/**
 * Fetch a feed or article page. In the Android app this goes through the native HTTP stack, which
 * isn't subject to browser CORS rules, so any site can be read directly. In a desktop browser most
 * news sites block cross-origin reads, so feeds there only work for sites that allow it.
 */
export async function proxyFetch(target: string): Promise<ProxyResult> {
  const url = checkUrl(target);

  if (Capacitor.isNativePlatform() && isNhkUrl(url.toString())) {
    const res = await nhkFetch(url);
    return { body: decode(res.bytes, res.contentType), contentType: res.contentType, url: res.url || url.toString() };
  }
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url: url.toString(),
      headers: requestHeaders(url),
      responseType: 'arraybuffer',
      connectTimeout: 15_000,
      readTimeout: 15_000,
    });
    if (res.status < 200 || res.status >= 300) throw new ProxyError(upstreamMessage(res.status), res.status);
    const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const contentType = headers['content-type'] ?? '';
    const bytes = typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data as ArrayBuffer);
    return { body: decode(bytes, contentType), contentType, url: res.url || url.toString() };
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: { Accept: requestHeaders(url).Accept } });
  } catch {
    throw new ProxyError('This site can’t be read from a desktop browser (it blocks cross-site requests). Use the Android app.');
  }
  if (!res.ok) throw new ProxyError(upstreamMessage(res.status), res.status);
  const contentType = res.headers.get('content-type') ?? '';
  return { body: decode(new Uint8Array(await res.arrayBuffer()), contentType), contentType, url: res.url || url.toString() };
}

/** Fetch raw bytes (audio clips for mining). Same transport rules as {@link proxyFetch}. */
export async function fetchBytes(target: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = checkUrl(target);
  if (Capacitor.isNativePlatform() && isNhkUrl(url.toString())) {
    const res = await nhkFetch(url);
    return { bytes: res.bytes, contentType: res.contentType };
  }
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({ url: url.toString(), responseType: 'arraybuffer', connectTimeout: 15_000, readTimeout: 15_000 });
    if (res.status < 200 || res.status >= 300) throw new ProxyError(upstreamMessage(res.status), res.status);
    const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes = typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(res.data as ArrayBuffer);
    return { bytes, contentType: headers['content-type'] ?? '' };
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new ProxyError(upstreamMessage(res.status), res.status);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
}
