-- ROLLBACK for LAUNCH-SEC-1B Stage 2. Manual, owner-approved use only -- never automatic.
--
-- Restores the exact pre-Stage-2 client-photos Storage configuration: the
-- bucket is public again and the four policies from
-- 20260606_client_photo_verification_v1.sql are recreated with their exact
-- definitions (verified against the live DEV catalog before Stage 2).
-- WARNING: running this re-opens P0-3 (public, listable client photos and
-- write access for any authenticated user).
--
-- Required order if an application rollback to a pre-Stage-1 build (one that
-- renders public client-photo URLs, e.g. dpl_XUUdUoMAXqE33YPKArEzTAZrBmfV) is
-- ever needed: explicitly authorize this rollback, apply and verify it, and
-- only then roll the application back.

begin;

do $$
begin
  if not exists (select 1 from storage.buckets b where b.id = 'client-photos') then
    raise exception 'LAUNCH-SEC-1B rollback: storage bucket client-photos does not exist';
  end if;
end $$;

update storage.buckets
set public = true
where id = 'client-photos';

drop policy if exists "Public read client photos" on storage.objects;
create policy "Public read client photos"
  on storage.objects
  for select
  using (bucket_id = 'client-photos');

drop policy if exists "Authenticated upload client photos" on storage.objects;
create policy "Authenticated upload client photos"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'client-photos');

drop policy if exists "Authenticated update client photos" on storage.objects;
create policy "Authenticated update client photos"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'client-photos')
  with check (bucket_id = 'client-photos');

drop policy if exists "Authenticated delete client photos" on storage.objects;
create policy "Authenticated delete client photos"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'client-photos');

commit;
