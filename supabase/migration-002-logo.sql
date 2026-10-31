-- Run this once in Supabase → SQL Editor if your database was created before the logo feature.
-- (Fresh installs get it from schema.sql automatically.)
alter table public.settings add column if not exists logo_path text;
