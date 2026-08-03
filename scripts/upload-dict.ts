/**
 * Upload ./dict-build (buckets + kanji index + manifest) to a PUBLIC Supabase Storage bucket
 * named `dictionary`. Run after build-dict.
 *
 * Requires in .env (local only — never commit):
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (Supabase → Project Settings → API → service_role key)
 *
 * Usage: npm run upload:dict
 *
 * The manifest goes up **last**, after every bucket it describes: clients treat the manifest as the
 * pointer to a complete build, so publishing it early would let a client fetch buckets that aren't
 * there yet. Objects left over from an earlier build are removed afterwards.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const OUT_DIR = 'dict-build';
const BUCKET = 'dictionary';
const MANIFEST = 'manifest.json';
/** Parallel uploads. Thousands of small objects go up far too slowly one at a time. */
const CONCURRENCY = 12;

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment (.env).');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function contentType(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.gz')) return 'application/gzip';
  return 'application/octet-stream';
}

const keyOf = (file: string) => relative(OUT_DIR, file).replace(/\\/g, '/');

async function uploadOne(file: string): Promise<number> {
  const body = readFileSync(file);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(keyOf(file), body, { upsert: true, contentType: contentType(file) });
  if (error) throw new Error(`Failed to upload ${keyOf(file)}: ${error.message}`);
  return body.length;
}

/** Run `task` over `items` with a fixed-size worker pool, reporting progress as it goes. */
async function pool<T>(items: T[], task: (item: T) => Promise<number>, label: string): Promise<number> {
  let next = 0;
  let done = 0;
  let bytes = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      bytes += await task(items[i]);
      done++;
      if (done % 100 === 0 || done === items.length) {
        process.stdout.write(`\r  ${label}: ${done}/${items.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  if (items.length) process.stdout.write('\n');
  return bytes;
}

/** List every object key currently in the bucket (paged; Storage caps a listing at 100). */
async function listAll(prefix = ''): Promise<string[]> {
  const keys: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 100, offset });
    if (error) throw new Error(`Failed to list ${prefix || '/'}: ${error.message}`);
    if (!data?.length) break;
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      // Storage reports a "folder" as a row with no id.
      if (item.id) keys.push(path);
      else keys.push(...(await listAll(path)));
    }
    if (data.length < 100) break;
  }
  return keys;
}

async function main() {
  // Ensure the bucket exists and is public.
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    console.log(`Creating public bucket "${BUCKET}"…`);
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error) throw error;
  }

  const files = [...walk(OUT_DIR)];
  const manifest = files.find((f) => keyOf(f) === MANIFEST);
  if (!manifest) throw new Error(`No ${MANIFEST} in ${OUT_DIR}/ — run \`npm run build:dict\` first.`);
  const payload = files.filter((f) => f !== manifest);

  console.log(`Uploading ${files.length} files to ${BUCKET}…`);
  const bytes = await pool(payload, uploadOne, 'buckets');
  await uploadOne(manifest);
  console.log(`  ✓ ${MANIFEST} (published last)`);
  console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB uploaded`);

  // Drop anything from a previous build (e.g. the pre-bucket `word/`/`name/`/`kanji/` shards),
  // which would otherwise sit in the bucket forever.
  const wanted = new Set(files.map(keyOf));
  const stale = (await listAll()).filter((k) => !wanted.has(k));
  if (stale.length) {
    console.log(`Removing ${stale.length} object(s) from a previous build…`);
    for (let i = 0; i < stale.length; i += 100) {
      const { error } = await supabase.storage.from(BUCKET).remove(stale.slice(i, i + 100));
      if (error) throw new Error(`Failed to remove stale objects: ${error.message}`);
    }
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
