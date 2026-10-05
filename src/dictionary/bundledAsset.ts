import { gunzipSync } from 'fflate';

/**
 * Read a gzipped data file that ships in `public/dict/` and return its inflated bytes.
 *
 * The same file reaches us in three shapes, depending on where the app runs:
 * - static hosts and our Vite servers serve `x.gz` as the raw gzip bytes;
 * - a server that labels it `Content-Encoding: gzip` makes the browser inflate it on the way in;
 * - the Android build has no `x.gz` at all: the Android Gradle plugin gunzips `.gz` assets while
 *   merging them and drops the suffix, so the APK holds a plain `x`.
 *
 * So try the `.gz` name, fall back to the bare name on a 404, and check the gzip magic bytes rather
 * than trusting the name. Whichever name worked is remembered so later reads go straight to it.
 */

export class BundledAssetMissing extends Error {
  constructor(path: string) {
    super(`${path} isn’t included in this build.`);
    this.name = 'BundledAssetMissing';
  }
}

/** null until a read succeeds; then whether this build stores the files without `.gz`. */
let plainNames: boolean | null = null;

export async function fetchBundledGzip(path: string): Promise<Uint8Array> {
  const plain = path.replace(/\.gz$/, '');
  const names = plain === path ? [path] : plainNames ? [plain, path] : [path, plain];
  for (const name of names) {
    let res: Response;
    try {
      res = await fetch(name);
    } catch (e) {
      throw new Error(`Couldn’t read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) continue;
    // Capacitor's local server reports every status with the reason phrase "OK", so never show
    // statusText — the number is the useful part.
    if (!res.ok) throw new Error(`Couldn’t read ${path} (HTTP ${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (name !== path || plain !== path) plainNames = name === plain;
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  }
  throw new BundledAssetMissing(path);
}
