-- 0006_srs_card_state.sql — Anki-parity card state + deck option presets.
--
-- DEPLOY ORDER MATTERS: (1) run this SQL (and 0007), (2) redeploy the PowerSync sync
-- rules (the `user_data` bucket uses `select *`, so the new `cards` columns only start
-- flowing to clients after a sync-rules redeploy re-syncs the table — expect a one-off
-- re-download of `cards` for every user), (3) ship the client build.
--
-- cards gains USER state that is deliberately NOT derivable from review_logs:
-- suspend/bury/flag are user actions with no revlog entry in Anki either.
--   queue        — matches Anki's queue values so .apkg import/export round-trips 1:1:
--                  0 active, -1 suspended, -2 scheduler/sibling-buried, -3 user-buried.
--                  (Positive Anki queue values are unnecessary: the derived FSRS `state`
--                  column already distinguishes new/learning/review.)
--   flag         — Anki's colored flags, 0 = none, 1..7.
--   position     — Anki's new-card ordinal (Anki stores it in `due` while type=new).
--                  Nullable: legacy cards fall back to created_at ordering.
--   buried_until — the study-day end at bury time. Anki unburies via a day-rollover
--                  sweep; offline-first multi-device sync makes a sweep alone racy, so
--                  "is buried" is a read-time comparison against this timestamp (counts
--                  are always right) and an opportunistic client sweep converges rows
--                  back to queue=0.

alter table public.cards
  add column if not exists queue        integer not null default 0,
  add column if not exists flag         integer not null default 0,
  add column if not exists position     integer,
  add column if not exists buried_until timestamptz;

create index if not exists cards_queue_idx on public.cards (queue);

-- deck_presets — Anki's shared "options group": many decks reference one preset, and
-- editing the preset affects every deck using it. All scheduling config (limits, steps,
-- display order, burying, leech handling, FSRS retention/weights) lives in `config`;
-- decks.fsrs_params shrinks to per-deck data only (description + "this deck" limit
-- overrides), mirroring what Anki itself keeps per-deck.
create table if not exists public.deck_presets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null,
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.deck_presets enable row level security;
drop policy if exists owner_all on public.deck_presets;
create policy owner_all on public.deck_presets
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.deck_presets to authenticated;
-- The `powersync` publication is `for all tables` (0001), so deck_presets replicates
-- automatically; it still needs adding to the sync rules bucket (see the yaml).

alter table public.decks
  add column if not exists preset_id uuid references public.deck_presets (id) on delete set null;
