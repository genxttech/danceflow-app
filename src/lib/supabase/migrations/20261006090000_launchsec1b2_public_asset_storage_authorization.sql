-- 20261006090000_launchsec1b2_public_asset_storage_authorization.sql
--
-- LAUNCH-SEC-1B2: close cross-tenant Storage writes on the public asset
-- buckets while keeping public delivery of their files.
--
-- Before (created outside repository migrations; captured read-only from PROD):
--   event-media           public, 5 MB, png/jpeg/webp
--     "Public can read event media"                         SELECT  public
--     "Authenticated users can upload event media"          INSERT  authenticated
--     "Authenticated users can update event media"          UPDATE  authenticated
--     "Authenticated users can delete event media"          DELETE  authenticated
--   studio-public-assets  public, no size/type limits
--     "Anyone can view studio public assets"                SELECT  public
--     "Authenticated users can upload studio public assets" INSERT  authenticated
--     "Authenticated users can update studio public assets" UPDATE  authenticated
--     "Authenticated users can delete studio public assets" DELETE  authenticated
-- Every policy was scoped only by bucket_id, so any signed-in user could
-- list, upload, overwrite or delete any studio's files.
--
-- After:
--   event-media: still public (files keep being served from public URLs);
--     the four policies are replaced by a single INSERT policy that requires
--     the first path segment to be the UUID of an existing studio in which
--     the caller has access via public.user_has_studio_access() (an ACTIVE
--     user_studio_roles row for that studio, or profiles.platform_role =
--     'platform_admin'). This is what the event cover upload in
--     src/app/app/events/actions.ts needs ({studioId}/{slug}/{ts}-{uuid}.ext,
--     upsert:false, user-scoped client). No SELECT/UPDATE/DELETE policy.
--   studio-public-assets: still public; all four policies are dropped (the
--     application writes it only through the service role after a studio
--     owner/admin check in settings/public-profile/actions.ts); 5 MB and
--     jpeg/png/webp limits are added.
--
-- No business rows, no Storage objects, no grants, no other bucket or policy.
-- Fails closed unless the live configuration matches the reviewed pre-state.

begin;

do $$
declare
  v_unexpected text;
begin
  if not exists (
    select 1 from storage.buckets b
    where b.id = 'event-media'
      and b.public = true
      and b.file_size_limit = 5242880
      and b.allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
  ) then
    raise exception 'LAUNCH-SEC-1B2: event-media bucket is missing or not in the reviewed state';
  end if;

  if not exists (
    select 1 from storage.buckets b
    where b.id = 'studio-public-assets'
      and b.public = true
      and (
        (b.file_size_limit is null and b.allowed_mime_types is null)
        or (b.file_size_limit = 5242880
            and b.allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'])
      )
  ) then
    raise exception 'LAUNCH-SEC-1B2: studio-public-assets bucket is missing or not in the reviewed state';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'user_has_studio_access'
      and pg_get_function_identity_arguments(p.oid) = 'target_studio_id uuid'
      and p.prosecdef
  ) then
    raise exception 'LAUNCH-SEC-1B2: public.user_has_studio_access(uuid) is missing';
  end if;

  -- Every storage policy that mentions either bucket must be one of the eight
  -- reviewed policies with its exact reviewed definition (or this migration's
  -- own policy, so a re-run is a no-op).
  select string_agg(p.tablename || '.' || p.policyname, ', ' order by p.policyname)
    into v_unexpected
  from pg_policies p
  where p.schemaname = 'storage'
    and (coalesce(p.qual, '') ~ 'event-media|studio-public-assets'
      or coalesce(p.with_check, '') ~ 'event-media|studio-public-assets')
    and not (
      p.tablename = 'objects'
      and p.permissive = 'PERMISSIVE'
      and (
        (p.policyname = 'Public can read event media'
          and p.cmd = 'SELECT' and p.roles = array['public']::name[]
          and p.qual = '(bucket_id = ''event-media''::text)' and p.with_check is null)
        or (p.policyname = 'Authenticated users can upload event media'
          and p.cmd = 'INSERT' and p.roles = array['authenticated']::name[]
          and p.qual is null and p.with_check = '(bucket_id = ''event-media''::text)')
        or (p.policyname = 'Authenticated users can update event media'
          and p.cmd = 'UPDATE' and p.roles = array['authenticated']::name[]
          and p.qual = '(bucket_id = ''event-media''::text)'
          and p.with_check = '(bucket_id = ''event-media''::text)')
        or (p.policyname = 'Authenticated users can delete event media'
          and p.cmd = 'DELETE' and p.roles = array['authenticated']::name[]
          and p.qual = '(bucket_id = ''event-media''::text)' and p.with_check is null)
        or (p.policyname = 'Anyone can view studio public assets'
          and p.cmd = 'SELECT' and p.roles = array['public']::name[]
          and p.qual = '(bucket_id = ''studio-public-assets''::text)' and p.with_check is null)
        or (p.policyname = 'Authenticated users can upload studio public assets'
          and p.cmd = 'INSERT' and p.roles = array['authenticated']::name[]
          and p.qual is null and p.with_check = '(bucket_id = ''studio-public-assets''::text)')
        or (p.policyname = 'Authenticated users can update studio public assets'
          and p.cmd = 'UPDATE' and p.roles = array['authenticated']::name[]
          and p.qual = '(bucket_id = ''studio-public-assets''::text)'
          and p.with_check = '(bucket_id = ''studio-public-assets''::text)')
        or (p.policyname = 'Authenticated users can delete studio public assets'
          and p.cmd = 'DELETE' and p.roles = array['authenticated']::name[]
          and p.qual = '(bucket_id = ''studio-public-assets''::text)' and p.with_check is null)
        or (p.policyname = 'Studio members can upload event media'
          and p.cmd = 'INSERT' and p.roles = array['authenticated']::name[])
      )
    );

  if v_unexpected is not null then
    raise exception 'LAUNCH-SEC-1B2: unexpected storage policy definition(s): %', v_unexpected;
  end if;
end $$;

drop policy if exists "Public can read event media" on storage.objects;
drop policy if exists "Authenticated users can upload event media" on storage.objects;
drop policy if exists "Authenticated users can update event media" on storage.objects;
drop policy if exists "Authenticated users can delete event media" on storage.objects;

drop policy if exists "Anyone can view studio public assets" on storage.objects;
drop policy if exists "Authenticated users can upload studio public assets" on storage.objects;
drop policy if exists "Authenticated users can update studio public assets" on storage.objects;
drop policy if exists "Authenticated users can delete studio public assets" on storage.objects;

drop policy if exists "Studio members can upload event media" on storage.objects;
create policy "Studio members can upload event media"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'event-media'
    and case
      when split_part(objects.name, '/', 1)
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then exists (
             select 1 from public.studios s
             where s.id = split_part(objects.name, '/', 1)::uuid
           )
           and public.user_has_studio_access(split_part(objects.name, '/', 1)::uuid)
      else false
    end
  );

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'studio-public-assets';

do $$
begin
  if not exists (
    select 1 from storage.buckets b
    where b.id = 'event-media' and b.public = true
      and b.file_size_limit = 5242880
      and b.allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
  ) then
    raise exception 'LAUNCH-SEC-1B2: event-media bucket changed unexpectedly';
  end if;

  if not exists (
    select 1 from storage.buckets b
    where b.id = 'studio-public-assets' and b.public = true
      and b.file_size_limit = 5242880
      and b.allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
  ) then
    raise exception 'LAUNCH-SEC-1B2: studio-public-assets limits were not applied';
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'storage'
      and (coalesce(p.qual, '') like '%studio-public-assets%'
        or coalesce(p.with_check, '') like '%studio-public-assets%')
  ) then
    raise exception 'LAUNCH-SEC-1B2: a storage policy still references studio-public-assets';
  end if;

  if (
    select count(*) from pg_policies p
    where p.schemaname = 'storage'
      and (coalesce(p.qual, '') like '%event-media%'
        or coalesce(p.with_check, '') like '%event-media%')
  ) <> 1
  or not exists (
    select 1 from pg_policies p
    where p.schemaname = 'storage' and p.tablename = 'objects'
      and p.policyname = 'Studio members can upload event media'
      and p.permissive = 'PERMISSIVE' and p.cmd = 'INSERT'
      and p.roles = array['authenticated']::name[]
      and p.qual is null
      and p.with_check like '%user_has_studio_access%'
  ) then
    raise exception 'LAUNCH-SEC-1B2: event-media must have exactly the scoped INSERT policy';
  end if;
end $$;

commit;
