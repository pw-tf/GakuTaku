-- 0001_init.sql — initial schema for the Japanese Reader app (§4 of the build plan).
-- All user data tables. Large static/binary data (dictionary, document blobs) is NOT
-- stored here; it lives client-side / in Supabase Storage.

-- decks ----------------------------------------------------------------------
create table if not exists public.decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null,
  fsrs_params jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- note_types — mirrors Anki's "model" so .apkg import (M6) is a clean map ------
create table if not exists public.note_types (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name           text not null,
  fields         jsonb not null default '[]'::jsonb,
  card_templates jsonb not null default '[]'::jsonb
);

-- notes ----------------------------------------------------------------------
create table if not exists public.notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  deck_id      uuid references public.decks (id) on delete cascade,
  note_type_id uuid references public.note_types (id) on delete set null,
  fields       jsonb not null default '{}'::jsonb,
  tags         text,
  created_at   timestamptz not null default now()
);

-- cards — FSRS fields are DERIVED from review_logs (§3.3); stored for query speed.
create table if not exists public.cards (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  note_id        uuid not null references public.notes (id) on delete cascade,
  template_index integer not null default 0,
  due            timestamptz,
  stability      double precision,
  difficulty     double precision,
  reps           integer not null default 0,
  lapses         integer not null default 0,
  state          integer not null default 0,
  last_review    timestamptz
);

-- review_logs — APPEND-ONLY source of truth for scheduling (§3.3) -------------
create table if not exists public.review_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  card_id        uuid not null references public.cards (id) on delete cascade,
  rating         integer not null,
  review_time    timestamptz not null default now(),
  elapsed_ms     integer,
  scheduled_days integer
);

-- documents — metadata; the actual blob lives in Supabase Storage -------------
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null,
  type         text,
  source       text not null default 'upload', -- 'upload' | 'rss'
  storage_path text,
  language     text not null default 'ja',
  added_at     timestamptz not null default now()
);

-- reading_positions ----------------------------------------------------------
create table if not exists public.reading_positions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  locator     text, -- CFI
  percent     double precision,
  updated_at  timestamptz not null default now()
);

-- feeds ----------------------------------------------------------------------
create table if not exists public.feeds (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  url      text not null,
  title    text,
  added_at timestamptz not null default now()
);

-- mined_words — optional lookup history → one-click cards ---------------------
create table if not exists public.mined_words (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  term         text not null,
  reading      text,
  context      text,
  document_id  uuid references public.documents (id) on delete set null,
  looked_up_at timestamptz not null default now()
);

-- user_settings --------------------------------------------------------------
create table if not exists public.user_settings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  furigana_default boolean not null default true,
  theme            text not null default 'dark',
  vertical_text    boolean not null default false
);

-- Helpful indexes for sync-rule / FK lookups.
create index if not exists notes_deck_idx           on public.notes (deck_id);
create index if not exists cards_note_idx           on public.cards (note_id);
create index if not exists review_logs_card_idx     on public.review_logs (card_id);
create index if not exists reading_pos_doc_idx      on public.reading_positions (document_id);

-- PowerSync replication ------------------------------------------------------
-- PowerSync streams changes via a logical-replication publication. Client writes
-- come back through the Supabase Data API (anon/authenticated role), so those
-- roles need DML grants — RLS (0002) still constrains them to the user's rows.
create publication powersync for all tables;

grant select, insert, update, delete on
  public.decks, public.note_types, public.notes, public.cards, public.review_logs,
  public.documents, public.reading_positions, public.feeds, public.mined_words,
  public.user_settings
to authenticated;
