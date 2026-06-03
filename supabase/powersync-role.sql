-- PowerSync replication role — run ONCE in the Supabase SQL editor.
-- This is the Postgres user PowerSync logs in as to read the logical-replication
-- stream. The `powersync` publication itself is already created by
-- migrations/0001_init.sql, so it is intentionally NOT recreated here
-- (CREATE PUBLICATION has no IF NOT EXISTS and would error).
--
-- SECURITY: do NOT commit a real password here. Replace the placeholder ONLY in the
-- Supabase SQL editor when you run it, and paste that same password into the PowerSync
-- "Connect to Supabase" dialog. Keep the placeholder in the repo.

create role powersync_role with replication bypassrls login password 'CHANGE-ME-strong-password';

-- PowerSync only needs to read.
grant select on all tables in schema public to powersync_role;

-- Ensure future tables (later milestones) are also readable by the role.
alter default privileges in schema public grant select on tables to powersync_role;
