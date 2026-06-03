# Japanese Reader

Offline-first PWA for learning Japanese through immersion reading + FSRS spaced
repetition. See [`japanese-reader-build-plan.md`](./japanese-reader-build-plan.md) for the
full 8-milestone spec.

**Status:** M0 (scaffold) + M1 (auth & synced data layer) complete. M2+ (Japanese core,
reader, SRS, analytics, import, RSS) not yet built — their `src/` folders are placeholders.

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

1. Create a project. In the SQL editor, run, in order:
   - [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql) — schema, the
     `powersync` publication, and Data-API grants.
   - [`supabase/migrations/0002_rls.sql`](./supabase/migrations/0002_rls.sql) — RLS policies
     (owner-only; `review_logs` is append-only).
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

### 4. Run

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
