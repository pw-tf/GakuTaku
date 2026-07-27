-- 0006_feeds_rss.sql — M7 (RSS): feed kind, per-feed enable/disable, and built-in
-- feed overrides.
--
-- Built-in default feeds (NHK Easy News, NHK category RSS, …) are defined in app
-- code (src/feeds/defaults.ts) and are NOT seeded as rows. A `feeds` row with
-- `builtin_id` set exists only once the user has toggled that default — it stores
-- the user's state (enabled/disabled) for it. Rows with `builtin_id` NULL are
-- user-added custom feeds.
--
-- `enabled` is an integer (1/0) rather than boolean: PowerSync's SQLite has no
-- boolean type, so client upserts write integers — an integer column avoids any
-- JSON→boolean coercion on the Data API write-back path.

alter table public.feeds add column if not exists kind text not null default 'rss';
alter table public.feeds add column if not exists enabled integer not null default 1;
alter table public.feeds add column if not exists builtin_id text;

comment on column public.feeds.kind is '''rss'' (generic RSS/Atom/RDF) | ''nhk-easy'' (NHK News Web Easy JSON news list)';
comment on column public.feeds.enabled is '1 = shown in the Library feed list, 0 = turned off';
comment on column public.feeds.builtin_id is 'When set, this row stores user state for a built-in default feed instead of a custom subscription';
