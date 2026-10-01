-- ROLLBACK for LAUNCH-SEC-1B2. Manual, owner-approved use only -- never automatic.
--
-- !!! WARNING: running this RE-OPENS the cross-tenant Storage write
-- !!! vulnerability on event-media and studio-public-assets (any signed-in
-- !!! user can list, upload, overwrite and delete any studio's files).
--
-- Restores the exact reviewed pre-1B2 configuration (captured read-only from
-- PROD): drops the scoped event-media INSERT policy, removes the
-- studio-public-assets size/type limits, and recreates the original eight
-- permissive policies. event-media bucket settings were not changed by the
-- forward migration and are asserted, not modified. No objects, no business
-- rows.

begin;

do $$
begin
  if not exists (
    select 1 from storage.buckets b
    where b.id = 'event-media' and b.public = true
      and b.file_size_limit = 5242880
      and b.allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
  ) then
    raise exception 'LAUNCH-SEC-1B2 rollback: event-media bucket is missing or not in the expected state';
  end if;
  if not exists (select 1 from storage.buckets b where b.id = 'studio-public-assets') then
    raise exception 'LAUNCH-SEC-1B2 rollback: studio-public-assets bucket does not exist';
  end if;
end $$;

drop policy if exists "Studio members can upload event media" on storage.objects;

update storage.buckets
set public = true,
    file_size_limit = null,
    allowed_mime_types = null
where id = 'studio-public-assets';

drop policy if exists "Public can read event media" on storage.objects;
create policy "Public can read event media"
  on storage.objects for select
  using (bucket_id = 'event-media');

drop policy if exists "Authenticated users can upload event media" on storage.objects;
create policy "Authenticated users can upload event media"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'event-media');

drop policy if exists "Authenticated users can update event media" on storage.objects;
create policy "Authenticated users can update event media"
  on storage.objects for update to authenticated
  using (bucket_id = 'event-media')
  with check (bucket_id = 'event-media');

drop policy if exists "Authenticated users can delete event media" on storage.objects;
create policy "Authenticated users can delete event media"
  on storage.objects for delete to authenticated
  using (bucket_id = 'event-media');

drop policy if exists "Anyone can view studio public assets" on storage.objects;
create policy "Anyone can view studio public assets"
  on storage.objects for select
  using (bucket_id = 'studio-public-assets');

drop policy if exists "Authenticated users can upload studio public assets" on storage.objects;
create policy "Authenticated users can upload studio public assets"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'studio-public-assets');

drop policy if exists "Authenticated users can update studio public assets" on storage.objects;
create policy "Authenticated users can update studio public assets"
  on storage.objects for update to authenticated
  using (bucket_id = 'studio-public-assets')
  with check (bucket_id = 'studio-public-assets');

drop policy if exists "Authenticated users can delete studio public assets" on storage.objects;
create policy "Authenticated users can delete studio public assets"
  on storage.objects for delete to authenticated
  using (bucket_id = 'studio-public-assets');

commit;
