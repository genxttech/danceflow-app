-- Minimal reproduction: Supabase postgres image 17.6.1.106 (PostgreSQL 17.6, supautils hint_roles feature) segfaults (signal 11) on a
-- "permission denied for FUNCTION" error raised for anon / authenticated / service_role. No application object is involved.
-- Prerequisites: the stock Supabase roles (the session user, `postgres`, is a member of anon with SET), and supautils.hint_roles at its default
-- ('anon, authenticated, service_role'). A permission error on a TABLE does not crash; a function owned by anyone does.
-- Run: node scripts/qa/iso-qa.mjs repro
create or replace function public.iso_repro_fn() returns int language sql as 'select 1';
revoke all on function public.iso_repro_fn() from public, anon;
set role anon;
select public.iso_repro_fn();   -- 17.6.1.106 default: "server closed the connection unexpectedly"; the postmaster logs "terminated by signal 11: Segmentation fault"
