-- LAUNCH-SEC-1B Stage 2 -- client-photos private storage, live-Postgres
-- regression suite.
--
-- Proves that after 20261005090000_launchsec1b_client_photos_private_storage.sql
-- the client-photos bucket is private, the four permissive policies are gone,
-- no other storage policy grants access to client-photos, the other buckets'
-- policies are untouched, and that at the database API boundary neither
-- `anon` nor `authenticated` (even the owner of the studio in the object
-- path) can read, list, insert, update or delete client-photos objects, while
-- `service_role` (the Stage 1 server path) still can read them. Entire script
-- runs in one transaction and is rolled back at the end -- nothing persists.
-- Run via `supabase db query --linked --file <this file>` against DEV, AFTER
-- 20261005090000 has been applied. (Before it is applied, this suite fails --
-- that is its negative control.)
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000fbXXXX

begin;

-- ============================================================================
-- CONFIGURATION
-- ============================================================================

do $$
declare
  v_bucket record;
begin
  select b.public, b.file_size_limit, b.allowed_mime_types into v_bucket
  from storage.buckets b where b.id = 'client-photos';
  if not found then
    raise exception 'FAIL T-launchsec1b-bucket-exists';
  end if;
  if v_bucket.public is distinct from false then
    raise exception 'FAIL T-launchsec1b-bucket-private: public=%', v_bucket.public;
  end if;
  if v_bucket.file_size_limit is distinct from 5242880
     or v_bucket.allowed_mime_types is distinct from array['image/jpeg', 'image/png', 'image/webp'] then
    raise exception 'FAIL T-launchsec1b-bucket-limits-unchanged';
  end if;
  raise notice 'PASS T-launchsec1b-bucket-private';
end $$;

do $$
declare
  v_names text;
begin
  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'storage'
      and p.policyname in (
        'Public read client photos',
        'Authenticated upload client photos',
        'Authenticated update client photos',
        'Authenticated delete client photos'
      )
  ) then
    raise exception 'FAIL T-launchsec1b-permissive-policies-dropped';
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'storage'
      and (coalesce(p.qual, '') like '%client-photos%' or coalesce(p.with_check, '') like '%client-photos%')
  ) then
    raise exception 'FAIL T-launchsec1b-no-replacement-policy';
  end if;

  -- The other buckets' storage.objects policies are exactly the pre-Stage-2 set.
  select string_agg(p.policyname, '|' order by p.policyname) into v_names
  from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects';
  if v_names is distinct from
    'Public can read instructor photos|Studio staff can update instructor photos|'
    || 'Studio staff can upload instructor photos|authenticated users can read imports|'
    || 'authenticated users can upload imports|partner profile photos are publicly readable|'
    || 'users can update their own partner profile photos|users can upload their own partner profile photos'
  then
    raise exception 'FAIL T-launchsec1b-other-policies-unchanged: %', v_names;
  end if;

  raise notice 'PASS T-launchsec1b-policies (4 dropped, none replaced, others unchanged)';
end $$;

-- ============================================================================
-- FIXTURES (as the migration owner)
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000fb0001', 'LAUNCH-SEC-1B Studio A', 't-launchsec1b-a');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000fb1001', 't-launchsec1b-owner-a@example.test'),
  ('00000000-0000-0000-0000-000000fb1002', 't-launchsec1b-norole@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000fb1001', 't-launchsec1b-owner-a@example.test', null),
  ('00000000-0000-0000-0000-000000fb1002', 't-launchsec1b-norole@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000fb1001', '00000000-0000-0000-0000-000000fb0001', 'studio_owner', true);

insert into storage.objects (bucket_id, name) values
  ('client-photos',
   '00000000-0000-0000-0000-000000fb0001/00000000-0000-0000-0000-000000fb2001/1759276800000-00000000-0000-0000-0000-000000fb3001.png');

-- storage.objects has a statement-level protect_delete trigger that rejects
-- every direct DELETE unless storage.allow_delete_query is set (the Storage API
-- sets it per request). Set it transaction-locally, as the API does, so the
-- DELETE checks below exercise row-level security rather than that trigger.
select set_config('storage.allow_delete_query', 'true', true);

-- ============================================================================
-- ANON: no read / list / write
-- ============================================================================

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from storage.objects where bucket_id = 'client-photos';
  if v_count <> 0 then
    raise exception 'FAIL T-launchsec1b-anon-read: % visible', v_count;
  end if;

  begin
    insert into storage.objects (bucket_id, name)
    values ('client-photos', '00000000-0000-0000-0000-000000fb0001/x/anon.png');
    raise exception 'FAIL T-launchsec1b-anon-insert: insert succeeded';
  exception
    when insufficient_privilege then null;
  end;

  update storage.objects set name = name || '.moved' where bucket_id = 'client-photos';
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b-anon-update: % rows', v_count; end if;

  delete from storage.objects where bucket_id = 'client-photos';
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b-anon-delete: % rows', v_count; end if;

  raise notice 'PASS T-launchsec1b-anon-denied';
end $$;

reset role;

-- ============================================================================
-- AUTHENTICATED: no direct path, even for the owner of the path's studio
-- ============================================================================

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fb1001","role":"authenticated"}',
  true
);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from storage.objects where bucket_id = 'client-photos';
  if v_count <> 0 then
    raise exception 'FAIL T-launchsec1b-owner-read: % visible', v_count;
  end if;

  begin
    insert into storage.objects (bucket_id, name, owner)
    values (
      'client-photos',
      '00000000-0000-0000-0000-000000fb0001/00000000-0000-0000-0000-000000fb2001/1759276800001-00000000-0000-0000-0000-000000fb3002.png',
      '00000000-0000-0000-0000-000000fb1001'
    );
    raise exception 'FAIL T-launchsec1b-owner-insert: insert succeeded';
  exception
    when insufficient_privilege then null;
  end;

  update storage.objects set name = name || '.moved' where bucket_id = 'client-photos';
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b-owner-update: % rows', v_count; end if;

  delete from storage.objects where bucket_id = 'client-photos';
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL T-launchsec1b-owner-delete: % rows', v_count; end if;

  raise notice 'PASS T-launchsec1b-studio-owner-denied';
end $$;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000fb1002","role":"authenticated"}',
  true
);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from storage.objects where bucket_id = 'client-photos';
  if v_count <> 0 then
    raise exception 'FAIL T-launchsec1b-norole-read: % visible', v_count;
  end if;

  begin
    insert into storage.objects (bucket_id, name)
    values ('client-photos', '00000000-0000-0000-0000-000000fb0001/x/norole.png');
    raise exception 'FAIL T-launchsec1b-norole-insert: insert succeeded';
  exception
    when insufficient_privilege then null;
  end;

  raise notice 'PASS T-launchsec1b-no-role-user-denied';
end $$;

reset role;

-- The fixture object is untouched by every rejected write.
do $$
begin
  if (select count(*) from storage.objects
      where bucket_id = 'client-photos'
        and name = '00000000-0000-0000-0000-000000fb0001/00000000-0000-0000-0000-000000fb2001/1759276800000-00000000-0000-0000-0000-000000fb3001.png') <> 1
     or (select count(*) from storage.objects where bucket_id = 'client-photos') <> 1 then
    raise exception 'FAIL T-launchsec1b-object-unchanged';
  end if;
  raise notice 'PASS T-launchsec1b-object-unchanged';
end $$;

-- ============================================================================
-- SERVICE ROLE: the Stage 1 server path still reaches the object
-- ============================================================================

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
begin
  if (select count(*) from storage.objects where bucket_id = 'client-photos') <> 1 then
    raise exception 'FAIL T-launchsec1b-service-role-read';
  end if;
  raise notice 'PASS T-launchsec1b-service-role-read';
end $$;

reset role;

do $$
begin
  raise notice 'ALL T-launchsec1b TESTS PASSED';
end $$;

rollback;
