# GakuTaku

Offline-first PWA for learning Japanese through immersion reading + FSRS spaced
repetition. See [`japanese-reader-build-plan.md`](./japanese-reader-build-plan.md) for the
full 8-milestone spec.

**Status:** M0 (scaffold) + M1 (auth & sync) + M2 (Japanese core: tokenizer, furigana,
offline dictionary lookup, shared popup) + M3–M6 (reader, SRS, analytics, Anki import) +
M7 (RSS feeds: real Japanese news with furigana + lookup) complete.

## Stack

- React + TypeScript + Vite, Tailwind, Zustand
- PWA via `vite-plugin-pwa` (Workbox)
- Supabase (Postgres + Auth + Storage + RLS)
- PowerSync (`@powersync/web` + `@powersync/react`) — local SQLite (wa-sqlite WASM) synced to Supabase

## Setup

### 1. Install

```bash
npm install
cp .env.example .env   # then fill in the three VITE_ values
```

### 2. Supabase

1. Create a project. In the SQL editor, run every file in
   [`supabase/migrations/`](./supabase/migrations) in order (`0001_init.sql` → schema +
   `powersync` publication + Data-API grants, `0002_rls.sql` → RLS policies, then the
   numbered follow-ups, e.g. `0006_feeds_rss.sql` for the RSS feed columns).
2. Auth → Providers: enable **Email** and **Google** (add Google OAuth client id/secret;
   set the redirect URL to your app origin).
3. Copy the project URL + anon key into `.env`.

### 3. PowerSync

1. Create an instance and connect it to your Supabase Postgres (create the
   `powersync_role` with `REPLICATION BYPASSRLS` as prompted by the PowerSync setup).
2. Enable **Use Supabase Auth** and set the JWT secret.
3. Paste [`supabase/powersync-sync-rules.yaml`](./supabase/powersync-sync-rules.yaml) into
   the Sync Rules editor and deploy.
4. Copy the instance URL into `VITE_POWERSYNC_URL`.

### 4. Dictionary (M2) — one-time build & upload

The tokenizer/furigana work out of the box (kuromoji dict is vendored in `public/dict/kuromoji/`).
The lookup dictionary (full JMdict + JMnedict names + KANJIDIC) is large, so it's hosted on
Supabase Storage and downloaded by the app on first use.

1. Download the latest JSON files from
   [jmdict-simplified releases](https://github.com/scriptin/jmdict-simplified/releases/latest)
   into a local `dict-src/` folder: `jmdict-eng-*.json`, `jmnedict-all-*.json`, `kanjidic2-en-*.json`.
2. Create a **public** Supabase Storage bucket named `dictionary`.
3. Add `SUPABASE_SERVICE_ROLE_KEY` to `.env` (local only — gitignored).
4. Build + upload:
   ```bash
   npm run build:dict     # → dict-build/ (sharded, gzipped NDJSON + manifest.json)
   npm run upload:dict    # → uploads to the `dictionary` bucket
   ```
   In the app, open **Japanese core → Download dictionary** once; it's then cached in IndexedDB.

### 5. RSS feed proxy (M7) — one-time deploy

Feeds and articles are fetched through a small Supabase Edge Function (browsers can't
fetch third-party feeds directly because of CORS, and legacy Japanese charsets like
Shift_JIS need server-side decoding):

```bash
supabase functions deploy rss-proxy   # from the repo root (uses supabase/functions/rss-proxy)
```

JWT verification stays on (the default), so only signed-in app users can call it. The
built-in defaults (NHK やさしいニュース via the News Web Easy list, plus NHK 主要/社会/科学・文化/経済
RSS) are defined in [`src/feeds/defaults.ts`](./src/feeds/defaults.ts); users can turn them
off and add their own RSS/Atom feeds from the Library's **Feeds → Manage / Add feed** UI.

### 6. Run

```bash
npm run dev       # http://localhost:5173
npm run build && npm run preview   # production build (PWA-installable)
```

## Architecture notes

- **Two local data layers** (do not conflate): PowerSync SQLite holds *user data*
  (decks, notes, cards, logs, …) and syncs to Postgres; the dictionary + document blobs
  (M2/M3) will live in IndexedDB / Cache API and are **not** synced.
- **Conflict strategy:** `review_logs` is append-only and the source of truth for scheduling
  (FSRS state is derived by replaying logs). Content tables use last-write-wins via the
  connector's `upsert`/`update`. See `src/sync/SupabaseConnector.ts`.

## Verifying M1 (sync round-trip)

1. Sign up / sign in.
2. DevTools → Network → **Offline**. Add a deck — it appears instantly (local write).
3. Go back **online**. The row appears in Supabase `decks` and in a second signed-in
   session without a manual refresh.
4. Sign in as a different user — the first user's decks are not visible (RLS).

## Verifying M2 (Japanese core)

1. Open the **Japanese core** tab; the sample text tokenizes with furigana (toggle on/off).
2. Reload in airplane mode — tokenization still works (kuromoji dict is cached).
3. Download the dictionary (above), then tap a word → popup shows readings + glosses; tap a name
   (e.g. 田中) → JMnedict hit; a kanji shows KANJIDIC info. 食べた resolves to 食べる.
4. **＋ Add to deck** inserts a `mined_words` row (real card creation arrives in M4).

## Verifying M7 (RSS)

1. Deploy the `rss-proxy` function and run `0006_feeds_rss.sql` (setup §2/§5).
2. Library → **Feeds** lists the NHK defaults with their latest headlines. Open
   NHK やさしいニュース → an article → it renders with furigana, tap-to-lookup and
   mining, exactly like a book (density/dictionary controls in the study rail).
3. **Manage** → toggle a default off (it disappears from the list; the state syncs
   across devices). **Add feed** → paste any RSS/Atom URL → its title is detected
   and articles open the same way.
