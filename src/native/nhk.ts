import { registerPlugin } from '@capacitor/core';
import { isNative } from '../app/platform';

interface NhkPluginApi {
  agree(): Promise<void>;
  get(opts: { url: string }): Promise<{ status: number; url: string; contentType: string; data: string }>;
}

/** android/app/src/main/java/app/gakutaku/NhkPlugin.java */
const Nhk = registerPlugin<NhkPluginApi>('Nhk');

/** True for NHK's web hosts (news.web.nhk and friends), which need the reader's agreement. */
export const isNhkUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'web.nhk' || u.hostname.endsWith('.web.nhk'));
  } catch {
    return false;
  }
};

/** Whether the in-app "agree to NHK's terms" step is available (Android app only). */
export const canAgreeToNhk = isNative;

/** Show NHK's page so the user can agree to its terms; resolves when they close it. */
export function agreeToNhk(): Promise<void> {
  return Nhk.agree();
}

/** Fetch an NHK page with the cookies NHK set when the user agreed (Android app only). */
export async function nhkGet(url: string): Promise<{ status: number; url: string; contentType: string; bytes: Uint8Array }> {
  const r = await Nhk.get({ url });
  const bin = atob(r.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { status: r.status, url: r.url, contentType: r.contentType, bytes };
}
