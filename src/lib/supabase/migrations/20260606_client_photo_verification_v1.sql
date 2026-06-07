-- 20260606_client_photo_verification_v1.sql
-- Adds client headshots for staff verification and future client QR identity workflows.

alter table public.clients
  add column if not exists photo_url text;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'client-photos',
  'client-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Public read client photos'
  ) then
    create policy "Public read client photos"
      on storage.objects
      for select
      using (bucket_id = 'client-photos');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Authenticated upload client photos'
  ) then
    create policy "Authenticated upload client photos"
      on storage.objects
      for insert
      to authenticated
      with check (bucket_id = 'client-photos');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Authenticated update client photos'
  ) then
    create policy "Authenticated update client photos"
      on storage.objects
      for update
      to authenticated
      using (bucket_id = 'client-photos')
      with check (bucket_id = 'client-photos');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Authenticated delete client photos'
  ) then
    create policy "Authenticated delete client photos"
      on storage.objects
      for delete
      to authenticated
      using (bucket_id = 'client-photos');
  end if;
end $$;
