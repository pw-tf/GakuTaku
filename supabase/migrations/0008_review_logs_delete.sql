-- 0008_review_logs_delete.sql — allow deleting one's own review logs, for Anki-style undo.
--
-- Undo of an answer (Anki's Z) removes the answer's revlog entry. review_logs was
-- select+insert only (0002), so a synced undo's DELETE was rejected server-side (42501)
-- and silently discarded by the upload connector, leaving local and remote divergent.
-- Owner deletes are now allowed. There is still NO update policy: logs remain
-- immutable-or-removed, never edited, so the event-sourced fold (§3.3) stays trustworthy.

drop policy if exists review_logs_delete on public.review_logs;
create policy review_logs_delete on public.review_logs
  for delete using (auth.uid() = user_id);
