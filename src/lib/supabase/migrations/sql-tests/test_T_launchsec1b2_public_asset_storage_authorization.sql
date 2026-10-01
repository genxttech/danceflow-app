-- LAUNCH-SEC-1B2 -- public asset Storage authorization, live-Postgres
-- regression suite.
--
-- Proves that after 20261006090000_launchsec1b2_public_asset_storage_authorization.sql:
--   event-media: still public; an INSERT is allowed only under the UUID of an
--     existing studio where the caller has an ACTIVE membership (or is a
--     platform admin); cross-studio, inactive, no-role and malformed-path
--     inserts are denied; nobody can list, update or delete objects through
--     RLS.
--   studio-public-assets: still public with 5 MB / jpeg-png-webp limits; no
--     authenticated or anonymous list/insert/update/delete; service_role (the
--     application's admin upload path) still can.
--   client-photos stays private and every other storage policy is unchanged.
-- Entire script runs in one transaction and is rolled back -- nothing
-- persists. Run via `supabase db query --linked --file <this file>` against
-- DEV, AFTER 20261006090000 has been applied. Against the reviewed vulnerable
-- baseline this suite fails -- that is its negative control.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000fcXXXX

begin;

-- ============================================================================
-- CONFIGURATION
-- ============================================================================

do $$
declare
  v_names text;
begin
  if not exists (
    select 1 from storage.buckets b
    where b.id = 'event-media' and b.public = true
      and b.file_size_limit = 5242880
      and b.allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
  ) then
    raise exception 'FAIL T-launchsec1b2-event-media-config';
  end if;

  if not exists (
    select 1 from storage.buckets b
    where b.id = 'studio-public-assets' and b.public = true
      and b.file_size_limit = 5242880
      and b.allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
  ) then
    raise exception 'FAIL T-launchsec1b2-studio-public-assets-config';
  end if;

  if (select public from storage.buckets where id = 'client-photos') is distinct from false then
    raise exception 'FAIL T-launchsec1b2-client-photos-still-private';
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'storage'
      and (coalesce(p.qual, '') like '%studio-public-assets%'
        or coalesce(p.with_check, '') like '%studio-public-assets%')
  ) then
    raise exception 'FAIL T-launchsec1b2-studio-public-assets-no-policies';
  end if;

  select string_agg(p.policyname || ':' || p.cmd, '|' order by p.policyname) into v_names
  from pg_policies p
  where p.schemaname = 'storage'
    and (coalesce(p.qual, '') like '%event-media%' or coalesce(p.with_check, '') like '%event-media%');
  if v_names is distinct from 'Studio members can upload event media:INSERT' then
    raise exception 'FAIL T-launchsec1b2-event-media-only-scoped-insert: %', v_names;
  end if;

  select string_agg(p.policyname, '|' order by p.policyname) into v_names
  from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects';
  if v_names is distinct from
    'Public can read instructor photos|Studio members can upload event media|'
    || 'Studio staff can update instructor photos|Studio staff can upload instructor photos|'
    || 'authenticated users can read imports|authenticated users can upload imports|'
    || 'partner profile photos are publicly readable|'
    || 'users can update their own partner profile photos|users can upload their own partner profile photos'
  then
    raise exception 'FAIL T-launchsec1b2-other-policies-unchanged: %', v_names;
  end if;

  raise notice 'PASS T-launchsec1b2-configuration';
end $$;

-- ============================================================================
-- FIXTURES (as the migration owner)
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000fc0001', 'LAUNCH-SEC-1B2 Studio A', 't-launchsec1b2-a'),
  ('00000000-0000-0000-0000-000000fc0002', 'LAUNCH-SEC-1B2 Studio B', 't-launchsec1b2-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000fc1001', 't-launchsec1b2-member-a@example.test'),
  ('00000000-0000-0000-0000-000000fc1002', 't-launchsec1b2-inactive-a@example.test'),
  ('00000000-0000-0000-0000-000000fc1003', 't-launchsec1b2-norole@example.test'),
  ('00000000-0000-0000-0000-000000fc1004', 't-launchsec1b2-platform-admin@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000fc1001', 't-launchsec1b2-member-a@example.test', null),
  ('00000000-0000-0000-0000-000000fc1002', 't-launchsec1b2-inactive-a@example.test', null),
  ('00000000-0000-0000-0000-000000fc1003', 't-launchsec1b2-norole@example.test', null),
  ('00000000-0000-0000-0000-000000fc1004', 't-launchsec1b2-platform-admin@example.test', 'platform_admin');

-- The member's role is deliberately not an event-management role: R1 keeps
-- current behavior (any ACTIVE membership in the path's studio).
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000fc1001', '00000000-0000-0000-0000-000000fc0001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000fc1002', '00000000-0000-0000-0000-000000fc0001', 'studio_admin', false);

-- Existing objects owned by studio B, used as overwrite/delete targets.
insert into storage.objects (bucket_id, name) values
  ('event-media', '00000000-0000-0000-0000-000000fc0002/spring-gala/1759276800000-00000000-0000-0000-0000-000000fc3001.png'),
  ('studio-public-assets', '00000000-0000-0000-0000-000000fc0002/logo-1759276800000-00000000-0000-0000-0000-000000fc3002.png');

-- Direct SQL DELETE on storage.objects is blocked by a statement-level
-- protect_delete trigger unless storage.allow_delete_query is set (the Storage
-- API sets it per request). Set it transaction-locally so the DELETE checks
-- below exercise row-level security rather than that trigger.
select set_config('storage.allow_delete_query', 'true', true);

-- Attempts an INSERT as the current role and reports whether it succeeded.
create or replace function pg_temp.launchsec1b2_try_insert(p_bucket text, p_name text)
returns boolean
language plpgsql
as $$
begin
  insert into storage.objects (bucket_id, name) values (p_bucket, p_name);
  return true;
exception
  when insufficient_privilege then
    return false;
end;
$$;

grant execute on function pg_temp.launchsec1b2_try_insert(text, text) to anon, authenticated, service_role;

-- ============================================================================
-- EVENT-MEDIA INSERT AUTHORIZATION
-- ============================================================================

set local role authenticated;

-- Active member of studio A.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fc1001","role":"authenticated"}', true);

do $$
begin
  if not pg_temp.launchsec1b2_try_insert('event-media',
       '00000000-0000-0000-0000-000000fc0001/spring-gala/1759276800001-00000000-0000-0000-0000-000000fc3101.png') then
    raise exception 'FAIL T-launchsec1b2-member-own-studio-insert: denied';
  end if;

  if pg_temp.launchsec1b2_try_insert('event-media',
       '00000000-0000-0000-0000-000000fc0002/spring-gala/1759276800002-00000000-0000-0000-0000-000000fc3102.png') then
    raise exception 'FAIL T-launchsec1b2-member-cross-studio-insert: allowed';
  end if;

  -- Malformed / non-canonical / non-existent tenant segments.
  if pg_temp.launchsec1b2_try_insert('event-media', 'not-a-uuid/x/1.png')
     or pg_temp.launchsec1b2_try_insert('event-media', '/x/1.png')
     or pg_temp.launchsec1b2_try_insert('event-media', 'x.png')
     or pg_temp.launchsec1b2_try_insert('event-media', '')
     or pg_temp.launchsec1b2_try_insert('event-media',
          '00000000-0000-0000-0000-000000FC0001/x/1.png')
     or pg_temp.launchsec1b2_try_insert('event-media',
          ' 00000000-0000-0000-0000-000000fc0001/x/1.png')
     or pg_temp.launchsec1b2_try_insert('event-media',
          '00000000-0000-0000-0000-000000fc0009/x/1.png')
  then
    raise exception 'FAIL T-launchsec1b2-malformed-path-insert: allowed';
  end if;

  -- studio-public-assets has no browser write path at all.
  if pg_temp.launchsec1b2_try_insert('studio-public-assets',
       '00000000-0000-0000-0000-000000fc0001/logo-1759276800003-00000000-0000-0000-0000-000000fc3103.png') then
    raise exception 'FAIL T-launchsec1b2-member-studio-public-assets-insert: allowed';
  end if;

  raise notice 'PASS T-launchsec1b2-member-scoped-insert';
end $$;

do $$
declare
  v_count integer;
begin
  -- No SELECT policy: not even the member lists objects (including their own).
  select count(*) into v_count from storage.objects
  where bucket_id in ('event-media', 'studio-public-assets');
  if v_count <> 0 then
    raise exception 'FAIL T-launchsec1b2-member-list: % visible', v_count;
  end if;

  update storage.objects set name = name || '.moved'
  where bucket_id in ('event-media', 'studio-public-assets');
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b2-member-update: % rows', v_count; end if;

  delete from storage.objects where bucket_id in ('event-media', 'studio-public-assets');
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b2-member-delete: % rows', v_count; end if;

  raise notice 'PASS T-launchsec1b2-member-no-list-update-delete';
end $$;

-- Inactive membership in studio A.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fc1002","role":"authenticated"}', true);

do $$
begin
  if pg_temp.launchsec1b2_try_insert('event-media',
       '00000000-0000-0000-0000-000000fc0001/spring-gala/1759276800004-00000000-0000-0000-0000-000000fc3104.png') then
    raise exception 'FAIL T-launchsec1b2-inactive-member-insert: allowed';
  end if;
  raise notice 'PASS T-launchsec1b2-inactive-member-denied';
end $$;

-- Signed-in user with no studio membership.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fc1003","role":"authenticated"}', true);

do $$
declare
  v_count integer;
begin
  if pg_temp.launchsec1b2_try_insert('event-media',
       '00000000-0000-0000-0000-000000fc0001/spring-gala/1759276800005-00000000-0000-0000-0000-000000fc3105.png')
     or pg_temp.launchsec1b2_try_insert('event-media',
       '00000000-0000-0000-0000-000000fc0002/spring-gala/1759276800006-00000000-0000-0000-0000-000000fc3106.png')
     or pg_temp.launchsec1b2_try_insert('studio-public-assets',
       '00000000-0000-0000-0000-000000fc0002/logo-1759276800007-00000000-0000-0000-0000-000000fc3107.png')
  then
    raise exception 'FAIL T-launchsec1b2-no-role-insert: allowed';
  end if;

  update storage.objects set name = name || '.moved'
  where bucket_id in ('event-media', 'studio-public-assets');
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b2-no-role-update: % rows', v_count; end if;

  delete from storage.objects where bucket_id in ('event-media', 'studio-public-assets');
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b2-no-role-delete: % rows', v_count; end if;

  raise notice 'PASS T-launchsec1b2-no-role-user-denied';
end $$;

-- Platform admin (profiles.platform_role).
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fc1004","role":"authenticated"}', true);

do $$
begin
  if not pg_temp.launchsec1b2_try_insert('event-media',
       '00000000-0000-0000-0000-000000fc0002/spring-gala/1759276800008-00000000-0000-0000-0000-000000fc3108.png') then
    raise exception 'FAIL T-launchsec1b2-platform-admin-insert: denied';
  end if;
  if pg_temp.launchsec1b2_try_insert('event-media', 'not-a-uuid/x/1.png')
     or pg_temp.launchsec1b2_try_insert('event-media',
          '00000000-0000-0000-0000-000000fc0009/x/1.png') then
    raise exception 'FAIL T-launchsec1b2-platform-admin-malformed-path: allowed';
  end if;
  raise notice 'PASS T-launchsec1b2-platform-admin';
end $$;

reset role;

-- ============================================================================
-- ANON: no listing / writes
-- ============================================================================

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from storage.objects
  where bucket_id in ('event-media', 'studio-public-assets');
  if v_count <> 0 then
    raise exception 'FAIL T-launchsec1b2-anon-list: % visible', v_count;
  end if;

  if pg_temp.launchsec1b2_try_insert('event-media',
       '00000000-0000-0000-0000-000000fc0001/x/1759276800009-00000000-0000-0000-0000-000000fc3109.png')
     or pg_temp.launchsec1b2_try_insert('studio-public-assets',
       '00000000-0000-0000-0000-000000fc0001/logo-1759276800010-00000000-0000-0000-0000-000000fc3110.png')
  then
    raise exception 'FAIL T-launchsec1b2-anon-insert: allowed';
  end if;

  update storage.objects set name = name || '.moved'
  where bucket_id in ('event-media', 'studio-public-assets');
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b2-anon-update: % rows', v_count; end if;

  delete from storage.objects where bucket_id in ('event-media', 'studio-public-assets');
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b2-anon-delete: % rows', v_count; end if;

  raise notice 'PASS T-launchsec1b2-anon-denied';
end $$;

reset role;

-- Studio B's existing objects are untouched by every rejected write.
do $$
begin
  if (select count(*) from storage.objects
      where bucket_id = 'event-media'
        and name = '00000000-0000-0000-0000-000000fc0002/spring-gala/1759276800000-00000000-0000-0000-0000-000000fc3001.png') <> 1
     or (select count(*) from storage.objects
      where bucket_id = 'studio-public-assets'
        and name = '00000000-0000-0000-0000-000000fc0002/logo-1759276800000-00000000-0000-0000-0000-000000fc3002.png') <> 1
     or (select count(*) from storage.objects where name like '%.moved') <> 0
  then
    raise exception 'FAIL T-launchsec1b2-existing-objects-unchanged';
  end if;
  raise notice 'PASS T-launchsec1b2-existing-objects-unchanged';
end $$;

-- ============================================================================
-- SERVICE ROLE: the application's admin upload path still works
-- ============================================================================

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
begin
  if not pg_temp.launchsec1b2_try_insert('studio-public-assets',
       '00000000-0000-0000-0000-000000fc0001/hero-1759276800011-00000000-0000-0000-0000-000000fc3111.png') then
    raise exception 'FAIL T-launchsec1b2-service-role-insert';
  end if;
  if (select count(*) from storage.objects
      where bucket_id = 'studio-public-assets'
        and name like '00000000-0000-0000-0000-000000fc000%') <> 2 then
    raise exception 'FAIL T-launchsec1b2-service-role-read';
  end if;
  raise notice 'PASS T-launchsec1b2-service-role-path';
end $$;

reset role;

do $$
begin
  raise notice 'ALL T-launchsec1b2 TESTS PASSED';
end $$;

rollback;
