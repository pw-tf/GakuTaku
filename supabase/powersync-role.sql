-- PowerSync replication role — run ONCE in the Supabase SQL editor.
-- This is the Postgres user PowerSync logs in as to read the logical-replication
-- stream. The `powersync` publication itself is already created by
-- migrations/0001_init.sql, so it is intentionally NOT recreated here
-- (CREATE PUBLICATION has no IF NOT EXISTS and would error).
--
-- Change the password below, then use the SAME password in the PowerSync
-- "Connect to Supabase" dialog.

create role powersync_role with replication bypassrls login password 'NFi$5$mt76w^FN';

-- PowerSync only needs to read.
grant select on all tables in schema public to powersync_role;

-- Ensure future tables (later milestones) are also readable by the role.
alter default privileges in schema public grant select on tables to powersync_role;
