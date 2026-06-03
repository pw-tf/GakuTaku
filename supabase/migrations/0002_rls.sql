-- 0002_rls.sql — Row-Level Security. Every table is scoped to its owner so a user
-- can only ever read/write their own rows. This mirrors the PowerSync sync rules
-- (powersync-sync-rules.yaml), which scope downloads the same way.

-- Standard owner-only access for content tables: same predicate for read + write.
do $$
declare
  t text;
begin
  foreach t in array array[
    'decks', 'note_types', 'notes', 'cards', 'documents',
    'reading_positions', 'feeds', 'mined_words', 'user_settings'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists owner_all on public.%I;', t);
    execute format(
      'create policy owner_all on public.%I
         for all
         using (auth.uid() = user_id)
         with check (auth.uid() = user_id);', t);
  end loop;
end $$;

-- review_logs is APPEND-ONLY (§3.3): allow select + insert only. With no update or
-- delete policy, RLS denies those operations, so logs can never be mutated.
alter table public.review_logs enable row level security;

drop policy if exists review_logs_select on public.review_logs;
create policy review_logs_select on public.review_logs
  for select using (auth.uid() = user_id);

drop policy if exists review_logs_insert on public.review_logs;
create policy review_logs_insert on public.review_logs
  for insert with check (auth.uid() = user_id);
