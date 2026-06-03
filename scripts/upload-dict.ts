/**
 * Upload ./dict-build (manifest + gzipped shards) to a PUBLIC Supabase Storage bucket
 * named `dictionary`. Run after build-dict.
 *
 * Requires in .env (local only — never commit):
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (Supabase → Project Settings → API → service_role key)
 *
 * Usage: npm run upload:dict
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const OUT_DIR = 'dict-build';
const BUCKET = 'dictionary';

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

async function main() {
  // Ensure the bucket exists and is public.
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    console.log(`Creating public bucket "${BUCKET}"…`);
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error) throw error;
  }

  const files = [...walk(OUT_DIR)];
  console.log(`Uploading ${files.length} files to ${BUCKET}…`);
  for (const file of files) {
    const key = relative(OUT_DIR, file).replace(/\\/g, '/');
    const body = readFileSync(file);
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(key, body, { upsert: true, contentType: contentType(file) });
    if (error) throw new Error(`Failed to upload ${key}: ${error.message}`);
    console.log(`  ✓ ${key} (${(body.length / 1024 / 1024).toFixed(2)} MB)`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
