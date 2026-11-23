-- Legacy instructor token migration SQL suite (disposable Postgres only; see calendar_feeds_legacy_v1.sh).
-- Fixture: the sh runner has already applied the v1 token migration and stubbed instructor_calendar_feeds.

create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;

create or replace function pg_temp.sha(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

insert into auth.users(id) values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000a3'), ('00000000-0000-0000-0000-0000000000a4');
insert into public.studios(id) values ('00000000-0000-0000-0000-0000000000b1');
insert into public.instructors(id, studio_id, user_id, active) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', true),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', null, true),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', false),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a4', true);
-- c1 ok, c2 ok but feed inactive, c3 no user, c4 inactive instructor, c5 ok but already has a current new-model token
insert into public.instructor_calendar_feeds(studio_id, instructor_id, token, active) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', true),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c2', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', false),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c3', 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', true),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c4', 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', true),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c5', 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', true);
select public.calendar_feed_set_studio_enabled('00000000-0000-0000-0000-0000000000b1', true, null);
select public.calendar_feed_issue_token('00000000-0000-0000-0000-0000000000b1', 'staff', '00000000-0000-0000-0000-0000000000a4', repeat('9', 64), 'nnnn0001', 'minimal', null, null, 0);

\i :migration

do $t$
declare
  s1 uuid := '00000000-0000-0000-0000-0000000000b1';
  n integer;
begin
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where legacy_source = 'instructor_feed') = 1, 'exactly one legacy token migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))) = 1, 'migrated token resolves by its hash (same subscription URL keeps working)');
  perform pg_temp.ok((select subject_kind from public.calendar_feed_resolve(pg_temp.sha('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))) = 'staff', 'migrated as a staff feed');
  perform pg_temp.ok((select detail_level from public.calendar_feed_resolve(pg_temp.sha('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))) = 'minimal', 'migrated feeds start at minimal detail');
  perform pg_temp.ok((select subject_user_id from public.calendar_feed_resolve(pg_temp.sha('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))) = '00000000-0000-0000-0000-0000000000a1'::uuid, 'subject is the instructor user');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'))) = 0, 'inactive legacy feed not migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'))) = 0, 'instructor without a user not migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'))) = 0, 'inactive instructor not migrated');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha('EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'))) = 0, 'subject with an existing current token not overwritten');
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(repeat('9', 64))) = 1, 'existing new-model token untouched');
  perform pg_temp.ok((select count(*) from public.calendar_feed_tokens where token_hash ~ '^[A-Za-z]{43}$') = 0, 'no plaintext stored in the token table');
  perform pg_temp.ok((select count(*) from public.calendar_feed_audit_events where action = 'migrated') = 1, 'migration audited once');
  perform pg_temp.ok((select token_prefix from public.calendar_feed_tokens where legacy_source = 'instructor_feed') = 'AAAAAA', 'prefix recorded for support display');
  perform pg_temp.ok((select token from public.instructor_calendar_feeds where instructor_id = '00000000-0000-0000-0000-0000000000c1') = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'legacy table untouched (cutover is a later step)');
  -- a disabled studio does not serve migrated tokens
  perform public.calendar_feed_set_studio_enabled(s1, false, null);
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))) = 0, 'migrated token dark while the studio is disabled');
  perform public.calendar_feed_set_studio_enabled(s1, true, null);
  -- staff deactivation hook covers migrated tokens
  update public.instructors set active = false where id = '00000000-0000-0000-0000-0000000000c1';
  perform pg_temp.ok((select count(*) from public.calendar_feed_resolve(pg_temp.sha('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))) = 0, 'deactivating the instructor revokes the migrated token');
end
$t$;

-- re-run is a no-op
\i :migration
select pg_temp.ok((select count(*) from public.calendar_feed_tokens where legacy_source = 'instructor_feed') = 1, 'idempotent re-run adds nothing');
select 'ALL LEGACY MIGRATION SQL CHECKS PASSED' as result;
