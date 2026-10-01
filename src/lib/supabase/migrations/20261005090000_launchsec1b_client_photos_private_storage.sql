-- 20261005090000_launchsec1b_client_photos_private_storage.sql
--
-- LAUNCH-SEC-1B Stage 2 (closes P0-3): make the client-photos Storage bucket
-- private and remove the four permissive storage.objects policies created by
-- 20260606_client_photo_verification_v1.sql:
--   "Public read client photos"          SELECT  to public        (anyone could read/list)
--   "Authenticated upload client photos" INSERT  to authenticated (any signed-in user could write)
--   "Authenticated update client photos" UPDATE  to authenticated
--   "Authenticated delete client photos" DELETE  to authenticated
--
-- No replacement browser-facing policies are added on purpose: after this
-- migration the only access path is the server-side service-role path shipped
-- in LAUNCH-SEC-1B Stage 1 (src/lib/clients/clientPhotoAccess.ts signs URLs for
-- authorized studio/client rows; uploads run after requireClientEditAccess()).
--
-- PREREQUISITE: the Stage 1 application (main a848efb) must be live before this
-- runs. After this runs, never roll the application back to a build that
-- renders public client-photo URLs unless this migration is reversed first
-- (rollback/20261005090000_launchsec1b_client_photos_private_storage_rollback.sql).
--
-- Scope: only the client-photos bucket row's `public` flag and those four
-- policies. No business rows, no clients.photo_url rewrite, no object changes,
-- no file_size_limit / allowed_mime_types change. Fails closed if the live
-- configuration differs from the reviewed pre-Stage-2 state.

begin;

do $$
declare
  v_public boolean;
  v_unexpected text;
begin
  select b.public into v_public
  from storage.buckets b
  where b.id = 'client-photos'
  for update;

  if not found then
    raise exception 'LAUNCH-SEC-1B: storage bucket client-photos does not exist';
  end if;

  -- Every storage policy that mentions client-photos must be one of the four
  -- reviewed policies with its exact reviewed definition (absent is allowed so
  -- a re-run is a no-op).
  select string_agg(p.tablename || '.' || p.policyname, ', ' order by p.policyname)
    into v_unexpected
  from pg_policies p
  where p.schemaname = 'storage'
    and (coalesce(p.qual, '') like '%client-photos%' or coalesce(p.with_check, '') like '%client-photos%')
    and not (
      p.tablename = 'objects'
      and p.permissive = 'PERMISSIVE'
      and (
        (p.policyname = 'Public read client photos'
          and p.cmd = 'SELECT' and p.roles = array['public']::name[]
          and p.qual = '(bucket_id = ''client-photos''::text)' and p.with_check is null)
        or (p.policyname = 'Authenticated upload client photos'
          and p.cmd = 'INSERT' and p.roles = array['authenticated']::name[]
          and p.qual is null and p.with_check = '(bucket_id = ''client-photos''::text)')
        or (p.policyname = 'Authenticated update client photos'
          and p.cmd = 'UPDATE' and p.roles = array['authenticated']::name[]
          and p.qual = '(bucket_id = ''client-photos''::text)'
          and p.with_check = '(bucket_id = ''client-photos''::text)')
        or (p.policyname = 'Authenticated delete client photos'
          and p.cmd = 'DELETE' and p.roles = array['authenticated']::name[]
          and p.qual = '(bucket_id = ''client-photos''::text)' and p.with_check is null)
      )
    );

  if v_unexpected is not null then
    raise exception 'LAUNCH-SEC-1B: unexpected client-photos storage policy definition(s): %', v_unexpected;
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'storage'
      and p.policyname in (
        'Public read client photos',
        'Authenticated upload client photos',
        'Authenticated update client photos',
        'Authenticated delete client photos'
      )
      and p.tablename <> 'objects'
  ) then
    raise exception 'LAUNCH-SEC-1B: reviewed client-photos policy name found on an unexpected table';
  end if;
end $$;

drop policy if exists "Public read client photos" on storage.objects;
drop policy if exists "Authenticated upload client photos" on storage.objects;
drop policy if exists "Authenticated update client photos" on storage.objects;
drop policy if exists "Authenticated delete client photos" on storage.objects;

update storage.buckets
set public = false
where id = 'client-photos';

do $$
begin
  if (select b.public from storage.buckets b where b.id = 'client-photos') is distinct from false then
    raise exception 'LAUNCH-SEC-1B: client-photos bucket is still public';
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'storage'
      and (coalesce(p.qual, '') like '%client-photos%' or coalesce(p.with_check, '') like '%client-photos%')
  ) then
    raise exception 'LAUNCH-SEC-1B: a storage policy still grants access to client-photos';
  end if;
end $$;

commit;
